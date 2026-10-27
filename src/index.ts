/** 推荐辅助服务：保留原请求语义，由所属 Cordis fiber 管理取消、封口和画像提交。 */
import { Context, Service } from '@deepseek-ai/cordis'
import { addSessionEvent, buildRecommendationContext, contextHash, emptySessionContext, type SessionContext } from './context.js'
import { InterestExtractor, RecommendationGenerator, recommendationModelConfig, type RecommendationModelConfig, type Recommendations } from './model.js'
import { addEvent, isSuppressed, mergeInterest, normalizeInterest, PROFILE_CONFIG, ProfileStore, pruneProfile,
  type EventSource, type RecentEvent, type SemanticInterest, type SuppressedInterest } from './profile.js'

declare module '@deepseek-ai/cordis' {
  interface Context { recommendations: RecommendationService }
}

export * from './profile.js'
export * from './context.js'
export { InterestExtractor, RecommendationGenerator, validQuestions } from './model.js'
export type { Recommendations } from './model.js'
export type { RecommendationModelConfig } from './model.js'

export interface RecommendationConfig extends Partial<RecommendationModelConfig> {}

/**
 * 推荐层服务，不参与业务回答；撤销时停止新任务、取消模型并排空画像存储。
 * 有效性绑定注册时的提供方 fiber，不能使用被 Cordis 代理切换后的调用方 ctx。
 */
export class RecommendationService extends Service {
  private closed = new Set<string>()
  readonly store: ProfileStore
  readonly extractor: InterestExtractor
  readonly generator: RecommendationGenerator
  private sessions = new Map<string, SessionContext>()
  private extractionJobs = new Map<string, Promise<void>>()
  private cache = new Map<string, { expires: number; result: Recommendations }>()
  private readonly cancellation = new AbortController()
  private closing = false
  private shutdownTask?: Promise<void>
  /** 同步查询原提供方状态，作为队列及最终磁盘提交的有效性屏障。 */
  private readonly available: () => boolean

  /**
   * 注册服务及 Cordis 收尾 effect；不依赖服务表注销与清理回调的执行顺序。
   * @param ctx 注册时提供方上下文。
   */
  constructor(ctx: Context, config: RecommendationConfig = {}) {
    super(ctx, 'recommendations')
    const modelConfig = recommendationModelConfig(config)
    this.extractor = new InterestExtractor(modelConfig)
    this.generator = new RecommendationGenerator(modelConfig)
    this.available = () => !this.closing && ctx.fiber.uid !== null && ctx.fiber.state === 2
    this.store = new ProfileStore(this.available)
    ctx.effect(
      /** 注册卸载资源，返回可等待的实例收尾函数。 */
      () => /** 撤销时同步封口并等待磁盘准备工作退出。 */
      () => this.shutdown(), 'dsh-recommendation lifecycle')
  }

  /**
   * 检查已撤销实例，避免旧引用发起请求或更新缓存。
   * @throws recommendations_unavailable。
   */
  private assertAvailable(): void {
    if (!this.available()) throw new Error('recommendations_unavailable')
  }

  /**
   * 等待可取消的外部任务，同时处理取消后迟到的成功/失败，避免悬挂队列或未处理拒绝。
   * @param work 只在实例有效时启动的模型操作。
   * @returns 原结果；撤销时立即拒绝，底层 HTTP 同时收到 AbortSignal。
   */
  private abortable<T>(work: () => Promise<T>): Promise<T> {
    this.assertAvailable()
    const signal = this.cancellation.signal
    return new Promise<T>(/** 建立实例取消与模型结果的单次竞争，并为迟到拒绝保留处理器。 */
    (resolve, reject) => {
      /** 撤销时释放上层等待，不允许迟到模型结果进入画像更新。 */
      const abort = () => reject(new Error('recommendations_unavailable'))
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve().then(/** 启动外部请求前复查，防止已排队微任务在撤销后发起模型调用。 */
      () => { this.assertAvailable(); return work() }).then(
        value => { signal.removeEventListener('abort', abort); resolve(value) },
        error => { signal.removeEventListener('abort', abort); reject(error) },
      )
    })
  }

