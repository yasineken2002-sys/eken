import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { PrismaService } from '../../common/prisma/prisma.service'
import { CronErrorSink } from '../../common/cron/cron-error-sink'
import { runCronSafely } from '../../common/cron/cron-safety'
import { LockService } from '../../common/redis/lock.service'

/**
 * ÅTERUPPTAGNINGSMOTORNS TYSTNAD — larmar på ÅLDER, inte på fel (#678).
 *
 * ── PROBLEMET, OCH VARFÖR DET INTE SYNS AV SIG SJÄLVT ───────────────────────
 *
 * Motorn skriver en `AiResumptionRun` även när den inte gjorde något — det är
 * hela poängen med hjärtslaget. Men ingenting läser raderna, och en motor som
 * SLUTAT köra ser då exakt likadan ut som en motor som avstod från allt:
 *
 *     "motorn avstod från allt"   ← normalt, och det vanliga utfallet
 *     "motorn kördes aldrig"      ← trasigt
 *
 * Båda är tystnad. Den här tjänsten är det enda som skiljer dem åt.
 *
 * ── FORMEN ÄR LÅNAD FRÅN BackupFreshnessService ─────────────────────────────
 *
 * Samma problem, samma form: ett rent `bedöm()` som returnerar ett strukturerat
 * utfall (ålder, tröskel, flagga), och ett `check()` som larmar. Skälet att
 * låna är mätt: backupen var avstängd i 45 dagar utan att någon märkte det,
 * eftersom en backup som aldrig körs aldrig kan misslyckas. Motorn har exakt
 * samma felform.
 *
 * ── INGEN NY KANAL ──────────────────────────────────────────────────────────
 *
 * Larmet går till `CronErrorSink` → `ErrorLog`, som redan finns och är
 * varaktig. Den lokala loggen överlever inte containern, och under 30 dagar
 * skedde 204 merges till main — ett larm från förra veckan hade inte funnits
 * kvar att fråga efter.
 */

/**
 * TRÖSKELN — ETT BESLUT, INTE EN HÄRLEDNING.
 *
 * Talet är skrivet som en literal och får INTE räknas fram ur `HJARTSLAG_MS`.
 * Skälet är samma som för uppdragens deadline (`check-assignment-deadline.mjs`):
 * två gränser som ska kunna ändras var för sig får inte vara en gräns. Hade
 * tröskeln varit `2 * HJARTSLAG_MS` hade en ändring av hjärtslaget flyttat
 * larmet utan att något blev rött.
 *
 * ── VAD SOM FAKTISKT BINDER, OCH DET ÄR INTE KADENSEN ───────────────────────
 *
 * Motorn kör VARJE MINUT, men en minut är fel utgångspunkt. Vad som skrivs
 * styrs av `skallSkrivaKörning`: en rad när det fanns något att säga, OCH minst
 * en gång per `HJARTSLAG_MS` (en timme) ändå.
 *
 * I produktion i dag skrivs en rad varje minut — men BARA därför att det finns
 * 11 rader med `completedAt = null` som aldrig kommer att stängas, så
 * `antalBedömda > 0` alltid. Den premissen är lånad: stänger eller gallrar
 * någon de elva raderna faller skrivfrekvensen till en gång i timmen, och en
 * tröskel satt efter det OBSERVERADE intervallet hade då larmat falskt varje
 * timme.
 *
 * Tröskeln sätts därför efter det GARANTERADE intervallet — hjärtslaget — och
 * inte efter det observerade.
 *
 * ── VARFÖR 2 TIMMAR 15 MINUTER ──────────────────────────────────────────────
 *
 *   2 h    två hjärtslagsfönster. EN missad puls tolereras, TVÅ gör det inte —
 *          samma regel som `BACKUP_MAX_AGE_DAYS = 1` ("en missad natt
 *          tolereras, inte två"). Ett larm på en enda missad puls är brus:
 *          pulsen kan hamna på fel sida av ett fönster av rena tidsskäl.
 *
 *  15 min  marginal mot ett verkligt avbrott. Ett Railway-omstartsvarv mättes
 *          till 90–165 s 2026-09-02. 15 minuter är ~5× det längsta, så en
 *          deploy PLUS en omstart PLUS ett långsamt pass i följd fortfarande
 *          inte kan fälla larmet.
 *
 * ⚠️ DEN HÄR TRÖSKELN KAN INTE BLI SNABBARE ÄN HJÄRTSLAGET. Vill man upptäcka
 * en död motor inom en timme är hjärtslaget spaken, inte tröskeln — och det är
 * ett eget beslut med en egen kostnad (`HJARTSLAG_MS` sattes till en timme för
 * att 1 440 rader per dygn "ingenting hände" är en annan sorts tystnad; vid 15
 * minuter blir det 96). Sänk inte den här tröskeln under hjärtslaget: provet
 * `resumption-freshness.spec.ts` fäller det, eftersom resultatet vore ett larm
 * som går varje timme på en frisk motor.
 */
export const ATERUPPTAGNING_TYSTNAD_MAX_MS = 2 * 60 * 60 * 1000 + 15 * 60 * 1000

/** Hur ofta tystnaden prövas. Tätt nog för upplösning, glest nog att inte kosta. */
const KADENS = '*/15 * * * *'

/** Låsets livslängd. Kontrollen är två frågor mot databasen. */
const LAS_TTL_SEC = 60

export interface TystnadsUtfall {
  /** Millisekunder sedan senaste körningsrad. `null` = ingen rad finns alls. */
  ageMs: number | null
  tröskelMs: number
  tyst: boolean
  /** Fanns det någon körningsrad överhuvudtaget? */
  harNågonKörning: boolean
}

