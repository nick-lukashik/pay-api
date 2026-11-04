import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { requestIdOf } from './request-id.js'

const fakeRequest = (header?: string) =>
    ({
        headers: header
            ? {
                  'x-request-id': header,
              }
            : {},
    }) as IncomingMessage

const fakeResponse = () => {
    const headers = new Map<string, unknown>()
    const res = {
        setHeader: (name: string, value: unknown) => headers.set(name, value),
    } as unknown as ServerResponse
    return {
        res,
        headers,
    }
}

describe('requestIdOf', () => {
    it('keeps a well-formed incoming id and echoes it', () => {
        const { res, headers } = fakeResponse()
        expect(requestIdOf(fakeRequest('web-1234abcd'), res)).toBe('web-1234abcd')
        expect(headers.get('x-request-id')).toBe('web-1234abcd')
    })

    it.each([
        'short',
        'has spaces in it',
        'x'.repeat(200),
        '<script>alert(1)',
    ])('replaces a malformed id %j with a UUID', header => {
        const { res } = fakeResponse()
        expect(requestIdOf(fakeRequest(header), res)).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('assigns the id once per request', () => {
        const req = fakeRequest()
        const { res } = fakeResponse()
        expect(requestIdOf(req, res)).toBe(requestIdOf(req, res))
    })
})
