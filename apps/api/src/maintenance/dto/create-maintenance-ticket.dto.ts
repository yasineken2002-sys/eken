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

export class CreateMaintenanceTicketDto {
  @IsString()
  @MinLength(3)
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
