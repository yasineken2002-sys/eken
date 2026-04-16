import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { TenantsController } from './tenants.controller'
import { TenantsService } from './tenants.service'

@Module({
  imports: [PrismaModule],
  controllers: [TenantsController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
