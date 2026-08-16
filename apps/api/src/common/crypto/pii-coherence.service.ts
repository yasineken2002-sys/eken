import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap } from '@nestjs/common'
import * as Sentry from '@sentry/nestjs'
import { PrismaService } from '../prisma/prisma.service'
import { SigningCryptoService } from '../../signing/signing-crypto.service'

/**
 * Samhörighetskontroll vid uppstart: hör SIGNING_PII_KEY/SIGNING_PII_PEPPER
 * fortfarande ihop med datan?
 *
 * `env.validation.ts` validerar bara FORM (64 hex-tecken, ≥16 tecken). Ett
 * rutinmässigt "rotera secrets"-svep passerar den obemärkt och lämnar varje
 * `personalNumberHash` bunden till en död pepper — blind-indexet slutar matcha
 * och signeringens identitetsbindning avvisar legitima signerare
 * (`signing.service.ts:245`). Rotationsverktyget finns
 * (`scripts/rotate-pii-secrets.ts`), men det HJÄLPER BARA DEN SOM VET ATT DET
 * BEHÖVS. Hotet är precis den som inte tänker på hashar — och den personen kör
 * ingen torrkörning. Därför en kontroll som larmar av sig själv.
 *
 * VARNING, INTE FAIL-FAST — i dag. En missmatchning gör inte appen osäker, bara
 * trasig i en väg som saknar produktionsanropare: `SIGNING_ENABLED` är inte satt
 * (Stub-provider, API-ytan inert) och `PersonalNumberService.index()` har noll
 * skarpa anropare. Att vägra starta vore oproportionerligt. Jämför #466, där
 * fail-fast var rätt därför att appen annars KÖR med en känd svag hemlighet.
 *
 * ┌─ BEFORDRAN — villkorad av en händelse, inte av ett datum ──────────────────┐
 * │ NÄR `SIGNING_ENABLED=true` SÄTTS SKA DEN HÄR KONTROLLEN BLI FAIL-FAST.     │
 * │                                                                            │
 * │ Då bär peppern en aktiv säkerhetsfunktion: identitetsbindningen mellan     │
 * │ BankID-personnummer och hyresgäst går genom blind-indexet, och en          │
 * │ missmatchning gör den obrukbar — signeringar avvisas eller, värre, en      │
 * │ begäran fryst med gammal hash matchar ingen. Att vägra starta är då        │
 * │ proportionerligt, precis som `signing.module.ts` redan vägrar starta när   │
 * │ flaggan är på men nycklarna saknas.                                        │
 * │                                                                            │
 * │ Mönstret att återanvända är #454:s: kontrollen i två lager, och villkoret  │
 * │ bundet till KÖRNINGSLÄGET (flaggan) — aldrig till en egen av/på-variabel,  │
 * │ eftersom en sådan är en väg att stänga av kontrollen utan att något blir   │
 * │ rött.                                                                      │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * NÄR DEN BEFORDRAS: `ROTATION_PAGAR` ska INTE ingå i det som fäller starten.
 * Att vägra boota mitt i en nyckelrotation vore att ta bort själva det
 * nedtidsfria fönster #469 byggdes för — appen ska starta, läsningen fungerar
 * via `_OLD`, och signalen är en varning tills rotationen är klar. Det är
 * `MISSMATCHNING` och `KAN_EJ_VERIFIERAS` som ska fälla.
 *
 * KOSTNAD: EN dekryptering per boot i normalfallet. Kontrollen läser EN rad —
 * den första källan som har en, sedan slutar den leta. Inte en rad per tabell,
 * inte en dekryptering per rad.
 *
 * Bara när den aktuella nyckeln INTE läser raden görs fler försök (som mest tre
 * AES-operationer totalt), för att skilja en pågående rotation från en felaktig
 * nyckel. Det är ett undantagsläge vid uppstart, inte normalfallet.
 */

export type PiiCoherenceStatus = 'OK' | 'ROTATION_PAGAR' | 'MISSMATCHNING' | 'KAN_EJ_VERIFIERAS'

