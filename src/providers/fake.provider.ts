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

const ID_PREFIX = 'fake_'

/**
 * No money: the checkout page is id-web's `/payments/fake/<id>`, which
 * confirms through `POST /me/payments/:id/fake-complete`. Local runs and stage only.
 */
export class FakeProvider extends PaymentProvider {
    readonly name = 'fake'
    /** The checkouts this process made. */
    private readonly made = new Set<string>()

    constructor(private readonly env: z.output<typeof fakeEnv>) {
        super()
    }

    async createCheckout({ payment }: CheckoutInput) {
        this.made.add(payment.id)
        return this.checkoutOf(payment)
    }

    /** One another pod made is not found, and creating it gives the same one: it depends on the payment only. */
    async findCheckout(payment: PaymentRow) {
        return this.made.has(payment.id) ? this.checkoutOf(payment) : null
    }

    /** Open for any checkout of this adapter: it knows no outcome, only fake-complete confirms. */
    async lookup(providerPaymentId: string) {
        return providerPaymentId.startsWith(ID_PREFIX) ? ('open' as const) : undefined
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
            providerPaymentId: `${ID_PREFIX}${payment.id}`,
            checkoutUrl: `${this.env.ID_WEB_URL}/payments/fake/${payment.id}`,
        }
    }
}
