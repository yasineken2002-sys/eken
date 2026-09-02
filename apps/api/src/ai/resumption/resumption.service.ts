import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { PrismaService } from '../../common/prisma/prisma.service'
import { CronErrorSink } from '../../common/cron/cron-error-sink'
import { runCronSafely } from '../../common/cron/cron-safety'
import { LockService } from '../../common/redis/lock.service'
import { AiQuotaService } from '../usage/ai-quota.service'
import {
  ATERUPPTAGNING_TAK_MS,
  bedöm,
  skallSkrivaKörning,
  ärUtåldrad,
  SKAL_TEXT,
} from './resumption-policy'

import type { Dom, PåbörjadKörning } from './resumption-policy'
import type { ResumptionReason } from '@prisma/client'

/**
 * ÅTERUPPTAGNINGSMOTORN — SKUGGLÄGE.
 *
 * ── DEN HÄR TJÄNSTEN KAN INTE UTFÖRA NÅGONTING ──────────────────────────────
 *
 * Det är inte en inställning, det är en avsaknad. Det finns ingen kodväg härifrån
 * till `ToolExecutorService`, ingen import av den, och inget `if (läge ===
 * LIVE)`-block som en flagga kan öppna. Skarpt läge kräver att någon SKRIVER den
 * vägen — och det är ett eget beslut, taget av en människa som sett vad motorn
 * skulle ha gjort mot verkliga rader.
 *
 * `ResumptionMode` finns ändå i schemat, satt till `SHADOW` på varje rad. Skälet
 * är att skuggutfallet ska gå att skilja från skarpt utfall den dag båda finns i
 * samma tabell. Ett fält som tillkommer efteråt gör gamla rader tvetydiga.
 *
 * ── VAD DEN SKRIVER, OCH VARFÖR DET ÄR TVÅ TABELLER ─────────────────────────
 *
 * `AiResumptionVerdict` är listan: en rad per påbörjad körning, med dom och skäl.
 * `AiResumptionRun` är kvittot på att motorn KÖRDE — även när den inte såg
 * något. Utan den andra är "motorn avstod från allt" och "motorn kördes aldrig"
 * samma tystnad, och då har vi byggt precis det tysta stopp som skulle rensas
 * bort.
 *
 * ── KVOTEN GÄLLER, OCH DEN LÄSANDE HALVAN ÄR DEN RÄTTA ──────────────────────
 *
 * `AiQuotaService` är inte undantagen för att anroparen är automatisk. Men
 * `checkQuota()` får INTE anropas härifrån, och det är en mätning och inte en
 * åsikt: den metoden DRAR EN CREDIT från organisationen när månadstaket är nått
 * (`aiCreditsBalance: { decrement: 1 }`). En motor i skuggläge som anropade den
 * hade betalat med kundens pengar för något den aldrig tänkte utföra.
 *
 * Rätt grind är `checkOrgDailyCostCap()`, som är REN LÄSNING (en `aggregate`),
 * gäller manuella och automatiska anrop lika, och vars egen docblock säger att
 * automatiska jobb ska anropa den direkt. Den gäller i skuggläge och i skarpt.
 *
 * Ett kvotstopp är ett SYNLIGT stopp: det blir en `QUOTA_BLOCKED`-dom OCH en rad
 * i cron-felsänkan. Att tyst hoppa över en organisation vore samma defekt en
 * gång till.
 *
 * ── VAD DEN HÄR TJÄNSTEN INTE KAN SE ────────────────────────────────────────
 *
 * Den mäter att omdömet FATTAS och SKRIVS NER. Den kan inte se om omdömet är
 * rätt — det ägs av `resumption-policy.ts` och dess prov. Och den kan inte se om
 * en rad som står påbörjad verkligen misslyckades i världen; ingen tabell vet
 * det. Motorn vilar på verktygens egna idempotensmekanismer, inte på kunskap om
 * utfallet.
 */

/** Hur många rader ett pass bedömer. Ett tak som SYNS — se `körEttPass`. */
export const RESUMPTION_BATCH = 500

/** Hjärtslag: skriv en körningsrad minst så här ofta även när passet var tomt. */
export const HJARTSLAG_MS = 60 * 60 * 1000

/** Låsets livslängd. Passet tar millisekunder; en minut är gott om marginal. */
const LAS_TTL_SEC = 60

export interface PassUtfall {
  runId: string | null
  kandidater: number
  återuppta: number
  avstå: number
  skälFördelning: Partial<Record<ResumptionReason, number>>
}

@Injectable()
export class ResumptionService {
  private readonly logger = new Logger(ResumptionService.name)