export type PiiCoherenceReason =
  | 'HASH_MATCHAR_PEPPER'
  | 'HASH_MATCHAR_INTE_PEPPER'
  | 'CHIFFERTEXT_LASES_INTE_MED_NYCKELN'
  | 'CHIFFERTEXT_LASES_VIA_GAMLA_NYCKELN'
  | 'NYCKLAR_SAKNAS'
  | 'INGA_KONTROLLERBARA_RADER'
  | 'KONTROLLEN_KUNDE_INTE_KORAS'

export interface PiiCoherenceOutcome {
  status: PiiCoherenceStatus
  reason: PiiCoherenceReason
  /** Tabellen sonderingsraden kom från. Aldrig ett rad-id, aldrig ett värde. */
  source: string | null
}

/** De två kolumnerna kontrollen behöver. Inget rad-id — det ska inte kunna loggas. */
export interface PiiProbeRow {
  personalNumberEnc: string | null
  personalNumberHash: string | null
}

/** En tabell att söka en kontrollerbar rad i. */
export interface PiiProbeSource {
  table: string
  findFirst(): Promise<PiiProbeRow | null>
}

/** Den lilla del av SigningCryptoService kontrollen faktiskt använder. */
export interface PiiCoherenceCrypto {
  readonly configured: boolean
  /**
   * Dekryptering med ENBART den aktuella nyckeln. Kontrollens huvudfråga —
   * `decrypt` duger inte, eftersom den kan lyckas via `SIGNING_PII_KEY_OLD`.
   */
  decryptWithCurrentKey(enc: string): string
  /** Läsning med fallback. Används bara för att SKILJA rotation från fel nyckel. */
  decrypt(enc: string): string
  blindIndex(personalNumber: string): string
}

const MANSKLIG_TEXT: Record<PiiCoherenceReason, string> = {
  HASH_MATCHAR_PEPPER: 'blind-indexet stämmer med peppern',
  HASH_MATCHAR_INTE_PEPPER:
    'blind-indexet stämmer INTE med SIGNING_PII_PEPPER — peppern har bytts utan att hasharna räknats om. ' +
    'Kör scripts/rotate-pii-secrets.ts --mode=pepper, eller återställ den gamla peppern.',
  CHIFFERTEXT_LASES_INTE_MED_NYCKELN:
    'chiffertexten går inte att dekryptera med SIGNING_PII_KEY — nyckeln har bytts utan omkryptering. ' +
    'Återställ den gamla nyckeln; utan den är datan inte återvinningsbar.',
  CHIFFERTEXT_LASES_VIA_GAMLA_NYCKELN:
    'raden läses med SIGNING_PII_KEY_OLD, inte med den aktuella nyckeln — en nyckelrotation är ' +
    'påbörjad men inte slutförd. Kör scripts/rotate-pii-secrets.ts --mode=key tills en torrkörning ' +
    'ger 0 ATT_ROTERA, och ta INTE bort _OLD innan dess.',
  NYCKLAR_SAKNAS: 'SIGNING_PII_KEY/SIGNING_PII_PEPPER saknas eller har fel form',
  INGA_KONTROLLERBARA_RADER:
    'ingen rad bär både chiffertext och blind-index, så ingenting kunde prövas',
  KONTROLLEN_KUNDE_INTE_KORAS: 'kontrollen kunde inte köras (se serverlogg för detalj)',
}

/**
 * Tabellerna som bär paret (chiffertext, blind-index), i den ordning de söks.
 *
 * `Tenant` först: det är den enda tabell som har rader i produktion i dag, så
 * kontrollen träffar normalt på första försöket. Ordningen är en
 * prestandadetalj — vilken källa som helst duger som sondering, eftersom alla
 * tre delar nyckel OCH pepper (se `personal-number.service.ts`).
 *
 * `SigningRequest.requiredRoles` står medvetet UTANFÖR: den bär en fryst hash
 * utan chiffertext, alltså finns ingen klartext att pröva mot. Den kan inte
 * kontrolleras här och kan inte heller roteras — se rotate-pii-secrets.ts.
 */
