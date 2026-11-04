import { firstValueFrom, of, timer } from 'rxjs'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from './app-error.js'
import { RequestTimeoutInterceptor } from './request-timeout.js'

const context = {} as never

describe('RequestTimeoutInterceptor', () => {
    it('passes a result that arrives within the budget', async () => {
        const interceptor = new RequestTimeoutInterceptor(50)
        await expect(
            firstValueFrom(
                interceptor.intercept(context, {
                    handle: () => of('done'),
                }),
            ),
        ).resolves.toBe('done')
    })

    it('fails with TIMEOUT and reports it when the handler is slower', async () => {
        const onTimeout = vi.fn()
        const interceptor = new RequestTimeoutInterceptor(20, onTimeout)
        const result = firstValueFrom(
            interceptor.intercept(context, {
                handle: () => timer(1_000),
            }),
        )
        await expect(result).rejects.toThrow(AppError)
        await expect(result).rejects.toMatchObject({
            code: 'TIMEOUT',
            status: 504,
        })
        expect(onTimeout).toHaveBeenCalledOnce()
    })
})
