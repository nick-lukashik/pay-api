import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

export type LavaInvoice = {
    id: string
    status: 'NEW' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'
    currency: string
    /** What the buyer paid, as Lava reports it in `receipt`. */
    amount?: number
    offerId?: string
    email?: string
    clientUtm?: Record<string, string>
}

const readJson = async (request: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    return JSON.parse(Buffer.concat(chunks).toString() || 'null')
}

/** InvoiceResponseV3, the shape of GET /api/v2/invoices and /api/v2/invoices/{id}. */
const contract = (invoice: LavaInvoice) => ({
    id: invoice.id,
    type: 'INVOICE',
    datetime: new Date().toISOString(),
    status: invoice.status,
    receipt: {
        amount: invoice.amount ?? 0,
        currency: invoice.currency,
        fee: 0,
    },
    buyer: {
        email: invoice.email,
    },
    clientUtm: invoice.clientUtm ?? null,
})

/** How the stand-in answers: as Lava, a 4xx to a create call (nothing created), a 5xx to anything, or garbage. */
export type LavaAnswer = 'ok' | 'refused' | 'unavailable' | 'malformed'

/**
 * A stand-in for the parts of lava.top's API that pay-api calls (OpenAPI
 * 1.22.0): POST /api/v3/invoice, GET /api/v2/invoices, GET /api/v2/invoices/{id}.
 * It keeps every invoice; `onCreate` decides how a create call ends: answered,
 * or dropped after the invoice exists (a lost answer). `answer` covers the rest.
 */
export async function startLavaApi(apiKey: string) {
    const invoices = new Map<string, LavaInvoice>()
    const api = {
        created: 0,
        onCreate: undefined as ((invoice: LavaInvoice) => Promise<'answer' | 'drop'>) | undefined,
        answer: 'ok' as LavaAnswer,
    }
    const server: Server = createServer(async (request, response) => {
        const send = (status: number, body?: unknown) => {
            response.statusCode = status
            response.setHeader('content-type', 'application/json')
            response.end(body === undefined ? undefined : JSON.stringify(body))
        }
        if (request.headers['x-api-key'] !== apiKey) return send(401)
        if (api.answer === 'unavailable') return send(503)
        const url = new URL(request.url ?? '/', 'http://lava.test')
        if (request.method === 'POST' && url.pathname === '/api/v3/invoice') {
            if (api.answer === 'refused') return send(400)
            const body = await readJson(request)
            const invoice: LavaInvoice = {
                id: randomUUID(),
                status: 'NEW',
                currency: body.currency,
                offerId: body.offerId,
                email: body.email,
                clientUtm: body.clientUtm,
            }
            invoices.set(invoice.id, invoice)
            api.created += 1
            if ((await api.onCreate?.(invoice)) === 'drop') return request.socket.destroy()
            if (api.answer === 'malformed') return send(201, {})
            return send(201, {
                id: invoice.id,
                status: 'new',
                paymentUrl: `https://pay.lava.top/${invoice.id}`,
            })
        }
        if (api.answer === 'malformed') return send(200, {})
        if (request.method === 'GET' && url.pathname === '/api/v2/invoices') {
            const statuses = url.searchParams.getAll('invoiceStatuses')
            const currencies = url.searchParams.getAll('currencies')
            const page = Number(url.searchParams.get('page') ?? 1)
            const size = Number(url.searchParams.get('size') ?? 20)
            const matching = [
                ...invoices.values(),
            ].filter(
                invoice =>
                    (statuses.length ? statuses.includes(invoice.status) : invoice.status === 'COMPLETED')
                    && (!currencies.length || currencies.includes(invoice.currency)),
            )
            return send(200, {
                items: matching.slice((page - 1) * size, page * size).map(contract),
                page,
                size,
                total: matching.length,
            })
        }
        const one = /^\/api\/v2\/invoices\/([^/]+)$/.exec(url.pathname)
        if (request.method === 'GET' && one) {
            const invoice = invoices.get(one[1] ?? '')
            return invoice ? send(200, contract(invoice)) : send(404)
        }
        send(404)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no address')

    return Object.assign(api, {
        url: `http://127.0.0.1:${address.port}`,
        invoices,
        /** An invoice Lava already has (created outside pay-api's calls). */
        add: (invoice: Omit<LavaInvoice, 'id'>) => {
            const id = randomUUID()
            invoices.set(id, {
                id,
                ...invoice,
            })
            return id
        },
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
    })
}
export type LavaApi = Awaited<ReturnType<typeof startLavaApi>>
