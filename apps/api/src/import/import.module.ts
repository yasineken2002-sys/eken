import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { ImportController } from './import.controller'
import { ImportService } from './import.service'
import { ContractScannerService } from './contract-scanner.service'

@Module({
  imports: [PrismaModule],
  controllers: [ImportController],
  providers: [ImportService, ContractScannerService],
})
export class ImportModule {}
