import { randomUUID } from 'node:crypto'
/** 推荐画像存储：串行准备临时文件，在不可插入的最终提交段验证实例及会话有效性。 */
import { renameSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type EventSource = 'user_input' | 'recommendation_click'
export type InterestType = 'entity' | 'location' | 'topic' | 'category' | 'concept' | 'other'
export type SemanticInterest = { name: string; type: InterestType }
export type RecentEvent = { id: string; sessionId: string; query: string; source: EventSource; at: string }
export type Interest = SemanticInterest & {
  key: string; eventCount: number; directCount: number; recommendationClickCount: number
  sessionCount: number; sessionIds: string[]; firstSeenAt: string; lastSeenAt: string
}
export type SuppressedInterest = { key: string; name: string; at: string; until?: string }
export type UserPreferences = { answerStyle?: 'concise' | 'detailed' }
export type ProfileV2 = { version: 2; preferences: UserPreferences; interests: Interest[]; recentEvents: RecentEvent[]; suppressedInterests: SuppressedInterest[]; dismissedQuestions: string[] }

export const PROFILE_CONFIG = {
  maxEvents: 40, maxInterests: 80, maxSessionsPerInterest: 24, maxSuppressed: 40, maxDismissedQuestions: 40,
  directWeight: 1, clickWeight: 0.3, crossSessionWeight: 1.2, migratedWeight: 0.1,
  maxDirectContribution: 12, maxClickContribution: 3, halfLifeDays: 45,
  pruneAfterDays: 180, pruneBelowScore: 0.12,
} as const

const INTEREST_TYPES = new Set<InterestType>(['entity', 'location', 'topic', 'category', 'concept', 'other'])

export function emptyProfile(): ProfileV2 {
  return { version: 2, preferences: {}, interests: [], recentEvents: [], suppressedInterests: [], dismissedQuestions: [] }
}

export function normalizeInterest(raw: SemanticInterest): SemanticInterest & { key: string } | undefined {
  if (!raw || !INTEREST_TYPES.has(raw.type) || typeof raw.name !== 'string') return undefined
  const name = raw.name.trim().replace(/\s+/g, ' ')
  if (name.length < 2 || name.length > 60 || /[\r\n<>\[\]{}]/u.test(name)) return undefined
  return { type: raw.type, name, key: `${raw.type}:${name.normalize('NFKC').toLocaleLowerCase('zh-CN')}` }
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\r\n]/.test(value)
}

function preferenceOf(value: unknown): UserPreferences {
  if (!value || typeof value !== 'object') return {}
  const style = (value as UserPreferences).answerStyle
  return style === 'concise' || style === 'detailed' ? { answerStyle: style } : {}
}

function validatedInterest(value: unknown): Interest | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<Interest>
  const normalized = normalizeInterest({ name: item.name as string, type: item.type as InterestType })
  if (!normalized || item.key !== normalized.key || !validDate(item.firstSeenAt) || !validDate(item.lastSeenAt)) return undefined
  const counts = [item.eventCount, item.directCount, item.recommendationClickCount, item.sessionCount]
  if (counts.some(count => !Number.isSafeInteger(count) || Number(count) < 0)) return undefined
  const sessions = Array.isArray(item.sessionIds) ? [...new Set(item.sessionIds.filter(validSessionId))].slice(-PROFILE_CONFIG.maxSessionsPerInterest) : []
  return { ...normalized, eventCount: item.eventCount!, directCount: item.directCount!, recommendationClickCount: item.recommendationClickCount!,
    sessionCount: Math.min(item.sessionCount!, PROFILE_CONFIG.maxSessionsPerInterest), sessionIds: sessions,
    firstSeenAt: item.firstSeenAt!, lastSeenAt: item.lastSeenAt! }
}

export function validateProfile(value: unknown): ProfileV2 {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 2) return emptyProfile()
  const source = value as Partial<ProfileV2>
  const interests = Array.isArray(source.interests) ? source.interests.map(validatedInterest).filter((item): item is Interest => Boolean(item)) : []
  const recentEvents = Array.isArray(source.recentEvents) ? source.recentEvents.filter((item): item is RecentEvent =>
    item && validSessionId(item.id) && validSessionId(item.sessionId) && typeof item.query === 'string'
    && item.query.length <= 500 && (item.source === 'user_input' || item.source === 'recommendation_click') && validDate(item.at),
  ) : []
  const suppressedInterests = Array.isArray(source.suppressedInterests) ? source.suppressedInterests.filter((item): item is SuppressedInterest =>
    item && typeof item.key === 'string' && item.key.length <= 100 && typeof item.name === 'string' && item.name.length <= 60
    && validDate(item.at) && (!item.until || validDate(item.until)),
  ) : []
  const dismissedQuestions = Array.isArray(source.dismissedQuestions) ? source.dismissedQuestions.filter((item): item is string =>
    typeof item === 'string' && item.trim().length >= 6 && item.length <= 120 && !/[\u0000-\u001f]/u.test(item),
  ).slice(-PROFILE_CONFIG.maxDismissedQuestions) : []
  return { version: 2, preferences: preferenceOf(source.preferences), interests: interests.slice(0, PROFILE_CONFIG.maxInterests),
    recentEvents: recentEvents.slice(-PROFILE_CONFIG.maxEvents), suppressedInterests: suppressedInterests.slice(-PROFILE_CONFIG.maxSuppressed), dismissedQuestions }
}

