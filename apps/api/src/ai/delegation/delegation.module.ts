import { Module } from '@nestjs/common'

import { PrismaModule } from '../../common/prisma/prisma.module'
import { DelegationController } from './delegation.controller'
import { DelegationService } from './delegation.service'

/**
 * DELEGATIONERNA (G2, etapp 7).
 *
 * Modulen importerar INTE AI-exekveraren, och den exporteras inte till den.
 * `assertDelegated` har ingen anropare utöver proven; utföraren som ska anropa
 * den är etapp 8–9. En grind utan anropare är ärligare än en grind som anropas
 * från en väg ingen prövat.
 */
@Module({
  imports: [PrismaModule],
  controllers: [DelegationController],
  providers: [DelegationService],
  exports: [DelegationService],
})
export class DelegationModule {}
