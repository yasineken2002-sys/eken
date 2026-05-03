import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { StorageModule } from '../storage/storage.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { CollectionExportService } from './collection-export.service'
import { CollectionsController } from './collections.controller'

@Module({
  imports: [PrismaModule, InvoicesModule, StorageModule, NotificationsModule],
  controllers: [CollectionsController],
  providers: [CollectionExportService],
  exports: [CollectionExportService],
})
export class CollectionsModule {}
