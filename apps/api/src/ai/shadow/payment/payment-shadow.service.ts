import Anthropic from '@anthropic-ai/sdk'
import { Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '../../../common/prisma/prisma.service'
import { AiUsageService } from '../../usage/ai-usage.service'
import { AiQuotaService } from '../../usage/ai-quota.service'
import { rentNoticePayableTotal } from '../../../common/utils/rent-notice-total.util'
import { arDubblettPaSkuggkallan } from '../maintenance-shadow.service'
import { INGEN_ATGARD } from '../shadow-tool-gate'
import { INGEN_AVI, OKAND_MOTPART, SKUGGKALLA_BANKRAD, type Beloppsutfall } from './payment-fields'
import {
  beloppsutfall,
  provaKandidater,
  type Kandidat,
  type RankadKandidat,
} from './payment-candidates'

import type { Prisma } from '@prisma/client'

/** Samma modell som agent 1. Billig, och uppgiften är ett val ur en meny. */
const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 1024
const FORSLAG_VERKTYGSNAMN = 'valj_avi'

/** Verktyget förslaget gäller. Aldrig delegerbart — `MOT_HYRESGAST`, Del 6. */
export const BETALNINGSVERKTYG = 'match_bank_transaction'

/**
 * Hur många öppna avier och fakturor kandidatfrågan läser.
 *
 * Taket SYNS: `korForBankrad` loggar när det slår i, så en trunkering blir ett
 * tal och inte en tystnad. En hyresvärd med 50 enheter har ~50 öppna avier;
 * 400 räcker med marginal och hindrar ändå att en org med tiotusen rader läser
 * in dem alla för varje bankrad.
 */
const KANDIDATTAK = 400

export interface BetalningsSkuggUtfall {
  utfall: 'SKAPAD' | 'REDAN_FINNS' | 'AVSTANGD' | 'SAKNAS' | 'INGEN_FRAGA' | 'AVVISAT_FORSLAG'
  assignmentId?: string
  detalj?: string
}

/**
 * SKUGGAGENT 2 — "PENGAR IN", ETAPP A.
 *
 * ── SÖMMEN, OCH VARFÖR DET BLEV JUST DEN ────────────────────────────────────
 *
 * Mätt i planens Del 14b: kravtrappan ställer INGA frågor. Alla fyra stegen —
 * förfallomarkering, påminnelse, inkasso-redo och befarad kundförlust — körs av
 * cron utan att någon människa tillfrågas. Det finns alltså ingen "föreslå
 * påminnelse"-lucka att fylla; påminnelsen skickas redan.
 *
 * Den enda återkommande frågan i pengaflödet där en människa i dag står UTAN
 * förslag är den omatchade betalningen — `matchTransaction` som returnerar
 * `false`. Dit löper alla fyra ingest-vägarna ihop, och det är strukturellt
 * exakt samma söm som `maintenance.service.create` var för agent 1.
 *
 * ── AGENTEN UTFÖR INGENTING HÄR ─────────────────────────────────────────────
 *
 * Filen importerar ingen exekverare och ingen `ReconciliationService`. Den
 * SKRIVER ett förslag; matchningen sker först när en människa trycker Godkänn,
 * och då genom avstämningens egen tjänstemetod med människan som aktör. Det är
 * samma strukturella frånvaro som `ai/shadow/`s egen modulnot beskriver.
 *
 * ── DE DETERMINISTISKA REGLERNA GÅR FÖRE, ALLTID ────────────────────────────
 *
 * `payment-candidates.ts` avgör exakt-OCR (ingen fråga alls) och tomma
 * kandidatmängder (INGEN) UTAN ett modellanrop. Modellen får bara välja bland
 * kandidater regeln redan tagit fram — enumen i verktygsschemat gör fritext
 * strukturellt omöjlig. Det är agent 1:s lärdom tillämpad i förväg i stället
 * för i efterhand.
 */
@Injectable()
export class PaymentShadowService {
  private readonly logger = new Logger(PaymentShadowService.name)
  private readonly anthropic = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] })

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: AiUsageService,
    private readonly quota: AiQuotaService,
  ) {}

  /**
   * Kör skuggförslaget för EN bankrad.
   *
   * Ordningen är fail-closed och billig först: flaggan, dubbletten, raden och
   * de deterministiska reglerna prövas alla FÖRE modellanropet. En avstängd
   * organisation ska inte kunna kosta ett enda token.
   */
  async korForBankrad(
    organizationId: string,
    bankTransactionId: string,
  ): Promise<BetalningsSkuggUtfall> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { shadowPaymentAgentEnabled: true },
    })
    if (!org?.shadowPaymentAgentEnabled) return { utfall: 'AVSTANGD' }

    // Dubbletten prövas här OCH av det partiella unika indexet. Den här
    // kontrollen sparar ett modellanrop; indexet är det som faktiskt håller.
    const redan = await this.prisma.aiAssignment.findFirst({
      where: {
        organizationId,
        shadow: true,
        sourceKind: SKUGGKALLA_BANKRAD,
        sourceId: bankTransactionId,
      },
      select: { id: true },
    })
    if (redan) return { utfall: 'REDAN_FINNS', assignmentId: redan.id }

    const tx = await this.prisma.bankTransaction.findFirst({
      where: { id: bankTransactionId, organizationId },
      select: {
        id: true,
        date: true,
        description: true,
        amount: true,
        rawOcr: true,
        status: true,
        autoMatchExcludedAt: true,
      },
    })
    if (!tx) return { utfall: 'SAKNAS' }

    // ── EN REDAN MATCHAD RAD HAR INGEN FRÅGA ────────────────────────────────
    //
    // Kön och svepet kan mötas, och emellan dem kan en människa ha matchat
    // raden för hand. Ett förslag om något som redan är gjort är inte bara brus:
    // godkänner någon det senare försöker vi matcha en rad som inte längre är
    // UNMATCHED, och felet uppstår hos hyresvärden i stället för här.
    if (tx.status !== 'UNMATCHED') {
      return { utfall: 'INGEN_FRAGA', detalj: `raden är ${tx.status}` }
    }
    // `autoMatchExcludedAt` betyder "automatiken hade fel" och sätts av
    // `unmatchTransaction`. En människa har alltså redan tagit ställning och
    // sagt nej till maskinens svar; att komma tillbaka med ett nytt gissat svar
    // vore att göra hennes beslut ogjort. FÄLTET LÅNAS INTE — det är avläst,
    // inte omtolkat: frågan "hade automatiken fel" och frågan "föreslog agenten
    // fel" är olika, och den andra får sitt eget svar i `outcome`.
    if (tx.autoMatchExcludedAt) {
      return { utfall: 'INGEN_FRAGA', detalj: 'en människa har avmatchat raden' }
    }

    const { kandidater, takNått } = await this.hämtaKandidater(organizationId)
    if (takNått) {
      this.logger.warn(
        `[ai-payment-shadow] kandidattaket ${KANDIDATTAK} slog i för org ${organizationId} — ` +
          'kandidatmängden är beskuren och en riktig avi kan ha fallit ur.',
      )
    }

    const rad = {
      id: tx.id,
      datum: tx.date,
      text: tx.description,
      belopp: tx.amount.toNumber(),
      rawOcr: tx.rawOcr,
    }
    const regel = provaKandidater(rad, kandidater)

    if (regel.typ === 'INGEN_FRAGA') {
      return { utfall: 'INGEN_FRAGA', detalj: regel.skäl }
    }

    if (regel.typ === 'INGEN') {
      // ETT AKTIVT NEJ ÄR OCKSÅ ETT SVAR, och det skrivs utan modellanrop.
      // Hyresvärden får veta att pengarna kommit in och att systemet INTE vet
      // vart de hör — vilket är den upplysning hen faktiskt saknar i dag.
      return this.skriv(organizationId, rad, {
        toolName: INGEN_ATGARD,
        prediction: { avi: INGEN_AVI, belopp: 'FULL', motpart: OKAND_MOTPART },
        // KONFIDENSEN ÄR REGELNS, INTE EN MODELLS. En deterministisk regel som
        // uttömt kandidatmängden är säker på sitt nej — men bara på att den
        // inte HITTADE något, inte på att inget finns. 0,9 och inte 1,0 säger
        // just det, och siffran är ett val någon ska kunna ifrågasätta.
        confidence: 0.9,
        reasoning: `Ingen avi eller faktura passar den här inbetalningen: ${regel.skäl}`,
        kandidater: [],
        takNått,
      })
    }

    // Kostnadstaket och inte plan-räknaren — samma val och samma skäl som
    // agent 1: skuggkörningen loggas `isAutomated: true` och ingår i baspriset,
    // medan `checkQuota` räknar MANUELLA anrop mot månadstaket.
    await this.quota.checkOrgDailyCostCap(organizationId)

    const val = await this.frågaModellen(organizationId, rad, regel.kandidater)
    if (!val) return { utfall: 'AVVISAT_FORSLAG', detalj: 'modellen svarade inte tolkbart' }

    const vald = regel.kandidater.find((k) => k.id === val.avi)
    if (val.avi !== INGEN_AVI && !vald) {
      // GRINDEN BOR HOS OSS, INTE HOS LEVERANTÖREN. Enumen i schemat har redan
      // gjort ett främmande id strukturellt omöjligt — men den spärren gäller
      // bara så länge modellen, providern och schemat är desamma. Den här
      // gäller den dag något av dem byts.
      this.logger.warn(
        `[ai-payment-shadow] tx ${rad.id}: modellen svarade "${val.avi}" som inte står i ` +
          'kandidatmängden — förslaget avvisas.',
      )
      return { utfall: 'AVVISAT_FORSLAG', detalj: 'valet stod inte i kandidatmängden' }
    }

    const belopp: Beloppsutfall = vald ? beloppsutfall(rad.belopp, vald.utestaende) : 'FULL'
    return this.skriv(organizationId, rad, {
      toolName: vald ? BETALNINGSVERKTYG : INGEN_ATGARD,
      prediction: {
        avi: vald ? vald.id : INGEN_AVI,
        belopp,
        motpart: vald?.motpartId ?? OKAND_MOTPART,
      },
      confidence: val.confidence,
      reasoning: val.reasoning,
      kandidater: regel.kandidater,
      takNått,
      ...(vald ? { vald } : {}),
    })
  }

  /**
   * De öppna avierna och fakturorna, org-avgränsade.
   *
   * Fönstret filtreras INTE i frågan utan i `provaKandidater`. Skälet är
   * prövbarhet: fönstret är en REGEL, och en regel som bor i en Prisma-predikat
   * går bara att pröva genom en databas. Mängden är liten (en organisations
   * öppna poster), så kostnaden är noll.
   */
  private async hämtaKandidater(
    organizationId: string,
  ): Promise<{ kandidater: Kandidat[]; takNått: boolean }> {
    const avier = await this.prisma.rentNotice.findMany({
      where: { organizationId, status: { in: ['SENT', 'PENDING', 'OVERDUE'] } },
      select: {
        id: true,
        noticeNumber: true,
        ocrNumber: true,
        dueDate: true,
        totalAmount: true,
        consumptionAmount: true,
        miscChargeAmount: true,
        reminderFeeAmount: true,
        credits: { select: { amount: true } },
        payments: { select: { amount: true } },
        tenantId: true,
        tenant: { select: { firstName: true, lastName: true } },
      },
      take: KANDIDATTAK + 1,
      orderBy: { dueDate: 'desc' },
    })
    const fakturor = await this.prisma.invoice.findMany({
      where: { organizationId, status: { in: ['SENT', 'OVERDUE', 'PARTIAL'] } },
      select: {
        id: true,
        invoiceNumber: true,
        ocrNumber: true,
        dueDate: true,
        total: true,
        payments: { select: { amount: true } },
        tenantId: true,
        tenant: { select: { firstName: true, lastName: true } },
      },
      take: KANDIDATTAK + 1,
      orderBy: { dueDate: 'desc' },
    })

    const kandidater: Kandidat[] = []
    for (const a of avier.slice(0, KANDIDATTAK)) {
      // SAMMA FUNKTION SOM AVSTÄMNINGEN OCH KRAVTRAPPAN. En egen summering här
      // hade varit den fjärde platsen — och den tredje togs bort i #518 just
      // därför att en kommentar inte kan hålla tre uttryck i synk.
      const betalbart = rentNoticePayableTotal(a)
      const allokerat = a.payments.reduce((s, p) => s + p.amount.toNumber(), 0)
      kandidater.push({
        id: a.id,
        sort: 'AVI',
        nummer: a.noticeNumber,
        ocr: a.ocrNumber,
        utestaende: Math.max(0, betalbart - allokerat),
        forfallodatum: a.dueDate,
        motpartId: a.tenantId,
        motpartNamn: a.tenant ? `${a.tenant.firstName} ${a.tenant.lastName}` : null,
      })
    }
    for (const f of fakturor.slice(0, KANDIDATTAK)) {
      const allokerat = f.payments.reduce((s, p) => s + p.amount.toNumber(), 0)
      kandidater.push({
        id: f.id,
        sort: 'FAKTURA',
        nummer: f.invoiceNumber,
        ocr: f.ocrNumber,
        utestaende: Math.max(0, f.total.toNumber() - allokerat),
        forfallodatum: f.dueDate,
        motpartId: f.tenantId,
        motpartNamn: f.tenant ? `${f.tenant.firstName} ${f.tenant.lastName}` : null,
      })
    }
    return {
      kandidater,
      takNått: avier.length > KANDIDATTAK || fakturor.length > KANDIDATTAK,
    }
  }

  /** Modellen väljer bland kandidaterna, eller avstår. Aldrig fritext. */
  private async frågaModellen(
    organizationId: string,
    rad: { id: string; datum: Date; text: string; belopp: number; rawOcr: string | null },
    kandidater: readonly RankadKandidat[],
  ): Promise<{ avi: string; confidence: number; reasoning: string } | null> {
    const response = await this.anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Temperatur 0 av samma mätskäl som agent 1: samplingsvarians lägger sig
      // ovanpå modellfelet i träffgraden, och de går inte att skilja åt sedan.
      temperature: 0,
      tools: [betalningsverktyg(kandidater)],
      tool_choice: { type: 'tool', name: FORSLAG_VERKTYGSNAMN },
      messages: [{ role: 'user', content: byggBetalningsprompt(rad, kandidater) }],
    })

    void this.usage
      .logUsage({
        organizationId,
        endpoint: 'analysis',
        model: MODEL,
        usage: response.usage,
        isAutomated: true,
        source: 'payment_shadow',
      })
      .catch((err: unknown) => this.logger.warn('logUsage(payment_shadow) failed', err))

    // STOP_REASON INSPEKTERAS — ett trunkerat svar och ett struntsvar hade
    // annars fått samma behandling, och ingen kunde skilja dem åt i efterhand.
    if (response.stop_reason === 'max_tokens') {
      this.logger.warn(
        `[ai-payment-shadow] svaret trunkerades av max_tokens (${MAX_TOKENS}) — inget förslag.`,
      )
      return null
    }
    const block = response.content.find((b) => b.type === 'tool_use')
    if (!block || block.type !== 'tool_use') return null
    return tolkaBetalningssvar(block.input, kandidater)
  }

  /** Skriver förslaget. Enda stället som rör `AiAssignment` i den här filen. */
  private async skriv(
    organizationId: string,
    rad: { id: string; datum: Date; text: string; belopp: number; rawOcr: string | null },
    f: {
      toolName: string
      prediction: Record<string, string>
      confidence: number
      reasoning: string
      kandidater: readonly RankadKandidat[]
      takNått: boolean
      vald?: RankadKandidat
    },
  ): Promise<BetalningsSkuggUtfall> {
    const evidence: Array<Record<string, string>> = [
      { fält: 'Bankrad', värde: `${rad.text} · ${rad.belopp.toFixed(2)} kr` },
      { fält: 'Bokföringsdag', värde: rad.datum.toISOString().slice(0, 10) },
      { fält: 'OCR på raden', värde: rad.rawOcr ?? 'saknas' },
    ]
    for (const k of f.kandidater) {
      evidence.push({
        fält: `Kandidat ${k.nummer}`,
        värde:
          `${k.utestaende.toFixed(2)} kr utestående, förfaller ` +
          `${k.forfallodatum.toISOString().slice(0, 10)} · ${k.signaler.join('; ')}`,
      })
    }
    if (f.takNått) {
      evidence.push({
        fält: 'Varning',
        värde: `Kandidatmängden beskars av taket ${KANDIDATTAK} — en riktig avi kan ha fallit ur.`,
      })
    }

    try {
      const skapad = await this.prisma.aiAssignment.create({
        data: {
          organizationId,
          kind: 'PAYMENT_MATCH_PROPOSAL',
          shadow: true,
          sourceKind: SKUGGKALLA_BANKRAD,
          sourceId: rad.id,
          toolName: f.toolName,
          toolInput: (f.vald
            ? {
                transactionId: rad.id,
                ...(f.vald.sort === 'AVI' ? { rentNoticeId: f.vald.id } : { invoiceId: f.vald.id }),
              }
            : { transactionId: rad.id }) as Prisma.InputJsonObject,
          // BANKRADENS EGEN TEXT GÅR INTE IN I RUBRIKEN. Samma slutna slinga som
          // agent 1 stängde: en text som kopieras in i historiken läses av nästa
          // körning som agentens eget tidigare omdöme. Beloppet och dagen räcker.
          title: `Inbetalning ${rad.belopp.toFixed(2)} kr den ${rad.datum
            .toISOString()
            .slice(0, 10)}`,
          reasoning: f.reasoning,
          consequence: konsekvenstext(f.vald, rad.belopp),
          undoHint:
            'Matchningen går att häva under Avstämning → Häv matchning. Hävningen bokför ett ' +
            'MOTVERIFIKAT — huvudboken raderar inte, den korrigerar, så både betalningen och ' +
            'rättelsen syns i efterhand.',
          evidence: evidence as unknown as Prisma.InputJsonArray,
          confidence: f.confidence,
          prediction: f.prediction as Prisma.InputJsonObject,
          deadline: this.deadline(),
          ...(f.vald?.motpartId ? { tenantId: f.vald.motpartId } : {}),
        },
        select: { id: true },
      })
      return { utfall: 'SKAPAD', assignmentId: skapad.id }
    } catch (err: unknown) {
      // P2002 PÅ DET PARTIELLA INDEXET är kapplöpningens rätta utfall, inte ett
      // fel. Disambigueras på KOLUMNMÄNGDEN och inte på en delsträng (#649).
      if (arDubblettPaSkuggkallan(err)) {
        const finns = await this.prisma.aiAssignment.findFirst({
          where: {
            organizationId,
            shadow: true,
            sourceKind: SKUGGKALLA_BANKRAD,
            sourceId: rad.id,
          },
          select: { id: true },
        })
        return { utfall: 'REDAN_FINNS', ...(finns ? { assignmentId: finns.id } : {}) }
      }
      throw err
    }
  }

  /**
   * Tidsgränsen för ett skuggförslag om en betalning.
   *
   * Sju dygn, och talet står HÄR och inte i en delad konstant —
   * `check-assignment-deadline.mjs` fäller varje härledning ur
   * `PENDING_ACTION_TTL_MS`. Sju dygn av samma skäl som agent 1: ingen brådska,
   * men förslaget ska förfalla innan inkorgen blir en hög. Att pengarna ligger
   * omatchade längre än så är i sig en signal, och den bärs av
   * färskhetsgrinden — inte av det här talet.
   */
  private deadline(): Date {
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  }
}