export function migrateProfile(value: unknown): ProfileV2 {
  if (value && typeof value === 'object' && (value as { version?: unknown }).version === 2) return validateProfile(value)
  const profile = emptyProfile()
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) return profile
  const old = value as { answerStyle?: unknown }
  profile.preferences = preferenceOf({ answerStyle: old.answerStyle })
  return profile
}

export function scoreInterest(interest: Interest, now = new Date()): number {
  const days = Math.max(0, (now.getTime() - Date.parse(interest.lastSeenAt)) / 86_400_000)
  const legacy = Math.max(0, interest.eventCount - interest.directCount - interest.recommendationClickCount)
  // Click-only sessions must not turn recommendation feedback into cross-session evidence.
  const crossSessions = Math.min(Math.max(0, interest.sessionCount - 1), Math.max(0, interest.directCount + legacy - 1))
  const base = Math.min(interest.directCount, PROFILE_CONFIG.maxDirectContribution) * PROFILE_CONFIG.directWeight
    + Math.min(interest.recommendationClickCount, PROFILE_CONFIG.maxClickContribution) * PROFILE_CONFIG.clickWeight
    + crossSessions * PROFILE_CONFIG.crossSessionWeight
    + legacy * PROFILE_CONFIG.migratedWeight
  return base * Math.exp(-Math.LN2 * days / PROFILE_CONFIG.halfLifeDays)
}

export function isLongTermInterest(interest: Interest): boolean {
  const legacy = Math.max(0, interest.eventCount - interest.directCount - interest.recommendationClickCount)
  return interest.sessionCount >= 2 && (interest.directCount >= 2 || legacy >= 2)
}

export function mergeInterest(profile: ProfileV2, semantic: SemanticInterest, evidence: { sessionId: string; source: EventSource | 'legacy'; at: string }): void {
  const normalized = normalizeInterest(semantic)
  if (!normalized || !validSessionId(evidence.sessionId) || !validDate(evidence.at)) return
  let interest = profile.interests.find(item => item.key === normalized.key)
  if (!interest) {
    interest = { ...normalized, eventCount: 0, directCount: 0, recommendationClickCount: 0,
      sessionCount: 0, sessionIds: [], firstSeenAt: evidence.at, lastSeenAt: evidence.at }
    profile.interests.push(interest)
  }
  interest.eventCount++
  if (evidence.source === 'user_input') interest.directCount++
  if (evidence.source === 'recommendation_click') interest.recommendationClickCount++
  if (!interest.sessionIds.includes(evidence.sessionId)) {
    interest.sessionIds.push(evidence.sessionId)
    interest.sessionIds = interest.sessionIds.slice(-PROFILE_CONFIG.maxSessionsPerInterest)
    interest.sessionCount = Math.min(interest.sessionCount + 1, PROFILE_CONFIG.maxSessionsPerInterest)
  }
  if (Date.parse(evidence.at) < Date.parse(interest.firstSeenAt)) interest.firstSeenAt = evidence.at
  if (Date.parse(evidence.at) > Date.parse(interest.lastSeenAt)) interest.lastSeenAt = evidence.at
}

export function pruneProfile(profile: ProfileV2, now = new Date()): void {
  profile.recentEvents = profile.recentEvents.slice(-PROFILE_CONFIG.maxEvents)
  profile.interests = profile.interests.filter(interest => {
    const days = (now.getTime() - Date.parse(interest.lastSeenAt)) / 86_400_000
    return days < PROFILE_CONFIG.pruneAfterDays || scoreInterest(interest, now) >= PROFILE_CONFIG.pruneBelowScore
  }).sort((a, b) => scoreInterest(b, now) - scoreInterest(a, now)).slice(0, PROFILE_CONFIG.maxInterests)
  profile.suppressedInterests = profile.suppressedInterests.slice(-PROFILE_CONFIG.maxSuppressed)
}

