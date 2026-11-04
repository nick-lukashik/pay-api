import { createHash } from 'node:crypto'
import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Inject,
    Logger,
    NotFoundException,
    Param,
    Post,
    Req,
    UnauthorizedException,
    VERSION_NEUTRAL,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { eq } from 'drizzle-orm'
import type { Request } from 'express'
import { PaymentsService } from '../checkout/payments.service.js'
import { DB } from '../common/database/database.js'
import { OutboxRelay } from '../common/messaging/outbox-relay.js'
import { webhookEvents } from '../db/schema.js'
import type { Db } from '../db/types.js'
import { PaymentProvider } from '../providers/provider.js'

/**
 * `POST /webhooks/<provider>`, outside /api: the only public route of this
 * service (hooks.nick-lukashik.com). The credential is checked before the
 * payload is read; each fact is recorded once (dedupe key) and applied in the
 * same transaction. 200 once recorded, so the provider stops retrying.
 */
@ApiExcludeController()
@Controller({
    path: 'webhooks',
    version: VERSION_NEUTRAL,
})
export class WebhooksController {
    private readonly logger = new Logger('Webhooks')

    constructor(
        @Inject(DB) private readonly db: Db,
        private readonly provider: PaymentProvider,
        private readonly payments: PaymentsService,
        private readonly relay: OutboxRelay,
    ) {}

    @Post(':provider')
    @HttpCode(HttpStatus.OK)
    async receive(@Param('provider') name: string, @Req() request: Request, @Body() body: unknown) {
        if (name !== this.provider.name) throw new NotFoundException('Unknown provider')
        if (!this.provider.authenticate(request.headers)) throw new UnauthorizedException('Bad webhook credential')
        const payloadSha256 = createHash('sha256')
            .update(JSON.stringify(body ?? null))
            .digest('hex')
        const fact = this.provider.parse(body)
        const result = await this.db.transaction(async tx => {
            const [recorded] = await tx
                .insert(webhookEvents)
                .values({
                    provider: this.provider.name,
                    dedupeKey: fact?.dedupeKey ?? `invalid:${payloadSha256}`,
                    payloadSha256,
                    outcome: fact ? 'processed' : 'invalid',
                })
                .onConflictDoNothing()
                .returning({
                    id: webhookEvents.id,
                })
            if (!recorded)
                return {
                    status: 'duplicate',
                }
            if (!fact)
                return {
                    status: 'invalid',
                }
            const applied = await this.payments.apply(tx, fact)
            if (applied.outcome !== 'processed' || applied.paymentId) {
                await tx
                    .update(webhookEvents)
                    .set({
                        outcome: applied.outcome,
                        paymentId: applied.paymentId ?? null,
                    })
                    .where(eq(webhookEvents.id, recorded.id))
            }
            return {
                status: applied.outcome,
            }
        })
        this.relay.kick()
        if (result.status === 'mismatch' || result.status === 'unmatched')
            this.logger.warn(
                {
                    status: result.status,
                },
                'Webhook not applied',
            )
        return result
    }
}
