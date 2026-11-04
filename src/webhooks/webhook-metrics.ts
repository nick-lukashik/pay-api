import { Injectable } from '@nestjs/common'
import { Metrics } from '../common/metrics/metrics.js'

const RESULTS = [
    'applied',
    'duplicate',
    'unmatched',
    'mismatch',
    'rejected',
] as const

/** What became of a provider webhook: the `result` label of payment_webhooks_total. */
export type WebhookResult = (typeof RESULTS)[number]

@Injectable()
export class WebhookMetrics {
    private readonly results

    constructor(metrics: Metrics) {
        this.results = metrics.counter({
            name: 'payment_webhooks_total',
            help: 'Provider webhooks by result: applied, duplicate (seen before, or the payment already final), unmatched (no payment yet; counted again when applied later), mismatch (money differs from the order), rejected (bad credential, malformed).',
            labelNames: [
                'result',
            ],
        })
        // Every series from the start, so rate() and alerts see zero rather than nothing.
        for (const result of RESULTS)
            this.results.inc(
                {
                    result,
                },
                0,
            )
    }

    count(result: WebhookResult) {
        this.results.inc({
            result,
        })
    }
}
