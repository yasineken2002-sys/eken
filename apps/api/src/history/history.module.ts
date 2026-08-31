import { Module } from '@nestjs/common'
import { HistoryController } from './history.controller'
import { TenantHistoryService } from './tenant-history.service'

@Module({
  controllers: [HistoryController],
  providers: [TenantHistoryService],
  exports: [TenantHistoryService],
})
export class HistoryModule {}
