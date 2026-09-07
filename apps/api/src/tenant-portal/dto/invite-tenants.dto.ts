import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator'

import type { InviteTenantsInput, ResendInvitesInput, SammaNycklar } from '@eken/shared'
import { INVITE_BATCH_MAX, InviteTenantsSchema, ResendInvitesSchema } from '@eken/shared'

import { UppfyllerSchemat } from '../../common/contract/uppfyller-schemat.decorator'
import { IngenKoercion } from '../../common/contract/no-coercion.decorator'

/**
 * FLYTTADE HIT 2026-09-06 ur `tenant-portal.controller.ts`.
 *
 * De var giltig kod där. Men `check-request-contract.mjs` bygger sin mängd
 * härledda nyttolasttyper genom att läsa filer som slutar på `.dto.ts`, så en
 * DTO som bor i en controller är OSYNLIG för den: vakten kunde aldrig kräva att
 * de här två hade ett delat schema, och tystnaden såg ut som godkänt.
 *
 * `check-dto-placement.mjs` spärrar numera formen. Se dess docblock för varför
 * en placeringsregel valdes framför ett svep över controllers.
 */

/** POST /tenant-portal/admin/invitations */
@UppfyllerSchemat(InviteTenantsSchema)
export class InviteTenantsDto {
  // Bjud in alla aktiva hyresgäster (≥1 ACTIVE-kontrakt).
  @IsOptional()
  @IngenKoercion()
  @IsBoolean()
  all?: boolean

  // Eller ett explicit urval.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(INVITE_BATCH_MAX)
  @IsUUID('4', { each: true })
  tenantIds?: string[]

  // Kringgå 24 h-dubbelklicks-skyddet (medveten omsändning).
  @IsOptional()
  @IsBoolean()
  force?: boolean
}

/** POST /tenant-portal/admin/invitations/resend */
@UppfyllerSchemat(ResendInvitesSchema)
export class ResendInvitesDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(INVITE_BATCH_MAX)
  @IsUUID('4', { each: true })
  tenantIds?: string[]

  // Skicka om till alla inbjudna men ej aktiverade.
  @IsOptional()
  @IngenKoercion()
  @IsBoolean()
  onlyNotActivated?: boolean
}

// NYCKELPARITET mot de delade schemana — bryts den faller BYGGET, inte ett prov.
const _kontraktBjudIn: SammaNycklar<InviteTenantsDto, InviteTenantsInput> = true
const _kontraktSkickaOm: SammaNycklar<ResendInvitesDto, ResendInvitesInput> = true
void _kontraktBjudIn
void _kontraktSkickaOm

// TAKET 2000 kommer nu från EN plats (`INVITE_BATCH_MAX` i @eken/shared).
// Det stod tidigare som en literal här och ingenstans i schemat, alltså kunde
// klienten beskriva ett utskick servern avvisade.
