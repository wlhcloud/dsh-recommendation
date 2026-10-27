import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import RecommendationService from '../src/index.ts'
import { addSessionEvent, buildRecommendationContext, contextHash, emptySessionContext } from '../src/context.ts'
import { InterestExtractor, RecommendationGenerator, recommendationModelConfig, validQuestions } from '../src/model.ts'
import { addEvent, emptyProfile, isLongTermInterest, mergeInterest, migrateProfile, normalizeInterest, ProfileStore,
  scoreInterest, type Interest } from '../src/profile.ts'

const NOW = '2026-09-30T08:00:00.000Z'
const SEMANTIC = { name: '双忠祠大门', type: 'entity' as const }

test('public defaults contain no private endpoint and explicit OpenAI configuration is honored', async () => {
  const config = recommendationModelConfig()
  assert.equal(config.baseUrl, 'http://127.0.0.1:11434/v1')
  assert.doesNotMatch(JSON.stringify(config), /192\.168\.|202\.41\.|59\.110\./)
  const originalFetch = globalThis.fetch
  try {
    let request: { url?: string; authorization?: string; model?: string } = {}
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      const headers = init?.headers as Record<string, string>
      request = { url: String(url), authorization: headers.authorization, model: body.model }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"interests":[{"name":"distributed systems","type":"topic"}]}' } }] }), { status: 200 })
    }
    const extractor = new InterestExtractor(recommendationModelConfig({ baseUrl: 'https://models.example.test/v1/', apiKey: 'test-key', recommendModel: 'recommend', interestModel: 'extract' }))
    assert.deepEqual(await extractor.extract('Teach me distributed systems'), [{ name: 'distributed systems', type: 'topic' }])
    assert.deepEqual(request, { url: 'https://models.example.test/v1/chat/completions', authorization: 'Bearer test-key', model: 'extract' })
  } finally { globalThis.fetch = originalFetch }
})

function interestOf(profile: ReturnType<typeof emptyProfile>, key: string): Interest {
  const item = profile.interests.find(value => value.key === key)
  assert.ok(item)
  return item
}

test('normalizes only semantic names, deduplicates events and merges evidence', () => {
  const profile = emptyProfile()
  const event = { id: 'session-a:request-a', sessionId: 'session-a', query: '三普资料', source: 'user_input' as const, at: NOW }
  assert.equal(addEvent(profile, event), true)
  assert.equal(addEvent(profile, event), false)
  assert.equal(profile.recentEvents.length, 1)
  mergeInterest(profile, { name: '三普', type: 'topic' }, event)
  mergeInterest(profile, { name: '  三普  ', type: 'topic' }, { ...event, id: 'request-b' })
  const item = interestOf(profile, 'topic:三普')
  assert.equal(item.eventCount, 2)
  assert.equal(item.directCount, 2)
  assert.equal(item.sessionCount, 1)
  assert.equal(normalizeInterest({ name: '变化', type: 'concept' })?.key, 'concept:变化')
})

