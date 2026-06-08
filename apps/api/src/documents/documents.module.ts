import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { DocumentsController } from './documents.controller'
import { DocumentsService } from './documents.service'
import { DocumentDeliveryService } from './document-delivery.service'

@Module({
  imports: [PrismaModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentDeliveryService],
  exports: [DocumentsService, DocumentDeliveryService],
})
export class DocumentsModule {}