/**
 * Domen om tystnaden. Ren funktion — ingen databas, inga sidoeffekter.
 *
 * ── "INGEN RAD ALLS" ÄR LIKA HÖGLJUTT SOM "GAMMAL RAD" ──────────────────────
 *
 * `senaste = null` betyder att motorn aldrig skrivit något. Det är INTE ett
 * ofarligt startläge som ska tolereras: motorn skriver ett hjärtslag direkt
 * efter en omstart (`senasteHjärtslag` är 0 i minnet, med flit), så en tom
 * tabell efter mer än ett kvarts drift betyder att motorn aldrig kom igång.
 *
 * Att låta `null` passera vore samma defekt som backupens: "det finns ingen
 * backup" hade sett friskare ut än "backupen är gammal".
 */
export function bedömTystnad(
  senaste: Date | null,
  nu: Date,
  tröskelMs: number = ATERUPPTAGNING_TYSTNAD_MAX_MS,
): TystnadsUtfall {
  if (senaste === null) {
    return { ageMs: null, tröskelMs, tyst: true, harNågonKörning: false }
  }
  const ageMs = nu.getTime() - senaste.getTime()
  return { ageMs, tröskelMs, tyst: ageMs > tröskelMs, harNågonKörning: true }
}

@Injectable()
export class ResumptionFreshnessService {
  private readonly logger = new Logger(ResumptionFreshnessService.name)

  /**
   * Processlokal dämpning: samma tillstånd larmas inte om och om igen var
   * femtonde minut. Samma avvägning som BackupFreshness — en omstart ger ett
   * larm till, vilket är fel håll att fela på och alltså rätt håll.
   */
  private senastLarmadSignatur: string | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly cronErrors: CronErrorSink,
  ) {}

  // ── KLASSIFICERING: A — LÅST (cron:ai-resumption-freshness) ───────────────
  @Cron(KADENS)
  async passera(): Promise<void> {
    const utfall = await this.locks.runIfUnlocked(
      'cron:ai-resumption-freshness',
      () => this.passeraUnsafe(),
      { ttlSec: LAS_TTL_SEC },
    )
    if (!utfall.ran) {
      // Ett tyst överhopp är oskiljbart från "cronen kördes aldrig" — vilket
      // vore en särskilt dålig felform i just den här tjänsten.
      this.logger.log(
        `[cron:ai-resumption-freshness] Kördes redan av en annan replik — hoppar över. ` +
          `Låset hållet i ${utfall.heldForSec ?? '?'} s av ${LAS_TTL_SEC} s.`,
      )
    }
  }

  /**
   * ETT KAST I `check()` MÅSTE OCKSÅ NÅ SÄNKAN — och det är inte samma sak som
   * larmet.
   *
   * `check()` rapporterar när motorn TYSTNAT. Men om `check()` självt kastar —
   * databasen nere, en trasig fråga — är det ett fel i DETEKTORN, och utan det
   * här höljet hade det bara nått containerns logg. Då hade det som ska upptäcka
   * tystnad tystnat, vilket är exakt felformen hela ärendet handlar om.
   *
   * Fångat av `check-cron-error-sink.mjs`, inte av läsning.
   */
  private async passeraUnsafe(): Promise<void> {
    await runCronSafely('ai-resumption-freshness', () => this.check(), {
      logger: this.logger,
      sink: this.cronErrors,
    })
  }

  /**
   * @param nu injiceras av proven.
   * @returns utfallet, så en anropare kan mäta utan att läsa loggen.
   */
  async check(nu: Date = new Date()): Promise<TystnadsUtfall> {
    const senaste = await this.senasteKörning()
    const utfall = bedömTystnad(senaste, nu)

    if (!utfall.tyst) {
      this.senastLarmadSignatur = null
      return utfall
    }

    // Signaturen är GROV med flit: den ska dämpa upprepning, inte dölja att
    // tillståndet förvärras. Ålder i hela timmar räcker — går motorn från 3 till
    // 4 timmars tystnad är det ett nytt larm, men inte var femtonde minut.
    const signatur = utfall.harNågonKörning
      ? `tyst:${Math.floor((utfall.ageMs ?? 0) / (60 * 60 * 1000))}h`
      : 'ingen-körning'
    if (signatur === this.senastLarmadSignatur) return utfall
    this.senastLarmadSignatur = signatur

    const text = utfall.harNågonKörning
      ? `Återupptagningsmotorn har inte skrivit en körningsrad på ${Math.round((utfall.ageMs ?? 0) / 60_000)} min ` +
        `(tröskel ${Math.round(utfall.tröskelMs / 60_000)} min). Motorn kan ha slutat köra — ` +
        `"avstod från allt" och "kördes aldrig" är annars samma tystnad.`
      : `Återupptagningsmotorn har ALDRIG skrivit en körningsrad. Den skriver ett hjärtslag ` +
        `direkt efter omstart, så en tom tabell betyder att den aldrig kom igång.`

    // `report` kastar aldrig och väntar in skrivningen. Ingen ny kanal.
    await this.cronErrors.report('ai-resumption-freshness', new Error(text), {
      detail: {
        ageMs: utfall.ageMs,
        tröskelMs: utfall.tröskelMs,
        harNågonKörning: utfall.harNågonKörning,
      },
    })
    return utfall
  }

  /** Senaste körningsradens starttid, eller null om ingen finns. */
  async senasteKörning(): Promise<Date | null> {
    const rad = await this.prisma.aiResumptionRun.findFirst({
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    })
    return rad?.startedAt ?? null
  }
}
