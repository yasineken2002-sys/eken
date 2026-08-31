import { Module } from '@nestjs/common'
import { HistoryController } from './history.controller'
import { TenantHistoryService } from './tenant-history.service'
import { TenantGapsService } from './tenant-gaps.service'

@Module({
  controllers: [HistoryController],
  providers: [TenantHistoryService, TenantGapsService],
  exports: [TenantHistoryService, TenantGapsService],
})
export class HistoryModule {}
