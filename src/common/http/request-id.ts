import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { runWithContext } from '../context/request-context.js'

export const REQUEST_ID_HEADER = 'x-request-id'
const WELL_FORMED = /^[\w.:-]{8,128}$/

type WithId = IncomingMessage & {
    id?: string
}

/**
 * The request id: a well-formed incoming `x-request-id` (from a proxy or the
 * calling service) or a new UUID. Assigned once and echoed in the response.
 */
export function requestIdOf(req: IncomingMessage, res: ServerResponse): string {
    const request = req as WithId
    if (request.id) return request.id
    const incoming = req.headers[REQUEST_ID_HEADER]
    const id = typeof incoming === 'string' && WELL_FORMED.test(incoming) ? incoming : randomUUID()
    request.id = id
    res.setHeader(REQUEST_ID_HEADER, id)
    return id
}

/** Express middleware: the rest of the request runs with its id as correlation. */
export function requestContext(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const id = requestIdOf(req, res)
    runWithContext(
        {
            correlationId: id,
            causationId: id,
        },
        next,
    )
}
