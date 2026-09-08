import { IsEnum, IsString, IsOptional, MaxLength } from 'class-validator'
import { InspectionStatus } from '@prisma/client'

import type { UpdateInspectionInput, SammaNycklar } from '@eken/shared'
import { INSPECTION_TEXT_MAX } from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { StrictIsoDatum } from '../../common/contract/strict-iso-datum.decorator'

/**
 * PATCH /inspections/:id
 *
 * ── `completedAt` ÄR BORTTAGET, OCH DET ÄR EN HÄRDNING ──────────────────────
 *
 * Fältet stod här men i ingen klient — inte i webben, inte i portalen, inte i
 * något AI-verktyg. Tjänsten skrev `completedAt: new Date()` när status gick
 * till COMPLETED och lät sedan klientens värde skriva över det på RADEN EFTER:
 *
 *     ...(dto.status === COMPLETED ? { completedAt: new Date() } : {}),
 *     ...(dto.completedAt ? { completedAt: new Date(dto.completedAt) } : {}),
 *
 * Alltså kunde vem som helst med MANAGER-rollen datera slutförandet av ett
 * besiktningsprotokoll fritt, bakåt eller framåt, i samma anrop som satte
 * status. Protokollet är ett bevismedel i en depositionstvist; tidpunkten ska
 * komma från servern, och gör det nu ensam.
 *
 * ── SIGNATURFÄLTEN STÅR KVAR, MED TAK ──────────────────────────────────────
 *
 * Mätt: ingen kod skriver dem och ingen kod läser dem — protokoll-PDF:en ritar
 * TOMMA linjer för signering på papper. Taket 200 säger därför vad fältet är:
 * ett namn, inte en base64-bild. Skälet står i `UpdateInspectionSchema`.
 */
export class UpdateInspectionDto implements UpdateInspectionInput {
  @IsEnum(InspectionStatus)
  @IsOptional()
  status?: InspectionStatus

  // Taken är nya. Kolumnerna är `@db.Text`, alltså utan egen gräns, så Fastifys
  // 1 MiB var enda spärren för en anteckning i ett protokoll.
  @IsString()
  @MaxLength(INSPECTION_TEXT_MAX)
  @IsOptional()
  @StrictString()
  notes?: string

  @IsString()
  @MaxLength(INSPECTION_TEXT_MAX)
  @IsOptional()
  @StrictString()
  overallCondition?: string

  @StrictIsoDatum()
  @IsOptional()
  signedAt?: string

  @IsString()
  @MaxLength(200)
  @IsOptional()
  @StrictString()
  tenantSignature?: string

  @IsString()
  @MaxLength(200)
  @IsOptional()
  @StrictString()
  landlordSignature?: string
}

const _kontraktUppdateraBesiktning: SammaNycklar<UpdateInspectionDto, UpdateInspectionInput> = true
void _kontraktUppdateraBesiktning
