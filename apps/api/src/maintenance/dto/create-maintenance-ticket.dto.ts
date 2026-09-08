import {
  IsString,
  IsUUID,
  IsOptional,
  IsEnum,
  IsNumber,
  MinLength,
  MaxLength,
  IsDateString,
} from 'class-validator'
import { MaintenanceCategory, MaintenancePriority } from '@prisma/client'

import type { CreateTicketInput, SammaNycklar } from '@eken/shared'
import { CreateTicketSchema } from '@eken/shared'

import { UppfyllerSchemat } from '../../common/contract/uppfyller-schemat.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'

/**
 * ÄGARENS väg — supermängden. Tjänstens `create()` tar den här formen, och
 * portalen når samma metod med en DELMÄNGD (`SubmitMaintenanceDto`, härledd ur
 * `CreateTicketBaseSchema`) sedan servern fyllt i fastighet, lägenhet,
 * hyresgäst och prioritet ur det aktiva avtalet.
 *
 * Delmängdsrelationen är en FÖLJD av att webbens schema är basen `.extend()`:ad
 * — inte något ett prov råkar kontrollera. `maintenance-ticket-subset.spec.ts`
 * härleder den ur schemana i stället för att lista fälten.
 */
@UppfyllerSchemat(CreateTicketSchema)
export class CreateMaintenanceTicketDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  @StrictString()
  title!: string

  // ── TAK PÅ DET SOM BETALAS PER TOKEN ────────────────────────────────────
  // Fältet hade `@MinLength(10)` men inget tak. Med Fastifys standardgräns på
  // 1 MiB kan en hyresgäst skicka text som spränger modellens kontextfönster i
  // skuggagenten (etapp 6) — och kostnaden per ärende blir obunden uppåt.
  // Skuggkörningen har ett eget tak för de rader som redan finns; det här
  // hindrar nya.
  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  @StrictString()
  description!: string

  @IsUUID()
  propertyId!: string

  @IsUUID()
  @IsOptional()
  unitId?: string

  @IsUUID()
  @IsOptional()
  tenantId?: string

  @IsEnum(MaintenanceCategory)
  @IsOptional()
  category?: MaintenanceCategory

  @IsEnum(MaintenancePriority)
  @IsOptional()
  priority?: MaintenancePriority

  @IsDateString()
  @IsOptional()
  scheduledDate?: string

  @IsNumber()
  @IsOptional()
  estimatedCost?: number
}

// NYCKELPARITET mot det delade schemat — bryts den faller BYGGET, inte ett prov.
const _kontraktSkapaArende: SammaNycklar<CreateMaintenanceTicketDto, CreateTicketInput> = true
void _kontraktSkapaArende