export function addEvent(profile: ProfileV2, event: RecentEvent): boolean {
  if (profile.recentEvents.some(item => item.id === event.id)) return false
  profile.recentEvents.push({ ...event, query: event.query.slice(0, 500) })
  profile.recentEvents = profile.recentEvents.slice(-PROFILE_CONFIG.maxEvents)
  if (/回答简短|简短回答|简洁回答/.test(event.query)) profile.preferences.answerStyle = 'concise'
  if (/详细回答|详细说明|展开分析/.test(event.query)) profile.preferences.answerStyle = 'detailed'
  return true
}

export function isSuppressed(profile: ProfileV2, key: string, now = new Date()): boolean {
  return profile.suppressedInterests.some(item => item.key === key && (!item.until || Date.parse(item.until) > now.getTime()))
}

/**
 * 画像持久化层：实例内按工作区串行写入，统一守护行为、兴趣、负反馈及迁移提交。
 * 不跨实例共享队列；旧实例由所属 fiber 屏障停止发布，不提供跨进程锁。
 */
export class ProfileStore {
  private writes = new Map<string, Promise<unknown>>()
  private closed = false

  /**
   * 创建实例级存储屏障；独立存储默认可用，服务提供所属 fiber 有效性判断。
   * @param available 每次发布前同步检查的实例有效性函数，不执行异步操作。
   */
  constructor(private readonly available: () => boolean = () => true) {}

  /**
   * 拒绝撤销实例或已关闭会话的写入，不改变既有画像文件。
   * @param allowed 本次操作的会话写入条件。
   * @throws recommendations_unavailable 或 session not found。
   */
  private assertWritable(allowed: () => boolean): void {
    if (this.closed || !this.available()) throw new Error('recommendations_unavailable')
    if (!allowed()) throw new Error('session not found')
  }

  /**
   * 立即封口并等待已安排的磁盘准备工作收尾；不等待外部模型。
   * @returns 所有队列已停止且临时文件清理完成的 Promise。
   */
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.writes.values()])
  }

  /**
   * 异步准备临时文件，不发布画像；独立方法便于确定性验证撤销窗口。
   * @param temporary 当前操作独占的临时文件路径。
   * @param data 序列化画像。
   * @returns 临时文件写入完成的 Promise；I/O 失败向调用方传播。
   */
  protected async writeTemporary(temporary: string, data: string): Promise<void> {
    await writeFile(temporary, data, 'utf8')
  }

  private path(workspace: string): string { return join(workspace, '.dsh-recommendation', 'profile.json') }

  async load(workspace: string): Promise<ProfileV2> {
    try {
      const raw = JSON.parse(await readFile(this.path(workspace), 'utf8')) as unknown
      if (raw && typeof raw === 'object' && (raw as { version?: unknown }).version === 1) {
        const migrated = migrateProfile(raw)
        await this.update(workspace, () => migrated)
        return migrated
      }
      return validateProfile(raw)
    } catch { return emptyProfile() }
  }

  /**
   * 按工作区串行更新；最终检查与原子重命名之间不让出事件循环，关闭撤销竞争窗口。
   * @param workspace 用户工作区。
   * @param mutate 原有画像变更函数。
   * @param allowed 会话级提交屏障，删除开始后禁止普通任务提交。
   * @returns 变更函数结果；封口或磁盘错误会拒绝并清理临时文件。
   */
  async update<T>(workspace: string, mutate: (profile: ProfileV2) => Promise<T> | T, allowed: () => boolean = () => true): Promise<T> {
    this.assertWritable(allowed)
    const previous = this.writes.get(workspace) || Promise.resolve()
    const next = previous.catch(() => undefined).then(/** 排队工作开始时检查封口，准备文件后再次进入最终发布屏障。 */
    async () => {
      this.assertWritable(allowed)
      let profile: ProfileV2
      try { profile = migrateProfile(JSON.parse(await readFile(this.path(workspace), 'utf8'))) }
      catch { profile = emptyProfile() }
      const result = await mutate(profile)
      this.assertWritable(allowed)
      const target = this.path(workspace)
      await mkdir(dirname(target), { recursive: true })
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        await this.writeTemporary(temporary, JSON.stringify(profile, null, 2))
        // 必须在同一同步调用栈检查并发布；异步 rename 会重新打开卸载/删除窗口。
        this.assertWritable(allowed)
        renameSync(temporary, target)
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
      return result
    })
    this.writes.set(workspace, next)
    try { return await next } finally { if (this.writes.get(workspace) === next) this.writes.delete(workspace) }
  }
}
