import { BullModule } from '@nestjs/bull'
import { Global, Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailQueue } from './mail.queue'
import { MailRenderer } from './mail.renderer'
import { MailService } from './mail.service'
import { MailWorkerHigh, MailWorkerNormal, MailWorkerLow } from './mail.worker'
import { QUEUE_HIGH, QUEUE_LOW, QUEUE_NORMAL } from './mail.types'

@Global()
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    BullModule.registerQueue({ name: QUEUE_HIGH }, { name: QUEUE_NORMAL }, { name: QUEUE_LOW }),
  ],
  providers: [
    MailRenderer,
    MailQueue,
    MailService,
    MailWorkerHigh,
    MailWorkerNormal,
    MailWorkerLow,
  ],
  exports: [MailService],
})
export class MailModule {}