export function buildProbeSources(prisma: PrismaService): PiiProbeSource[] {
  const select = { personalNumberEnc: true, personalNumberHash: true } as const
  const where = {
    personalNumberEnc: { not: null },
    personalNumberHash: { not: null },
  } as const

  return [
    { table: 'Tenant', findFirst: () => prisma.tenant.findFirst({ where, select }) },
    { table: 'Customer', findFirst: () => prisma.customer.findFirst({ where, select }) },
    // Kolumnerna är NOT NULL här, så inget where behövs.
    {
      table: 'SignatureEvidence',
      findFirst: () => prisma.signatureEvidence.findFirst({ select }),
    },
  ]
}

/**
 * Läser EN kontrollerbar rad och avgör om nyckel + pepper hör ihop med den.
 *
 * Fyra utfall, ingen fallback till "anta att det är bra":
 *
 * | Läge                                                      | Utfall              |
 * |-----------------------------------------------------------|---------------------|
 * | aktuell nyckel läser raden OCH hashen matchar peppern     | `OK`                |
 * | aktuell nyckel läser INTE raden, men `_OLD` gör det       | `ROTATION_PAGAR`    |
 * | hashen matchar inte peppern (oavsett vilken nyckel)       | `MISSMATCHNING`     |
 * | ingen nyckel läser raden                                   | `MISSMATCHNING`     |
 * | nycklar saknas / ingen rad / läsfel                        | `KAN_EJ_VERIFIERAS` |
 *
 * `ROTATION_PAGAR` är det enda icke-OK-utfall som inte är ett fel: det är det
 * mellanläge #469 medvetet gjorde möjligt, och det ska synas utan att larma som
 * en defekt. Det är INTE ett `OK` — den aktuella nyckeln är oprövad mot datan,
 * och försvinner `_OLD` innan rotationen är klar slutar läsningen fungera.
 *
 * `KAN_EJ_VERIFIERAS` är INTE ett mildare `OK`. Det är frånvaron av ett besked,
 * och larmas lika högt (se `report`) — annars blir kontrollen tyst verkningslös
 * den dag tabellerna är tomma, precis den no-op ingen upptäcker.
 */
export async function classifyPiiCoherence(
  sources: readonly PiiProbeSource[],
  crypto: PiiCoherenceCrypto,
): Promise<PiiCoherenceOutcome> {
  if (!crypto.configured) {
    return { status: 'KAN_EJ_VERIFIERAS', reason: 'NYCKLAR_SAKNAS', source: null }
  }

  for (const source of sources) {
    const row = await source.findFirst()
    if (!row?.personalNumberEnc || !row.personalNumberHash) continue

    // DEKRYPTERINGSRUNDTUREN (#472). Med `crypto.decrypt` här hade den AKTUELLA
    // nyckeln aldrig prövats: sedan #469 faller den tillbaka på
    // SIGNING_PII_KEY_OLD, så ett `OK` kunde lika gärna komma därifrån. Exakt
    // det läget mättes 2026-08-15 — kontrollen svarade OK medan varningen från
    // [signing-crypto] visade att läsningen gick via _OLD.
    let plaintext: string
    let viaGammalNyckel = false
    try {
      plaintext = crypto.decryptWithCurrentKey(row.personalNumberEnc)
    } catch {
      // SMAL, KLASSIFICERANDE catch — inte en svald signal. AES-256-GCM med fel
      // nyckel KASTAR på authTag (den returnerar aldrig skräp), så kastet ÄR
      // svaret: den aktuella nyckeln hör inte ihop med raden.
      //
      // Men två helt olika lägen döljer sig bakom det kastet, och de får inte
      // rapporteras likadant: en pågående rotation (legitim, _OLD bär raden) och
      // en felaktig nyckel utan väg tillbaka (dataförlust). Fallbacken frågas
      // därför EN gång till — inte för att läsa datan, utan för att skilja dem åt.
      try {
        plaintext = crypto.decrypt(row.personalNumberEnc)
        viaGammalNyckel = true
      } catch {
        return {
          status: 'MISSMATCHNING',
          reason: 'CHIFFERTEXT_LASES_INTE_MED_NYCKELN',
          source: source.table,
        }
      }
    }

    // Pepper-kontrollen gäller OAVSETT vilken nyckel som bar raden. En trasig
    // pepper är ett verkligt fel även mitt i en rotation, och ska inte kunna
    // gömma sig bakom det mildare rotationsutfallet — därför prövas den först.
    if (crypto.blindIndex(plaintext) !== row.personalNumberHash) {
      return { status: 'MISSMATCHNING', reason: 'HASH_MATCHAR_INTE_PEPPER', source: source.table }
    }

    // EN rad räcker. Vi returnerar här oavsett utfall — vi letar inte vidare
    // efter en rad som råkar matcha.
    return viaGammalNyckel
      ? {
          status: 'ROTATION_PAGAR',
          reason: 'CHIFFERTEXT_LASES_VIA_GAMLA_NYCKELN',
          source: source.table,
        }
      : { status: 'OK', reason: 'HASH_MATCHAR_PEPPER', source: source.table }
  }

  return { status: 'KAN_EJ_VERIFIERAS', reason: 'INGA_KONTROLLERBARA_RADER', source: null }
}

