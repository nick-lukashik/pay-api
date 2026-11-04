import { describe, expect, it } from 'vitest'
import { catalog } from './catalog.js'

describe('catalog', () => {
    it('knows only products, nothing of a provider', () => {
        for (const product of catalog)
            expect(Object.keys(product).sort()).toEqual([
                'coins',
                'key',
                'prices',
                'title',
            ])
    })
})
