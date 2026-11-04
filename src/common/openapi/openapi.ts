import { applyDecorators, type INestApplication } from '@nestjs/common'
import { ApiResponse, DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { errorBodySchema } from '../http/app-error.js'

const descriptions: Record<number, string> = {
    400: 'Validation failed (VALIDATION_FAILED)',
    401: 'No valid access token or service token (UNAUTHORIZED)',
    402: 'Not enough funds (INSUFFICIENT_FUNDS)',
    403: 'Missing permission (FORBIDDEN)',
    404: 'Not found (NOT_FOUND)',
    409: 'Conflicts with the current state or an earlier request with the same key (CONFLICT)',
    422: 'Refused by the domain (UNPROCESSABLE)',
    423: 'The resource is locked (LOCKED)',
    413: 'Request body over 1 MiB (PAYLOAD_TOO_LARGE)',
    429: 'Rate limited (RATE_LIMITED)',
    500: 'Internal error (INTERNAL)',
    503: 'Database over its time budget or unavailable, retry later (UNAVAILABLE)',
    504: 'Request over its 10 s budget (TIMEOUT)',
}

/** Documents the contract error body for the given statuses; 500, 503 and 504 apply to every route. */
export const ApiErrors = (...statuses: (400 | 401 | 402 | 403 | 404 | 409 | 413 | 422 | 423 | 429)[]) =>
    applyDecorators(
        ...[
            ...statuses,
            500 as const,
            503 as const,
            504 as const,
        ].map(status =>
            ApiResponse({
                status,
                description: descriptions[status],
                standardSchema: errorBodySchema,
            }),
        ),
    )

/**
 * OpenAPI generated from the Zod schemas on the routes: JSON at
 * `/openapi.json` always, Swagger UI at `/docs` only when `ui` is true.
 */
export function setupOpenApi(
    app: INestApplication,
    options: {
        title: string
        version: string
        ui: boolean
    },
) {
    const config = new DocumentBuilder().setTitle(options.title).setVersion(options.version).build()
    const document = SwaggerModule.createDocument(app, config)
    SwaggerModule.setup('docs', app, document, {
        ui: options.ui,
        raw: [
            'json',
        ],
        jsonDocumentUrl: 'openapi.json',
    })
    return document
}
