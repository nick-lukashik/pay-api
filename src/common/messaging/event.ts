import { randomUUIDv7 } from 'node:crypto'
import { z } from 'zod'

const EVENT_TYPE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+\.v\d+$/

/**
 * The envelope of every event on the bus. The version is part of the type
 * (`notes.note.created.v1`): a breaking change is a new event type.
 */
export const envelopeSchema = z.object({
    /** uuidv7; consumers deduplicate by it (inbox). */
    eventId: z.uuid(),
    type: z.string().regex(EVENT_TYPE),
    producer: z.string().min(1).max(64),
    occurredAt: z.iso.datetime(),
    aggregateId: z.string().min(1).max(128),
    /** The whole chain: request id, or the id of the first event. */
    correlationId: z.string().min(1).max(128).optional(),
    /** The direct cause: the request or the event being handled. */
    causationId: z.string().min(1).max(128).optional(),
    payload: z.unknown(),
})
export type Envelope = z.infer<typeof envelopeSchema>

/** Declares a versioned event with its payload schema and owner. */
export function defineEvent<Type extends string, Payload extends z.ZodType>(
    type: Type,
    producer: string,
    payload: Payload,
) {
    if (!EVENT_TYPE.test(type)) {
        throw new Error(`Event type must look like <domain>.<entity>.<event>.vN: ${type}`)
    }
    const schema = envelopeSchema.extend({
        type: z.literal(type),
        payload,
    })
    type Event = z.output<typeof schema>
    return {
        type,
        producer,
        schema,
        /** A complete envelope; correlation ids are filled in by `enqueueEvent`. */
        create(input: { aggregateId: string; payload: z.input<Payload>; occurredAt?: Date }): Event {
            return schema.parse({
                eventId: randomUUIDv7(),
                type,
                producer,
                occurredAt: (input.occurredAt ?? new Date()).toISOString(),
                aggregateId: input.aggregateId,
                payload: input.payload,
            })
        },
        /** The typed event from an envelope that matched this type. */
        parse(envelope: Envelope): Event {
            return schema.parse(envelope)
        },
    }
}