test('migrates V1 preferences without importing unknown legacy interest fields', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'relic-profile-migration-'))
  try {
    const directory = join(workspace, '.dsh-recommendation')
    await (await import('node:fs/promises')).mkdir(directory)
    const file = join(directory, 'profile.json')
    await writeFile(file, JSON.stringify({ version: 1, answerStyle: 'detailed', recentTopics: [
      { id: 'session-a:request-a', topic: '三普查询', district: '东城区', at: NOW },
      { id: 'session-b:request-b', topic: '单文物详情', relicName: '双忠祠大门', at: NOW },
      { id: 'session-c:request-c', topic: '四普查询', at: NOW },
    ] }))
    const profile = await new ProfileStore().load(workspace)
    assert.equal(profile.version, 2)
    assert.deepEqual(profile.interests, [])
    assert.equal(profile.recentEvents.length, 0)
    assert.equal(profile.preferences.answerStyle, 'detailed')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('corrupted profiles safely become empty V2 profiles', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'relic-profile-corrupt-'))
  try {
    const directory = join(workspace, '.dsh-recommendation')
    await (await import('node:fs/promises')).mkdir(directory)
    await writeFile(join(directory, 'profile.json'), '{broken')
    assert.deepEqual(await new ProfileStore().load(workspace), emptyProfile())
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('one-off interest remains recent while cross-session direct interest becomes long-term', () => {
  const profile = emptyProfile()
  mergeInterest(profile, SEMANTIC, { sessionId: 'session-a', source: 'user_input', at: NOW })
  const once = interestOf(profile, 'entity:双忠祠大门')
  assert.equal(isLongTermInterest(once), false)
  const singleSessionScore = scoreInterest(once, new Date(NOW))
  mergeInterest(profile, SEMANTIC, { sessionId: 'session-b', source: 'user_input', at: NOW })
  assert.equal(isLongTermInterest(once), true)
  assert.ok(scoreInterest(once, new Date(NOW)) > singleSessionScore)
  const context = buildRecommendationContext(profile, emptySessionContext())
  assert.deepEqual(context.longTermInterests, [SEMANTIC])
})

test('cross-session evidence scores higher than same-session repetition with equal direct counts', () => {
  const sameSession = emptyProfile(); const crossSession = emptyProfile()
  for (let index = 0; index < 3; index++) {
    mergeInterest(sameSession, SEMANTIC, { sessionId: 'one', source: 'user_input', at: NOW })
    mergeInterest(crossSession, SEMANTIC, { sessionId: `session-${index}`, source: 'user_input', at: NOW })
  }
  assert.ok(scoreInterest(crossSession.interests[0]!, new Date(NOW)) > scoreInterest(sameSession.interests[0]!, new Date(NOW)))
})

test('recommendation clicks have lower and capped influence than direct input', () => {
  const clicks = emptyProfile(); const direct = emptyProfile()
  for (let index = 0; index < 30; index++) mergeInterest(clicks, SEMANTIC, { sessionId: `click-${index}`, source: 'recommendation_click', at: NOW })
  for (let index = 0; index < 3; index++) mergeInterest(direct, SEMANTIC, { sessionId: 'one', source: 'user_input', at: NOW })
  assert.equal(clicks.interests[0]?.recommendationClickCount, 30)
  assert.ok(scoreInterest(clicks.interests[0]!, new Date(NOW)) < scoreInterest(direct.interests[0]!, new Date(NOW)))
  assert.equal(isLongTermInterest(clicks.interests[0]!), false)
})

test('interest score decays over time without persisting a score', () => {
  const profile = emptyProfile()
  mergeInterest(profile, SEMANTIC, { sessionId: 'one', source: 'user_input', at: NOW })
  const interest = profile.interests[0]!
  assert.ok(scoreInterest(interest, new Date('2026-12-29T08:00:00.000Z')) < scoreInterest(interest, new Date(NOW)) / 3)
  assert.equal('score' in interest, false)
})

test('current Haidian session takes priority over long-term Dongcheng interest', () => {
  const profile = emptyProfile()
  for (const sessionId of ['old-a', 'old-b', 'old-c']) mergeInterest(profile, { name: '东城区', type: 'location' }, { sessionId, source: 'user_input', at: NOW })
  const session = emptySessionContext()
  addSessionEvent(session, '海淀区有哪些古建筑？', [{ name: '海淀区', type: 'location' }, { name: '古建筑', type: 'category' }])
  const context = buildRecommendationContext(profile, session, { question: '海淀区有哪些古建筑？', answer: '海淀区有多处古建筑。' })
  assert.ok(context.current?.activeEntities.some(item => item.name === '海淀区'))
  assert.equal(context.longTermInterests.some(item => item.name === '东城区'), false)
})

test('repeated study of one relic remains the current focus', () => {
  const profile = emptyProfile(); const session = emptySessionContext()
  addSessionEvent(session, '双忠祠大门三普信息', [SEMANTIC, { name: '第三次全国文物普查', type: 'topic' }])
  addSessionEvent(session, '双忠祠大门四普信息', [SEMANTIC, { name: '第四次全国文物普查', type: 'topic' }])
  const context = buildRecommendationContext(profile, session, { question: '双忠祠大门四普信息', answer: '目前没有找到可靠四普关联。' })
  assert.equal(context.current?.activeEntities[0]?.name, '双忠祠大门')
  assert.deepEqual(context.session.recentQueries, ['双忠祠大门三普信息', '双忠祠大门四普信息'])
  assert.equal(context.longTermInterests.length, 0)
})

test('a failed follow-up model falls back only to the currently studied relic', async () => {
  const profile = emptyProfile(); const session = emptySessionContext()
  addSessionEvent(session, '双忠祠大门四普信息', [SEMANTIC])
  const context = buildRecommendationContext(profile, session, { question: '双忠祠大门四普信息是什么？', answer: '暂未找到可靠四普关联。' })
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions: [
      '双忠祠大门四普信息是什么？',
    ] }) } }] }), { status: 200 })
    const result = await new RecommendationGenerator().generate(context, 'follow_up')
    assert.equal(result.source, 'fallback')
    assert.deepEqual(result.questions, ['关于双忠祠大门，还有哪些重要细节值得继续了解？'])
  } finally { globalThis.fetch = originalFetch }
})

