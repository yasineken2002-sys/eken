import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { OcrModule } from '../common/ocr/ocr.module'
import { StorageModule } from '../storage/storage.module'
import { AccountingModule } from '../accounting/accounting.module'
import { AviseringController } from './avisering.controller'
import { AviseringService } from './avisering.service'
import { AviseringScheduler } from './avisering.scheduler'

@Module({
  imports: [PrismaModule, MailModule, InvoicesModule, OcrModule, StorageModule, AccountingModule],
  controllers: [AviseringController],
  providers: [AviseringService, AviseringScheduler],
  exports: [AviseringService],
})
export class AviseringModule {}
