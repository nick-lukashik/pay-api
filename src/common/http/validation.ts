import type { StandardSchemaV1 } from '@standard-schema/spec'
import { AppError, type ErrorDetail } from './app-error.js'

/** `a.b.0.c` from a Standard Schema issue path; empty for the value itself. */
export function issuePath(issue: StandardSchemaV1.Issue): string {
    return (issue.path ?? [])
        .map(segment => (typeof segment === 'object' ? String(segment.key) : String(segment)))
        .join('.')
}

/** For StandardSchemaValidationPipe: every issue becomes one `details` entry. */
export function validationException(issues: readonly StandardSchemaV1.Issue[]): AppError {
    const details: ErrorDetail[] = issues.map(issue => ({
        path: issuePath(issue),
        message: issue.message,
    }))
    return new AppError('VALIDATION_FAILED', 'Request validation failed', details)
}
