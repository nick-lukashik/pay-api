import { Module } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import { CatalogController } from './catalog/catalog.controller.js'
import { IdClient } from './checkout/id-client.js'
import { MePaymentsController } from './checkout/me.controller.js'
import { PaymentsService } from './checkout/payments.service.js'
import { payConfig } from './config/config.js'
import { FakeProvider } from './providers/fake.provider.js'
import { LavaProvider } from './providers/lava.provider.js'
import { PaymentProvider } from './providers/provider.js'
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
            useFactory: (config: ConfigType<typeof payConfig>) =>
                config.provider === 'lava' ? new LavaProvider(config) : new FakeProvider(config),
        },
        IdClient,
        PaymentsService,
    ],
})
export class PayModule {}
