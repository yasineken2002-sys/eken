import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'
import { MaintenanceCategory } from '@prisma/client'

import type { AddTenantCommentInput, SammaNycklar, SubmitTicketInput } from '@eken/shared'

/**
 * HYRESGÄSTENS väg — BASEN, inte en egen form.
 *
 * FLYTTAD HIT 2026-09-06 ur `tenant-portal.controller.ts`, där den var osynlig
 * för kontraktsvakten (se `check-dto-placement.mjs`).
 *
 * De tre fälten är exakt `CreateTicketBaseSchema`. De sex övriga som ägarvägen
 * bär — fastighet, lägenhet, hyresgäst, prioritet, datum, kostnad — HÄRLEDS
 * server-side ur det aktiva avtalet (`tenant-portal.service.ts`). Det är inte
 * en förenkling: en hyresgäst ska inte kunna peka ut någon annans fastighet,
 * och prioriteten är hyresvärdens bedömning, inte anmälarens.
 *
 * De två vägarna möts i `MaintenanceService.create`, som tar supermängden.
 * Delmängdsrelationen bevisas av `maintenance-ticket-subset.spec.ts`, härledd
 * ur schemana.
 */
export class SubmitMaintenanceDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string

  // ── TAK PÅ DET SOM BETALAS PER TOKEN ────────────────────────────────────
  // Fältet hade `@MinLength(10)` men inget tak. Med Fastifys standardgräns på
  // 1 MiB kan en hyresgäst skicka text som spränger modellens kontextfönster i
  // skuggagenten (etapp 6) — och kostnaden per ärende blir obunden uppåt.
  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  description!: string

  @IsEnum(MaintenanceCategory)
  @IsOptional()
  category?: MaintenanceCategory
}

/**
 * POST /portal/maintenance/:id/comment
 *
 * Hyresgästen har INGET `isInternal` — en intern kommentar är hyresvärdens
 * anteckning om ärendet, och den som anmäler kan inte skriva en sådan om sig
 * själv. Att fältet saknas här är därför en behörighetsgräns, inte en lucka.
 */
export class AddTenantCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content!: string
}

const _kontraktPortalArende: SammaNycklar<SubmitMaintenanceDto, SubmitTicketInput> = true
const _kontraktPortalKommentar: SammaNycklar<AddTenantCommentDto, AddTenantCommentInput> = true
void _kontraktPortalArende
void _kontraktPortalKommentar
