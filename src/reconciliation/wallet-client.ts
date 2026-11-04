import { Inject, Injectable } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import { z } from 'zod'
import { reconciliationConfig } from '../config/config.js'

const knownRefsSchema = z.object({
    found: z.array(z.string()),
})

/** What the ledger has: wallet-api over the cluster network with its service token. */
@Injectable()
export class WalletClient {
    constructor(@Inject(reconciliationConfig.KEY) private readonly config: ConfigType<typeof reconciliationConfig>) {}

    /** Which of `refs` the ledger has; throws when wallet-api cannot tell. */
    async knownRefs(refs: string[]): Promise<Set<string>> {
        const response = await fetch(`${this.config.walletApiUrl}/api/v1/internal/refs`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${this.config.walletInternalToken}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                refs,
            }),
            signal: AbortSignal.timeout(5_000),
        })
        if (!response.ok) throw new Error(`wallet-api answered ${response.status}`)
        return new Set(knownRefsSchema.parse(await response.json()).found)
    }
}
