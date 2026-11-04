import { Inject, Injectable } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import { payConfig } from '../config/config.js'
import type { PaymentRow } from '../db/types.js'
import { type CheckoutInput, type ParsedWebhook, PaymentProvider } from './provider.js'

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
        return this.checkoutOf(payment)
    }

    /** The checkout depends on the payment only: the same one again. */
    async findCheckout(payment: PaymentRow) {
        return this.checkoutOf(payment)
    }

    /** Confirmed through fake-complete only. */
    async lookup() {
        return undefined
    }

    /** The fake provider has no webhooks. */
    authenticate() {
        return false
    }

    parse(): ParsedWebhook {
        return {
            rejected: 'the fake provider has no webhooks',
        }
    }

    private checkoutOf(payment: PaymentRow) {
        return {
            providerPaymentId: `fake_${payment.id}`,
            checkoutUrl: `${this.config.idWebUrl}/payments/fake/${payment.id}`,
        }
    }
}
