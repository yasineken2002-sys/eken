import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from '../common/prisma/prisma.module'
import { ResendWebhookController } from './resend-webhook.controller'
import { ResendWebhookService } from './resend-webhook.service'
import { AviseringModule } from '../avisering/avisering.module'

@Module({
  imports: [ConfigModule, PrismaModule, AviseringModule],
  controllers: [ResendWebhookController],
  providers: [ResendWebhookService],
})
export class WebhooksModule {}
