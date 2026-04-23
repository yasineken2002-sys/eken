import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { AviseringController } from './avisering.controller'
import { AviseringService } from './avisering.service'
import { OcrService } from './ocr.service'

@Module({
  imports: [PrismaModule, MailModule, InvoicesModule],
  controllers: [AviseringController],
  providers: [AviseringService, OcrService],
  exports: [AviseringService],
})
export class AviseringModule {}
