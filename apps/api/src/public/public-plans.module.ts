import { Module } from '@nestjs/common'
import { PublicPlansController } from './public-plans.controller'

@Module({
  controllers: [PublicPlansController],
})
export class PublicPlansModule {}
