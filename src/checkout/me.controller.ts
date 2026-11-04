import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common'
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { AccessClaims } from '@nick-lukashik/auth'
import { Authenticated, Caller } from '@nick-lukashik/auth/nest'
import { currencySchema } from '@nick-lukashik/contracts'
import { z } from 'zod'
import { AppError } from '../common/http/app-error.js'
import { ApiErrors } from '../common/openapi/openapi.js'
import { PaymentsService } from './payments.service.js'

const checkoutSchema = z.object({
    productKey: z.string().min(1).max(64),
    currency: currencySchema.default('RUB'),
})
type CheckoutInput = z.infer<typeof checkoutSchema>

const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
})
type ListQuery = z.infer<typeof listQuerySchema>

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/

/** The caller's own payments. */
@ApiTags('payments')
@ApiBearerAuth()
@Controller('me')
@Authenticated()
export class MePaymentsController {
    constructor(private readonly payments: PaymentsService) {}

    @Post('checkout')
    @HttpCode(HttpStatus.OK)
    @ApiHeader({
        name: 'idempotency-key',
        required: true,
        description: '8-128 characters [A-Za-z0-9._:-]; a retry with the same key returns the same payment',
    })
    @ApiOperation({
        summary: 'Start paying for a coin pack; returns the provider checkout URL',
        description: [
            'The status of the payment says what to do next.',
            '`pending`: go to `checkoutUrl`.',
            '`creating`: another request with this key is still creating the provider checkout (this one waited for it first); `checkoutUrl` is null, retry with the same key.',
            '`failed`: nobody can pay this checkout: it failed at the provider, or was found again without its URL (`checkout_lost`); `checkoutUrl` is null, start over with a new key.',
            '`succeeded`: already paid.',
        ].join('\n\n'),
    })
    @ApiErrors(400, 401, 403, 409)
    checkout(
        @Caller() caller: AccessClaims,
        @Headers('idempotency-key') key: string | undefined,
        @Body({
            schema: checkoutSchema,
        })
        body: CheckoutInput,
    ) {
        if (!key || !IDEMPOTENCY_KEY.test(key))
            throw new AppError('VALIDATION_FAILED', 'Request validation failed', [
                {
                    path: 'idempotency-key',
                    message: '8-128 characters [A-Za-z0-9._:-]',
                },
            ])
        return this.payments.checkout(caller.userId, body, key)
    }

    @Get('payments')
    @ApiErrors(400, 401)
    list(
        @Caller() caller: AccessClaims,
        @Query({
            schema: listQuerySchema,
        })
        query: ListQuery,
    ) {
        return this.payments.list(caller.userId, query.limit, query.cursor)
    }

    @Get('payments/:id')
    @ApiErrors(401, 404)
    get(@Caller() caller: AccessClaims, @Param('id', new ParseUUIDPipe()) id: string) {
        return this.payments.get(caller.userId, id)
    }

    @Post('payments/:id/fake-complete')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Fake provider only: confirm the payment without money',
    })
    @ApiErrors(401, 404)
    fakeComplete(@Caller() caller: AccessClaims, @Param('id', new ParseUUIDPipe()) id: string) {
        return this.payments.completeFake(caller.userId, id)
    }
}
