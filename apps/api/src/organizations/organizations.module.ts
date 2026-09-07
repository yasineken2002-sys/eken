import { Module } from '@nestjs/common'
import { DelegationModule } from '../ai/delegation/delegation.module'
import { PrismaModule } from '../common/prisma/prisma.module'
import { OrganizationsController } from './organizations.controller'
import { OrganizationsService } from './organizations.service'

@Module({
  // `DelegationModule` — organisationens växel PAUSAR delegationerna när
  // skuggan stängs av. Se `OrganizationsService`.
  imports: [PrismaModule, DelegationModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