/**
 * VAD SOM HÄNDER VID ETT JA — I KLARTEXT, MED BOKFÖRINGEN UTSKRIVEN.
 *
 * Planens femte krav ("vad som hade krävt godkännande") betyder något annat här
 * än i agent 1. Där utförs ingenting ens vid ett ja; här UTFÖRS matchningen, och
 * texten måste därför säga vad som bokförs innan hyresvärden trycker. Att visa
 * "godkänn" utan bokföringseffekten hade varit att be om ett samtycke till något
 * som inte står i frågan.
 */
export function konsekvenstext(vald: RankadKandidat | undefined, belopp: number): string {
  if (!vald) {
    return (
      'Ingenting utförs. Agenten hittade ingen avi eller faktura som passar, och ' +
      'inbetalningen ligger kvar omatchad tills du matchar den för hand.'
    )
  }
  const del = beloppsutfall(belopp, vald.utestaende) === 'DEL'
  return (
    `Ett ja MATCHAR inbetalningen mot ${vald.nummer} och BOKFÖR den: ` +
    `${belopp.toFixed(2)} kr debiteras bankkontot (1930) och krediterar ` +
    `kundfordran (1510). ` +
    (del
      ? `Beloppet räcker inte till hela ${vald.utestaende.toFixed(2)} kr — ` +
        `${(vald.utestaende - belopp).toFixed(2)} kr står kvar som skuld, och ` +
        'kravtrappan fortsätter på resten.'
      : `${vald.nummer} blir därmed reglerad, och kravtrappan slutar räkna på den.`) +
    ' Verifikationen får ett eget nummer och går inte att radera; en felaktig ' +
    'matchning rättas med ett motverifikat under Avstämning → Häv matchning.'
  )
}

