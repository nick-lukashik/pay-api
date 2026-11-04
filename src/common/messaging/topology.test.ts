import { describe, expect, it } from 'vitest'
import { defineQueue, queueDeclarations } from './topology.js'

describe('queueDeclarations', () => {
    const spec = defineQueue(
        'svc.work',
        [
            {
                producer: 'notes',
                types: [
                    'notes.note.created.v1',
                ],
            },
        ],
        {
            retryDelaysMs: [
                1_000,
                5_000,
            ],
        },
    )

    it('declares the DLQ, the main queue and one retry queue per delay, all quorum', () => {
        const declarations = queueDeclarations(spec)
        expect(declarations.map(d => d.name)).toEqual([
            'svc.work.dlq',
            'svc.work',
            'svc.work.retry.0',
            'svc.work.retry.1',
        ])
        expect(declarations.every(d => d.arguments['x-queue-type'] === 'quorum')).toBe(true)
    })

    it('dead-letters at least once: the strategy needs reject-publish and a dead-letter exchange', () => {
        const [, main, retry] = queueDeclarations(spec)
        expect(main?.arguments).toMatchObject({
            'x-dead-letter-strategy': 'at-least-once',
            'x-overflow': 'reject-publish',
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': 'svc.work.dlq',
        })
        expect(retry?.arguments).toMatchObject({
            'x-dead-letter-strategy': 'at-least-once',
            'x-overflow': 'reject-publish',
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': 'svc.work',
            'x-message-ttl': 1_000,
        })
    })
})
