import type { z } from 'zod'
import { defineEnv } from '../common/config/define-env.js'
import { FakeProvider, fakeEnv } from './fake.provider.js'
import { LavaProvider, lavaEnv } from './lava.provider.js'
import type { PaymentProvider } from './provider.js'

/** An adapter behind its env block: validated when it is created, so only for the selected one. */
const adapter =
    <S extends z.ZodObject>(schema: S, create: (env: z.output<S>) => PaymentProvider) =>
    () =>
        create(defineEnv(schema)())

/**
 * Every provider this service can run, by the value of PAY_PROVIDER, which must
 * equal the adapter's `name`. The one place that chooses a provider.
 */
const registry = {
    fake: adapter(fakeEnv, env => new FakeProvider(env)),
    lava: adapter(lavaEnv, env => new LavaProvider(env)),
}

export type ProviderName = keyof typeof registry

export const providerNames = Object.keys(registry) as [
    ProviderName,
    ...ProviderName[],
]

/** The adapter; throws, naming the variables, when its env block is invalid, which stops the process at startup. */
export const createProvider = (name: ProviderName) => registry[name]()
