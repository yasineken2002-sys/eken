import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common'
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator'
import { Roles } from '../common/decorators/roles.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { RentCollectionExportService } from './rent-collection-export.service'

class RentBulkExportDto {
  @IsArray()
  // Tak mot resursuttömning (säkerhetsgranskning LOW): N avier ⇒ N Puppeteer-
  // renderingar i ett jobb. 200 inkasso-redo avier i en batch är redan extremt.
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  noticeIds!: string[]
}

/**
 * Inkasso PR 4b — steg 3. Read-only export av inkasso-redo hyresavier. Samma
 * rollkrav och 202-mönster som CollectionsController (faktura-flödet), men på
 * RentNotice. INV-C: inga endpoints som rör krav/förverkande/avhysning — Evenos
 * ansvar slutar vid exportfilen.
 */
@Controller('rent-collections')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
export class RentCollectionsController {
  constructor(private readonly exportService: RentCollectionExportService) {}

  @Get('ready')
  async ready(@OrgId() organizationId: string) {
    return this.exportService.listReady(organizationId)
  }

  @Post('export/:noticeId')
  @HttpCode(HttpStatus.ACCEPTED)
  async exportSingle(
    // ParseUUIDPipe — konsekvent med bulk-DTO:ns @IsUUID; avvisar icke-UUID innan
    // den når Prisma (säkerhetsgranskning PR 2, MEDIUM).
    @Param('noticeId', ParseUUIDPipe) noticeId: string,
    @OrgId() organizationId: string,
  ) {
    return this.exportService.enqueueExportForNotice(noticeId, organizationId)
  }

  @Post('bulk-export')
  @HttpCode(HttpStatus.ACCEPTED)
  async exportBulk(@Body() dto: RentBulkExportDto, @OrgId() organizationId: string) {
    if (!dto.noticeIds?.length) {
      throw new BadRequestException('noticeIds får inte vara tom')
    }
    return this.exportService.enqueueBulkExport(dto.noticeIds, organizationId)
  }
}
