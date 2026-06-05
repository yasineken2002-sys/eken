import { Module } from '@nestjs/common'
import { CustomerNumberService } from './customer-number.service'

/**
 * Lean modul som exponerar CustomerNumberService till de moduler som skapar
 * organisationer (AuthModule, PlatformModule). PrismaModule är @Global() så
 * PrismaService injiceras utan explicit import.
 */
@Module({
  providers: [CustomerNumberService],
  exports: [CustomerNumberService],
})
export class CustomerNumberModule {}
