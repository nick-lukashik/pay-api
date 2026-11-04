import { Inject, Injectable } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import type { Locale } from '@nick-lukashik/contracts'
import { authConfig } from '../config/config.js'

export type Recipient = {
    id: string
    email: string
    locale: Locale
    status: 'active' | 'suspended'
}

/** Where to send: id-api over the cluster network with its service token. */
@Injectable()
export class IdClient {
    constructor(@Inject(authConfig.KEY) private readonly config: ConfigType<typeof authConfig>) {}

    async recipient(userId: string): Promise<Recipient | undefined> {
        const response = await fetch(`${this.config.idApiUrl}/api/v1/internal/users/${encodeURIComponent(userId)}`, {
            headers: {
                authorization: `Bearer ${this.config.idInternalToken}`,
            },
            signal: AbortSignal.timeout(5_000),
        })
        if (response.status === 404) return undefined
        if (!response.ok) throw new Error(`id-api answered ${response.status}`)
        return (await response.json()) as Recipient
    }
}
