import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { LeasesModule } from '../leases/leases.module'
import { TerminationsController } from './terminations.controller'
import { TerminationsService } from './terminations.service'

// MailModule är @Global → MailService injiceras utan explicit import.
// LeasesModule exporterar LeasesService som approve() återanvänder för själva
// kontraktstermineringen (ingen modulcykel: inget i Leases-trädet importerar
// detta eller AiModule).
@Module({
  imports: [PrismaModule, NotificationsModule, LeasesModule],
  controllers: [TerminationsController],
  providers: [TerminationsService],
  exports: [TerminationsService],
})
export class TerminationsModule {}
