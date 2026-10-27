/** 推荐撤销并发验收：使用真实 Cordis fiber、临时文件及可控 Promise 屏障，不依赖 sleep。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { Context } from '@deepseek-ai/cordis'
import RecommendationService from '../src/index.ts'
import type { ProfileStore } from '../src/profile.ts'

/** 创建显式释放的并发屏障，失败也可主动拒绝。 */
function barrier<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** 注册真实服务及独立卸载开始通知，供测试观察 fiber 生命周期而不是猜测时序。 */
async function install(ctx: Context) {
  let service!: RecommendationService
  const stopping = barrier()
  /** 在独立提供方上下文构造服务，保留与 Gateway 相同的追踪代理获取方式。 */
  const provider = (owner: Context) => {
    service = new RecommendationService(owner)
    owner.effect(
      /** 登记测试专用卸载通知，无生产副作用。 */
      () => /** 通知卸载已经开始。 */
      () => stopping.resolve(), 'test unload notification')
  }
  const fiber = ctx.plugin(provider)
  await fiber.await()
  return { service, fiber, stopping }
}

/** 在临时目录运行测试，所有 provider 收尾后清理测试文件。 */
async function fixture(run: (ctx: Context, workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-recommendation-unload-'))
  const ctx = new Context()
  try { await run(ctx, workspace) }
  finally { await ctx.fiber.dispose(); await rm(workspace, { recursive: true, force: true }) }
}

/** 暂停指定第 N 次临时文件写入之后、最终提交检查之前，覆盖最窄撤销竞态窗口。 */
function pausePublication(store: ProfileStore, occurrence = 1) {
  const target = store as unknown as { writeTemporary(path: string, data: string): Promise<void> }
  const original = target.writeTemporary.bind(store)
  const entered = barrier(), release = barrier()
  let count = 0
  /** 在真实临时写入完成后显式阻塞，最终检查尚未运行。 */
  target.writeTemporary = async (path, data) => {
    await original(path, data)
    if (++count === occurrence) { entered.resolve(); await release.promise }
  }
  return { entered, release }
}

/** 读取实际磁盘字节，以验证旧任务没有覆盖新画像。 */
async function bytes(workspace: string) {
  return readFile(join(workspace, '.dsh-recommendation', 'profile.json'), 'utf8')
}

test('normal record awaits event publication but not extraction; queued jobs keep original order', async () => fixture(async (ctx, workspace) => {
  const { service, fiber } = await install(ctx), entered = barrier(), release = barrier()
  const calls: string[] = []
  service.extractor.extract = async query => {
    calls.push(query)
    if (query === '第一条') { entered.resolve(); await release.promise }
    return [{ name: query, type: 'topic' }]
  }
  await service.record(workspace, 'a', 'one', '第一条')
  await entered.promise
  assert.equal(JSON.parse(await bytes(workspace)).recentEvents.length, 1)
  await service.record(workspace, 'b', 'two', '第二条')
  assert.deepEqual(calls, ['第一条'])
  release.resolve(); await service.waitForExtraction(workspace)
  assert.deepEqual(calls, ['第一条', '第二条'])
  assert.equal((await service.store.load(workspace)).interests.length, 2)
  await fiber.dispose()
}))

for (const lateFailure of [false, true]) test(`running extraction cancels; queued work and late result cannot write (${lateFailure})`, async () => fixture(async (ctx, workspace) => {
  const { service, fiber } = await install(ctx), entered = barrier(), release = barrier()
  let calls = 0, signal!: AbortSignal
  service.extractor.extract = async (_query, received) => {
    calls++; signal = received!; entered.resolve(); await release.promise
    if (lateFailure) throw new Error('late failure')
    return [{ name: '不应写入', type: 'topic' }]
  }
  await service.record(workspace, 'a', 'one', '第一条'); await entered.promise
  await service.record(workspace, 'b', 'two', '第二条')
  const before = await bytes(workspace)
  await fiber.dispose() // 不释放提取屏障也必须完成撤销。
  assert.equal(signal.aborted, true); assert.equal(ctx.get('recommendations'), undefined)
  await service.waitForExtraction(workspace)
  release.resolve(); await service.waitForExtraction(workspace)
  await service.record(workspace, 'c', 'three', '撤销后任务')
  assert.equal(calls, 1); assert.equal(await bytes(workspace), before)
}))

test('withdrawal between temporary write and rename denies initial event publication and drains files', async () => fixture(async (ctx, workspace) => {
  const { service, fiber, stopping } = await install(ctx)
  const gate = pausePublication(service.store)
  const pending = assert.rejects(service.record(workspace, 'a', 'one', '近期行为'), /recommendations_unavailable/)
  await gate.entered.promise
  let drained = false
  const unloading = Promise.resolve(fiber.dispose()).then(() => { drained = true })
  await stopping.promise
  assert.equal(drained, false)
  gate.release.resolve(); await pending; await unloading
  await assert.rejects(bytes(workspace), { code: 'ENOENT' })
  assert.deepEqual(await readdir(join(workspace, '.dsh-recommendation')), [])
}))

test('withdrawal after extracted profile temporary write cannot publish interests', async () => fixture(async (ctx, workspace) => {
  const { service, fiber, stopping } = await install(ctx)
  const gate = pausePublication(service.store, 2)
  service.extractor.extract = async () => [{ name: '旧兴趣', type: 'topic' }]
  await service.record(workspace, 'a', 'one', '原事件')
  await gate.entered.promise
  const before = await bytes(workspace), unloading = fiber.dispose()
  await stopping.promise
  gate.release.resolve(); await unloading
  assert.equal(await bytes(workspace), before)
  assert.deepEqual((await service.store.load(workspace)).interests, [])
  assert.deepEqual(await readdir(join(workspace, '.dsh-recommendation')), ['profile.json'])
}))

test('new instance can publish while old publication is blocked; old commit cannot overwrite replacement', async () => fixture(async (ctx, workspace) => {
  const old = await install(ctx), gate = pausePublication(old.service.store)
  const pending = assert.rejects(old.service.record(workspace, 'a', 'one', '旧实例'), /recommendations_unavailable/)
  await gate.entered.promise
  const unloading = old.fiber.dispose(); await old.stopping.promise
  assert.equal(ctx.get('recommendations'), undefined)
  const replacement = await install(ctx)
  replacement.service.extractor.extract = async () => [{ name: '新兴趣', type: 'topic' }]
  await replacement.service.record(workspace, 'b', 'two', '新实例')
  await replacement.service.waitForExtraction(workspace)
  const expected = await bytes(workspace)
  gate.release.resolve(); await pending; await unloading
  assert.equal(await bytes(workspace), expected)
  await assert.rejects(old.service.dismissQuestion(workspace, '旧引用不得写入'), /recommendations_unavailable/)
  await assert.rejects(old.service.home(workspace), /recommendations_unavailable/)
  await assert.rejects(old.service.suppress(workspace, { name: '旧兴趣', type: 'topic' }), /recommendations_unavailable/)
  assert.equal(await bytes(workspace), expected)
  await replacement.fiber.dispose()
}))

test('in-flight recommendation rejects on unload and late model result cannot recreate cache', async () => fixture(async (ctx, workspace) => {
  const { service, fiber } = await install(ctx), entered = barrier(), release = barrier()
  let signal!: AbortSignal
  service.generator.generate = async (_context, _kind, received) => {
    signal = received!; entered.resolve(); await release.promise
    return { questions: ['不应缓存的迟到问题'], source: 'generated' }
  }
  // 与 Gateway 一样通过根上下文获取服务，确保屏障绑定提供方而非调用方 fiber。
  const pending = assert.rejects(ctx.get('recommendations')!.home(workspace), /recommendations_unavailable/)
  await entered.promise; await fiber.dispose(); await pending
  assert.equal(signal.aborted, true)
  release.resolve()
  const state = service as unknown as { cache: Map<string, unknown>; sessions: Map<string, unknown> }
  await Promise.resolve(); await Promise.resolve()
  assert.equal(state.cache.size, 0); assert.equal(state.sessions.size, 0)
}))

test('session deletion closes the publication gate before waiting, then removes original events', async () => fixture(async (ctx, workspace) => {
  const { service, fiber } = await install(ctx), gate = pausePublication(service.store, 2)
  service.extractor.extract = async () => [{ name: '被删兴趣', type: 'topic' }]
  await service.record(workspace, 'a', 'one', '待删除')
  await gate.entered.promise
  const deletion = service.forgetSessions(workspace, ['a'])
  gate.release.resolve(); await deletion
  const profile = await service.store.load(workspace)
  assert.deepEqual(profile.interests, []); assert.deepEqual(profile.recentEvents, [])
  await fiber.dispose()
}))

test('concurrent deletion and withdrawal reports incomplete cleanup, never publishes late; replacement can finish cleanup', async () => fixture(async (ctx, workspace) => {
  const old = await install(ctx), gate = pausePublication(old.service.store, 2)
  old.service.extractor.extract = async () => [{ name: '被删兴趣', type: 'topic' }]
  await old.service.record(workspace, 'a', 'one', '原事件'); await gate.entered.promise
  const before = await bytes(workspace)
  const deletion = assert.rejects(old.service.forgetSessions(workspace, ['a']), /recommendations_unavailable/)
  const unloading = old.fiber.dispose(); await old.stopping.promise
  gate.release.resolve(); await deletion; await unloading
  assert.equal(await bytes(workspace), before)
  const replacement = await install(ctx)
  await replacement.service.forgetSessions(workspace, ['a'])
  assert.deepEqual((await replacement.service.store.load(workspace)).recentEvents, [])
  await replacement.fiber.dispose()
}))

test('real model fetch receives cancellation and its rejected promise is handled', async () => fixture(async (ctx, workspace) => {
  const original = globalThis.fetch, entered = barrier()
  const { service, fiber } = await install(ctx)
  let signal!: AbortSignal
  globalThis.fetch = async (_url, init) => {
    signal = init!.signal as AbortSignal; entered.resolve()
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  try {
    await service.record(workspace, 'a', 'one', '真实模型取消通道')
    await entered.promise; const before = await bytes(workspace)
    await fiber.dispose(); await service.waitForExtraction(workspace)
    assert.equal(signal.aborted, true); assert.equal(await bytes(workspace), before)
  } finally { globalThis.fetch = original }
}))

for (const operation of ['dismiss', 'suppress', 'migration'] as const) test(`all profile publishers share final unload gate: ${operation}`, async () => fixture(async (ctx, workspace) => {
  const { service, fiber, stopping } = await install(ctx)
  // 先创建有效文件，以逐字节比较未获提交授权的更新。
  await service.dismissQuestion(workspace, '原有不赞问题保持不变')
  if (operation === 'migration') {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(workspace, '.dsh-recommendation', 'profile.json'), JSON.stringify({ version: 1, recentTopics: [] }))
  }
  const before = await bytes(workspace), gate = pausePublication(service.store)
  const action = operation === 'dismiss' ? service.dismissQuestion(workspace, '撤销前不应该提交新问题')
    : operation === 'suppress' ? service.suppress(workspace, { name: '旧兴趣', type: 'topic' })
      : service.store.load(workspace)
  // load 沿用原读取降级；其他更新必须明确拒绝。
  const pending = operation === 'migration' ? action : assert.rejects(action, /recommendations_unavailable/)
  await gate.entered.promise
  const unloading = fiber.dispose(); await stopping.promise
  gate.release.resolve(); await pending; await unloading
  assert.equal(await bytes(workspace), before)
  assert.deepEqual(await readdir(join(workspace, '.dsh-recommendation')), ['profile.json'])
}))

test('follow-up already in flight cannot repopulate cache after session deletion', async () => fixture(async (ctx, workspace) => {
  const { service, fiber } = await install(ctx), entered = barrier(), release = barrier()
  service.generator.generate = async () => {
    entered.resolve(); await release.promise
    return { questions: ['删除后不得缓存这个问题'], source: 'generated' }
  }
  const pending = assert.rejects(service.followUps(workspace, 'a', 1, '问题', '回答'), /session not found/)
  await entered.promise
  await service.forgetSessions(workspace, ['a'])
  release.resolve(); await pending
  assert.equal((service as unknown as { cache: Map<string, unknown> }).cache.size, 0)
  await fiber.dispose()
}))

test('modified recommendation methods all retain Chinese JSDoc', async () => {
  const expected: Record<string, string[]> = {
    'index.ts': ['constructor', 'assertAvailable', 'abortable', 'shutdown', 'record', 'waitForExtraction', 'home', 'followUps', 'suppress', 'dismissQuestion', 'sessionOf', 'recommend', 'invalidate', 'active', 'forgetSessions'],
    'profile.ts': ['constructor', 'assertWritable', 'close', 'writeTemporary', 'update'],
    'model.ts': ['modelJson', 'extract', 'generate'],
  }
  for (const [file, names] of Object.entries(expected)) {
    const content = await readFile(join(process.cwd(), 'src', file), 'utf8')
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const seen = new Set<string>()
    /** 扫描实际源码声明，不以手工估计代替注释覆盖验证。 */
    const visit = (node: ts.Node) => {
      if (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isFunctionDeclaration(node)) {
        const name = ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText(source)
        if (name && names.includes(name)) {
          const docs = ts.getJSDocCommentsAndTags(node).map(doc => doc.getText(source)).join('\n')
          assert.match(docs, /[\u4e00-\u9fff]/u, `${file}:${name} 缺少中文方法注释`)
          seen.add(name)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    assert.deepEqual([...seen].sort(), [...names].sort())
  }
})

test('same Cordis fiber restart replaces service without reactivating captured old instance', async () => fixture(async (ctx, workspace) => {
  const fiber = ctx.plugin(RecommendationService)
  await fiber.await()
  const old = ctx.get('recommendations')!, entered = barrier(), release = barrier()
  old.extractor.extract = async () => { entered.resolve(); await release.promise; return [{ name: '旧兴趣', type: 'topic' }] }
  await old.record(workspace, 'a', 'one', '重载前事件'); await entered.promise
  await fiber.restart()
  const current = ctx.get('recommendations')!
  assert.notEqual(old.store, current.store)
  current.extractor.extract = async () => [{ name: '新兴趣', type: 'topic' }]
  await current.record(workspace, 'b', 'two', '重载后事件')
  await current.waitForExtraction(workspace)
  release.resolve()
  await old.record(workspace, 'c', 'three', '旧引用不能复活')
  await assert.rejects(old.home(workspace), /recommendations_unavailable/)
  const profile = await current.store.load(workspace)
  assert.deepEqual(profile.interests.map(item => item.name), ['新兴趣'])
  assert.deepEqual(profile.recentEvents.map(item => item.query), ['重载前事件', '重载后事件'])
  await fiber.dispose()
}))
