import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { LeasesController } from './leases.controller'
import { LeasesService } from './leases.service'

@Module({
  imports: [PrismaModule],
  controllers: [LeasesController],
  providers: [LeasesService],
  exports: [LeasesService],
})
export class LeasesModule {}
