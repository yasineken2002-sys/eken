import { Module } from '@nestjs/common'

import { PrismaModule } from '../../common/prisma/prisma.module'
import { DelegationController } from './delegation.controller'
import { DelegationService } from './delegation.service'

/**
 * DELEGATIONERNA (G2, etapp 7).
 *
 * Modulen importerar INTE AI-exekveraren, och den exporteras inte till den.
 *
 * `assertDelegated` fick sin FÖRSTA anropare i etapp 8:
 * `AiExecutionDryRunService`, som fäller en DOM och inte utför något. Grinden är
 * alltså prövad genom en väg innan den bär en effekt — vilket var hela skälet
 * att den stod utan anropare fram till dess. Utföraren i skarpt läge är
 * fortfarande obyggd.
 */
@Module({
  imports: [PrismaModule],
  controllers: [DelegationController],
  providers: [DelegationService],
  exports: [DelegationService],
})
export class DelegationModule {}
