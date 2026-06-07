import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { StorageModule } from '../storage/storage.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { CollectionExportService } from './collection-export.service'
import { CollectionsController } from './collections.controller'
import { RentCollectionExportService } from './rent-collection-export.service'
import { RentCollectionsController } from './rent-collections.controller'

@Module({
  imports: [PrismaModule, InvoicesModule, StorageModule, NotificationsModule],
  controllers: [CollectionsController, RentCollectionsController],
  // RentCollectionExportService exporteras så PdfWorker (kind
  // 'rent-collections-export') kan resolva den via ModuleRef.
  providers: [CollectionExportService, RentCollectionExportService],
  exports: [CollectionExportService, RentCollectionExportService],
})
export class CollectionsModule {}
