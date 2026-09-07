import { Module } from '@nestjs/common'

import { ContractorsController } from './contractors.controller'
import { ContractorsService } from './contractors.service'
import { WorkOrderService } from './work-order.service'
import {
  WorkOrderAdminController,
  WorkOrderController,
  WorkOrderPublicController,
} from './work-order.controller'
import { MailModule } from '../mail/mail.module'

@Module({
  imports: [MailModule],
  controllers: [
    ContractorsController,
    WorkOrderController,
    WorkOrderAdminController,
    WorkOrderPublicController,
  ],
  providers: [ContractorsService, WorkOrderService],
  exports: [ContractorsService, WorkOrderService],
})
export class ContractorsModule {}
