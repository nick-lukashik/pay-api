import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { AppError, notFound } from './app-error.js'
import { renderError } from './error.filter.js'

describe('renderError', () => {
    it('keeps code, message and details of an AppError', () => {
        const error = new AppError('VALIDATION_FAILED', 'Request validation failed', [
            {
                path: 'title',
                message: 'Required',
            },
        ])
        expect(renderError(error)).toEqual({
            status: 400,
            code: 'VALIDATION_FAILED',
            message: 'Request validation failed',
            details: [
                {
                    path: 'title',
                    message: 'Required',
                },
            ],
        })
        expect(renderError(notFound('Note'))).toEqual({
            status: 404,
            code: 'NOT_FOUND',
            message: 'Note not found',
        })
    })

    it('maps any 429 (the throttler) to RATE_LIMITED', () => {
        expect(renderError(new HttpException('ThrottlerException: Too Many Requests', 429))).toEqual({
            status: 429,
            code: 'RATE_LIMITED',
            message: 'Too many requests',
        })
    })

    it('maps Nest HTTP exceptions by status', () => {
        expect(renderError(new NotFoundException('Cannot GET /x'))).toEqual({
            status: 404,
            code: 'NOT_FOUND',
            message: 'Cannot GET /x',
        })
        expect(renderError(new BadRequestException('Unexpected token'))).toMatchObject({
            status: 400,
            code: 'VALIDATION_FAILED',
        })
    })

    it('keeps the status of a body-parser refusal', () => {
        const tooLarge = Object.assign(new Error('request entity too large'), {
            expose: true,
            status: 413,
            type: 'entity.too.large',
        })
        expect(renderError(tooLarge)).toEqual({
            status: 413,
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Request body too large',
        })
    })

    it('answers 503 UNAVAILABLE when Postgres is over a budget or gone, without the SQL', () => {
        const wrapped = (code: string, message: string) =>
            Object.assign(new Error('Failed query: update notes set title = $1\nparams: secret'), {
                cause: Object.assign(new Error(message), {
                    code,
                }),
            })
        expect(renderError(wrapped('55P03', 'canceling statement due to lock timeout'))).toEqual({
            status: 503,
            code: 'UNAVAILABLE',
            message: 'Database lock wait timed out, retry later',
        })
        expect(renderError(wrapped('57014', 'canceling statement due to statement timeout'))).toMatchObject({
            status: 503,
            message: 'Database query timed out, retry later',
        })
        expect(renderError(new Error('timeout exceeded when trying to connect'))).toMatchObject({
            status: 503,
            message: 'Database is busy, retry later',
        })
        expect(
            renderError(
                Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
                    code: 'ECONNREFUSED',
                }),
            ),
        ).toMatchObject({
            status: 503,
            message: 'Database unavailable, retry later',
        })
    })

    it('keeps 504 TIMEOUT of the request budget', () => {
        expect(renderError(new AppError('TIMEOUT', 'Request timed out'))).toEqual({
            status: 504,
            code: 'TIMEOUT',
            message: 'Request timed out',
        })
    })

    it('never leaks the message of an unknown error', () => {
        const rendered = renderError(new Error('password=secret in connection string'))
        expect(rendered).toEqual({
            status: 500,
            code: 'INTERNAL',
            message: 'Internal server error',
        })
    })
})
