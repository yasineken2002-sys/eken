import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { AviseringController } from './avisering.controller'
import { AviseringService } from './avisering.service'

@Module({
  imports: [PrismaModule, MailModule, InvoicesModule],
  controllers: [AviseringController],
  providers: [AviseringService],
  exports: [AviseringService],
})
export class AviseringModule {}