test('suppression removes an interest from recommendation context', () => {
  const profile = emptyProfile()
  mergeInterest(profile, { name: '东城区', type: 'location' }, { sessionId: 'one', source: 'user_input', at: NOW })
  profile.suppressedInterests.push({ key: 'location:东城区', name: '东城区', at: NOW })
  const context = buildRecommendationContext(profile, emptySessionContext())
  assert.equal(context.recentInterests.length + context.longTermInterests.length, 0)
})

test('dismissed recommendation is persisted and excluded without suppressing its interests', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-recommendation-dismiss-test-'))
  const originalFetch = globalThis.fetch
  const dismissed = '双忠祠大门周边还有哪些清代建筑？'
  try {
    const service = new RecommendationService(new Context())
    await service.dismissQuestion(workspace, dismissed)
    const profile = await service.store.load(workspace)
    assert.deepEqual(profile.dismissedQuestions, [dismissed])
    assert.deepEqual(profile.suppressedInterests, [])
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions: [
      dismissed, '北京长城遗产的保护现状如何？',
    ] }) } }] }), { status: 200 })
    const result = await service.home(workspace)
    assert.deepEqual(result.questions, ['北京长城遗产的保护现状如何？'])
  } finally { globalThis.fetch = originalFetch; await rm(workspace, { recursive: true, force: true }) }
})

test('answer changes the recommendation context hash even for the same turn', () => {
  const profile = emptyProfile(); const session = emptySessionContext()
  const first = buildRecommendationContext(profile, session, { question: '双忠祠大门是什么？', answer: '它是一座清代建筑。' })
  const second = buildRecommendationContext(profile, session, { question: '双忠祠大门是什么？', answer: '四普暂未找到对应记录。' })
  assert.notEqual(contextHash(first), contextHash(second))
})

test('only basic quality filters apply; reasonable unsupported-capability questions remain eligible', async () => {
  assert.deepEqual(validQuestions(['北京长城遗产的保护现状如何？', '北京长城遗产的保护现状如何？', '你好'], '', 3),
    ['北京长城遗产的保护现状如何？'])
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions: [
      '北京长城遗产的保护现状如何？', '双忠祠大门周边还有哪些清代建筑？',
    ] }) } }] }), { status: 200 })
    const generated = await new RecommendationGenerator().generate(buildRecommendationContext(emptyProfile(), emptySessionContext()), 'home')
    assert.equal(generated.source, 'generated')
    assert.equal(generated.questions[0], '北京长城遗产的保护现状如何？')
  } finally { globalThis.fetch = originalFetch }
})

test('recommendations avoid recently asked questions and near-duplicate phrasings', () => {
  const questions = validQuestions([
    '双忠祠大门三普信息是什么？',
    '海淀区有哪些古建筑值得参观？',
    '海淀区有哪些古建筑值得拍照？',
    '北京长城遗产保护中有哪些新方法？',
  ], '海淀区有哪些古建筑？', 3, ['双忠祠大门三普信息'])
  assert.deepEqual(questions, ['北京长城遗产保护中有哪些新方法？'])
})

test('extractor accepts semantic interests but cannot set scores or edit profile', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ interests: [
      { name: '三普', type: 'topic', score: 100 }, { name: '三普', type: 'topic' }, { name: '双忠祠大门', type: 'entity' },
    ] }) } }] }), { status: 200 })
    const extracted = await new InterestExtractor().extract('双忠祠大门三普信息')
    assert.deepEqual(extracted, [{ name: '三普', type: 'topic' }, SEMANTIC])
  } finally { globalThis.fetch = originalFetch }
})

test('service records direct input and recommendation clicks as separate evidence', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-recommendation-source-test-'))
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ interests: [SEMANTIC] }) } }] }), { status: 200 })
    const service = new RecommendationService(new Context())
    await service.record(workspace, 'session-a', 'direct', '双忠祠大门的历史是什么？', 'user_input')
    await service.record(workspace, 'session-a', 'clicked', '双忠祠大门有哪些故事？', 'recommendation_click')
    await service.waitForExtraction(workspace)
    const profile = await service.store.load(workspace)
    assert.deepEqual(profile.recentEvents.map(event => event.source), ['user_input', 'recommendation_click'])
    assert.equal(profile.interests[0]?.directCount, 1)
    assert.equal(profile.interests[0]?.recommendationClickCount, 1)
    assert.equal(profile.interests[0]?.sessionCount, 1)
  } finally { globalThis.fetch = originalFetch; await rm(workspace, { recursive: true, force: true }) }
})

test('V1 migration ignores vague old topic labels', () => {
  const profile = migrateProfile({ version: 1, recentTopics: [
    { id: 'session-a:request-a', topic: '三普查询', at: NOW },
  ] })
  assert.deepEqual(profile.interests, [])
})