/**
 * Verktygsschemat. ENUMEN ÄR SPÄRREN — inte instruktionen i prompten.
 *
 * `avi` får bara vara ett av kandidat-id:na eller `INGEN`. En modell som vill
 * peka på något annat kan alltså inte uttrycka det, och grinden i tjänsten är
 * andra spärren för den dag providern eller schemat byts.
 */
export function betalningsverktyg(kandidater: readonly RankadKandidat[]): Anthropic.Tool {
  return {
    name: FORSLAG_VERKTYGSNAMN,
    description:
      'Välj vilken avi eller faktura inbetalningen hör till, eller INGEN om ingen av ' +
      'kandidaterna stämmer. Du får bara välja bland de uppräknade kandidaterna.',
    input_schema: {
      type: 'object',
      properties: {
        avi: {
          type: 'string',
          enum: [...kandidater.map((k) => k.id), INGEN_AVI],
          description:
            'Kandidatens id, eller INGEN när ingen av dem stämmer. INGEN är ett fullgott ' +
            'svar och ska väljas hellre än en gissning.',
        },
        confidence: {
          type: 'number',
          description:
            'Hur säker du är, 0–1. Använd hela skalan: ett OCR som skiljer en siffra och ett ' +
            'belopp som stämmer på öret är nära 1, ett namn som råkar stå i texten är nära 0,5.',
        },
        reasoning: {
          type: 'string',
          description:
            'En till tre meningar på svenska om VARFÖR, riktade till hyresvärden. Nämn vilka ' +
            'signaler som talade för och vilka som talade emot.',
        },
      },
      required: ['avi', 'confidence', 'reasoning'],
    },
  }
}

