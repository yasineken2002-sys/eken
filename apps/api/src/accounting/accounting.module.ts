import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AccountingController } from './accounting.controller'
import { AccountingService } from './accounting.service'
import { SupplierInvoiceService } from './supplier-invoice.service'
import { AccountingPeriodService } from './accounting-period.service'
import { VerifikationsnummerModule } from './verifikationsnummer.module'

@Module({
  imports: [PrismaModule, VerifikationsnummerModule],
  controllers: [AccountingController],
  providers: [AccountingService, AccountingPeriodService, SupplierInvoiceService],
  // Re-exporterar VerifikationsnummerModule så att moduler som importerar
  // AccountingModule (t.ex. AiModule) kan injicera VerifikationsnummerService.
  exports: [
    AccountingService,
    AccountingPeriodService,
    VerifikationsnummerModule,
    SupplierInvoiceService,
  ],
})
export class AccountingModule {}
