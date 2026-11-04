import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { paymentSucceededV1 } from '@nick-lukashik/contracts'
import { connect } from 'amqplib'
import { eventsExchange } from '../src/common/messaging/topology.js'

const QUEUE = 'test.wallet.payments'

const readJson = async (request: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    return JSON.parse(Buffer.concat(chunks).toString() || 'null')
}

/** How the stand-in answers: as wallet-api, or as it does when something is wrong. */
export type WalletAnswer = 'ok' | 'unavailable' | 'refused' | 'malformed'

/**
 * A stand-in for wallet-api: its queue of pay.payment.succeeded.v1 over a
 * ledger that takes a ref once, like the real one, and its internal refs
 * endpoint (with a service token).
 */
export async function startWallet(rabbitmqUrl: string) {
    const internalToken = randomBytes(32).toString('hex')
    const ledger = new Set<string>()
    const wallet = {
        answer: 'ok' as WalletAnswer,
        /** Calls of the refs endpoint. */
        asked: 0,
        /** Every copy of an event that reached the queue. */
        deliveries: [] as {
            eventId: string
            paymentId: string
        }[],
    }

    const connection = await connect(rabbitmqUrl)
    const channel = await connection.createChannel()
    await channel.assertExchange(eventsExchange(paymentSucceededV1.producer), 'topic', {
        durable: true,
    })
    await channel.assertQueue(QUEUE)
    await channel.bindQueue(QUEUE, eventsExchange(paymentSucceededV1.producer), paymentSucceededV1.type)
    await channel.consume(QUEUE, message => {
        if (!message) return
        const event = JSON.parse(message.content.toString()) as {
            eventId: string
            payload: {
                paymentId: string
            }
        }
        wallet.deliveries.push({
            eventId: event.eventId,
            paymentId: event.payload.paymentId,
        })
        ledger.add(`pack:payment:${event.payload.paymentId}`)
        channel.ack(message)
    })

    const server: Server = createServer(async (request, response) => {
        const send = (status: number, body?: unknown) => {
            response.statusCode = status
            response.setHeader('content-type', 'application/json')
            response.end(body === undefined ? undefined : JSON.stringify(body))
        }
        if (request.method !== 'POST' || request.url !== '/api/v1/internal/refs') return send(404)
        if (request.headers.authorization !== `Bearer ${internalToken}`) return send(401)
        wallet.asked += 1
        if (wallet.answer === 'refused') return request.socket.destroy()
        if (wallet.answer === 'unavailable') return send(503)
        if (wallet.answer === 'malformed')
            return send(200, {
                refs: [],
            })
        const { refs } = (await readJson(request)) as {
            refs: string[]
        }
        send(200, {
            found: refs.filter(ref => ledger.has(ref)),
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no address')

    return Object.assign(wallet, {
        url: `http://127.0.0.1:${address.port}`,
        internalToken,
        ledger,
        close: async () => {
            await new Promise<void>(resolve => server.close(() => resolve()))
            await channel.deleteQueue(QUEUE)
            await connection.close()
        },
    })
}
export type Wallet = Awaited<ReturnType<typeof startWallet>>
