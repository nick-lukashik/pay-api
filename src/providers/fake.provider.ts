import { Inject, Injectable } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import { payConfig } from '../config/config.js'
import { type CheckoutInput, PaymentProvider, type ProviderFact } from './provider.js'

/**
 * No money: the checkout page is id-web's `/payments/fake/<id>`, which
 * confirms through `POST /me/payments/:id/fake-complete`. Local runs and stage only.
 */
@Injectable()
export class FakeProvider extends PaymentProvider {
    readonly name = 'fake'

    constructor(@Inject(payConfig.KEY) private readonly config: ConfigType<typeof payConfig>) {
        super()
    }

    async createCheckout({ payment }: CheckoutInput) {
        return {
            providerPaymentId: `fake_${payment.id}`,
            checkoutUrl: `${this.config.idWebUrl}/payments/fake/${payment.id}`,
        }
    }

    /** The fake provider has no webhooks. */
    authenticate() {
        return false
    }

    parse(): ProviderFact | undefined {
        return undefined
    }
}
