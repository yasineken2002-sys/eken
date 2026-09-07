import { IsEmail, IsOptional, IsString, IsUUID, MinLength } from 'class-validator'

import type {
  BankIdChooseInput,
  BankIdCollectInput,
  SammaNycklar,
  TenantActivateInput,
  TenantForgotPasswordInput,
  TenantLoginInput,
  TenantLogoutInput,
  TenantResetPasswordInput,
} from '@eken/shared'

/**
 * HYRESGÄSTPORTALENS INLOGGNINGSYTA — sju DTO:er.
 *
 * FLYTTADE HIT ur `tenant-portal.controller.ts`, där de var osynliga för
 * kontraktsvakten: `harleddaTyper` i `check-request-contract.mjs` läser bara
 * filer som slutar på `.dto.ts`, så en klass som bor i en controller finns inte
 * i mängden. Vakten sa då inte "saknar schema" — den sa ingenting, och tystnaden
 * såg ut som godkänt. Samma flytt som #825/#828; se `check-dto-placement.mjs`.
 *
 * ── VARFÖR class-validator LIGGER KVAR ──────────────────────────────────────
 *
 * Schemat i @eken/shared beskriver FORMEN, dekoratorerna nedan beskriver
 * GRÄNSERNA i runtime. Att de säger samma sak antas inte: paritetsprovet i
 * KONTRAKTSREGISTER kör samma kropp genom båda och kräver samma svar.
 * `SammaNycklar`-raderna längst ned binder nyckelmängderna vid kompilering —
 * `implements` ensamt hade släppt igenom en DTO som utelämnar ett VALFRITT fält,
 * och det är just det fältet som blir ett 400 den dag portalen börjar skicka det.
 */

export class LoginDto implements TenantLoginInput {
  @IsEmail()
  email!: string

  @IsString()
  @MinLength(1)
  password!: string

  @IsOptional()
  @IsUUID()
  organizationId?: string
}

export class ActivateDto implements TenantActivateInput {
  @IsString()
  @MinLength(1)
  token!: string

  // Lösenordsstyrkan kontrolleras i TenantAuthService.assertStrongPassword.
  @IsString()
  @MinLength(1)
  password!: string

  // Hyresgästens skrivna namnunderskrift vid digital signering. Sparas
  // på Document-raden så signaturen blir spårbar separat från FK-länken
  // till Tenant. VALFRI: rena portal-inbjudningar (massutskick för
  // importerade hyresgäster utan kontrakts-PDF) signerar inget kontrakt och
  // behöver ingen underskrift. Anges den ändå kräver vi minst 2 tecken.
  @IsOptional()
  @IsString()
  @MinLength(2)
  signatureName?: string
}

/**
 * BankID-anropen bär ETT fält: providerns handtag. Ingen tenantId, inget
 * personnummer — servern avgör vem ordern gäller ur uppslaget, och en klient som
 * fick skicka med en identitet hade sett ut som om den bestämde den.
 */
export class BankIdCollectDto implements BankIdCollectInput {
  @IsString()
  @MinLength(1)
  orderRef!: string
}

export class BankIdChooseDto implements BankIdChooseInput {
  @IsString()
  @MinLength(1)
  chooseToken!: string

  /**
   * Hyresgästraden användaren valde. Får BARA vara en av dem som signerades i
   * `chooseToken` — kontrollen ligger i `TenantBankIdService.choose`, inte här:
   * en DTO kan bara se formen, aldrig vilka id som var kandidater.
   */
  @IsUUID()
  tenantId!: string
}

export class DeleteAccountDto {
  @IsString()
  @MinLength(1)
  password!: string
}

export class ForgotPasswordDto implements TenantForgotPasswordInput {
  @IsEmail()
  email!: string
}

export class ResetPasswordDto implements TenantResetPasswordInput {
  @IsString()
  @MinLength(1)
  token!: string

  // Lösenordsstyrkan kontrolleras i TenantAuthService.assertStrongPassword.
  @IsString()
  @MinLength(1)
  password!: string
}

/**
 * POST /tenant-portal/logout — HADE INGEN DTO ALLS.
 *
 * Hanteraren tog `@Body() body: { sessionToken?: string }`. En inline-typ
 * försvinner i runtime, så `ValidationPipe` hade ingen metadata att läsa och
 * validerade INGENTING: varken formen, typen eller okända nycklar. Klassen finns
 * för att göra `forbidNonWhitelisted` verksam på endpointen.
 *
 * Fältet är fortfarande VALFRITT — en utloggning utan token är ett giltigt
 * anrop, och hanteraren gör då ingenting. Det som ändras är att allt annat nu
 * avvisas i stället för att passera.
 */
export class LogoutDto implements TenantLogoutInput {
  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionToken?: string
}

// `DeleteAccountDto` har med flit INGEN paritetsrad: den betjänar
// DELETE /portal/account, som portalen anropar utan JSON-kropp via `del()`.
// Kontraktsvakten mäter POST/PATCH/PUT, så det finns ingen webbhalva att binda.
// Klassen flyttades hit ändå — placeringsregeln gäller varje validerad klass.
const _kontraktLogin: SammaNycklar<LoginDto, TenantLoginInput> = true
const _kontraktAktivera: SammaNycklar<ActivateDto, TenantActivateInput> = true
const _kontraktCollect: SammaNycklar<BankIdCollectDto, BankIdCollectInput> = true
const _kontraktChoose: SammaNycklar<BankIdChooseDto, BankIdChooseInput> = true
const _kontraktGlomt: SammaNycklar<ForgotPasswordDto, TenantForgotPasswordInput> = true
const _kontraktAterstall: SammaNycklar<ResetPasswordDto, TenantResetPasswordInput> = true
const _kontraktUtloggning: SammaNycklar<LogoutDto, TenantLogoutInput> = true
void _kontraktLogin
void _kontraktAktivera
void _kontraktCollect
void _kontraktChoose
void _kontraktGlomt
void _kontraktAterstall
void _kontraktUtloggning
