import { randomUUID } from 'node:crypto'
import { FakeProvider, fakeEnv } from '../src/providers/fake.provider.js'
import { LavaProvider, lavaEnv } from '../src/providers/lava.provider.js'
import { type LavaInvoice, startLavaApi } from './lava-api.js'
import { providerContract } from './provider-contract.js'

providerContract('fake', async () => ({
    provider: new FakeProvider(
        fakeEnv.parse({
            ID_WEB_URL: 'https://id.example.test',
        }),
    ),
    side: null,
    webhooks: null,
    close: async () => {},
}))

providerContract('lava', async () => {
    const SECRET = 'l'.repeat(40)
    const API_KEY = 'api-key'
    const api = await startLavaApi(API_KEY)
    return {
        provider: new LavaProvider(
            lavaEnv.parse({
                LAVA_API_URL: api.url,
                LAVA_API_KEY: API_KEY,
                LAVA_WEBHOOK_SECRET: SECRET,
                LAVA_OFFER_COINS_550: randomUUID(),
            }),
        ),
        side: {
            answers: how => {
                api.answer = how
            },
            losesNextAnswer: () => {
                api.onCreate = async () => {
                    api.onCreate = undefined
                    return 'drop'
                }
            },
            checkoutsOf: payment =>
                [
                    ...api.invoices.values(),
                ].filter(invoice => invoice.clientUtm?.utm_content === payment.id).length,
            settles: (providerPaymentId, { outcome, ...money }) => {
                const invoice = api.invoices.get(providerPaymentId)
                if (!invoice) throw new Error(`no invoice ${providerPaymentId}`)
                const status: LavaInvoice['status'] = outcome === 'succeeded' ? 'COMPLETED' : 'FAILED'
                Object.assign(invoice, money, {
                    status,
                })
            },
        },
        webhooks: {
            credential: {
                'x-api-key': SECRET,
            },
            wrongCredentials: [
                {
                    'x-api-key': API_KEY,
                },
                {
                    'x-api-key': SECRET.slice(1),
                },
                {
                    authorization: `Bearer ${SECRET}`,
                },
            ],
            paid: (contractId, money) => ({
                eventType: 'payment.success',
                contractId,
                status: 'completed',
                ...money,
            }),
            failed: contractId => ({
                eventType: 'payment.failed',
                contractId,
                status: 'failed',
            }),
        },
        close: () => api.close(),
    }
})
