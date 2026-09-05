import { IsArray, IsOptional, IsString, IsUUID, MinLength } from 'class-validator'
import type {
  BulkExportInput,
  MarkSentInput,
  PauseRemindersInput,
  SammaNycklar,
} from '@eken/shared'

/**
 * INKASSOFLÖDETS KROPPAR.
 *
 * Klasserna låg tidigare inline i `collections.controller.ts`. De flyttades hit
 * av två skäl: varje annan feature har en `dto/`-katalog, och kontraktsvakten
 * letar härledningar i `*.dto.ts` — en DTO som bor i en controller är osynlig
 * för den, vilket hade gjort regeln tyst just här.
 *
 * Formen ägs av schemana i @eken/shared; `implements` + paritetsraderna binder
 * dem. VÄRDEIMPORT i controllern, aldrig `import type` (CLAUDE.md:s DTO-regel).
 */

export class BulkExportDto implements BulkExportInput {
  @IsArray()
  @IsUUID('4', { each: true })
  invoiceIds!: string[]
}

export class PauseRemindersDto implements PauseRemindersInput {
  @IsOptional()
  @IsString()
  reason?: string
}

export class MarkSentDto implements MarkSentInput {
  @IsOptional()
  @IsString()
  @MinLength(1)
  note?: string
}

const _kontraktBulkExport: SammaNycklar<BulkExportDto, BulkExportInput> = true
const _kontraktPausa: SammaNycklar<PauseRemindersDto, PauseRemindersInput> = true
const _kontraktMarkeraSand: SammaNycklar<MarkSentDto, MarkSentInput> = true
void _kontraktBulkExport
void _kontraktPausa
void _kontraktMarkeraSand
