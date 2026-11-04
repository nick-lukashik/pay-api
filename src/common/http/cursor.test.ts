import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AppError } from './app-error.js'
import { cursorCodec } from './cursor.js'

const codec = cursorCodec(
    z.object({
        createdAt: z.iso.datetime(),
        id: z.uuid(),
    }),
)
const position = {
    createdAt: '2026-11-02T10:00:00.123Z',
    id: '01a19d24-c0ea-7f4b-baae-cb578982b95b',
}

describe('cursorCodec', () => {
    it('round-trips a position through an opaque url-safe string', () => {
        const cursor = codec.encode(position)
        expect(cursor).toMatch(/^[\w-]+$/)
        expect(codec.decode(cursor)).toEqual(position)
    })

    it.each([
        'not-base64-json',
        Buffer.from('{"id":"x"}').toString('base64url'),
        '',
    ])('rejects a forged cursor %j with VALIDATION_FAILED', cursor => {
        expect(() => codec.decode(cursor)).toThrow(AppError)
        try {
            codec.decode(cursor)
        } catch (error) {
            expect(error).toMatchObject({
                code: 'VALIDATION_FAILED',
                details: [
                    {
                        path: 'cursor',
                        message: 'Invalid cursor',
                    },
                ],
            })
        }
    })
})
