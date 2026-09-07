import { IsBoolean, IsEnum, IsInt, IsOptional, Min } from 'class-validator'

import type { SammaNycklar, UpdateAppendixInput } from '@eken/shared'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'

/**
 * PATCH /contracts/:leaseId/appendices/:documentId
 *
 * FLYTTAD HIT 2026-09-06. Klassen låg inline i `contracts.controller.ts`, över
 * `@Controller`-klassen. Den var giltig kod — men `check-request-contract.mjs`
 * räknar bara upp filer under `dto/`, så en DTO som bor i en controller är
 * OSYNLIG för kontraktsvakten: den kunde aldrig hamna i baslinjen, och kunde
 * därför aldrig krävas ha ett schema.
 */
export class UpdateAppendixDto {
  @StrictBoolean() @IsBoolean() @IsOptional() attachedToLeaseAsAppendix?: boolean

  @IsEnum(['ENERGY_DECLARATION', 'HOUSE_RULES', 'INSPECTION_PROTOCOL', 'OTHER'])
  @IsOptional()
  category?: 'ENERGY_DECLARATION' | 'HOUSE_RULES' | 'INSPECTION_PROTOCOL' | 'OTHER'

  @IsInt() @Min(0) @IsOptional() appendixOrder?: number
}

// Nyckelparitet mot det delade schemat — bryts den faller BYGGET, inte ett prov.
const _kontraktBilaga: SammaNycklar<UpdateAppendixDto, UpdateAppendixInput> = true
void _kontraktBilaga
