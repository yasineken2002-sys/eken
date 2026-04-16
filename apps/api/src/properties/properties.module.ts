import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { PropertiesController } from './properties.controller'
import { PropertiesService } from './properties.service'

@Module({
  imports: [PrismaModule],
  controllers: [PropertiesController],
  providers: [PropertiesService],
  exports: [PropertiesService],
})
export class PropertiesModule {}