  /**
   * Tidpunkten för senast skrivna körningsrad. I minnet med flit: efter en
   * omstart skrivs ett hjärtslag direkt, vilket är önskvärt — det är just efter
   * en deploy man vill se att motorn kom igång igen.
   */
  private senasteHjärtslag = 0

  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: AiQuotaService,
    private readonly locks: LockService,
    // #605 — varaktig felsänka. SIST i listan: nya beroenden läggs till på
    // slutet så befintliga positionsanrop inte tyst byter betydelse.
    private readonly cronErrors: CronErrorSink,
  ) {}

  /**
   * VARJE MINUT, och det är en följd av taket och inte en smaksak.
   *
   * Fönstret är [golv, tak] = [60 s, 5 min]. Tittar motorn mer sällan än var
   * fjärde minut hinner varje rad åldras förbi taket innan den setts, och taket
   * blir i praktiken en spärr mot all återupptagning. I skuggläget märks det
   * inte — ingenting utförs — men skuggmätningen hade då mätt kadensen i stället
   * för omdömet.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async passera(): Promise<void> {
    const utfall = await this.locks.runIfUnlocked(
      'cron:ai-resumption-shadow',
      () => this.passeraUnsafe(),
      {
        ttlSec: LAS_TTL_SEC,
      },
    )
    if (!utfall.ran) {
      // Ett tyst överhopp är oskiljbart från "cronen kördes aldrig".
      this.logger.log(
        `[cron:ai-resumption-shadow] Kördes redan av en annan replik — hoppar över. ` +
          `Låset hållet i ${utfall.heldForSec ?? '?'} s av ${LAS_TTL_SEC} s.`,
      )
    }
  }

  private async passeraUnsafe(): Promise<void> {
    await runCronSafely('ai-resumption-shadow', () => this.körEttPass(), {
      logger: this.logger,
      sink: this.cronErrors,
    })
  }

  /**
   * Ett pass: läs de påbörjade raderna, fäll en dom om var och en, skriv ner.
   *
   * @param nu en och samma tidpunkt för hela passet, så två rader i samma varv
   *           mäts mot samma klocka. Proven injicerar den.
   */
  async körEttPass(nu: Date = new Date()): Promise<PassUtfall> {
    // ── TAKET SYNS, DET KRYMPER INTE TYST ────────────────────────────────────
    //
    // `kandidater` är det SANNA antalet påbörjade rader, räknat separat. Att
    // rapportera `rader.length` hade gjort ett tak till en mätning: passade 500
    // rader in såg det ut som att det fanns 500.
    const kandidater = await this.prisma.aiToolExecution.count({ where: { completedAt: null } })
    const rader = await this.prisma.aiToolExecution.findMany({
      where: { completedAt: null },
      orderBy: { createdAt: 'asc' },
      take: RESUMPTION_BATCH,
      select: {
        id: true,
        organizationId: true,
        toolName: true,
        createdAt: true,
        completedAt: true,
        success: true,
        durationMs: true,
        toolResult: true,
      },
    })
    if (kandidater > rader.length) {
      // Inte ett fel, men ett läge ingen ska behöva gissa sig till.
      await this.cronErrors.report(
        'ai-resumption-shadow',
        new Error(
          `Fler påbörjade rader än passets tak: ${kandidater} funna, ${rader.length} bedömda ` +
            `(tak ${RESUMPTION_BATCH}). Resten bedöms i nästa pass.`,
        ),
        { detail: { kandidater, bedömda: rader.length, tak: RESUMPTION_BATCH } },
      )
    }

    // ── DOMARNA ─────────────────────────────────────────────────────────────
    const domar: Array<{ rad: PåbörjadKörning; dom: Dom }> = []
    for (const r of rader) {
      const rad: PåbörjadKörning = {
        id: r.id,
        organizationId: r.organizationId,
        toolName: r.toolName,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        success: r.success,
        durationMs: r.durationMs,
        harToolResult: r.toolResult !== null,
      }
      domar.push({ rad, dom: bedöm(rad, nu) })
    }

    // ── KVOTGRINDEN, bara för dem som annars skulle återupptagits ───────────
    //
    // En organisation frågas EN gång per pass. Grinden kan bara göra RESUME till
    // ABSTAIN, aldrig tvärtom — den öppnar ingen dörr som omdömet stängt.
    const kvotsvar = new Map<string, boolean>()
    for (const post of domar) {
      if (post.dom.beslut !== 'RESUME') continue
      const org = post.rad.organizationId
      if (!kvotsvar.has(org)) {
        kvotsvar.set(org, await this.harBudget(org))
      }
      if (!kvotsvar.get(org)) {
        post.dom = { beslut: 'ABSTAIN', skäl: 'QUOTA_BLOCKED', ageMs: post.dom.ageMs }
      }
    }

    // ── SKRIV NER ───────────────────────────────────────────────────────────
    const skälFördelning: Partial<Record<ResumptionReason, number>> = {}
    for (const { dom } of domar) {
      skälFördelning[dom.skäl] = (skälFördelning[dom.skäl] ?? 0) + 1
    }
    const återuppta = domar.filter((d) => d.dom.beslut === 'RESUME').length
    const avstå = domar.length - återuppta

    const utfall: PassUtfall = { runId: null, kandidater, återuppta, avstå, skälFördelning }

    const skallSkriva = skallSkrivaKörning({
      antalBedömda: domar.length,
      nu,
      senasteHjärtslag: this.senasteHjärtslag,
      hjärtslagMs: HJARTSLAG_MS,
    })
    if (!skallSkriva) return utfall

    const run = await this.prisma.aiResumptionRun.create({
      data: {
        mode: 'SHADOW',
        startedAt: nu,
        candidates: kandidater,
        resumed: återuppta,
        abstained: avstå,
        reasonCounts: skälFördelning,
      },
      select: { id: true },
    })
    this.senasteHjärtslag = nu.getTime()
    utfall.runId = run.id

    for (const { rad, dom } of domar) {
      // EN RAD PER KÖRNING, inte per bedömning: `assessments` räknar upp i
      // stället för att en ny rad skrivs. De påbörjade raderna kan stå kvar för
      // alltid, och en rad per pass hade vuxit obegränsat utan ny information.
      const skriven = await this.prisma.aiResumptionVerdict.upsert({
        where: { executionId: rad.id },
        create: {
          runId: run.id,
          executionId: rad.id,
          organizationId: rad.organizationId,
          toolName: rad.toolName,
          decision: dom.beslut,
          reason: dom.skäl,
          ageSec: Math.floor(dom.ageMs / 1000),
        },
        update: {
          runId: run.id,
          decision: dom.beslut,
          reason: dom.skäl,
          ageSec: Math.floor(dom.ageMs / 1000),
          assessments: { increment: 1 },
        },
        select: { assessments: true },
      })

      // ── ETT UTÅLDRAT FALL ÄR INGET TYST ÖVERHOPP ──────────────────────────
      //
      // Det är det enda avslaget som beskriver ett fel hos MOTORN och inte hos
      // raden: den var återupptagbar, och motorn hann inte titta. Blir det
      // vanligt är taket för snävt eller kadensen för gles, och den frågan ska
      // gå att svara på ur data.
      //
      // EN GÅNG PER RAD, inte per pass. `assessments === 1` betyder att upserten
      // nyss SKAPADE raden — de påbörjade raderna kan stå kvar för alltid, och
      // en rapport per minut hade gjort sänkan oläsbar och därmed tyst igen.
      if (skriven.assessments === 1 && ärUtåldrad(rad, nu)) {
        await this.cronErrors.report(
          'ai-resumption-shadow',
          new Error(
            `Återupptagbar körning åldrades ut osedd: ${rad.toolName}, ` +
              `${Math.floor(dom.ageMs / 1000)} s gammal (tak ${ATERUPPTAGNING_TAK_MS / 1000} s). ` +
              `Motorn hann aldrig titta inom fönstret.`,
          ),
          {
            organizationId: rad.organizationId,
            detail: {
              steg: 'utåldrad',
              executionId: rad.id,
              toolName: rad.toolName,
              ageSec: Math.floor(dom.ageMs / 1000),
              takSec: ATERUPPTAGNING_TAK_MS / 1000,
            },
          },
        )
      }
    }

    await this.prisma.aiResumptionRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date() },
    })

    this.logger.log(
      `[cron:ai-resumption-shadow] ${kandidater} påbörjade, ${domar.length} bedömda: ` +
        `${återuppta} skulle återupptagits, ${avstå} avstods. ` +
        Object.entries(skälFördelning)
          .map(([skäl, n]) => `${n}× ${SKAL_TEXT[skäl as ResumptionReason]}`)
          .join(' · '),
    )
    return utfall
  }

  /**
   * Har organisationen budget kvar i dag?
   *
   * `checkOrgDailyCostCap` kastar när taket passerats. Ett stopp är SYNLIGT: det
   * går till cron-felsänkan och blir en `QUOTA_BLOCKED`-dom. Andra fel — en
   * trasig databas — får inte tolkas som "budget finns"; också de ger `false`,
   * vilket är fail-closed åt rätt håll.
   */
  private async harBudget(organizationId: string): Promise<boolean> {
    try {
      await this.quota.checkOrgDailyCostCap(organizationId)
      return true
    } catch (err) {
      await this.cronErrors.report('ai-resumption-shadow', err, {
        organizationId,
        detail: { steg: 'kvotgrind' },
      })
      return false
    }
  }
}
