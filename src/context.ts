import { createHash } from 'node:crypto'
import { isLongTermInterest, isSuppressed, PROFILE_CONFIG, scoreInterest, type ProfileV2, type SemanticInterest } from './profile.js'

export type SessionContext = { recentQueries: string[]; activeEntities: SemanticInterest[]; activeTopics: string[] }
export type RecommendationContext = {
  current?: { question: string; answer: string; activeEntities: SemanticInterest[]; activeTopics: string[] }
  session: SessionContext
  recentInterests: SemanticInterest[]
  longTermInterests: SemanticInterest[]
  preferences: ProfileV2['preferences']
  dismissedQuestions: string[]
}

export function emptySessionContext(): SessionContext { return { recentQueries: [], activeEntities: [], activeTopics: [] } }

export function addSessionEvent(context: SessionContext, query: string, extracted: SemanticInterest[]): void {
  if (query.trim()) context.recentQueries = [...context.recentQueries, query.slice(0, 300)].slice(-6)
  for (const item of extracted) {
    if (item.type === 'entity' || item.type === 'location') {
      context.activeEntities = [...context.activeEntities.filter(old => item.type === 'location' ? old.type !== 'location' : old.type !== item.type || old.name !== item.name), item].slice(-8)
    } else if (!context.activeTopics.includes(item.name)) context.activeTopics = [...context.activeTopics, item.name].slice(-8)
  }
}

export function buildRecommendationContext(profile: ProfileV2, session: SessionContext, current?: { question: string; answer: string }): RecommendationContext {
  const now = new Date()
  const available = profile.interests.filter(item => !isSuppressed(profile, item.key, now))
    .sort((a, b) => scoreInterest(b, now) - scoreInterest(a, now))
  const currentLocations = new Set(session.activeEntities.filter(item => item.type === 'location').map(item => item.name))
  const historical = available.filter(item => item.type !== 'location' || currentLocations.size === 0 || currentLocations.has(item.name))
  const recentInterests = historical.filter(item => !isLongTermInterest(item)
    && now.getTime() - Date.parse(item.lastSeenAt) <= 14 * 86_400_000).slice(0, 5)
  const longTermInterests = historical.filter(isLongTermInterest).slice(0, 5)
  return {
    ...(current ? { current: { question: current.question.slice(0, 500), answer: current.answer.slice(0, 2500),
      activeEntities: session.activeEntities.slice(-5), activeTopics: session.activeTopics.slice(-5) } } : {}),
    session: { recentQueries: session.recentQueries.slice(-5), activeEntities: session.activeEntities.slice(-5), activeTopics: session.activeTopics.slice(-5) },
    recentInterests: recentInterests.map(({ name, type }) => ({ name, type })),
    longTermInterests: longTermInterests.map(({ name, type }) => ({ name, type })),
    preferences: profile.preferences,
    dismissedQuestions: profile.dismissedQuestions.slice(-PROFILE_CONFIG.maxDismissedQuestions),
  }
}

export function contextHash(context: RecommendationContext): string {
  return createHash('sha256').update(JSON.stringify(context)).digest('hex')
}