  /**
   * 同步关闭入口、模型及内存更新，再等待已登记磁盘任务退出；多次调用共享收尾 Promise。
   * @returns 收尾完成的 Promise，不等待忽略取消的外部模型实现。
   */
  private shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask
    this.closing = true
    this.cancellation.abort()
    this.cache.clear()
    this.sessions.clear()
    this.shutdownTask = Promise.allSettled([this.store.close(), ...this.extractionJobs.values()]).then(() => undefined)
    return this.shutdownTask
  }

  /**
   * 等待近期事件写入后按工作区排队提取；返回仍不等待后台画像提取。
   * @param workspace 用户工作区。
   * @param sessionId 当前会话。
   * @param requestId 幂等事件标识。
   * @param query 用户问题。
   * @param source 原始输入或推荐点击。
   * @returns 事件写入及提取排队完成；撤销后的新任务直接跳过。
   */
  async record(workspace: string, sessionId: string, requestId: string, query: string, source: EventSource = 'user_input'): Promise<void> {
    if (!this.active(sessionId)) return
    if (!query.trim()) return
    const event: RecentEvent = { id: `${sessionId}:${requestId}`, sessionId, query: query.trim().slice(0, 500), source,
      at: new Date().toISOString() }
    const added = await this.store.update(workspace, profile => this.active(sessionId) ? addEvent(profile, event) : false, () => this.active(sessionId))
    if (!added || !this.active(sessionId)) return
    const session = this.sessionOf(workspace, sessionId)
    addSessionEvent(session, event.query, [])
    this.invalidate(workspace)
    const previous = this.extractionJobs.get(workspace) || Promise.resolve()
    const job = previous.catch(() => undefined).then(/** 轮到当前工作区任务时再检查入口，模型返回后再次验证并提交。 */
    async () => {
      if (!this.active(sessionId)) return
      const extracted = await this.abortable(() => this.extractor.extract(event.query, this.cancellation.signal))
      if (!extracted.length || !this.active(sessionId)) return
      await this.store.update(workspace, profile => {
        if (!this.active(sessionId)) return
        for (const item of extracted) {
          const normalized = normalizeInterest(item)
          if (normalized && !isSuppressed(profile, normalized.key)) mergeInterest(profile, item, event)
        }
        pruneProfile(profile)
      }, () => this.active(sessionId))
      if (!this.active(sessionId)) return
      addSessionEvent(session, '', extracted)
      this.invalidate(workspace)
    }).catch(error => { if (this.available() && this.active(sessionId)) console.warn('dsh-recommendation: profile enrichment failed', error instanceof Error ? error.name : 'unknown') })
    this.extractionJobs.set(workspace, job)
    void job.finally(() => { if (this.extractionJobs.get(workspace) === job) this.extractionJobs.delete(workspace) })
  }

  /**
   * 等待当前工作区已排队提取链收尾；已取消任务也会正常结束。
   * @param workspace 用户工作区。
   * @returns 当前提取链的完成 Promise。
   */
  async waitForExtraction(workspace: string): Promise<void> { await this.extractionJobs.get(workspace) }

  /**
   * 使用原画像构造首页推荐；撤销后的旧实例拒绝调用。
   * @param workspace 用户工作区。
   * @returns 原首页推荐结构，撤销时拒绝而非伪装为空推荐。
   */
  async home(workspace: string): Promise<Recommendations> {
    this.assertAvailable()
    const profile = await this.store.load(workspace)
    return this.recommend(workspace, 'home', buildRecommendationContext(profile, emptySessionContext()))
  }

  /**
   * 使用原轮次参数生成追问，保留会话关闭检查及上下文构建顺序。
   * @param workspace 用户工作区。
   * @param sessionId 当前会话。
   * @param turn 已完成轮次。
   * @param question 本轮用户问题。
   * @param answer 本轮正式回答。
   * @returns 原追问结构；撤销或会话关闭时拒绝。
   */
  async followUps(workspace: string, sessionId: string, turn: number, question: string, answer: string): Promise<Recommendations> {
    this.assertAvailable()
    if (!this.active(sessionId)) throw new Error('session not found')
    const profile = await this.store.load(workspace)
    if (!this.active(sessionId)) throw new Error('session not found')
    const session = this.sessionOf(workspace, sessionId, profile.recentEvents.filter(event => event.sessionId === sessionId).map(event => event.query))
    const context = buildRecommendationContext(profile, session, { question, answer })
    return this.recommend(`${workspace}:${sessionId}:${turn}`, 'follow_up', context, () => this.active(sessionId))
  }

  /**
   * 按原规则持久化负反馈；撤销屏障由 ProfileStore 最终发布点执行。
   * @param workspace 用户工作区。
   * @param semantic 待屏蔽兴趣。
   * @param until 可选屏蔽到期时间。
   * @returns 持久化完成；实例撤销或 I/O 失败拒绝。
   */
  async suppress(workspace: string, semantic: SemanticInterest, until?: string): Promise<void> {
    this.assertAvailable()
    const normalized = normalizeInterest(semantic)
    if (!normalized) return
    const item: SuppressedInterest = { key: normalized.key, name: normalized.name, at: new Date().toISOString(),
      ...(until && Number.isFinite(Date.parse(until)) ? { until } : {}) }
    await this.store.update(workspace, profile => {
      profile.suppressedInterests = [...profile.suppressedInterests.filter(old => old.key !== item.key), item]
        .slice(-PROFILE_CONFIG.maxSuppressed)
    })
    if (this.available()) this.invalidate(workspace)
  }

  /**
   * 验证并持久化不赞问题，参数及正常去重规则不变。
   * @param workspace 用户工作区。
   * @param question 原始不赞问题。
   * @returns 持久化完成；参数、撤销或 I/O 失败拒绝。
   */
  async dismissQuestion(workspace: string, question: string): Promise<void> {
    this.assertAvailable()
    const value = question.trim().replace(/\s+/g, ' ')
    if (value.length < 6 || value.length > 120 || /[\u0000-\u001f]/u.test(value)) throw new Error('invalid recommendation question')
    await this.store.update(workspace, profile => {
      profile.dismissedQuestions = [...profile.dismissedQuestions.filter(old => old !== value), value]
        .slice(-PROFILE_CONFIG.maxDismissedQuestions)
    })
    if (this.available()) this.invalidate(workspace)
  }

  /**
   * 返回实例内会话缓存，只有有效实例可创建或更新该缓存。
   * @param workspace 用户工作区。
   * @param sessionId 会话标识。
   * @param recentQueries 首次建立上下文的近期问题。
   * @returns 实例内会话上下文；可能更新内存缓存。
   */
  private sessionOf(workspace: string, sessionId: string, recentQueries: string[] = []): SessionContext {
    this.assertAvailable()
    const key = `${workspace}:${sessionId}`
    let session = this.sessions.get(key)
    if (!session) {
      session = { ...emptySessionContext(), recentQueries: recentQueries.slice(-6) }
      this.sessions.set(key, session)
      if (this.sessions.size > 300) this.sessions.delete(this.sessions.keys().next().value!)
    }
    return session
  }

  /**
   * 沿用原推荐缓存及模型参数，撤销或删除时拒绝迟到缓存写入。
   * @param scope 原工作区或会话轮次缓存键。
   * @param kind 首页或追问。
   * @param context 原结构化推荐上下文。
   * @param allowed 会话级有效性检查，首页默认允许。
   * @returns 原推荐结果；实例撤销或会话关闭时拒绝。
   */
  private async recommend(scope: string, kind: 'home' | 'follow_up', context: ReturnType<typeof buildRecommendationContext>, allowed: () => boolean = () => true): Promise<Recommendations> {
    this.assertAvailable()
    if (!allowed()) throw new Error('session not found')
    const key = `${scope}:${kind}:${contextHash(context)}`
    const cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.result
    const result = await this.abortable(() => this.generator.generate(context, kind, this.cancellation.signal))
    this.assertAvailable()
    if (!allowed()) throw new Error('session not found')
    this.cache.set(key, { expires: Date.now() + 10 * 60_000, result })
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!)
    return result
  }

  /**
   * 删除工作区推荐缓存，不创建新缓存。
   * @param workspace 用户工作区。
   * @returns 无返回值，仅更新内存。
   */
  private invalidate(workspace: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${workspace}:`)) this.cache.delete(key)
  }
  /**
   * 同时检查实例、会话关闭标记及原有归属服务写屏障。
   * @param id 待检查会话。
   * @returns 当前实例可接受该会话写入时为 true。
   */
  private active(id: string): boolean { return this.available() && !this.closed.has(id) && ((this.ctx.get('sessionOwners') as any)?.isActive(id) ?? true) }
  /**
   * 先封闭会话，再等待已排队提取并清理画像；与撤销并发时拒绝未完成发布，由原调用方处理失败。
   * @param workspace 用户工作区。
   * @param ids 待删除主子会话标识。
   * @returns 清理完成；实例撤销或 I/O 失败拒绝，不静默报告已清理。
   */
  async forgetSessions(workspace: string, ids: string[]): Promise<void> {
    this.assertAvailable()
    for (const id of ids) this.closed.add(id)
    await this.waitForExtraction(workspace)
    const removed = new Set(ids)
    await this.store.update(workspace, profile => {
      profile.recentEvents = profile.recentEvents.filter(e => !removed.has(e.sessionId))
      for (const interest of profile.interests) {
        interest.sessionIds = interest.sessionIds.filter(id => !removed.has(id))
        interest.sessionCount = interest.sessionIds.length
      }
      profile.interests = profile.interests.filter(i => i.sessionIds.length)
    })
    if (!this.available()) return
    for (const id of ids) this.sessions.delete(`${workspace}:${id}`)
    this.invalidate(workspace)
  }
}

export default RecommendationService
