import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Public } from '../../common/decorators/public.decorator'
import { PlatformGuard } from '../auth/platform.guard'
import { PlatformErrorsService } from './platform-errors.service'
import { CreateFrontendErrorDto } from './dto/error-log.dto'

@ApiTags('Platform / Errors')
@Controller('platform/errors')
export class PlatformErrorsController {
  constructor(private readonly svc: PlatformErrorsService) {}

  /**
   * Frontend-felrapportering — NUMERA BAKOM PLATTFORMS-JWT (#612).
   *
   * ── VARFÖR DEN ÖPPNA FORMEN INTE GICK ATT BEHÅLLA ──────────────────────────
   *
   * Rutten bar tidigare `@Public()` UTAN `PlatformGuard`, alltså helt
   * oautentiserad. Den skrev fri text (`message`, `stack`, `context`) med ett
   * KLIENTVALT `organizationId` in i `ErrorLog` — en tabell som varje
   * plattformsadmin läser i klartext och som (i skrivande stund) inte gallras.
   * Strypningen är 100 req/60 s per IP, vilket ger en enskild avsändare
   * storleksordningen 10^5 rader per dygn.
   *
   * Syftet — att ett kraschat gränssnitt ska kunna rapportera — är rimligt.
   * Det är FORMEN som inte var det.
   *
   * ── VAD MÄTNINGEN SA ───────────────────────────────────────────────────────
   *
   * Ett enda anropsställe i hela trädet: `apps/admin/src/components/
   * ErrorBoundary.tsx`. `web` och `portal` har egna ErrorBoundary-komponenter
   * som rapporterar till Sentry och ALDRIG hit. Admin är i sin helhet bakom
   * plattformsinloggning, så `PlatformGuard` kostar den ingenting.
   *
   * ── `@Public()` BETYDER INTE "OSKYDDAD" HÄR ────────────────────────────────
   *
   * `JwtAuthGuard` är global och `@Public()` stänger av just den — ORG-JWT:n.
   * Plattformsrutter använder en ANNAN token, så mönstret i den här filen är
   * `@Public()` + `@UseGuards(PlatformGuard)`: hoppa över org-vakten, kräv
   * plattformsvakten. Defekten var att `report` bara hade den första halvan.
   * Ett `@Public()` utan `PlatformGuard` på en `platform/`-rutt är alltså
   * alltid ett fynd — det ser ut som resten av filen men gör motsatsen.
   *
   * Rutten står som oskyddad i `authz-surface.golden.txt`; den raden flyttar
   * sig till PlatformGuard-gruppen i samma commit, och det är beviset.
   */
  @Post('report')
  @Public()
  @UseGuards(PlatformGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Rapportera fel från admin-gränssnittet' })
  async report(@Body() dto: CreateFrontendErrorDto) {
    await this.svc.logFrontendError(dto)
    return null
  }

  /**
   * ── ÖPPEN PUNKT: LÄSNINGEN ÄR INTE GRADERAD (#612) ─────────────────────────
   *
   * `PlatformGuard` skiljer inloggad från inte inloggad. Den skiljer INTE en
   * plattformsanvändare från en annan, eftersom `PlatformUser` inte har något
   * rollfält alls (`schema.prisma`). Varje inloggad plattformsadmin ser därför
   * varje rad för varje organisation, med `message`, `stack` och `context` i
   * klartext — och ingen läsning loggas (`ImpersonationLog` täcker
   * impersonering, inte den här vyn).
   *
   * DET ÄR MEDVETET INTE LÖST HÄR. I dag finns två plattformsanvändare, båda
   * grundare; en rollmodell nu vore arbete mot ett problem som ännu inte finns.
   *
   * VILLKORET, UTSKRIVET: detta ska lösas INNAN någon utanför de två grundarna
   * får admin-inlogg. Den som skapar den tredje plattformsanvändaren äger
   * frågan. Fram till dess är exponeringen begränsad av fristen
   * (`error-log-retention.ts`) och av att skrivvägen är stängd — inte av vem som
   * läser.
   */
  @Get()
  @Public()
  @UseGuards(PlatformGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lista fel-logg' })
  list(
    @Query('severity') severity?: 'CRITICAL' | 'ERROR' | 'WARNING',
    @Query('source') source?: 'API' | 'WEB' | 'PORTAL' | 'ADMIN',
    @Query('resolved') resolved?: string,
    @Query('organizationId') organizationId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.list({
      ...(severity ? { severity } : {}),
      ...(source ? { source } : {}),
      ...(resolved !== undefined ? { resolved: resolved === 'true' } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(page ? { page: parseInt(page, 10) } : {}),
      ...(pageSize ? { pageSize: parseInt(pageSize, 10) } : {}),
    })
  }

  @Post(':id/resolve')
  @Public()
  @UseGuards(PlatformGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Markera fel som löst' })
  resolve(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.resolve(id)
  }

  @Get('summary')
  @Public()
  @UseGuards(PlatformGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Count per severity (för dashboard-badge)' })
  summary() {
    return this.svc.summary()
  }
}
