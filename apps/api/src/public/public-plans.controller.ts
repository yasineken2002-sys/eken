import { Controller, Get } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { Public } from '../common/decorators/public.decorator'
import { PLAN_LIMITS, PLAN_ORDER, CREDIT_PACKAGES, CREDIT_PRICE_SEK } from '@eken/shared'

/**
 * Publik plan-prislista. Konsumeras av säljsidan på eveno.se utan
 * autentisering. Returnerar exakt samma data som plan-väljaren i admin
 * — så att priser och tak alltid är synkade mellan säljsida och konto.
 */
@ApiTags('public')
@Controller('public/plans')
export class PublicPlansController {
  @Public()
  @Get()
  list() {
    return {
      plans: PLAN_ORDER.map((id) => ({
        id,
        ...PLAN_LIMITS[id],
      })),
      credits: {
        pricePerCreditSek: CREDIT_PRICE_SEK,
        packages: CREDIT_PACKAGES.map((p) => ({ ...p })),
      },
      currency: 'SEK',
      vatRate: 25,
      note: 'Alla priser visas exkl moms.',
    }
  }
}