/** Prompten. Kandidaterna räknas upp med sina signaler — modellen letar inte själv. */
export function byggBetalningsprompt(
  rad: { datum: Date; text: string; belopp: number; rawOcr: string | null },
  kandidater: readonly RankadKandidat[],
): string {
  const rader = kandidater.map(
    (k) =>
      `- id: ${k.id} · ${k.sort === 'AVI' ? 'Hyresavi' : 'Faktura'} ${k.nummer} · ` +
      `utestående ${k.utestaende.toFixed(2)} kr · förfaller ` +
      `${k.forfallodatum.toISOString().slice(0, 10)} · OCR ${k.ocr ?? 'saknas'} · ` +
      `motpart ${k.motpartNamn ?? 'okänd'} · signaler: ${k.signaler.join('; ')}`,
  )
  return [
    'Du hjälper en svensk hyresvärd att stämma av en inbetalning som den automatiska',
    'matchningen inte kunde lösa. Din uppgift är att välja vilken av de UPPRÄKNADE',
    'kandidaterna inbetalningen hör till — eller svara INGEN.',
    '',
    'INBETALNINGEN',
    `  Bokföringsdag: ${rad.datum.toISOString().slice(0, 10)}`,
    `  Belopp: ${rad.belopp.toFixed(2)} kr`,
    `  Text från banken: ${rad.text}`,
    `  OCR på raden: ${rad.rawOcr ?? 'saknas'}`,
    '',
    'KANDIDATER (framtagna av deterministiska regler — du får inte peka på något annat)',
    ...rader,
    '',
    'SÅ HÄR VÄGER DU',
    '  Ett OCR som skiljer en enda siffra är en stark signal: hyresgäster skriver fel.',
    '  Ett belopp som stämmer på öret är starkt. Ett belopp som är LÄGRE än det utestående',
    '  kan vara en delbetalning och är fortfarande ett giltigt svar.',
    '  Ett belopp som är HÖGRE än det utestående är misstänkt — det kan vara en',
    '  dubbelbetalning eller en betalning som hör till något annat. Välj då hellre INGEN.',
    '  Ett namn som står i banktexten är en svag signal ensam.',
    '',
    'INGEN ÄR ETT FULLGOTT SVAR. En felaktig matchning reglerar fel fordran och lämnar den',
    'rätta obetald, varefter kravtrappan skickar krav till någon som redan har betalat.',
    'Att svara INGEN kostar hyresvärden en minuts arbete; att gissa fel kostar en hyresgäst',
    'ett inkassokrav.',
  ].join('\n')
}

/** Tolkar modellens svar. Fail-closed på allt som inte är exakt rätt form. */
export function tolkaBetalningssvar(
  input: unknown,
  kandidater: readonly RankadKandidat[],
): { avi: string; confidence: number; reasoning: string } | null {
  if (typeof input !== 'object' || input === null) return null
  const o = input as Record<string, unknown>
  const avi = o['avi']
  const confidence = o['confidence']
  const reasoning = o['reasoning']
  if (typeof avi !== 'string' || typeof reasoning !== 'string' || !reasoning.trim()) return null
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null
  if (avi !== INGEN_AVI && !kandidater.some((k) => k.id === avi)) return null
  return {
    avi,
    // KLAMPAD, inte avvisad. En modell som svarar 1.2 har en åsikt som går att
    // använda; att kasta hela förslaget för ett värde utanför spannet hade varit
    // att låta ett formfel äta ett innehåll.
    confidence: Math.min(1, Math.max(0, confidence)),
    reasoning: reasoning.trim(),
  }
}
