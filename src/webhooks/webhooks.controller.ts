import { createHash } from 'node:crypto'
import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Logger,
    NotFoundException,
    Param,
    Post,
    Req,
    UnauthorizedException,
    VERSION_NEUTRAL,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import type { Request } from 'express'
import { PaymentsService } from '../checkout/payments.service.js'
import { PaymentProvider } from '../providers/provider.js'
import { WebhookMetrics } from './webhook-metrics.js'

/**
 * `POST /webhooks/<provider>`, outside /api: the only public route of this
 * service (hooks.nick-lukashik.com). The credential is checked before the
 * payload is read; each fact is recorded once (dedupe key) and applied in the
 * same transaction, or later when its payment gets the provider id. 200 once
 * recorded, so the provider stops retrying; 503 when its record does not
 * confirm a success yet or it cannot be asked (`deferred`), so it retries.
 */
@ApiExcludeController()
@Controller({
    path: 'webhooks',
    version: VERSION_NEUTRAL,
})
export class WebhooksController {
    private readonly logger = new Logger('Webhooks')

    constructor(
        private readonly provider: PaymentProvider,
        private readonly payments: PaymentsService,
        private readonly metrics: WebhookMetrics,
    ) {}

    @Post(':provider')
    @HttpCode(HttpStatus.OK)
    async receive(@Param('provider') name: string, @Req() request: Request, @Body() body: unknown) {
        if (name !== this.provider.name) throw new NotFoundException('Unknown provider')
        if (!this.provider.authenticate(request.headers)) {
            this.metrics.count('rejected')
            throw new UnauthorizedException('Bad webhook credential')
        }
        const payloadSha256 = createHash('sha256')
            .update(JSON.stringify(body ?? null))
            .digest('hex')
        const status = await this.payments.receive(this.provider.parse(body), payloadSha256)
        if (status === 'mismatch' || status === 'unmatched')
            this.logger.warn(
                {
                    status,
                },
                'Webhook not applied',
            )
        return {
            status,
        }
    }
}
