import { Type } from 'class-transformer'
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator'

import type {
  FortnoxRejectionEvidence,
  FortnoxReleaseRejectedInput,
  SammaNycklar,
} from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { IngenKoercion } from '../../common/contract/no-coercion.decorator'

const SHA256 = /^[0-9a-f]{64}$/

/** TESTKUND-016 K3.4: externt 400-kvitto för en äldre avvisning utan lagrad kod (bara OWNER). */
export class FortnoxRejectionEvidenceDto implements FortnoxRejectionEvidence {
  // TESTKUND-027 K4.1 (F-022-1): bara riktiga JSON-heltal. Utan spärren tvingade den globala pipens
  // enableImplicitConversion om "400", "0x190" och " 400 " till tal innan @IsInt prövade dem.
  @IngenKoercion()
  @IsInt()
  @Min(400)
  @Max(499)
  http!: number

  @IngenKoercion()
  @IsInt()
  @Min(1)
  code!: number

  @IsString()
  @StrictString()
  @Matches(SHA256)
  rakvittoSha256!: string

  @IsString()
  @StrictString()
  @Matches(SHA256)
  manifestSha256!: string

  @IsString()
  @StrictString()
  @Matches(SHA256)
  sentPayloadHash!: string
}

/**
 * POST /integrations/fortnox/exports/:id/release-rejected. Servern läser Fortnox före bytet.
 * TESTKUND-027 K4.2 (F-022-2): `avvisningsbevis` får BARA anges för en äldre avvisning utan lagrad
 * kod (lastOutcome 'REJECTED'). Har exporten en lagrad kod används den, och ett medskickat bevis
 * avvisas med 400 i stället för att tyst ignoreras.
 */
export class FortnoxReleaseRejectedDto implements FortnoxReleaseRejectedInput {
  @IsString()
  @StrictString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string

  @IsOptional()
  @ValidateNested()
  @Type(() => FortnoxRejectionEvidenceDto)
  avvisningsbevis?: FortnoxRejectionEvidenceDto
}

/** KOMPILERINGSTIDENS KOPPLING till webben. */
const _kontrakt: SammaNycklar<FortnoxReleaseRejectedDto, FortnoxReleaseRejectedInput> = true
void _kontrakt
const _bevis: SammaNycklar<FortnoxRejectionEvidenceDto, FortnoxRejectionEvidence> = true
void _bevis
