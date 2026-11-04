import { Module } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import { CatalogController } from './catalog/catalog.controller.js'
import { IdClient } from './checkout/id-client.js'
import { MePaymentsController } from './checkout/me.controller.js'
import { PaymentsService } from './checkout/payments.service.js'
import { payConfig } from './config/config.js'
import { PaymentProvider } from './providers/provider.js'
import { createProvider } from './providers/registry.js'
import { ReconciliationService } from './reconciliation/reconciliation.service.js'
import { WalletClient } from './reconciliation/wallet-client.js'
import { WebhookMetrics } from './webhooks/webhook-metrics.js'
import { WebhooksController } from './webhooks/webhooks.controller.js'

@Module({
    controllers: [
        CatalogController,
        MePaymentsController,
        WebhooksController,
    ],
    providers: [
        {
            provide: PaymentProvider,
            inject: [
                payConfig.KEY,
            ],
            useFactory: (config: ConfigType<typeof payConfig>) => createProvider(config.provider),
        },
        IdClient,
        PaymentsService,
        ReconciliationService,
        WalletClient,
        WebhookMetrics,
    ],
})
export class PayModule {}
