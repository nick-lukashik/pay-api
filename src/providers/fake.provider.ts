import { z } from 'zod'
import { baseEnvSchema } from '../common/config/define-env.js'
import type { PaymentRow } from '../db/types.js'
import { type CheckoutInput, type ParsedWebhook, PaymentProvider } from './provider.js'

/** The variables of this adapter, read only when `PAY_PROVIDER=fake`. */
export const fakeEnv = baseEnvSchema
    .pick({
        NODE_ENV: true,
    })
    .extend({
        /** Stage runs NODE_ENV=production with the fake provider on purpose. */
        PAY_ALLOW_FAKE: z.stringbool().default(false),
        /** id-web: the fake checkout page. */
        ID_WEB_URL: z.url().default('https://id.nick-lukashik.com'),
    })
    .refine(value => !(value.NODE_ENV === 'production' && !value.PAY_ALLOW_FAKE), {
        path: [
            'PAY_ALLOW_FAKE',
        ],
        message: 'the fake provider gives coins without money: in production only with PAY_ALLOW_FAKE=true (stage)',
    })

/**
 * No money: the checkout page is id-web's `/payments/fake/<id>`, which
 * confirms through `POST /me/payments/:id/fake-complete`. Local runs and stage only.
 */
export class FakeProvider extends PaymentProvider {
    readonly name = 'fake'

    constructor(private readonly env: z.output<typeof fakeEnv>) {
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
            checkoutUrl: `${this.env.ID_WEB_URL}/payments/fake/${payment.id}`,
        }
    }
}
