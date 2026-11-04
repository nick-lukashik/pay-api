import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineEvent, envelopeSchema } from './event.js'

const created = defineEvent(
    'demo.thing.created.v1',
    'demo',
    z.object({
        thingId: z.string(),
    }),
)

describe('defineEvent', () => {
    it('builds a complete envelope with a uuidv7 id', () => {
        const event = created.create({
            aggregateId: 't-1',
            payload: {
                thingId: 't-1',
            },
            occurredAt: new Date('2026-11-02T10:00:00.000Z'),
        })
        expect(event).toEqual({
            eventId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
            type: 'demo.thing.created.v1',
            producer: 'demo',
            occurredAt: '2026-11-02T10:00:00.000Z',
            aggregateId: 't-1',
            payload: {
                thingId: 't-1',
            },
        })
        expect(envelopeSchema.safeParse(event).success).toBe(true)
    })

    it('rejects a payload that does not match the schema', () => {
        expect(() =>
            created.create({
                aggregateId: 't-1',
                payload: {
                    thingId: 1,
                } as never,
            }),
        ).toThrow()
    })

    it('requires the version in the type', () => {
        expect(() => defineEvent('demo.thing.created', 'demo', z.object({}))).toThrow(/\.vN/)
    })
})
