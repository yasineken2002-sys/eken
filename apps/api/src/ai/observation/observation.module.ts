import { Module } from '@nestjs/common'

import { PrismaModule } from '../../common/prisma/prisma.module'
import { DelegationProposalService } from './delegation-proposal.service'
import { ObservationService } from './observation.service'

/**
 * OBSERVATIONSLAGRET (etapp 8).
 *
 * Modulen exporterar EN tjänst som bara läser. Den importerar inte
 * `AiToolsModule` och ger ingen rätt — se docblocket i tjänsten för varför den
 * medvetet saknar en `fårAgenten(...)`.
 */
@Module({
  imports: [PrismaModule],
  providers: [ObservationService, DelegationProposalService],
  exports: [ObservationService, DelegationProposalService],
})
export class ObservationModule {}
