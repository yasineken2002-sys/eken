import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { RentIncreasesController } from './rent-increases.controller'
import { RentIncreasesService } from './rent-increases.service'

@Module({
  imports: [PrismaModule, MailModule, NotificationsModule],
  controllers: [RentIncreasesController],
  providers: [RentIncreasesService],
  exports: [RentIncreasesService],
})
export class RentIncreasesModule {}