@Injectable()
export class PiiCoherenceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PiiCoherenceService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SigningCryptoService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.report(await this.run())
  }

  /**
   * Kör kontrollen och översätter ETT oväntat fel till ett utfall.
   *
   * Det här är inte ett try/catch som gör kontrollen till en no-op — den fällan
   * beskrivs i #466:s PR-text och är exakt vad som gör en kontroll grön för
   * alltid. Kastet blir `KONTROLLEN_KUNDE_INTE_KORAS`, som larmar lika högt som
   * en missmatchning. Skillnaden mot att svälja är att tystnad aldrig är ett
   * möjligt utfall: varje väg härifrån går genom `report`.
   */
  private async run(): Promise<PiiCoherenceOutcome> {
    try {
      return await classifyPiiCoherence(buildProbeSources(this.prisma), this.crypto)
    } catch (err) {
      // Full detalj lokalt. Frågan bär inga PII-parametrar (den filtrerar på
      // `not: null`), så meddelandet kan inte innehålla ett personnummer.
      this.logger.error(
        `[pii-coherence] kontrollen kastade: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      )
      return { status: 'KAN_EJ_VERIFIERAS', reason: 'KONTROLLEN_KUNDE_INTE_KORAS', source: null }
    }
  }

  /**
   * Larmar. BARA `OK` är tyst — allt annat rapporteras, alltid.
   *
   * Att `MISSMATCHNING` och `KAN_EJ_VERIFIERAS` delar kodväg OCH nivå är med
   * flit: det är strukturen som gör kravet sant, inte en kommentar om att de ska
   * vara lika högljudda. Ingen av dem får bli ett mildare besked.
   *
   * `ROTATION_PAGAR` är det enda undantaget, och det är ett medvetet sådant: en
   * påbörjad nyckelrotation är ett läge #469 gjorde möjligt med avsikt, inte en
   * defekt. Den rapporteras därför på `warning` i stället för `error` — men den
   * går samma väg och kan inte bli tyst. Nivån är det enda som skiljer.
   *
   * Sentry, inte bara loggen: en `console.error` i Railway läses av ingen, och
   * en varning som ingen läser är inte en kontroll. Mönstret speglar
   * `cron-safety.ts` — full detalj till den lokala loggen, ett skrubbat
   * syntetiskt fel till Sentry.
   */
  report(outcome: PiiCoherenceOutcome): void {
    if (outcome.status === 'OK') {
      this.logger.log(`[pii-coherence] OK — ${MANSKLIG_TEXT[outcome.reason]} (${outcome.source})`)
      return
    }

    const text = `[pii-coherence] ${outcome.status}: ${MANSKLIG_TEXT[outcome.reason]}`
    const nivå = outcome.status === 'ROTATION_PAGAR' ? 'warning' : 'error'
    // Lokal kanal FÖRST, så larmet finns även om Sentry inte är konfigurerat
    // eller själv fallerar.
    if (nivå === 'warning') this.logger.warn(text)
    else this.logger.error(text)

    try {
      Sentry.captureException(new Error(text), {
        level: nivå,
        tags: {
          check: 'pii-coherence',
          status: outcome.status,
          reason: outcome.reason,
          source: outcome.source ?? '(ingen)',
        },
      })
    } catch (err) {
      // Rapportera ATT rapporteringen fallerade — svälj den inte.
      this.logger.error(
        `[pii-coherence] Sentry-rapporteringen misslyckades, larmet nådde bara loggen: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}
