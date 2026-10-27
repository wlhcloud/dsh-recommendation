# dsh-recommendation

A privacy-aware personalized question recommendation service for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and Cordis.

It records bounded recent behavior, extracts semantic interests with an OpenAI-compatible model, and generates home-page suggestions or follow-up questions. It does **not** answer the user's question, call business tools, expose HTTP routes, or depend on a particular MCP server.

## Features

- Home recommendations and turn-aware follow-up questions.
- Separate evidence for direct user input and recommendation clicks.
- Recent and long-term interests with decay and cross-session thresholds.
- Question-level dismissal and semantic-interest suppression.
- Per-workspace JSON persistence with atomic publication.
- Session deletion coordination through `forgetSessions()`.
- Safe Cordis unload: queued tasks stop, in-flight model requests are aborted, and late results cannot write profiles or caches.
- OpenAI-compatible endpoint support, including optional bearer authentication.
- Generic `entity`, `location`, `topic`, `category`, `concept`, and `other` interest types.

## Requirements

- Node.js 22 or newer.
- `@deepseek-ai/cordis` 4.x.
- An OpenAI-compatible `/v1/chat/completions` endpoint for generated recommendations. The service degrades to configured fallback questions when the model is unavailable.

## Install

```bash
npm install dsh-recommendation @deepseek-ai/cordis
```

Until an npm release is published, install from GitHub:

```bash
npm install github:wlhcloud/dsh-recommendation
```

## Cordis registration

```ts
import { Context } from '@deepseek-ai/cordis'
import RecommendationService from 'dsh-recommendation'

const ctx = new Context()

await ctx.plugin(RecommendationService, {
  baseUrl: 'http://127.0.0.1:11434/v1',
  recommendModel: 'qwen3:4b',
  interestModel: 'qwen3:4b',
  language: 'zh-CN',
}).await()

const recommendations = ctx.get('recommendations')
```

The host application supplies an authenticated user's isolated workspace path. The plugin never derives authorization from that path.

```ts
await recommendations.record(
  '/srv/app/workspaces/user-42',
  'session-7',
  'request-19',
  'How does optimistic locking work?',
  'user_input',
)

const home = await recommendations.home('/srv/app/workspaces/user-42')

const followUp = await recommendations.followUps(
  '/srv/app/workspaces/user-42',
  'session-7',
  3,
  'How does optimistic locking work?',
  'It detects concurrent writes by comparing a version field.',
)
```

`record()` waits for the recent-event publication and queues semantic extraction, but it does not wait for the model extraction to finish. Use `waitForExtraction(workspace)` only when a maintenance or test flow must wait for the queue.

## Configuration

Constructor options take precedence over environment variables.

| Option | Environment variable | Default |
| --- | --- | --- |
| `baseUrl` | `DSH_RECOMMENDATION_OPENAI_BASE_URL` | `http://127.0.0.1:11434/v1` |
| `apiKey` | `DSH_RECOMMENDATION_OPENAI_API_KEY` | unset |
| `recommendModel` | `DSH_RECOMMENDATION_MODEL` | `qwen3:4b` |
| `interestModel` | `DSH_RECOMMENDATION_INTEREST_MODEL` | recommendation model |
| `language` | `DSH_RECOMMENDATION_LANGUAGE` | `zh-CN` |
| `homeFallback` | `DSH_RECOMMENDATION_HOME_FALLBACK` | four generic questions |
| `interestPrompt` | constructor only | built-in generic prompt |
| `recommendationPrompt` | constructor only | built-in generic prompt |

`DSH_RECOMMENDATION_HOME_FALLBACK` is a pipe-separated list. Custom prompts must preserve the documented JSON output shapes; malformed model output falls back safely.

## Service API

| Method | Purpose |
| --- | --- |
| `record(workspace, sessionId, requestId, query, source?)` | Store a recent event and queue interest extraction |
| `home(workspace)` | Generate up to four home questions |
| `followUps(workspace, sessionId, turn, question, answer)` | Generate up to three questions related to a completed turn |
| `dismissQuestion(workspace, question)` | Persistently exclude a question and near duplicates |
| `suppress(workspace, interest, until?)` | Suppress a semantic interest |
| `waitForExtraction(workspace)` | Wait for the current workspace extraction chain |
| `forgetSessions(workspace, sessionIds)` | Close sessions, wait for related work, and remove their evidence |

The plugin provides the Cordis service name `recommendations`. HTTP routes, authentication, workspace ownership, UI rendering, and user consent belong to the host application.

## Data and privacy

Profiles are stored at:

```text
<workspace>/.dsh-recommendation/profile.json
```

The profile contains bounded recent questions, derived interests, preferences, suppressions, and dismissed questions. It must not be treated as identity, authorization, or verified fact.

The configured model receives a bounded form of the current question and answer, session context, and selected interests. Operators should document this processing, protect workspace permissions, provide deletion controls, and avoid sending sensitive content to an endpoint without an appropriate data agreement.

No telemetry is included.

## Host integration guidance

- Authenticate first, then resolve a workspace owned by that user.
- Keep recommendation failure separate from primary chat failure.
- Preserve the `await record(...)` call: it guarantees the recent event has been published before returning.
- Call `forgetSessions()` from the host's session deletion workflow.
- Acquire the Cordis service dynamically if the host supports hot registration or withdrawal.
- Do not run multiple writer processes against the same profile directory; the current atomicity boundary is process-local plus filesystem rename.

See [LIFECYCLE.md](LIFECYCLE.md) for cancellation, unload, and publication guarantees.

## Development

```bash
npm install
npm run check
```

Tests use temporary directories and mocked model responses. They do not require a running model and do not write production profiles.

## License

[MIT](LICENSE)
