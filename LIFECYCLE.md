# Lifecycle and concurrency guarantees

## State model

Each Cordis registration owns one `RecommendationService`, one `ProfileStore`, one abort controller, and in-memory session/cache state.

The instance moves in one direction:

```text
ACTIVE → CLOSING → DISPOSED
```

Cordis disposal synchronously closes new work, aborts model requests, clears in-memory recommendations, and then waits for registered extraction and storage tasks to settle. A restarted plugin receives a fresh instance; references to the old instance remain closed.

## `record()` ordering

`record()` performs these steps:

1. Validate that the instance and session are active.
2. Atomically publish the bounded recent event.
3. Update the in-memory session context and invalidate cached recommendations.
4. Append semantic extraction to the workspace's ordered extraction chain.
5. Return without waiting for model extraction.

This means callers may rely on the recent event being durable when `record()` resolves, while interest enrichment remains asynchronous.

## Profile publication

Writes are serialized per workspace. Each update:

1. Reads and validates the existing profile.
2. Applies a bounded mutation in memory.
3. Writes an operation-specific temporary file in the target directory.
4. Rechecks the instance and optional session barrier.
5. Publishes with a synchronous same-directory rename.
6. Cleans up the temporary file on success or failure.

The final validity check and rename occur in the same JavaScript call stack with no `await` between them. This closes the race where unload or session deletion begins after a check but before publication.

Atomic rename does not provide a cross-process writer lock. Do not run multiple independent writer processes against the same workspace profile.

## Queued and in-flight model work

- A queued extraction rechecks instance/session state before starting.
- An in-flight HTTP request receives the instance abort signal.
- A model implementation that ignores cancellation may finish remotely, but its late result cannot update profiles, session context, or caches.
- Late promise success and failure both have handlers; disposal does not leave unhandled rejections.
- Recommendation results are cached only after a final instance/session check.

## Session deletion

`forgetSessions(workspace, ids)` closes the listed sessions first, waits for the workspace extraction chain, then removes matching recent events and interest evidence through the same publication barrier.

The operation is idempotent. If plugin disposal races with cleanup, the old instance rejects an incomplete publication instead of reporting false success. A replacement instance may safely retry deletion.

The host remains responsible for persisting deletion jobs or retries across complete service outages.

## Known limits

- Aborting `fetch` cannot prove that a remote model stopped computation.
- Filesystem rename guarantees depend on the target filesystem.
- A permanently blocked operating-system I/O call cannot be forcibly interrupted by this plugin.
- Process-local serialization does not coordinate separate Node.js processes.
- The host owns authentication, workspace ownership, and session authorization.

The concurrency tests use controllable Promise barriers at the temporary-write/final-rename boundary instead of relying on timing sleeps.
