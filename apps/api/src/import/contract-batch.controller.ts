import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  BadRequestException,
  Req,
} from '@nestjs/common'
import { ApiBearerAuth, ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { ContractScanBatchService, type UploadedFile } from './contract-scan-batch.service'
import { ConfirmContractRowDto } from './dto/confirm-contract-row.dto'
import { MAX_BATCH_FILES_ABSOLUTE } from './contract-scan-cost'
import { MAX_CONTRACT_BYTES } from '../common/utils/file-validation'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { ScannedContract } from './contract-scanner.service'
import type { JwtPayload } from '@eken/shared'

/**
 * Batch-kontraktsskanning. Operatören laddar upp flera kontrakts-PDF:er,
 * systemet skannar dem asynkront (PR1) och föreslår en Unit per rad (PR2).
 * Roller MANAGER/ADMIN/OWNER — i linje med /leases/with-tenant (slutåtgärden i
 * serien skapar avtal i PR3), men hittills finns INGEN väg att skapa avtal:
 * skanning + matchningsförslag, inget mer.
 */
@ApiTags('Import')
@ApiBearerAuth()
@Controller('import')
export class ContractBatchController {
  constructor(private readonly batchService: ContractScanBatchService) {}

  @Post('contract-batches')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  @ApiOperation({ summary: 'Ladda upp flera hyreskontrakt för batch-skanning' })
  @ApiConsumes('multipart/form-data')
  async createBatch(
    @Req() request: FastifyRequest,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const files: UploadedFile[] = []
    for await (const part of request.parts()) {
      if (part.type !== 'file') continue
      // Tak på ANTAL filer kollas FÖRE buffring (annars buffras fil N+1 redan
      // innan stoppet) — så att toppen i minnet är begränsad till
      // MAX_BATCH_FILES_ABSOLUTE × MAX_CONTRACT_BYTES, inte Fastify-takets 20 MB
      // × obegränsat antal. Per-org filtaket kollas sedan i servicen.
      if (files.length >= MAX_BATCH_FILES_ABSOLUTE) {
        throw new BadRequestException(
          `För många filer i uppladdningen (max ${MAX_BATCH_FILES_ABSOLUTE}).`,
        )
      }
      const buffer = await part.toBuffer()
      // Per-fil storleksgräns redan här (samma tak som ContractScannerService),
      // så en enskild fil inte kan svälla minnet upp till Fastify-takets 20 MB.
      if (buffer.length > MAX_CONTRACT_BYTES) {
        throw new BadRequestException(
          `Filen "${part.filename}" är för stor (max ${MAX_CONTRACT_BYTES / 1024 / 1024} MB).`,
        )
      }
      files.push({ fileName: part.filename, buffer })
    }
    if (files.length === 0) {
      throw new BadRequestException('Inga filer hittades i formuläret.')
    }
    return this.batchService.createBatch(files, organizationId, user.sub)
  }

  @Get('contract-batches/:id')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  @ApiOperation({ summary: 'Hämta en batch med skanningsstatus per rad' })
  getBatch(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.batchService.getBatch(id, organizationId)
  }

  @Delete('contract-batches/:id')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  @ApiOperation({ summary: 'Avbryt en batch och radera de uppladdade filerna' })
  cancelBatch(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.batchService.cancelBatch(id, organizationId)
  }

  // ── PR3: granskning → commit (avtal skapas vid en explicit operatörsåtgärd) ──

  @Post('contract-batches/:id/rows/:rowId/confirm')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  @ApiOperation({ summary: 'Godkänn en rad → skapa avtal via /leases/with-tenant' })
  confirmRow(
    @Param('id') id: string,
    @Param('rowId') rowId: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConfirmContractRowDto,
  ) {
    return this.batchService.confirmRow(id, rowId, organizationId, user.sub, {
      ...(dto.unitId ? { unitId: dto.unitId } : {}),
      ...(dto.reviewedData ? { reviewedData: dto.reviewedData as Partial<ScannedContract> } : {}),
    })
  }

  @Post('contract-batches/:id/confirm-safe')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  @ApiOperation({ summary: 'Godkänn alla säkra (AUTO_MATCHED) rader i batchen' })
  confirmSafe(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.batchService.bulkConfirmSafe(id, organizationId, user.sub)
  }

  @Post('contract-batches/:id/rows/:rowId/skip')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  @ApiOperation({ summary: 'Hoppa över en rad (skapa inget avtal)' })
  skipRow(@Param('id') id: string, @Param('rowId') rowId: string, @OrgId() organizationId: string) {
    return this.batchService.skipRow(id, rowId, organizationId)
  }
}
