import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { UnitsController } from './units.controller'
import { UnitsService } from './units.service'

@Module({
  imports: [PrismaModule],
  controllers: [UnitsController],
  providers: [UnitsService],
  exports: [UnitsService],
})
export class UnitsModule {}
