import { Module } from '@nestjs/common'
import { PublicConfigController } from './public-config.controller'
import { PublicPlansController } from './public-plans.controller'

@Module({
  // Två oautentiserade ytor med samma karaktär: de beskriver plattformen för
  // den som ännu inte har ett konto. Ingen av dem läser en databas.
  controllers: [PublicPlansController, PublicConfigController],
})
export class PublicPlansModule {}
