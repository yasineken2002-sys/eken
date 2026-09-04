import { Controller, Get } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Public } from '../common/decorators/public.decorator'

/**
 * Funktionsflaggor som gränssnitten behöver känna till FÖRE inloggning.
 *
 * ── MÄTNINGEN SOM FÖREGICK ENDPOINTEN ───────────────────────────────────────
 *
 * Det fanns ingen väg alls. `import.meta.env` i de tre SPA:erna används bara till
 * Sentry-DSN, release-sha och en admin-URL; ingen `VITE_*_ENABLED` finns, i något
 * paket. `/v1/health` bär med FLIT bara `revision`, `legalKnowledge` och
 * `resumption` — dess egen kommentar säger att "branch, byggnummer, miljönamn,
 * domäner och tjänste-id:n hör inte hemma i ett svar vem som helst kan hämta",
 * och den är dessutom en Terminus-endpoint som Railway pollar för att avgöra om
 * tjänsten ska startas om. En funktionsflagga hör inte hemma i den.
 *
 * `src/public/` är däremot redan precis det här: en oautentiserad yta som
 * beskriver plattformen för den som ännu inte har ett konto (`PublicPlansController`
 * matar säljsidan med prislistan). Endpointen läggs därför här.
 *
 * ── VARFÖR EN FLAGGA MÅSTE EXPONERAS I STÄLLET FÖR ATT GISSAS ───────────────
 *
 * Alternativet är att alltid visa BankID-knappen och låta Stub-providern svara
 * 503. Det gör felet till användarens: hen trycker på en knapp, väntar, och får
 * ett fel som inte går att skilja från ett trasigt BankID. En knapp som inte kan
 * fungera ska inte finnas — och frontend kan inte veta det utan att fråga.
 *
 * ── VAD SOM FÅR STÅ HÄR ────────────────────────────────────────────────────
 *
 * Bara BOOLEANER om vad som är påslaget. Aldrig ett värde, en URL, ett
 * miljönamn eller något som avslöjar hur tjänsten är konfigurerad. `bankId: true`
 * säger exakt lika mycket som inloggningssidan själv gör när knappen syns.
 *
 * Notera vad `bankId` INTE påstår: att BankID är påslaget säger ingenting om
 * VILKEN provider som valdes. Ett `BANKID_PROVIDER=mock` syns inte här och ska
 * inte göra det — den kombinationen är omöjlig i produktion (appen vägrar starta,
 * se `bankid/bankid-provider-mode.ts`), och att exponera den hade gett en
 * angripare besked om körningsläget utan att hjälpa gränssnittet.
 */
export interface PublicFeatureFlags {
  /** BankID-inloggning påslagen? Styr om knappen visas på inloggningssidan. */
  bankId: boolean
}

@ApiTags('public')
@Controller('public/config')
export class PublicConfigController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Funktionsflaggor som gränssnitten behöver före inloggning' })
  get(): { features: PublicFeatureFlags } {
    return {
      features: {
        // Strikt likhet med 'true', samma regel som modul-factoryn. Två läsningar
        // av samma flagga får inte kunna ge olika svar: vore den här `!== 'false'`
        // hade knappen visats mot en Stub som svarar 503.
        bankId: this.config.get<string>('BANKID_ENABLED') === 'true',
      },
    }
  }
}
