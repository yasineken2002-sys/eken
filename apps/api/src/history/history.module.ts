import { Module } from '@nestjs/common'
import { HistoryController } from './history.controller'
import { HistoryService } from './history.service'
import { GapsService } from './gaps.service'

@Module({
  controllers: [HistoryController],
  providers: [HistoryService, GapsService],
  exports: [HistoryService, GapsService],
})
export class HistoryModule {}
