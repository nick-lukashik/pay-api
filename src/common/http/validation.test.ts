import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { validationException } from './validation.js'

describe('validationException', () => {
    it('turns every Standard Schema issue into a details entry with its path', async () => {
        const schema = z.object({
            title: z.string().min(1),
            tags: z.array(z.string()),
        })
        const result = await schema['~standard'].validate({
            title: '',
            tags: [
                1,
            ],
        })
        if (!result.issues) throw new Error('expected issues')

        const error = validationException(result.issues)
        expect(error.code).toBe('VALIDATION_FAILED')
        expect(error.status).toBe(400)
        expect(error.details?.map(d => d.path)).toEqual([
            'title',
            'tags.0',
        ])
    })
})
