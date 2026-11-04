import { Injectable } from '@nestjs/common'

export type HealthDetails = Record<string, unknown>

/** Resolves when healthy (with an object: details for the response body), throws when not. */
export type HealthCheck = () => Promise<unknown>

export type HealthEntry = {
    check: HealthCheck
    /** Readiness fails (503) only for a required dependency; the others are reported as `degraded`. */
    required: boolean
}

/** Thrown by a check to report details (e.g. consumer states) together with the failure. */
export class DependencyDownError extends Error {
    constructor(
        message: string,
        readonly details: HealthDetails = {},
    ) {
        super(message)
        this.name = 'DependencyDownError'
    }
}

/** Infrastructure modules register their readiness checks here. */
@Injectable()
export class HealthRegistry {
    private readonly checks = new Map<string, HealthEntry>()

    register(
        name: string,
        check: HealthCheck,
        options: {
            required: boolean
        } = {
            required: true,
        },
    ) {
        this.checks.set(name, {
            check,
            required: options.required,
        })
    }

    entries() {
        return [
            ...this.checks.entries(),
        ]
    }
}
