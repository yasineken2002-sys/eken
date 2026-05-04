import { Module } from '@nestjs/common'
import { ContractsController } from './contracts.controller'
import { ContractTemplateService } from './contract-template.service'
import { PrismaModule } from '../common/prisma/prisma.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { StorageModule } from '../storage/storage.module'

@Module({
  imports: [PrismaModule, InvoicesModule, StorageModule],
  controllers: [ContractsController],
  providers: [ContractTemplateService],
  exports: [ContractTemplateService],
})
export class ContractsModule {}
