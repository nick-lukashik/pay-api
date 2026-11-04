import { z } from 'zod'
import { AppError } from './app-error.js'

/**
 * Opaque keyset cursors: base64url JSON the client passes back unchanged.
 * The schema checks what comes back, so a forged cursor is a 400, not a 500.
 */
export function cursorCodec<S extends z.ZodType>(schema: S) {
    return {
        encode(value: z.input<S>): string {
            return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
        },
        decode(cursor: string): z.output<S> {
            let raw: unknown
            try {
                raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
            } catch {
                raw = undefined
            }
            const result = schema.safeParse(raw)
            if (!result.success) {
                throw new AppError('VALIDATION_FAILED', 'Request validation failed', [
                    {
                        path: 'cursor',
                        message: 'Invalid cursor',
                    },
                ])
            }
            return result.data
        },
    }
}
