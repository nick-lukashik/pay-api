import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

export const ISSUER = 'https://id.example.test'
export const AUDIENCE = 'nick-lukashik'

export type FakeUser = {
    id: string
    email: string
    locale: 'en' | 'ru'
    status: 'active' | 'suspended'
}

/**
 * A stand-in for id-api: its JWKS, its internal users endpoint (with a
 * service token) and access tokens signed with the matching key.
 */
export async function startIdentity() {
    const { publicKey, privateKey } = await generateKeyPair('ES256')
    const jwk = {
        ...(await exportJWK(publicKey)),
        kid: 'test-key',
        alg: 'ES256',
        use: 'sig',
    }
    const internalToken = randomBytes(32).toString('hex')
    const users = new Map<string, FakeUser>()
    const server: Server = createServer((request, response) => {
        const send = (status: number, body?: unknown) => {
            response.statusCode = status
            response.setHeader('content-type', 'application/json')
            response.end(body === undefined ? undefined : JSON.stringify(body))
        }
        if (request.url === '/.well-known/jwks.json')
            return send(200, {
                keys: [
                    jwk,
                ],
            })
        const user = /^\/api\/v1\/internal\/users\/([0-9a-f-]+)$/.exec(request.url ?? '')
        if (user) {
            if (request.headers.authorization !== `Bearer ${internalToken}`) return send(401)
            const found = users.get(user[1] ?? '')
            return found ? send(200, found) : send(404)
        }
        send(404)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    const url = `http://127.0.0.1:${address.port}`

    return {
        url,
        jwksUrl: `${url}/.well-known/jwks.json`,
        internalToken,
        users,
        /** An access token of `userId` with `roles`, valid for five minutes. */
        token: (userId: string, roles: string[] = []) =>
            new SignJWT({
                sid: crypto.randomUUID(),
                roles,
                av: 0,
            })
                .setProtectedHeader({
                    alg: 'ES256',
                    kid: 'test-key',
                    typ: 'at+jwt',
                })
                .setSubject(userId)
                .setIssuer(ISSUER)
                .setAudience(AUDIENCE)
                .setIssuedAt()
                .setExpirationTime('5m')
                .sign(privateKey),
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
    }
}
export type Identity = Awaited<ReturnType<typeof startIdentity>>
