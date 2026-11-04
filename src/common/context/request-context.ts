import { AsyncLocalStorage } from 'node:async_hooks'

/** What the current work belongs to: an HTTP request or a consumed event. */
export type RequestContext = {
    /** The whole chain: the request id, or the id of the first event. */
    correlationId: string
    /** The direct cause of what is written now: the request or the consumed event. */
    causationId: string
}

const storage = new AsyncLocalStorage<RequestContext>()
// Captured at import time, outside of any request or event.
const detached = AsyncLocalStorage.snapshot()

/** Runs `fn` and everything it awaits as part of `context`. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
    return storage.run(context, fn)
}

export function currentContext(): RequestContext | undefined {
    return storage.getStore()
}

/**
 * Runs `fn` outside of any request. Background loops kicked from a request
 * (outbox relay) schedule their timers through it, otherwise every later pass
 * would inherit that request's ids in logs and events.
 */
export function runDetached<T>(fn: () => T): T {
    return detached(fn)
}
