import { Controller, Get } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { catalog } from './catalog.js'

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
    @Get()
    @ApiOperation({
        summary: 'GRM packs and their prices',
    })
    list() {
        return {
            items: catalog.map(product => ({
                key: product.key,
                grm: String(product.grm),
                title: product.title,
                prices: product.prices,
            })),
        }
    }
}
