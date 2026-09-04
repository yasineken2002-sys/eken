import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import type { FastifyRequest } from 'fastify'
import type { JwtPayload } from '@eken/shared'

import { CurrentUser } from '../common/decorators/current-user.decorator'
import { Public } from '../common/decorators/public.decorator'
import { BankIdAuthService } from './bankid-auth.service'
// Värde-importer, aldrig `import type`: ValidationPipe läser reflect-metadata i
// runtime, och en typ-import raderas — då försvinner all validering tyst.
import { BankIdChooseDto, BankIdCollectDto } from './dto/bankid.dto'

/**
 * BankID-endpoints. `@Controller('auth')` ger URL:erna `/v1/auth/bankid/*` —
 * samma prefix som lösenordsinloggningen, som sig bör: det är samma sorts
 * handling för den som anropar.
 *
 * ── VARFÖR EN EGEN CONTROLLER OCH INTE RADER I AuthController ─────────────
 *
 * `AuthController` bor i `AuthModule`, och en controller kan bara injicera det
 * som syns i SIN moduls kontext. `BankIdAuthService` bor i `BankidModule`, som
 * i sin tur importerar `AuthModule` (för `issueTokensForUser`). Att lägga
 * endpointsen i `AuthController` hade alltså krävt att `AuthModule` importerar
 * `BankidModule` — en cykel, som bara går att lösa med `forwardRef` åt båda hållen.
 *
 * Att bara importera KLASSEN utan modulimporten duger inte, och det är MÄTT och
 * inte antaget: en minimal reproduktion (controller i modul A, tjänst bara i
 * modul B) ger `Nest can't resolve dependencies`. Värre: `check-module-cycles`
 * ser INTE det felet, eftersom den läser `imports:` och `AuthModule` i det läget
 * inte importerar något alls. Felet hade synts först vid boot.
 *
 * En egen controller under samma prefix ger identiska URL:er, ingen cykel, och
 * inget att deklarera.
 *
 * ── THROTTLING: TVÅ TAK, INTE ETT ────────────────────────────────────────
 *
 * `start` får lösenordsinloggningens tak (5/min) — det är samma sorts handling,
 * ett försök att komma in. `collect` POLLAS med flit under hela BankID-flödet
 * och behöver ett högre tak. Ett gemensamt tak hade antingen strypt en normal
 * pollning eller öppnat starten.
 *
 * ── DEKORATORN ÄR INTE SKYDDET ───────────────────────────────────────────
 *
 * `@Public()` på inloggningsvägarna och inloggningskrav på anslutningen är
 * ytan. Bindningen mellan order och session — CSRF-spärren — ligger i
 * `BankIdAuthService`, som är chokepunkten. Se dess docblock.
 */
@ApiTags('Auth')
@Controller('auth')
export class BankIdController {
  constructor(private readonly bankid: BankIdAuthService) {}

  /** Startar en anslutning av inloggarens BankID till DET HÄR kontot. */
  @Post('bankid/enroll/start')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Starta anslutning av BankID till inloggat konto' })
  enrollStart(@CurrentUser() user: JwtPayload, @Req() req: FastifyRequest) {
    return this.bankid.enrollStart(user.sub, req.ip, new Date())
  }

  /** Pollar anslutningen. Bara den användare som STARTADE ordern får fullborda den. */
  @Post('bankid/enroll/collect')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hämta status för pågående BankID-anslutning' })
  enrollCollect(@CurrentUser() user: JwtPayload, @Body() dto: BankIdCollectDto) {
    return this.bankid.enrollCollect(user.sub, dto.orderRef, new Date())
  }

  @Post('bankid/login/start')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Starta inloggning med BankID' })
  loginStart(@Req() req: FastifyRequest) {
    return this.bankid.loginStart(req.ip, new Date())
  }

  @Post('bankid/login/collect')
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hämta status för pågående BankID-inloggning' })
  loginCollect(@Body() dto: BankIdCollectDto) {
    return this.bankid.loginCollect(dto.orderRef, new Date())
  }

  /** Väljer konto när identiteten är kopplad till flera. Se bankid-choose-token.ts. */
  @Post('bankid/login/choose')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Välj konto efter BankID-inloggning' })
  loginChoose(@Body() dto: BankIdChooseDto) {
    return this.bankid.loginChoose(dto.chooseToken, dto.userId, new Date())
  }
}
