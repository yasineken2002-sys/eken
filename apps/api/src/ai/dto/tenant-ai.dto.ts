import { IsBoolean, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

import type { SammaNycklar, TenantChatInput, TenantConfirmInput } from '@eken/shared'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'

/**
 * HYRESGÄSTENS AI-YTA — två DTO:er, flyttade hit ur `tenant-ai.controller.ts`.
 *
 * Samma skäl som `tenant-portal/dto/tenant-auth.dto.ts`: en validerad klass som
 * bor i en controller är osynlig för kontraktsvakten, som bara läser `*.dto.ts`.
 *
 * TAKET PÅ `message` är inte kosmetiskt. Fältet går rakt in i en modellprompt,
 * och med Fastifys standardgräns på 1 MiB är kostnaden per meddelande obunden
 * uppåt utan det. Samma slag som `description` i #828.
 */

export class TenantChatDto implements TenantChatInput {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @StrictString()
  message!: string

  @IsOptional()
  @IsString()
  @StrictString()
  conversationId?: string
}

export class TenantConfirmDto implements TenantConfirmInput {
  @IsString()
  @MinLength(1)
  @StrictString()
  toolName!: string

  /**
   * Argumenten till verktyget `toolName` namnger. Avsiktligt en fri karta —
   * formerna är verktygens egna, och att räkna upp dem här hade blivit en andra
   * uppräkning av verktygsregistret. Verktyget validerar sina egna argument.
   */
  @IsObject()
  toolInput!: Record<string, unknown>

  @IsString()
  @MinLength(1)
  @StrictString()
  conversationId!: string

  /**
   * ── @Transform ÄR SPÄRREN, INTE @IsBoolean ──────────────────────────────
   *
   * Den globala pipen kör `transform: true` med `enableImplicitConversion: true`
   * (`main.ts`). class-transformer läser då TS-typen `boolean` och kör
   * `Boolean(värdet)` INNAN `@IsBoolean()` ser något. `Boolean('false')` är
   * `true` i JavaScript, så strängen `"false"` blev ett JA. Uppmätt mot den
   * riktiga pipen:
   *
   *     confirmed="false"  zod=AVVISADE  dto=SLÄPPTE IGENOM → true
   *     confirmed="0"      zod=AVVISADE  dto=SLÄPPTE IGENOM → true
   *     confirmed="no"     zod=AVVISADE  dto=SLÄPPTE IGENOM → true
   *     confirmed=""       zod=AVVISADE  dto=SLÄPPTE IGENOM → false
   *
   * Fältet är hyresvärdens — här hyresgästens — uttryckliga ja till att en
   * AI-föreslagen handling ska utföras. Ett "vet ej" som blir ett ja är den
   * enda riktning som inte får finnas, och `@IsBoolean()` ensamt kunde inte
   * hindra den: den validerar det REDAN KONVERTERADE värdet.
   *
   * `@Transform(({ value }) => value)` lämnar värdet orört, så `@IsBoolean()`
   * ser strängen och avvisar den. Att de två halvorna nu svarar likadant bevisas
   * av `ogiltigKoercion`-fallet i KONTRAKTSREGISTER — utan det är fixen
   * obevisad nästa gång fältet flyttas.
   */
  @IsBoolean()
  @StrictBoolean()
  confirmed!: boolean
}

const _kontraktChatt: SammaNycklar<TenantChatDto, TenantChatInput> = true
const _kontraktBekraftelse: SammaNycklar<TenantConfirmDto, TenantConfirmInput> = true
void _kontraktChatt
void _kontraktBekraftelse
