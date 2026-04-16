import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AiModule } from '../ai/ai.module'
import { NotificationsService } from './notifications.service'
import { NotificationsController } from './notifications.controller'

@Module({
  imports: [PrismaModule, AiModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
