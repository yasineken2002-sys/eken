import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
// `Prisma` importeras som VÄRDE (inte `import type`) — `Prisma.Decimal` används
// för momsaritmetiken i createJournalEntryForInvoice. Namnrymden ger fortfarande
// typerna (Prisma.TransactionClient m.fl.), så inget annat behöver ändras.
import {
  CompanyForm,
  PaymentMethod,
  Prisma,
  RentNoticeType,
  UnitType,
  UserRole,
} from '@prisma/client'
import type {
  BankTransaction,
  ConsumptionVatStatus,
  Invoice,
  InvoiceLine,
  JournalEntrySource,
  MeterType,
} from '@prisma/client'
import type { Decimal } from '@prisma/client/runtime/library'

import { isReminderFeeContractuallyAllowed } from './debt-origin'
import { REMINDER_FEE_MAX_SEK } from '@eken/shared'
import type { DebtOriginDate } from './debt-origin'
import type {
  BalanceSheet,
  ProfitLossReport,
  ReportAccountAmount,
  ReportAccountBalance,
  VatReport,
} from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { stockholmCivilDate, throughStockholmDay } from '../common/time/stockholm-period'
import { encodeCp437 } from './cp437'
import { VerifikationsnummerService } from './verifikationsnummer.service'
import { basChartFor } from './bas-chart'
import {
  cancelBlockedReason,
  paymentSourceId,
  cancellationSourceId,
  receiptSourceId,
} from './supplier-invoice-status'
import {
  byggLeverantorsbetalningsrader,
  byggLeverantorsfakturareverseringsrader,
  byggLeverantorsfakturarader,
  byggUtgiftsrader,
  byggVerifikatrader,
  kontouppslagAv,
  type Kontouppslag,
  type RadIndata,
  type UtgiftIndata,
} from './manual-entry'
import { isPeriodClosed, periodKeyOf, periodOfDate } from './closed-period'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'

// Konteringsrad i internt format innan den mappas till Prisma create-input.
interface JournalLineInput {
  accountId: string
  debit?: number
  credit?: number
  description?: string
}

interface JournalFilters {
  from?: string
  to?: string
  source?: string
}

// Map VAT rate to account number. 0% (momsbefriad) ska INTE bokföras som
// momskredit alls — då hoppas raden över i createJournalEntryForInvoice.
/**
 * Vem som får rätta ett verifikat. Samma kalibrering som periodstängningen:
 * MANAGER utesluts medvetet — att bokföra en rättelse är en redovisningshandling,
 * inte förvaltning. VIEWER stängs ute redan av controllerns klassgrind.
 *
 * ADMIN står med av samma medvetna skäl som i `CLOSE_ROLES` — se motiveringen
 * där (beslut 2026-08-01: kalibrerat mot ett kundsegment där ägare och
 * administratör är samma person, omprövas om större organisationer tillkommer).
 *
 * Exporterad av samma skäl som `CLOSE_ROLES`: `accounting-role-gates.spec.ts`
 * kräver att controllerns `@Roles`-lista säger exakt samma sak, så att de två
 * lagren inte kan glida isär obemärkt.
 */
export const REVERSAL_ROLES: UserRole[] = [UserRole.ACCOUNTANT, UserRole.ADMIN, UserRole.OWNER]

/** Skälet blir rättelsens beskrivning i huvudboken — det måste gå att förstå. */
const REVERSAL_REASON_MIN_LENGTH = 10

/**
 * Betyder den här P2002:an "någon hann före med samma affärshändelse"?
 *
 * Hette `isReversalRaceConflict` fram till Etapp 2 (G0). Namnet var för snävt:
 * igenkänningen satt bara inkopplad i `reverseJournalEntry`, men frågan den
 * ställer — är det här ett ofarligt idempotensrace? — gäller ALLA verifikatvägar
 * och används nu också av `createNumberedEntry`.
 *
 * JournalEntry har tre unika index och de betyder olika saker:
 *   • reversalOfEntryId               → en rättelse finns redan (ofarligt race)
 *   • (org, source, sourceId)         → samma sak, via idempotensnyckeln
 *   • (org, series, fiscalYear, verNumber) → DUBBLETT I VERIFIKATIONSSERIEN.
 *     Det är ett allvarligt fel som måste fortsätta upp, inte maskeras.
 *
 * Prisma rapporterar `meta.target` som en kolumn-ARRAY (empiriskt verifierat i
 * #214 — inte sträng-formen som äldre kod antar). Sträng-fallbacken finns för
 * säkerhets skull; okänd form klassas som "inte ett race" och kastas vidare.
 */
function isIdempotencyRaceConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false
  const target = (err.meta as { target?: unknown } | undefined)?.target
  const fields = Array.isArray(target)
    ? target.map(String)
    : typeof target === 'string'
      ? [target]
      : []
  return fields.some((f) => f === 'reversalOfEntryId' || f === 'sourceId')
}

const VAT_TO_ACCOUNT: Record<number, number> = {
  25: 2611,
  12: 2621,
  6: 2631,
}

// BAS 2024-konto för hyresintäkt per upplåtelsetyp. Avgör vilket 39xx-konto
// en hyresfaktura/-avi krediteras mot. Bostäder (3911) är undantagna moms
// (ML 10 kap. 35 §); lokaler (3913) kan vara momspliktiga vid frivillig
// beskattning (ML 12 kap.). Saknas koppling till en Unit används 3914
// (övriga rörelseintäkter) som säker fallback.
const REVENUE_ACCOUNT_BY_UNIT_TYPE: Record<UnitType, number> = {
  APARTMENT: 3911,
  PARKING: 3912,
  OFFICE: 3913,
  RETAIL: 3913,
  STORAGE: 3914,
  OTHER: 3914,
}
const DEFAULT_REVENUE_ACCOUNT = 3914

export function revenueAccountForUnitType(type: UnitType | null | undefined): number {
  return type ? REVENUE_ACCOUNT_BY_UNIT_TYPE[type] : DEFAULT_REVENUE_ACCOUNT
}

// BAS-intäktskonto för förbrukningsersättning (IMD) per mätartyp. Bruttoredovisat
// och skilt från hyresintäkten (39xx ovan): el/värme → 3920, vatten → 3970.
// Kostnaden (5020/5040) bokförs ALDRIG här — den hör till leverantörsfaktura-
// flödet. Vi nettar aldrig kostnad mot intäkt.
const CONSUMPTION_REVENUE_ACCOUNT_BY_METER_TYPE: Record<MeterType, number> = {
  ELECTRICITY: 3920,
  HEATING: 3920,
  WATER_COLD: 3970,
  WATER_HOT: 3970,
}

// Svensk etikett per mätartyp för verifikatets beskrivning/radtext.
const METER_TYPE_LABEL: Record<MeterType, string> = {
  ELECTRICITY: 'el',
  HEATING: 'värme',
  WATER_COLD: 'kallvatten',
  WATER_HOT: 'varmvatten',
}

// BAS-likvidkonto som debiteras vid manuell betalningsregistrering, per
// betalningssätt. Kontona seedas av basChartFor och backfillas för
// befintliga organisationer via migration (PR 6) — saknas kontot loggas ett
// fel och betalningsverifikatet skapas inte (hellre än att boka mot fel konto).
const PAYMENT_METHOD_TO_ACCOUNT: Record<PaymentMethod, number> = {
  BANK: 1930,
  CASH: 1910,
  // Swish-medel landar inom sekunder på företagskontot (1930) — det är inte ett
  // separatredovisat bankkonto. Vi bokför därför mot 1930 (undviker ett
  // "fantasikonto" som aldrig kan stämmas av mot ett kontoutdrag). Att det var
  // Swish framgår av paymentMethod på avin + verifikatets radtext.
  SWISH: 1930,
  MANUAL: 1930,
}

// Radtext på debetraden i betalningsverifikatet, per betalningssätt.
const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  BANK: 'Inbetalning bank',
  CASH: 'Inbetalning kontant',
  SWISH: 'Inbetalning Swish',
  MANUAL: 'Inbetalning (manuell registrering)',
}

// Tillämplig momssats (%) för hyresintäkt per upplåtelsetyp (ML 2023:200):
//   • Bostad (APARTMENT)         → 0 %. Undantagen moms (ML 10 kap. 35 §). Frivillig
//     beskattning får ALDRIG avse stadigvarande bostad (ML 12 kap. 5 §) —
//     därför alltid 0 % oavsett voluntaryTaxLiability.
//   • Lokal (OFFICE/RETAIL)      → 0 % som huvudregel; 25 % endast vid frivillig
//     beskattning (ML 12 kap. 5 §).
//   • Parkering (PARKING)        → 25 %. Momspliktig enligt lag (ML 10 kap. 36 §),
//     oberoende av frivillig skattskyldighet. Gäller fristående p-plats; ingår
//     platsen i en bostadsupplåtelse hör den till APARTMENT-enheten.
//   • Förråd/övrigt (STORAGE/OTHER) → 0 % som huvudregel; 25 % vid frivillig
//     beskattning (konservativ tolkning — fristående förvaringsbox kan vara
//     momspliktig enligt ML 10 kap. 36 § 6, men kräver då explicit beskattning).
export function vatRateForRent(
  type: UnitType | null | undefined,
  voluntaryTaxLiability: boolean,
): number {
  switch (type) {
    case 'APARTMENT':
      return 0
    case 'PARKING':
      return 25
    case 'OFFICE':
    case 'RETAIL':
    case 'STORAGE':
    case 'OTHER':
      return voluntaryTaxLiability ? 25 : 0
    default:
      return 0
  }
}

/**
 * Kastas av fail-closed-guarden (T5 A2/A2b) när en 1510-kreditering (betalning
 * ELLER nedskrivning) saknar sin motsvarande fordrans-debet (accrual-verifikat).
 * Subklass av UnprocessableEntityException → befintliga `instanceof
 * UnprocessableEntityException`-kontroller (A2) fortsätter matcha; callers som
 * behöver särskilja just accrual-felet (t.ex. bad-debt-cronen som larmar) kan
 * fånga `instanceof MissingAccrualError`.
 */
export class MissingAccrualError extends UnprocessableEntityException {}

/**
 * Räkenskapsår som täcks av ett exportintervall, numrerade enligt SIE-specen.
 *
 * §#RAR pt 1: "Räkenskapsårets start och slutdatum anges i formatet ÅÅÅÅMMDD.
 * Årsnr sätts till 0 för innevarande år och -1 för föregående år."
 * §#RAR pt 2: ytterligare jämförelseår läggs som -2, -3 osv.
 *
 * Årsnr 0 = räkenskapsåret som exportens SLUTDATUM ligger i. Ett intervall som
 * spänner flera räkenskapsår ger en rad per år, äldre år med negativa nummer.
 *
 * `fiscalYearStartMonth` är 1–12. Med startmånad 1 sammanfaller räkenskapsåret
 * med kalenderåret; med t.ex. 5 löper det maj–april.
 */
/**
 * SIE-BELOPPETS TECKEN: Σdebet − Σkredit. ALLTID. Oavsett kontoslag.
 *
 * ── LÄS DET HÄR INNAN DU ÅTERANVÄNDER getBalanceSheet ELLER getProfitLossReport ──
 *
 * De två ligger längre ned i samma fil och ser ut som självklara
 * återanvändningskandidater — de summerar ju redan per konto. Det vore fel, och
 * felet är tyst.
 *
 * De rapporterna VÄNDER tecknet efter kontots normalsaldo, så att en skuld och
 * en intäkt visas som positiva tal för en människa som läser en balans- eller
 * resultaträkning. SIE gör inte det: där är ett kreditsaldo NEGATIVT även på ett
 * konto vars normalsaldo är kredit.
 *
 * VAD SOM GÅR SÖNDER om rapportvändningen används här: filens `#IB`/`#UB`/`#RES`
 * skulle sluta stämma mot filens EGNA `#TRANS`-rader, som är tecknade med den
 * råa formeln. Sambandet `IB + rörelse = UB` bryts för varje skuld-, eget
 * kapital- och intäktskonto, och ett mottagande bokslutsprogram flaggar
 * avstämningsfel — eller värre, importerar en balansräkning med fel tecken.
 *
 * Invarianten i sie-balance-records.spec.ts räknar om saldona ur filens egna
 * `#TRANS`-rader och kan därför inte vara grön med fel teckenkonvention.
 */
export function sieSignedAmount(
  debit: Prisma.Decimal | number | null,
  credit: Prisma.Decimal | number | null,
): number {
  return Number(debit ?? 0) - Number(credit ?? 0)
}

export function fiscalYearsCovering(
  from: string,
  to: string,
  fiscalYearStartMonth: number,
): Array<{ number: number; start: string; end: string }> {
  const compact = (d: Date): string =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
      d.getUTCDate(),
    ).padStart(2, '0')}`

  // Vilket räkenskapsår ett datum tillhör: före startmånaden hör det till
  // föregående år (samma regel som VerifikationsnummerService.fiscalYearFor).
  const fiscalYearOf = (iso: string): number => {
    const d = new Date(`${iso}T00:00:00Z`)
    const year = d.getUTCFullYear()
    const month = d.getUTCMonth() + 1
    return month < fiscalYearStartMonth ? year - 1 : year
  }

  const boundsFor = (fy: number): { start: string; end: string } => {
    const start = new Date(Date.UTC(fy, fiscalYearStartMonth - 1, 1))
    // Slutet = dagen före nästa räkenskapsårs start.
    const end = new Date(Date.UTC(fy + 1, fiscalYearStartMonth - 1, 1))
    end.setUTCDate(end.getUTCDate() - 1)
    return { start: compact(start), end: compact(end) }
  }

  const firstFy = fiscalYearOf(from)
  const lastFy = fiscalYearOf(to)
  const out: Array<{ number: number; start: string; end: string }> = []
  for (let fy = lastFy; fy >= firstFy; fy--) {
    out.push({ number: fy - lastFy, ...boundsFor(fy) })
  }
  return out
}

/**
 * #326 D — sourceId för ett BANKMATCHAT betalningsverifikat.
 *
 * EN KÄLLA, TRE ANVÄNDNINGAR: skrivaren (`createJournalEntryForPayment` /
 * `createJournalEntryForRentNoticePayment`), reverseringen
 * (`reverseJournalEntryForPayment`) och testerna. Byggdes nyckeln på tre ställen
 * kunde reverseringen leta efter en post skrivaren aldrig skrev — och en
 * reversering som inte hittar sitt original är en tyst no-op (`if (!original)
 * return`), alltså exakt den sortens fel som inte syns förrän böckerna stäms av.
 *
 * Formen speglar de manuella vägarnas redan etablerade nycklar
 * (`invoice-manual-payment:<id>`, `rent-notice-payment:<id>` från #290/PR 3b).
 */
export function bankPaymentSourceId(kind: 'invoice' | 'rent-notice', allocationId: string): string {
  return kind === 'invoice'
    ? `invoice-bank-payment:${allocationId}`
    : `rent-notice-bank-payment:${allocationId}`
}

@Injectable()
export class AccountingService {
  private readonly logger = new Logger(AccountingService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly verifikationsnummer: VerifikationsnummerService,
  ) {}

  /**
   * Skapar en JournalEntry med ett gap-free verifikationsnummer, idempotent på
   * (org, source, sourceId).
   *
   * ── VAD SOM FAKTISKT SKYDDAR MOT DUBBLETTEN ──────────────────────────────
   *
   * INDEXET. Inte kontrollen i transaktionen. Fram till 2026-08-30 stod här att
   * `findFirst` inuti transaktionen var "TOCTOU-säkert" — det är falskt, och en
   * kommentar som påstår en garanti som inte finns är värre än ingen kommentar:
   * nästa person bygger på den.
   *
   * `findFirst` är en ögonblicksläsning under READ COMMITTED. **En läsning som
   * inte hittar någon rad låser ingenting** — det finns inget att låsa. Två
   * samtidiga transaktioner med samma nyckel ser därför båda noll rader och går
   * båda vidare till insert:en. Mätt mot riktig Postgres (bevisad i
   * `numbered-entry-race.concurrency.spec.ts`):
   *
   *     T1 ser 0 rader · T2 ser 0 rader
   *     T2: ERROR: duplicate key value violates unique constraint
   *     slutligt antal rader: 1
   *
   * Antalet är rätt, men det är `@@unique([organizationId, source, sourceId])`
   * som gör det. Sekvensallokeringen serialiserar visserligen de två
   * transaktionerna (`journalEntrySequence.upsert` tar ett radlås), men det sker
   * EFTER läsningen och räddar därför ingenting.
   *
   * `findFirst` är alltså en SNABBVÄG, inte en spärr: den låter ett omförsök som
   * kommer efter att den första posten committats returnera den befintliga utan
   * att gå via ett databasfel. Den är kvar av det skälet, inte som skydd.
   *
   * ── SAMTIDIGT OMFÖRSÖK FÅR TILLBAKA DET FÖRSTA VERIFIKATET ───────────────
   *
   * Det är skillnaden mellan "idempotent" och "råkar bli rätt antal rader". En
   * agent som gör automatiskt omförsök träffar exakt den här vägen: förloraren
   * krockade på indexet och fick förr ett kastat P2002 i stället för vinnarens
   * verifikat. Nu fångas kollisionen (`isIdempotencyRaceConflict`), den
   * befintliga posten slås upp och returneras — samma svar som en sekventiell
   * retry hade fått.
   *
   * VARFÖR UPPSLAGET LIGGER UTANFÖR TRANSAKTIONEN: en P2002 poison:ar den. Mätt
   * mot riktig Postgres — en läsning i samma transaktion efter kollisionen ger
   * `25P02 current transaction is aborted, commands ignored until end of
   * transaction block`. Uppslaget måste därför ske efter rollbacken, på
   * `this.prisma`.
   *
   * DÄRFÖR GÄLLER ÅTERHÄMTNINGEN INTE EN INSKICKAD `tx`. Kollisionen aborterar
   * hela ANROPARENS transaktion, och den ska den göra: `tx` skickas in just när
   * verifikatet måste skapas atomiskt med andra writes (INV-A). Att svälja felet
   * där hade lämnat anroparen med en död transaktion och ett returvärde som såg
   * ut som framgång. Felet fortsätter upp, oförändrat.
   *
   * ── GAP-FREE ─────────────────────────────────────────────────────────────
   *
   * Verifikationsnumret allokeras atomiskt inuti transaktionen. Misslyckas något
   * rullas hela transaktionen — inklusive sekvensökningen — tillbaka, så serien
   * förblir obruten (BFL 5 kap 6 §). Det gäller också förloraren i racet ovan:
   * hens nummer bränns aldrig.
   */
  private async createNumberedEntry(params: {
    organizationId: string
    date: Date
    description: string
    source: JournalEntrySource
    sourceId: string | null
    createdById?: string | null
    lines: JournalLineInput[]
    idempotencyWhere: Prisma.JournalEntryWhereInput
    include?: Prisma.JournalEntryInclude
    // Länk till verifikatet den här posten RÄTTAR (T5 PR1c2). Sätts bara av den
    // operatörsstyrda rättelsevägen; de automatiska motverifikaten (annullerad
    // avi, makulerad faktura, hävd matchning) lämnar den tom och är oförändrade.
    reversalOfEntryId?: string
    /**
     * Underlaget till en MANUELLT bokförd post (BFL 7 kap). Sätts bara av den
     * fria vägen — automatiska verifikat har sitt underlag i affärshändelsen de
     * kommer ur. Fältet togs tidigare emot av DTO:n och skrevs ingenstans; en
     * bilaga hyresvärden trodde var sparad försvann då tyst.
     */
    attachmentUrl?: string | null
    /**
     * AI-ursprunget. Mjuk referens till `AiToolExecution.id`, utan främmande
     * nyckel — skälet står i schemat. Sätts bara av AI-vägen.
     */
    aiToolExecutionId?: string | null
    /**
     * KÖRS I ALLA TRE UTFALLEN: när posten skapades, när idempotensuppslaget
     * hittade en befintlig, och när en sann samtidig kollision rullade tillbaka
     * vår transaktion och vinnarens rad slogs upp efteråt.
     *
     * De två första körs INUTI verifikatets transaktion. Det tredje kan inte —
     * transaktionen är rullad tillbaka — och får därför en egen kort
     * transaktion. Skillnaden står utskriven vid anropsstället: en garanti om
     * atomicitet som bara gäller två av tre grenar är värre än ingen garanti.
     *
     * Finns för AI-vägen, som måste skriva sitt utförandespår atomiskt med
     * effekten (G0). Att låta anroparen skicka in en egen `tx` hade också
     * fungerat, men då tappar den race-återhämtningen: med en inskickad
     * transaktion äger anroparen rollbacken och kollisionen kastar vidare. En
     * hook låter skrivvägen förbli EN och behålla alla sina spärrar.
     *
     * BÅDA UTFALLEN, och det är inte en detalj: verktyget KÖRDE även när det
     * inte skapade något, och ett spår som saknas för idempotensträffen gör en
     * uppspelning till en förnekelse av något som hände.
     */
    efterSkrivning?: (
      tx: Prisma.TransactionClient,
      entry: { id: string },
      redanFanns: boolean,
    ) => Promise<void>
    // Valfri yttre transaktion. Anges när verifikatet måste skapas ATOMISKT
    // tillsammans med andra DB-writes (t.ex. unmatch-flödet som måste rulla
    // tillbaka statusändringar om bokföringen fallerar — BFL 5 kap 5 §/9 §).
    // Utan tx öppnar metoden en egen transaktion som tidigare.
    tx?: Prisma.TransactionClient
  }) {
    // ── C0: IDEMPOTENSNYCKELN MÅSTE FINNAS OCH VARA ORG-SCOPAD ───────────────
    //
    // `idempotencyWhere` är REDAN obligatorisk i typen ovan — inget `?`. Den
    // här spärren finns för att typen inte skyddar mot ett värde som RÅKAR bli
    // undefined i runtime: ett spec som går via `as any` förbi den privata
    // metodens synlighet, ett params-objekt byggt med spridning av något
    // valfritt, en `JSON.parse`. Uppmätt: `{ ...undefined, source }` är laglig
    // JS och ger `{ source }`.
    //
    // VARFÖR DET ÄR ALLVARLIGT och inte bara "hittar fel rad": uppslaget nedan
    // är `findFirst({ where: { ...idempotencyWhere, source } })`. Faller
    // nyckeln bort återstår bara `source` — alltså INGEN `organizationId`, och
    // frågan returnerar första verifikatet med den källan i HELA tabellen,
    // tvärs över organisationsgränsen. Metoden svarar då med en annan
    // organisations verifikat i stället för att skapa ett nytt, och anroparen
    // ser det som en lyckad idempotent träff.
    //
    // Kravet på `organizationId` är inte en skärpning av något befintligt:
    // samtliga 20 anropare i den här filen scopar redan på org (uppmätt), så
    // spärren kan inte fälla en existerande väg. Den fäller nästa.
    //
    // VAD DEN INTE KAN SE: att nyckeln är TILLRÄCKLIGT unik. En `where` som
    // bär `organizationId` men fel `sourceId` är org-scopad och ändå fel;
    // det ägs av det unika DB-indexet (org, source, sourceId) och av
    // anroparens egen spec, inte av den här kontrollen.
    if (params.idempotencyWhere == null) {
      throw new InternalServerErrorException(
        `createNumberedEntry anropades utan idempotencyWhere (${params.source} ${params.sourceId ?? '—'}) — ` +
          'uppslaget hade blivit oscopat över organisationer',
      )
    }
    if (params.idempotencyWhere.organizationId == null) {
      throw new InternalServerErrorException(
        `createNumberedEntry: idempotencyWhere saknar organizationId (${params.source} ${params.sourceId ?? '—'}) — ` +
          'ett oscopat uppslag kan returnera en annan organisations verifikat',
      )
    }

    // ── C1: DEN GLOBALA BALANSGRINDEN ────────────────────────────────────────
    //
    // Ett verifikat MÅSTE balansera: summa debet = summa kredit (BFL 5 kap).
    // Fram till nu fanns ingen sådan kontroll någonstans i skrivvägen — alla
    // 15 verifikatvägar förlitade sig på att var och en av dem var individuellt
    // korrekt, utan nät. C2 visade att det inte höll: fakturans momsberäkning
    // gick isär med ett öre på flerradsfakturor och skrevs rakt in i huvudboken.
    //
    // Grinden ligger HÄR, i den delade skrivaren, i stället för i varje
    // anropare — det är den enda punkt alla verifikat passerar. Den körs FÖRE
    // verifikationsnumret allokeras, så ett obalanserat verifikat aldrig hinner
    // förbruka ett nummer (numret ska vara gap-fritt).
    //
    // NOLLTOLERANS. Belopp är Decimal(10,2) och summeras i Decimal — ett öre är
    // ett fel, inte brus. En tolerans hade bara flyttat gränsen för vad som får
    // vara fel.
    //
    // Verifierat säkert att aktivera: samtliga 627 verifikat i dev-databasen
    // balanserar, och datainvarianten total = netto + moms håller i RentNotice,
    // ConsumptionCharge, MiscCharge och Invoice. Ingen befintlig väg producerar
    // en obalans.
    if (params.lines.length === 0) {
      throw new UnprocessableEntityException(
        `Verifikat utan konteringsrader kan inte skapas (${params.source} ${params.sourceId ?? '—'})`,
      )
    }

    let debitSum = new Prisma.Decimal(0)
    let creditSum = new Prisma.Decimal(0)
    for (const line of params.lines) {
      const hasDebit = line.debit != null
      const hasCredit = line.credit != null
      // En rad ska bära EN sida. Bär den båda räknas den in i två summor och
      // balanskontrollen blir meningslös; bär den ingen är den en tom rad.
      if (hasDebit === hasCredit) {
        throw new UnprocessableEntityException(
          `Konteringsrad måste ha antingen debet eller kredit, inte ${
            hasDebit ? 'båda' : 'ingetdera'
          } (${params.source} ${params.sourceId ?? '—'})`,
        )
      }
      if (hasDebit) debitSum = debitSum.plus(line.debit!)
      else creditSum = creditSum.plus(line.credit!)
    }

    if (!debitSum.equals(creditSum)) {
      throw new UnprocessableEntityException(
        `Verifikatet balanserar inte: debet ${debitSum.toFixed(2)} ≠ kredit ${creditSum.toFixed(2)} ` +
          `(${params.source} ${params.sourceId ?? '—'}: ${params.description})`,
      )
    }

    const run = async (tx: Prisma.TransactionClient) => {
      // SNABBVÄG, INTE SPÄRR. Kontrollen matchar samma (org, source, sourceId)
      // som det unika DB-indexet, så app-kontroll och DB-constraint säger samma
      // sak — men den LÅSER ingenting när den inte hittar någon rad, och stoppar
      // därför inte en samtidig skrivning. Det gör indexet. Se docblocket ovan.
      const existing = await tx.journalEntry.findFirst({
        where: { ...params.idempotencyWhere, source: params.source },
        ...(params.include ? { include: params.include } : {}),
      })
      if (existing) {
        if (params.efterSkrivning) await params.efterSkrivning(tx, existing, true)
        return existing
      }

      const { series, verNumber, fiscalYear } = await this.verifikationsnummer.allocate(
        tx,
        params.organizationId,
        params.date,
      )

      const skapad = await tx.journalEntry.create({
        data: {
          organizationId: params.organizationId,
          date: params.date,
          description: params.description,
          source: params.source,
          series,
          verNumber,
          fiscalYear,
          ...(params.sourceId != null ? { sourceId: params.sourceId } : {}),
          ...(params.createdById != null ? { createdById: params.createdById } : {}),
          ...(params.reversalOfEntryId != null
            ? { reversalOfEntryId: params.reversalOfEntryId }
            : {}),
          ...(params.attachmentUrl ? { attachmentUrl: params.attachmentUrl } : {}),
          // `!== undefined`, inte `!= null`: skillnaden är "anroparen skickade
          // INGET fält" mot "anroparen skickade null". AI-vägen skickar alltid
          // `aiToolExecutionId ?? null` och ska då få kolumnen skriven som null
          // — precis som dess egen transaktion gjorde före #790. De tjugo
          // övriga anroparna skickar inget och får fältet utelämnat, alltså
          // oförändrad nyttolast.
          ...(params.aiToolExecutionId !== undefined
            ? { aiToolExecutionId: params.aiToolExecutionId }
            : {}),
          lines: {
            create: params.lines.map((l) => ({
              accountId: l.accountId,
              ...(l.debit != null ? { debit: l.debit } : {}),
              ...(l.credit != null ? { credit: l.credit } : {}),
              ...(l.description ? { description: l.description } : {}),
            })),
          },
        },
        ...(params.include ? { include: params.include } : {}),
      })
      if (params.efterSkrivning) await params.efterSkrivning(tx, skapad, false)
      return skapad
    }
    // Inskickad transaktion: anroparen äger rollbacken, och en kollision ska
    // rulla tillbaka HELA hens transaktion. Ingen återhämtning här — se
    // docblocket ovan (25P02).
    if (params.tx) return run(params.tx)

    try {
      return await this.prisma.$transaction(run, PRISMA_DEFAULT_TX_LIMITS)
    } catch (err) {
      // SAMTIDIGT OMFÖRSÖK: förloraren krockade på idempotensindexet. Vinnarens
      // verifikat ÄR svaret på förlorarens fråga — samma affärshändelse, samma
      // nyckel — så det ska returneras, inte kastas som ett fel.
      //
      // Disambiguering på err.meta.target, aldrig en blind P2002-fångst:
      // JournalEntry har tre unika index och (org, series, fiscalYear,
      // verNumber) betyder DUBBLETT I VERIFIKATIONSSERIEN. Det får aldrig
      // maskeras som en ofarlig krock.
      if (!isIdempotencyRaceConflict(err)) throw err

      // UTAN NYCKEL FINNS INGEN VINNARE ATT PEKA UT. `idempotencyWhere` med
      // `sourceId: null` matchar VARJE nyckellös post i samma källa — uppslaget
      // hade returnerat en godtycklig främmande rad som om den vore svaret.
      //
      // Grenen är onåbar i dag (Postgres räknar NULL som distinkt, så vår egen
      // rad kan inte krocka på idempotensindexet, och den enda vägen som sätter
      // `reversalOfEntryId` skickar alltid en nyckel). Den står här ändå: utan
      // den vilar säkerheten på ett resonemang tvärs över två funktioner, och
      // första nyckellösa reverseringsvägen någon lägger till bryter det tyst.
      if (params.sourceId == null) throw err

      const winner = await this.prisma.journalEntry.findFirst({
        where: { ...params.idempotencyWhere, source: params.source },
        ...(params.include ? { include: params.include } : {}),
      })
      // Ingen post på VÅR nyckel betyder att kollisionen var någon annans —
      // `reversalOfEntryId`, dvs. någon reverserade samma original via en annan
      // sourceId. Att returnera den posten hade varit att svara på fel fråga.
      // Felet fortsätter upp och hanteras där reverseringen startade.
      if (!winner) throw err

      // ── HOOKEN GÄLLER ÄVEN HÄR, OCH DET ÄR TREDJE UTFALLET ─────────────
      //
      // `run()` har två utfall — snabbträff och ny post — och båda anropar
      // hooken. Det HÄR är det tredje: en sann samtidig kollision, där vår
      // transaktion rullades tillbaka och vinnarens rad slås upp efteråt.
      //
      // Utan raden nedan tappas AI-vägens utförandespår HELT i just det
      // fallet. Konsekvensen är mätbar och värre än en saknad loggrad:
      // `create_journal_entry`/`record_expense` är `traceIntegrity:
      // 'TRANSAKTIONELL'`, alltså skrivs INGEN AiToolExecution-rad i förväg —
      // hela raden är hookens ansvar. Uteblir den finns varken en lyckad, en
      // misslyckad eller en påbörjad körning, medan verktyget svarar
      // "Verifikat skapat" (`redanFanns` sätts bara inuti hooken och förblir
      // false). En körning som hände förnekas alltså av sitt eget spår.
      //
      // Det var dessutom en REGRESSION mot läget före den här ändringen: AI:ns
      // egen transaktion hade ingen P2002-fångst, så en kollision kastade
      // vidare och `logToolExecution` skrev en FAILED-rad. Ett synligt fel MED
      // spår blev en tyst framgång UTAN spår.
      //
      // EN EGEN KORT TRANSAKTION, därför att den ursprungliga är rullad
      // tillbaka — det finns ingen levande `tx` att skriva i. Skrivningen är
      // liten och rör bara spårtabellen.
      if (params.efterSkrivning) {
        const hook = params.efterSkrivning
        await this.prisma.$transaction((tx) => hook(tx, winner, true), PRISMA_DEFAULT_TX_LIMITS)
      }
      return winner
    }
  }

  /**
   * Bokför en påminnelseavgift: 1510 D / 3593 K. DELAD kärna för BÅDE
   * faktura-flödet (PaymentReminderService) och hyresavi-flödet (RentReminder-
   * Service, inkasso PR 2) — ingen bokföringslogik byggs på annat håll.
   *
   * Momsfri: avgiften är en lagstadgad påföljd (4 § lagen 1981:739), inte omsättning
   * — den får ALDRIG moms, oavsett om underliggande hyra var bostad (0 %) eller
   * lokal (25 %). 3593 är ett momsfritt intäktskonto; inget 26xx-momskonto rörs.
   *
   * Idempotent + gap-free via createNumberedEntry (unikt index (org, source,
   * sourceId)). En `tx` kan skickas in så att källans avgiftsmarkering och detta
   * verifikat skapas ATOMISKT (INV-A: ingen avgift utan verifikat — faller
   * verifikatet rullas hela transaktionen, inkl. markeringen, tillbaka).
   *
   * Returnerar verifikatet, eller null om avgiften ≤ 0 eller om 1510/3593 saknas
   * i kontoplanen (loggas) — anroparen avgör då om eskaleringen ska avbrytas.
   */
  async bookReminderFee(params: {
    organizationId: string
    source: JournalEntrySource
    sourceId: string
    fee: number
    description: string
    // ── G2: AVTALSGRUNDEN, KRÄVD ─────────────────────────────────────────
    //
    // Båda fälten är obligatoriska och får inte utelämnas. En anropare som
    // inte skickar dem kompilerar inte — det är hela poängen: grinden ska
    // inte gå att glömma bort, och den ska inte gå att gå runt.
    //
    // `debtOrigin` är BRANDAD (`DebtOriginDate`) och går bara att få ur
    // `resolveNoticeDebtOrigin`/`resolveInvoiceDebtOrigin`. En krävd `Date`
    // hade hindrat glömska men inte att någon skickar `notice.dueDate` rakt
    // av och därmed kringgår den tidigaste-av-två-regeln utan att märka det.
    // null = ursprunget gick inte att fastställa → avgiften vägras.
    //
    // `termsFrom` är `Lease.reminderFeeTermsFrom`. null = ingen avtalsgrund.
    debtOrigin: DebtOriginDate | null
    termsFrom: Date | null
    createdById?: string | null
    tx?: Prisma.TransactionClient
  }): Promise<{ id: string } | null> {
    const { organizationId, source, sourceId, fee, description, debtOrigin, termsFrom } = params
    if (!Number.isFinite(fee) || fee <= 0) return null

    // ── GRINDEN: INGEN AVGIFT UTAN AVTALSVILLKOR ─────────────────────────
    //
    // Påminnelseavgift får inte debiteras utan avtalsvillkor (2 § lagen
    // 1981:739), och villkoret binder bara FRAMÅT: "senast i samband med
    // skuldens uppkomst". Tre skäl att vägra, alla på ett ställe:
    //
    //   1. Skuldens uppkomst gick inte att fastställa (`debtOrigin` null).
    //      Vägrar hellre än gissar — se resolveNoticeDebtOrigin.
    //   2. Ingen avtalsgrund alls (`termsFrom` null). Det är tillståndet för
    //      varje avtal som finns i dag; migreringen backfillade med flit inte.
    //   3. Villkoret trädde i kraft EFTER att skulden uppkom. Avgiften vore
    //      retroaktiv, och en retroaktiv avgift är ett olagligt krav.
    //
    // Vägran är TYST (null, som en avgift ≤ 0) och inte ett kast. Anroparna
    // behandlar redan null från `fee <= 0` som "ingen avgift, fortsätt med
    // påminnelsen" — och det är rätt utfall också här: hyresgästen ska ändå
    // påminnas om sin obetalda hyra, bara inte debiteras för det. Ett kast
    // hade stoppat påminnelsen, vilket vore att straffa hyresvärden för ett
    // villkor hyresgästen inte skrivit under.
    //
    // ⚠️ ANROPARNA SKILJER PÅ NULL-ORSAKER. `bookReminderFee` returnerar null
    // både här och när kontoplanen saknar 1510/3593 — och de två fallen får
    // INTE behandlas lika. Kontoplansfallet ska kasta (INV-A: ingen avgift
    // utan verifikat); det här fallet ska inte. Anroparna grindar därför på
    // avtalsgrunden FÖRE de anropar, och kastar bara när de vet att avgiften
    // var tillåten men bokföringen ändå uteblev.
    if (!isReminderFeeContractuallyAllowed(debtOrigin, termsFrom)) return null

    // ── G3: DET LAGSTADGADE TAKET, SISTA LINJEN ───────────────────────────
    //
    // Tredje och sista lagret. `@Max(REMINDER_FEE_MAX_SEK)` i
    // UpdateOrganizationDto hindrar att ett för högt värde skrivs in, men
    // validering skyddar bara skrivningar GENOM DEN VÄGEN. `resolveReminderFee`
    // klampar hos anroparen, före anspråket, så att reskontran och huvudboken
    // bär samma tal. Klampningen här fångar den anropare som inte gjort det.
    //
    // ⚠️ DEN FÄLLER INTE I PRODUKTION, OCH SKA INTE GÖRA DET. Båda dagens
    // anropare skickar redan ett klampat belopp, så varningen nedan är tyst för
    // dem — den som larmar om felkonfigurationen är `reminderFeeCapMessage` hos
    // anroparen, med avi- eller fakturanummer i loggraden. Fäller den här
    // klampningen betyder det att en NY anropare skriver reskontran med ett
    // oklampat belopp, och då är verifikatet det enda som räddats. Behandla ett
    // utfall härifrån som ett fynd, inte som att skyddet fungerade.
    //
    // Att den ändå står kvar är poängen med försvar i djupet: en spärr som bara
    // finns hos anroparen är ingen spärr mot nästa anropare.
    //
    // TAKET GÄLLER ALLA HYRESGÄSTTYPER. 6 § första stycket lagen (1981:739)
    // gör ett avtalsvillkor som utvidgar gäldenärens ersättningsskyldighet
    // ogiltigt, och ordalydelsen har ingen konsumentavgränsning — ett avtalat
    // belopp över taket är ogiltigt i den överskjutande delen även mellan
    // företag. Ingen INDIVIDUAL/COMPANY-förgrening ska införas här.
    //
    // KLAMPAS, INTE VÄGRAS. Att returnera null hade tagit bort hela avgiften
    // och därmed straffat hyresvärden för en felkonfiguration — de 60 kronorna
    // är hen faktiskt berättigad till. Bara det överskjutande är ogiltigt.
    //
    // OCH DEN ÄR INTE TYST — MEN DEN BETYDER NÅGOT ANNAT ÄN FÖRR.
    //
    // Före resolvern var ett utfall här en KONFIGURATION: någon hade skrivit in
    // ett olagligt belopp, och raden fanns för att hen skulle få veta varför det
    // blev 60. Den betydelsen är övertagen av `reminderFeeCapMessage` hos
    // anroparen, som dessutom kan namnge avin eller fakturan.
    //
    // Ett utfall HÄR betyder nu i stället en DEFEKT: en anropare har skrivit
    // avgiften utan att gå genom `resolveReminderFee`. Och eftersom reskontran
    // skrivs FÖRE bokföringen är skadan sannolikt redan skedd — verifikatet är
    // det enda som räddats. Därför `error`, inte `warn`: raden är inte en
    // upplysning om en inställning, den är ett fynd om ett krav som kan vara för
    // högt. Nivån väljs efter vad ett utfall betyder, inte efter hur ovanligt
    // det är.
    //
    // Raden bär `source`/`sourceId` för att det ska gå att hitta VILKET krav som
    // berörs — utan dem säger larmet bara att något är fel någonstans i en
    // organisation.
    const cappedFee = Math.min(fee, REMINDER_FEE_MAX_SEK)
    if (cappedFee < fee) {
      this.logger.error(
        `ANROPARE FÖRBI resolveReminderFee: påminnelseavgiften för ${source} ${sourceId} ` +
          `(organisation ${organizationId}) kom hit på ${fee} kr och klampades till ` +
          `${cappedFee} kr (taket i 4 § lagen 1981:739, tvingande enligt 6 § 1 st). ` +
          `Verifikatet är räddat — men reskontran skrivs av anroparen FÖRE bokföringen ` +
          `och bär sannolikt ${fee} kr. Kontrollera kravet mot hyresgästen, och hitta ` +
          `skrivaren: beloppet ska komma ur resolveReminderFee.`,
      )
    }

    const db = params.tx ?? this.prisma
    const accounts = await db.account.findMany({
      where: { organizationId, number: { in: [1510, 3593] } },
      select: { id: true, number: true },
    })
    const byNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const receivableId = byNumber.get(1510)
    const reminderRevenueId = byNumber.get(3593)
    if (!receivableId || !reminderRevenueId) {
      this.logger.warn(
        `Saknar konto 1510 eller 3593 för organisation ${organizationId} — ` +
          `påminnelseavgift (${source} ${sourceId}) bokfördes inte`,
      )
      return null
    }

    return this.createNumberedEntry({
      organizationId,
      date: new Date(),
      description,
      source,
      sourceId,
      createdById: params.createdById ?? null,
      lines: [
        { accountId: receivableId, debit: cappedFee, description: 'Påminnelseavgift fordran' },
        {
          accountId: reminderRevenueId,
          credit: cappedFee,
          description: 'Påminnelseintäkt (momsfri)',
        },
      ],
      idempotencyWhere: { organizationId, source, sourceId },
      ...(params.tx ? { tx: params.tx } : {}),
    })
  }

  /**
   * Bokför dröjsmålsränta: 1510 D / 8131 K. Speglar bookReminderFee men
   * krediterar 8131 (Dröjsmålsränta, kundfordringar) — en FINANSIELL intäkt.
   * Räntan får ALDRIG hamna på 3593 (påminnelseavgift, rörelseintäkt); det är
   * två olika resultatposter (bokföringsexpertens uttryckliga poäng).
   *
   * Momsfri (dröjsmålsränta är inte omsättning, ML). Idempotent + gap-free via
   * createNumberedEntry (unikt index (org, source, sourceId)). En `tx` kan
   * skickas in så att räntemarkeringen på avin och verifikatet skapas ATOMISKT
   * (INV-A). `date` daterar verifikatet till kristalliseringspunkten.
   *
   * Returnerar verifikatet, eller null om beloppet ≤ 0 eller om 1510/8131 saknas
   * i kontoplanen (loggas) — anroparen avgör då om kristalliseringen ska avbrytas.
   */
  async bookInterest(params: {
    organizationId: string
    source: JournalEntrySource
    sourceId: string
    amount: number
    description: string
    date?: Date
    createdById?: string | null
    tx?: Prisma.TransactionClient
  }): Promise<{ id: string } | null> {
    const { organizationId, source, sourceId, amount, description } = params
    if (!Number.isFinite(amount) || amount <= 0) return null

    const db = params.tx ?? this.prisma
    const accounts = await db.account.findMany({
      where: { organizationId, number: { in: [1510, 8131] } },
      select: { id: true, number: true },
    })
    const byNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const receivableId = byNumber.get(1510)
    const interestIncomeId = byNumber.get(8131)
    if (!receivableId || !interestIncomeId) {
      this.logger.warn(
        `Saknar konto 1510 eller 8131 för organisation ${organizationId} — ` +
          `dröjsmålsränta (${source} ${sourceId}) bokfördes inte`,
      )
      return null
    }

    return this.createNumberedEntry({
      organizationId,
      date: params.date ?? new Date(),
      description,
      source,
      sourceId,
      createdById: params.createdById ?? null,
      lines: [
        { accountId: receivableId, debit: amount, description: 'Dröjsmålsränta fordran' },
        { accountId: interestIncomeId, credit: amount, description: 'Dröjsmålsränteintäkt' },
      ],
      idempotencyWhere: { organizationId, source, sourceId },
      ...(params.tx ? { tx: params.tx } : {}),
    })
  }

  /**
   * Bokför BEFARAD kundförlust: 1515 D / 1510 K — omklassning av en osäker
   * hyresfordran från kundfordringar (1510) till osäkra kundfordringar (1515).
   * En ren BALANSRÄKNINGS-omklassning: ingen resultatpåverkan, ingen moms.
   *
   * ENDAST MOMSFRI fordran (bostadshyra). Lokalhyra under frivillig skattskyldighet
   * är momspliktig och momsåterkravet vid kundförlust är en ÖPPEN revisorfråga
   * (docs/legal/46 fråga 1) — anroparen vägrar momspliktiga avier, så ingen 26xx-rad
   * rörs här. Skriv ALDRIG egen moms-återkravslogik innan revisorn svarat.
   *
   * Idempotent + gap-free via createNumberedEntry (unikt index (org, source,
   * sourceId)). `tx` kan skickas in så att avins befarad-markering (probableLossAt)
   * och verifikatet skapas ATOMISKT (INV-A). Returnerar verifikatet, eller null om
   * beloppet ≤ 0 eller om 1510/1515 saknas (loggas) — anroparen avbryter då.
   */
  async bookBadDebtReclassification(params: {
    organizationId: string
    source: JournalEntrySource
    sourceId: string
    // T5 A2b: fordrans accrual-nyckel (t.ex. 'rent-notice:<noticeId>'). Fail-closed-
    // guarden verifierar att 1510-DEBETEN faktiskt bokförts innan nedskrivningen
    // krediterar 1510 — annars spökkredit på nedskrivningssidan (samma F1-fälla som
    // A2 stängde för betalning). Skild från sourceId (nedskrivningens EGNA nyckel).
    accrualSourceId: string
    amount: number
    description: string
    date?: Date
    createdById?: string | null
    tx?: Prisma.TransactionClient
  }): Promise<{ id: string } | null> {
    const { organizationId, source, sourceId, accrualSourceId, amount, description } = params
    if (!Number.isFinite(amount) || amount <= 0) return null

    const db = params.tx ?? this.prisma
    const accounts = await db.account.findMany({
      where: { organizationId, number: { in: [1510, 1515] } },
      select: { id: true, number: true },
    })
    const byNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const receivableId = byNumber.get(1510)
    const doubtfulId = byNumber.get(1515)
    if (!receivableId || !doubtfulId) {
      this.logger.warn(
        `Saknar konto 1510 eller 1515 för organisation ${organizationId} — ` +
          `befarad kundförlust (${source} ${sourceId}) bokfördes inte`,
      )
      return null
    }

    // T5 A2b fail-closed: neka nedskrivningen (kastar MissingAccrualError) om
    // fordrans accrual-debet saknas — 1510 får aldrig krediteras utan sin debet.
    await this.assertReceivableAccrualBooked(db, organizationId, accrualSourceId, description)

    return this.createNumberedEntry({
      organizationId,
      date: params.date ?? new Date(),
      description,
      source,
      sourceId,
      createdById: params.createdById ?? null,
      lines: [
        { accountId: doubtfulId, debit: amount, description: 'Omklassning osäker kundfordran' },
        { accountId: receivableId, credit: amount, description: 'Befarad kundförlust' },
      ],
      idempotencyWhere: { organizationId, source, sourceId },
      ...(params.tx ? { tx: params.tx } : {}),
    })
  }

  /**
   * Bokför KONSTATERAD kundförlust: 6352 D / 1515 K — den osäkra fordran (1515)
   * skrivs av som en konstaterad förlust (6352, kostnadskonto 6-serien). Detta är
   * resultatpåverkan: förlusten lämnar balansräkningen och belastar resultatet.
   *
   * Förutsätter att fordran redan omklassats till 1515 (bookBadDebtReclassification).
   * ENDAST MOMSFRI fordran (bostadshyra) — samma avgränsning som befarad: lokalhyrans
   * momsåterkrav (2611) väntar revisorbeslut (docs/legal/46 fråga 1) och rörs INTE.
   *
   * Idempotent + gap-free via createNumberedEntry. `tx` kan skickas in så att avins
   * WRITTEN_OFF-flip och verifikatet skapas ATOMISKT (INV-A). Returnerar verifikatet,
   * eller null om beloppet ≤ 0 eller om 1515/6352 saknas (loggas).
   */
  async bookBadDebtWriteOff(params: {
    organizationId: string
    source: JournalEntrySource
    sourceId: string
    amount: number
    description: string
    date?: Date
    createdById?: string | null
    tx?: Prisma.TransactionClient
  }): Promise<{ id: string } | null> {
    const { organizationId, source, sourceId, amount, description } = params
    if (!Number.isFinite(amount) || amount <= 0) return null

    const db = params.tx ?? this.prisma
    const accounts = await db.account.findMany({
      where: { organizationId, number: { in: [1515, 6352] } },
      select: { id: true, number: true },
    })
    const byNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const doubtfulId = byNumber.get(1515)
    const lossId = byNumber.get(6352)
    if (!doubtfulId || !lossId) {
      this.logger.warn(
        `Saknar konto 1515 eller 6352 för organisation ${organizationId} — ` +
          `konstaterad kundförlust (${source} ${sourceId}) bokfördes inte`,
      )
      return null
    }

    return this.createNumberedEntry({
      organizationId,
      date: params.date ?? new Date(),
      description,
      source,
      sourceId,
      createdById: params.createdById ?? null,
      lines: [
        { accountId: lossId, debit: amount, description: 'Konstaterad kundförlust' },
        { accountId: doubtfulId, credit: amount, description: 'Bortskrivning osäker fordran' },
      ],
      idempotencyWhere: { organizationId, source, sourceId },
      ...(params.tx ? { tx: params.tx } : {}),
    })
  }

  async getAccounts(organizationId: string) {
    return this.prisma.account.findMany({
      where: { organizationId },
      orderBy: { number: 'asc' },
    })
  }

  async getJournalEntries(organizationId: string, filters?: JournalFilters) {
    return this.prisma.journalEntry.findMany({
      where: {
        organizationId,
        ...(filters?.from || filters?.to
          ? {
              date: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {}),
              },
            }
          : {}),
        ...(filters?.source
          ? { source: filters.source as 'MANUAL' | 'INVOICE' | 'PAYMENT' | 'LEASE' }
          : {}),
      },
      include: {
        lines: {
          include: { account: true },
        },
        // Rättelsekedjan (PR1c2): `reversedBy` = rättelsen av DEN HÄR posten
        // (finns → knappen ska vara låst), `reversalOf` = posten den här RÄTTAR.
        reversedBy: { select: { id: true, series: true, verNumber: true, date: true } },
        reversalOf: { select: { id: true, series: true, verNumber: true, date: true } },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    })
  }

  async getJournalEntry(id: string, organizationId: string) {
    const entry = await this.prisma.journalEntry.findFirst({
      where: { id, organizationId },
      include: {
        lines: {
          include: { account: true },
        },
        reversedBy: { select: { id: true, series: true, verNumber: true, date: true } },
        reversalOf: { select: { id: true, series: true, verNumber: true, date: true } },
      },
    })
    if (!entry) throw new NotFoundException('Verifikation hittades inte')
    return entry
  }

  /**
   * Seeda BAS-kontoplan för en organisation. Hoppar över om kontona
   * redan är seedade — idempotent och säker att kalla flera gånger.
   *
   * Eget kapital-serien väljs baserat på companyForm:
   *   • AB             → 2080-serien (aktiekapital, reservfond, fritt kapital)
   *   • ENSKILD_FIRMA  → 2010-serien (eget kapital, egna uttag/insättningar)
   *   • HB / KB        → 2010-serien per delägare
   *   • FORENING       → 2065-serien
   *   • STIFTELSE      → 2070-serien
   *
   * Anropas både från AuthService.register() (vid org-skapande) och
   * från POST /v1/accounting/accounts/seed (manuell trigger för
   * importerade orgs som saknar kontoplan).
   */
  async seedDefaultAccounts(organizationId: string, companyForm?: CompanyForm): Promise<void> {
    const existing = await this.prisma.account.count({ where: { organizationId } })
    if (existing > 0) return

    let form: CompanyForm
    if (companyForm) {
      form = companyForm
    } else {
      // Fallback: läs upp från Organization-raden om anroparen inte
      // skickat med formen explicit. Default till AB om kolumnen är null.
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { companyForm: true },
      })
      form = org?.companyForm ?? CompanyForm.AB
    }

    const accounts = basChartFor(form)
    await this.prisma.account.createMany({
      data: accounts.map((a) => ({ ...a, organizationId })),
    })
  }

  async exportSie4(organizationId: string, from: string, to: string): Promise<Buffer> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, orgNumber: true, fiscalYearStartMonth: true },
    })

    // Dedikerad hämtning för export: ALLA verifikationer i perioden, kronologiskt
    // ordnade efter verifikationsnummer. (getJournalEntries har take:100 för UI —
    // får aldrig användas för SIE, då blir räkenskapsinformationen ofullständig.)
    const entries = await this.prisma.journalEntry.findMany({
      where: {
        organizationId,
        date: { gte: new Date(from), lte: new Date(to) },
      },
      include: { lines: { include: { account: true } } },
      orderBy: [{ date: 'asc' }, { series: 'asc' }, { verNumber: 'asc' }],
    })

    // ── #RAR: RÄKENSKAPSÅRET, inte exportintervallet ─────────────────────────
    //
    // Tidigare skrevs `#RAR 0 <from> <to>` — alltså exportens datumintervall.
    // Specen (§#RAR pt 1): "Räkenskapsårets start och slutdatum anges i formatet
    // ÅÅÅÅMMDD. Årsnr sätts till 0 för innevarande år och -1 för föregående år."
    // Exporterade man en månad påstod filen att räkenskapsåret var den månaden,
    // vilket får mottagande bokslutsprogram att periodisera fel.
    //
    // Räkenskapsåret härleds ur organisationens fiscalYearStartMonth — samma
    // regel som verifikationsnumreringen använder (VerifikationsnummerService).
    const startMonth = org?.fiscalYearStartMonth ?? 1
    const fiscalYears = fiscalYearsCovering(from, to, startMonth)

    // SIE4-format enligt SIE Gruppen specifikation 4B.
    // Källa: https://sie.se/wp-content/uploads/2020/05/SIE_filformat_ver_4B_080930.pdf
    const generatedAt = new Date()
    const genDate =
      generatedAt.getFullYear().toString() +
      String(generatedAt.getMonth() + 1).padStart(2, '0') +
      String(generatedAt.getDate()).padStart(2, '0')
    const lines: string[] = [
      '#FLAGGA 0',
      '#PROGRAM "Eveno" "1.0"',
      '#FORMAT PC8',
      `#GEN ${genDate}`,
      '#SIETYP 4',
      `#ORGNR ${org?.orgNumber ?? organizationId}`,
      `#FNAMN "${(org?.name ?? 'Okänd organisation').replace(/"/g, '')}"`,
      // Årsnr 0 = det räkenskapsår exporten SLUTAR i; tidigare år numreras
      // -1, -2 … Spänner exporten över flera räkenskapsår skrivs en rad per år,
      // vilket specen uttryckligen tillåter (§#RAR pt 2).
      ...fiscalYears.map((fy) => `#RAR ${fy.number} ${fy.start} ${fy.end}`),
      '',
    ]

    // Kontoplan – krävs för att bokslutsprogram ska kunna mappa.
    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      orderBy: { number: 'asc' },
    })
    for (const acc of accounts) {
      lines.push(`#KONTO ${acc.number} "${acc.name.replace(/"/g, '')}"`)
    }
    lines.push('')

    // ── SALDOPOSTERNA: #IB, #UB, #RES ───────────────────────────────────────
    //
    // Utan dem kan ett mottagande bokslutsprogram varken bygga en balansräkning
    // eller en resultaträkning ur filen — den blir en verifikationslista, inte
    // en bokföringsexport.
    //
    // TECKEN: `sieSignedAmount`, samma råa Σdebet − Σkredit som `#TRANS` ovan.
    // Läs docblocket där innan du frestas att återanvända getBalanceSheet.
    //
    // INGET `{}`-fält på de här posterna. Bara `#TRANS` har objektfältet; skriver
    // man det här avvisas raden av strikta läsare.
    //
    // HÄMTNINGEN GÅR INTE VIA `entries`. Den arrayen är avgränsad till
    // from/to, och `#IB` behöver allt som hänt FÖRE räkenskapsårets start —
    // ofta långt utanför exportintervallet. En deposition mottagen 2024 ska
    // fortfarande synas som skuld i ingående balans 2026.
    const balanceAccounts = accounts.filter(
      (a) => a.type === 'ASSET' || a.type === 'LIABILITY' || a.type === 'EQUITY',
    )
    const resultAccounts = accounts.filter((a) => a.type === 'REVENUE' || a.type === 'EXPENSE')

    /** Saldo per konto-id för ett datumfönster. Summerar hela historiken som ryms i where. */
    const balancesFor = async (where: Prisma.JournalEntryLineWhereInput) => {
      const rows = await this.prisma.journalEntryLine.groupBy({
        by: ['accountId'],
        where,
        _sum: { debit: true, credit: true },
      })
      const per = new Map<string, number>()
      for (const r of rows) per.set(r.accountId, sieSignedAmount(r._sum.debit, r._sum.credit))
      return per
    }

    /** YYYYMMDD → Date (UTC-midnatt). fiscalYearsCovering ger kompakt form. */
    const fromCompact = (c: string): Date =>
      new Date(`${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}T00:00:00Z`)

    // CUTOFF = `to`, inte räkenskapsårets slut. Vid en PARTIELL export (och
    // SIE4-fliken föreslår "innevarande år t.o.m. idag", alltså nästan alltid)
    // måste utgående saldo stämma mot de verifikationer filen FAKTISKT
    // innehåller. Räknades det mot årets slut skulle IB + filens transaktioner
    // ≠ UB, och mottagaren får ett avstämningsfel den inte kan lösa.
    const cutoff = new Date(to)

    for (const fy of fiscalYears) {
      const yearStart = fromCompact(fy.start)
      const yearEnd = fromCompact(fy.end)

      // CUTOFF PER ÅR = min(räkenskapsårets slut, exportens `to`).
      //
      // För ett AVSLUTAT år (index -1 och nedåt) är utgående saldo årets slut —
      // annars skulle `#UB -1` innehålla rörelser som hör till år 0, och två
      // årsindex skulle rapportera exakt samma tal. För det SENASTE året är
      // cutoff `to`, så att saldot stämmer mot de verifikationer filen bär.
      const yearCutoff = yearEnd < cutoff ? yearEnd : cutoff

      // DAGSGRÄNSER, och det är rätt (#730): `yearStart`/`yearCutoff` kommer ur
      // `fromCompact` respektive `new Date(to)` — båda UTC-midnatt. Mot en
      // `@db.Date`-kolumn är Prismas trunkering då en no-op, och fönstren
      // inkluderar sin egen sista dag. Bytt till ögonblick hade de slutat göra
      // det. Rör dem inte.
      const ib = await balancesFor({ journalEntry: { organizationId, date: { lt: yearStart } } })
      const ub = await balancesFor({ journalEntry: { organizationId, date: { lte: yearCutoff } } })
      const res = await balancesFor({
        journalEntry: { organizationId, date: { gte: yearStart, lte: yearCutoff } },
      })

      // NOLLSALDON UTELÄMNAS — skriv inte 0.00-rader "för tydlighets skull".
      //
      // En utelämnad rad läses av mottagaren som noll, och regeln har en andra
      // effekt som är lätt att missa: den är precis det som gör att ett
      // räkenskapsår UTAN data (nystartad organisation, eller tiden före
      // nollställningen) faller ut rätt helt utan specialkod. Alla konton får
      // saldo 0, inga rader skrivs, och `#RAR -1` står kvar utan saldoposter —
      // vilket är en giltig fil som säger "inga siffror registrerade det året".
      //
      // Lägger någon till en 0.00-rad "för fullständighet" försvinner den
      // egenskapen, och nystartade organisationer får en fil full av nollor.
      const push = (tag: string, per: Map<string, number>, urval: typeof accounts) => {
        for (const acc of urval) {
          const saldo = per.get(acc.id) ?? 0
          if (saldo === 0) continue
          lines.push(`${tag} ${fy.number} ${acc.number} ${saldo.toFixed(2)}`)
        }
      }
      push('#IB', ib, balanceAccounts)
      push('#UB', ub, balanceAccounts)
      push('#RES', res, resultAccounts)
    }
    lines.push('')

    // Verifikationsnummer (serie + nummer) skrivs ut deterministiskt så att
    // samma verifikation identifieras lika i varje export (BFL 5 kap 6 §).
    for (const entry of entries) {
      const dateStr = entry.date.toISOString().slice(0, 10).replace(/-/g, '')
      const serie = entry.series.replace(/"/g, '')
      lines.push(
        `#VER "${serie}" ${entry.verNumber} ${dateStr} "${entry.description.replace(/"/g, '')}"`,
      )
      lines.push('{')
      for (const l of entry.lines) {
        // Samma formel som saldoposterna nedan — se sieSignedAmount.
        const amount = sieSignedAmount(l.debit, l.credit)
        lines.push(`  #TRANS ${l.account.number} {} ${amount.toFixed(2)}`)
      }
      lines.push('}')
      lines.push('')
    }

    // Filen deklarerar `#FORMAT PC8` — då MÅSTE bytena vara CP437, annars
    // motsäger deklarationen innehållet och å/ä/ö blir skräptecken hos
    // mottagaren. Specen tillåter ingen annan teckenuppsättning (§5.8).
    return encodeCp437(lines.join('\n'))
  }

  // ── Finansiella rapporter ───────────────────────────────────────────────
  // EN sanningskälla för beräkningen. Både REST-endpoints (AccountingController)
  // och AI-verktygen (tool-executor) anropar dessa metoder — ingen divergens.

  // Momsrapport: utgående moms (kredit på 2611/2621/2631 = försäljning ökar
  // skuld) minus ingående moms (debet på 2641 = köp ökar fordran på SKV).
  async getVatReport(organizationId: string, from: string, to: string): Promise<VatReport> {
    const accounts = await this.prisma.account.findMany({
      where: { organizationId, number: { in: [2611, 2621, 2631, 2641] } },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a]))

    const sumFor = async (num: number) => {
      const acc = accountByNumber.get(num)
      if (!acc) return { debit: 0, credit: 0 }
      const agg = await this.prisma.journalEntryLine.aggregate({
        where: {
          accountId: acc.id,
          journalEntry: {
            organizationId,
            date: { gte: new Date(from), lte: new Date(to) },
          },
        },
        _sum: { debit: true, credit: true },
      })
      return {
        debit: Number(agg._sum.debit ?? 0),
        credit: Number(agg._sum.credit ?? 0),
      }
    }

    const [v25, v12, v6, vIn] = await Promise.all([
      sumFor(2611),
      sumFor(2621),
      sumFor(2631),
      sumFor(2641),
    ])
    const outVat25 = v25.credit - v25.debit
    const outVat12 = v12.credit - v12.debit
    const outVat6 = v6.credit - v6.debit
    const outTotal = outVat25 + outVat12 + outVat6
    const inVat = vIn.debit - vIn.credit
    const netToPay = outTotal - inVat
    return {
      period: { from, to },
      outgoing: { vat25: outVat25, vat12: outVat12, vat6: outVat6, total: outTotal },
      incoming: { total: inVat },
      netToPay,
      direction: netToPay >= 0 ? 'BETALA' : 'ÅTERBÄRING',
    }
  }

  // Resultaträkning: intäkter (3xxx, kreditsaldo) minus kostnader
  // (5xxx–8xxx, debetsaldo), grupperat i BAS-kontoklasser.
  async getProfitLossReport(
    organizationId: string,
    from: string,
    to: string,
    propertyId?: string,
  ): Promise<ProfitLossReport> {
    const lines = await this.prisma.journalEntryLine.findMany({
      where: {
        journalEntry: {
          organizationId,
          date: { gte: new Date(from), lte: new Date(to) },
        },
      },
      include: { account: true },
    })
    const buckets: Record<string, ReportAccountAmount[]> = {
      revenue: [],
      operating: [],
      admin: [],
      personnel: [],
      depreciation: [],
      financial: [],
    }
    const sums = {
      revenue: 0,
      operating: 0,
      admin: 0,
      personnel: 0,
      depreciation: 0,
      financial: 0,
    }
    const perAccount = new Map<number, { name: string; amount: number }>()
    for (const l of lines) {
      const num = l.account.number
      const debit = Number(l.debit ?? 0)
      const credit = Number(l.credit ?? 0)
      const value = num >= 3000 && num < 4000 ? credit - debit : debit - credit
      const cur = perAccount.get(num) ?? { name: l.account.name, amount: 0 }
      cur.amount += value
      perAccount.set(num, cur)
    }
    for (const [num, info] of perAccount) {
      if (num >= 3000 && num < 4000) {
        buckets.revenue!.push({ number: num, name: info.name, amount: info.amount })
        sums.revenue += info.amount
      } else if (num >= 5000 && num < 6000) {
        buckets.operating!.push({ number: num, name: info.name, amount: info.amount })
        sums.operating += info.amount
      } else if (num >= 6000 && num < 7000) {
        buckets.admin!.push({ number: num, name: info.name, amount: info.amount })
        sums.admin += info.amount
      } else if (num >= 7000 && num < 8000) {
        buckets.personnel!.push({ number: num, name: info.name, amount: info.amount })
        sums.personnel += info.amount
      } else if (num >= 8000 && num < 8400) {
        buckets.depreciation!.push({ number: num, name: info.name, amount: info.amount })
        sums.depreciation += info.amount
      } else if (num >= 8400 && num < 9000) {
        buckets.financial!.push({ number: num, name: info.name, amount: info.amount })
        sums.financial += info.amount
      }
    }
    const totalCosts =
      sums.operating + sums.admin + sums.personnel + sums.depreciation + sums.financial
    const result = sums.revenue - totalCosts
    return {
      period: { from, to },
      ...(propertyId
        ? {
            propertyFilter: propertyId,
            note: 'Per-fastighets-resultat kräver att kostnader är taggade per fastighet — totalsumman gäller hela organisationen tills dess.',
          }
        : {}),
      revenue: { total: sums.revenue, accounts: buckets.revenue! },
      costs: {
        operating: { total: sums.operating, accounts: buckets.operating! },
        admin: { total: sums.admin, accounts: buckets.admin! },
        personnel: { total: sums.personnel, accounts: buckets.personnel! },
        depreciation: { total: sums.depreciation, accounts: buckets.depreciation! },
        financial: { total: sums.financial, accounts: buckets.financial! },
        total: totalCosts,
      },
      result,
    }
  }

  /**
   * Σ intäkt (BAS-kontoklass 3, kreditsaldo − debetsaldo) för perioden, direkt
   * ur huvudboken. EN enda aggregate — DB:n summerar debit/credit, ingen
   * radhydrering till Node (till skillnad från getProfitLossReport, som laddar
   * hela periodens alla konton i minnet för att gruppera per konto/kontoklass).
   * Avsedd för frekventa KPI-anrop (dashboardens "Totala intäkter").
   *
   * DUBBELRÄKNINGS-SÄKER: hyra (RentNotice → 39xx), förbrukning (Consumption-
   * Charge → 30xx/3xxx) och manuella fakturor (Invoice → 39xx) konvergerar alla
   * till kontoklass 3 via JournalEntry — varje krona bokförs exakt en gång.
   * Depositioner (2890, skuld) ligger utanför spannet [3000,4000) och räknas
   * därför ALDRIG som intäkt. Detta är den enda intäktskälla som strukturellt
   * undviker att läsa Invoice och RentNotice parallellt (och dubbelräkna dem).
   *
   * ACCRUAL, inte kassa: intäkten bokförs vid avi-/fakturagenerering (den
   * intjänade perioden), oavsett betalstatus — matchar resultaträkningen.
   *
   * Dubbelt org-scopat (account.organizationId + journalEntry.organizationId):
   * summan kan aldrig spänna över fel tenant. Ren LÄSNING — rör aldrig
   * verifikat/huvudbok.
   */
  /**
   * `to` FÅR VARA ETT ÖGONBLICK, och normaliseras här (#730).
   *
   * `JournalEntry.date` är `@db.Date`, så Prisma trunkerar en ögonblicksgräns
   * till dess UTC-datum — inte till dagens datum i Sverige. Mätt: med
   * `to = 2026-12-31T23:30Z`, alltså 1 januari 00:30 svensk tid, föll raden
   * daterad 2027-01-01 bort. "Årets intäkter hittills" tappade den innevarande
   * dagen under de sista en till två timmarna av varje UTC-dygn.
   *
   * `throughStockholmDay` gör gränsen till den svenska civila dagen, så den
   * betyder samma sak dygnet runt. `from` normaliseras INTE: båda anroparna
   * skickar redan räkenskapsårets första dag som UTC-midnatt.
   */
  async getRevenueTotal(organizationId: string, from: Date, to: Date): Promise<number> {
    const agg = await this.prisma.journalEntryLine.aggregate({
      where: {
        account: { organizationId, number: { gte: 3000, lt: 4000 } },
        journalEntry: {
          organizationId,
          date: { gte: from, lte: throughStockholmDay(to) },
        },
      },
      _sum: { debit: true, credit: true },
    })
    const revenue = Number(agg._sum.credit ?? 0) - Number(agg._sum.debit ?? 0)
    return Math.round(revenue * 100) / 100
  }

  /**
   * Bokförd intäkt räkenskapsår-till-idag (Σ 3xxx accrual) för en organisation,
   * inkl. den beräknade perioden. DELAD sanningskälla för "Totala intäkter" —
   * samma bas som dashboardens KPI. Läser Organization.fiscalYearStartMonth och
   * beräknar [räkenskapsårets start (UTC), now] med SAMMA formel som
   * DashboardService.fiscalYearToDate (default 1 = kalenderår). Avsedd så att AI
   * och dashboard rapporterar identisk intäkt för samma org/tidpunkt utan att
   * duplicera vare sig period- eller summeringslogik. Ren LÄSNING.
   *
   * OBS spegling: dashboard har fortfarande en egen privat fiscalYearToDate;
   * följdpunkt att låta även den anropa denna metod (då försvinner spegeln).
   */
  async getRevenueYearToDate(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<{ total: number; from: Date; to: Date }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { fiscalYearStartMonth: true },
    })
    const fiscalYearStartMonth = org?.fiscalYearStartMonth ?? 1
    // Svensk civil tid: vid årsskiftet avgör datumet i Sverige vilket
    // räkenskapsår som är "innevarande".
    const { year: y, month: currentMonth } = stockholmCivilDate(now)
    const startYear = currentMonth >= fiscalYearStartMonth ? y : y - 1
    const from = new Date(Date.UTC(startYear, fiscalYearStartMonth - 1, 1))
    const total = await this.getRevenueTotal(organizationId, from, now)
    return { total, from, to: now }
  }

  // Balansräkning per ett datum: tillgångar (1xxx, debet−kredit) mot
  // skulder/eget kapital (2xxx, kredit−debet). difference ska vara 0 i en
  // balanserad bok.
  async getBalanceSheet(organizationId: string, asOf: string): Promise<BalanceSheet> {
    const lines = await this.prisma.journalEntryLine.findMany({
      where: {
        journalEntry: { organizationId, date: { lte: new Date(asOf) } },
      },
      include: { account: true },
    })
    const perAccount = new Map<number, { name: string; balance: number }>()
    for (const l of lines) {
      const num = l.account.number
      const debit = Number(l.debit ?? 0)
      const credit = Number(l.credit ?? 0)
      const value = num < 2000 ? debit - credit : credit - debit
      const cur = perAccount.get(num) ?? { name: l.account.name, balance: 0 }
      cur.balance += value
      perAccount.set(num, cur)
    }
    const assets: ReportAccountBalance[] = []
    const liabilities: ReportAccountBalance[] = []
    let totalAssets = 0
    let totalLiabilities = 0
    for (const [num, info] of perAccount) {
      if (num < 2000) {
        assets.push({ number: num, name: info.name, balance: info.balance })
        totalAssets += info.balance
      } else if (num < 3000) {
        liabilities.push({ number: num, name: info.name, balance: info.balance })
        totalLiabilities += info.balance
      }
    }
    assets.sort((a, b) => a.number - b.number)
    liabilities.sort((a, b) => a.number - b.number)
    return {
      asOf,
      assets: { total: totalAssets, accounts: assets },
      liabilitiesAndEquity: { total: totalLiabilities, accounts: liabilities },
      difference: totalAssets - totalLiabilities,
    }
  }

  /**
   * Fakturans konteringsrader i NORMALRIKTNING: 1510 D / 39xx K / 26xx K.
   *
   * BRUTEN UT UR `createJournalEntryForInvoice` (#517) för att kreditnotan ska
   * spegla EXAKT samma kontering — samma intäktskonto härlett ur samma
   * unit-typ, samma moms per sats, samma balanskontroll. En andra uppsättning
   * regler för kreditsidan hade kunnat glida ifrån fakturasidan, och då hade
   * krediteringen bokat bort intäkt från ett annat konto än den bokades på.
   *
   * Kreditnotan vänder raderna efteråt via `buildReversalLines` — samma
   * spegling som VOID redan använder.
   *
   * Returnerar null när kontoplanen saknar 1510/intäktskonto och anroparen
   * INTE är atomisk; i atomiskt läge kastas i stället, så att den yttre
   * transaktionen rullas tillbaka i stället för att committa utan verifikat.
   */
  private async buildInvoiceJournalLines(
    invoice: Invoice & { lines: InvoiceLine[] },
    organizationId: string,
    db: Prisma.TransactionClient | PrismaService,
    atomic: boolean,
  ): Promise<Array<{
    accountId: string
    debit?: number
    credit?: number
    description: string
  }> | null> {
    // Look up account numbers
    const accounts = await db.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))

    // Välj hyresintäktskonto (39xx) utifrån lägenhetens/lokalens typ. En
    // hyresfaktura avser ett kontrakt (lease) → en unit, så typen avgör om
    // intäkten är bostad (3911), lokal (3913), p-plats (3912) eller övrigt.
    let unitType: UnitType | null = null
    if (invoice.leaseId) {
      // Org-scopad findFirst (inte findUnique på enbart id) — FIX 2-mönstret mot
      // cross-tenant-läsning. Ett leaseId från en annan org → null → fallback
      // till default-intäktskonto (3914) i revenueAccountForUnitType.
      const lease = await db.lease.findFirst({
        where: { id: invoice.leaseId, organizationId },
        select: { unit: { select: { type: true } } },
      })
      // leaseId var satt men ingen lease hittades i org → anomali (möjligt
      // cross-tenant-försök eller felkopplad lease). Logga så det syns; intäkten
      // faller tillbaka till 3914. Förväntat null (faktura utan lease) loggas ej.
      if (!lease) {
        this.logger.warn(
          `[Accounting] Lease ${invoice.leaseId} hittades ej i org ${organizationId} ` +
            `för faktura ${invoice.invoiceNumber} — intäkt bokförs mot 3914 (fallback).`,
        )
      }
      unitType = lease?.unit?.type ?? null
    }
    const revenueAccountNumber = revenueAccountForUnitType(unitType)

    const receivableId = accountByNumber.get(1510)
    const revenueId = accountByNumber.get(revenueAccountNumber)

    if (!receivableId || !revenueId) {
      // T5 A1 (bokförings-expert HIGH): symmetriskt med createJournalEntryFor-
      // RentNotice. Tidigare TYST `return null` → en felkonfigurerad kontoplan gav
      // en faktura UTAN intäktsverifikat (orphan-faktura, A0-fyndet) utan att någon
      // larmades. Logga ALLTID; och i ATOMISKT läge (tx angiven) KASTA så den yttre
      // transaktionen rullar tillbaka fakturan i stället för att committa den utan
      // verifikat. Utan tx (best-effort) behålls null (oförändrat).
      const missing = !receivableId ? 1510 : revenueAccountNumber
      this.logger.error(
        `[Accounting] Konto ${missing} saknas i kontoplanen (org ${organizationId}) — ` +
          `intäktsverifikat för faktura ${invoice.invoiceNumber} skapas ej.`,
      )
      if (atomic) {
        throw new UnprocessableEntityException(
          `Kontoplanen saknar konto ${missing} — fakturan kan inte bokföras atomiskt`,
        )
      }
      return null
    }

    const subtotal = Number(invoice.subtotal)
    const total = Number(invoice.total)

    // Build journal lines
    const lines: Array<{
      accountId: string
      debit?: number
      credit?: number
      description: string
    }> = [
      // Debit receivables for full amount
      { accountId: receivableId, debit: total, description: `Faktura ${invoice.invoiceNumber}` },
      // Credit revenue for subtotal
      { accountId: revenueId, credit: subtotal, description: 'Hyresintäkt' },
    ]

    // ── Moms per momssats ────────────────────────────────────────────────────
    //
    // Momsen HÄRLEDS ur radernas lagrade belopp med EXAKT samma metod som
    // faktureringen använde (computeInvoiceAmounts i invoices.service.ts):
    // radens moms = brutto − netto, där brutto är det redan öresavrundade
    // `line.total` och nettot avrundas likadant.
    //
    // Tidigare räknades momsen om från grunden och OAVRUNDAT:
    //
    //     const vat = Number(q) * Number(unitPrice) * (vatRate / 100)
    //
    // Det är en ANNAN formel än fakturans (som tar brutto − netto per rad, båda
    // öresavrundade). På enradsfakturor sammanföll de; på flerradsfakturor gjorde
    // de inte det, och verifikatet blev OBALANSERAT — debet togs från det lagrade
    // `invoice.total` medan krediten byggdes av den omräknade momsen:
    //
    //     3 rader à 33,33 kr @ 25 %:  debet 124,98  kredit 124,99  → 1 öre fel
    //     7 rader à 14,29 kr @ 25 %:  debet 125,02  kredit 125,04  → 2 öre fel
    //
    // Ingenting upptäckte det: createNumberedEntry kontrollerar inte att debet =
    // kredit (den globala grinden är ett eget ärende, C1), och Decimal(10,2)
    // avrundade tyst vid skrivning så raderna SÅG rimliga ut.
    //
    // Aritmetiken görs i Decimal, inte i float. Summan av per-sats-momsen blir
    // per konstruktion exakt `invoice.vatTotal` — fakturan byggde vatTotal ur
    // samma per-rad-värden — så krediten (netto + moms) blir exakt lika med
    // debet (total).
    const vatByRate = new Map<number, Prisma.Decimal>()
    for (const line of invoice.lines) {
      if (line.vatRate === 0) continue // momsbefriat — ingen momsrad
      const net = new Prisma.Decimal(line.quantity).times(line.unitPrice).toDecimalPlaces(2)
      const lineVat = new Prisma.Decimal(line.total).minus(net)
      const prev = vatByRate.get(line.vatRate) ?? new Prisma.Decimal(0)
      vatByRate.set(line.vatRate, prev.plus(lineVat))
    }

    for (const [rate, amount] of vatByRate) {
      if (amount.lte(0)) continue
      const vatAccountNumber = VAT_TO_ACCOUNT[rate]
      if (!vatAccountNumber) {
        // En momssats utan konto skulle tyst utelämna krediten och lämna
        // verifikatet obalanserat. DTO:n begränsar satsen till 0/6/12/25, så
        // detta nås bara via en väg som kringgår valideringen — men då ska det
        // fela högt, inte tyst.
        throw new UnprocessableEntityException(
          `Okänd momssats ${rate}% på faktura ${invoice.invoiceNumber} — verifikatet kan inte balanseras`,
        )
      }
      const vatAccountId = accountByNumber.get(vatAccountNumber)
      if (!vatAccountId) {
        // Samma resonemang: saknat momskonto får inte ge ett tyst tapp av
        // momsraden. (Symmetriskt med createJournalEntryForRentNotice, som
        // redan kastar i motsvarande läge.)
        throw new UnprocessableEntityException(
          `Kontoplanen saknar momskonto ${vatAccountNumber} (moms ${rate}%) — ` +
            `faktura ${invoice.invoiceNumber} kan inte bokföras balanserat`,
        )
      }
      lines.push({
        accountId: vatAccountId,
        credit: amount.toNumber(),
        description: `Moms ${rate}%`,
      })
    }

    // Invarianten som hela fixen finns för: debet = kredit, exakt.
    //
    // Detta är INTE den globala balansgrinden (C1) — den hör hemma i
    // createNumberedEntry och gäller alla 15 verifikatvägar. Här kontrolleras
    // bara att just den här funktionens egen aritmetik går ihop, så att ett
    // dataavvikelse-fall (t.ex. rader vars summa inte matchar fakturans totaler)
    // fälls i stället för att skrivas till huvudboken.
    const creditSum = lines.reduce(
      (s, l) => (l.credit != null ? s.plus(l.credit) : s),
      new Prisma.Decimal(0),
    )
    const debitSum = lines.reduce(
      (s, l) => (l.debit != null ? s.plus(l.debit) : s),
      new Prisma.Decimal(0),
    )
    if (!creditSum.equals(debitSum)) {
      throw new UnprocessableEntityException(
        `Verifikatet för faktura ${invoice.invoiceNumber} balanserar inte ` +
          `(debet ${debitSum.toFixed(2)} / kredit ${creditSum.toFixed(2)}) — ` +
          `fakturans radbelopp stämmer inte mot dess totaler`,
      )
    }

    return lines
  }

  async createJournalEntryForInvoice(
    invoice: Invoice & { lines: InvoiceLine[] },
    organizationId: string,
    createdById: string,
    // T5 A1: valfri yttre transaktion så fakturan + intäktsverifikatet kan skapas
    // ATOMISKT (BFL 5:6). Trädd genom till createNumberedEntry. Kastar den (stängd
    // period/DB-fel) rullar den yttre tx:en tillbaka fakturan → ingen orphan.
    // Returnerar null (org saknar 1510/intäktskonto) = ingen bokföring, ingen
    // rollback (orgen bokför inte alls — utanför A1/audit-scope).
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma
    const lines = await this.buildInvoiceJournalLines(invoice, organizationId, db, !!tx)
    if (!lines) return null

    return this.createNumberedEntry({
      organizationId,
      date: invoice.issueDate,
      description: `Faktura ${invoice.invoiceNumber}`,
      source: 'INVOICE',
      sourceId: invoice.id,
      createdById,
      lines,
      idempotencyWhere: { organizationId, sourceId: invoice.id },
      include: { lines: { include: { account: true } } },
      ...(tx ? { tx } : {}),
    })
  }

  /**
   * KREDITNOTANS VERIFIKAT (#517, den obetalda halvan).
   *
   * Konteringen är fakturans, speglad:
   *
   *     D  39xx Hyresintäkt        krediterat netto
   *     D  26xx Utgående moms      momsandel
   *     K  1510 Kundfordringar     krediterat brutto
   *
   * Raderna byggs av `buildInvoiceJournalLines` ur KREDITNOTANS egna belopp och
   * vänds sedan av `buildReversalLines` — samma spegling som VOID gör. Att gå
   * via kreditnotans egna rader i stället för att skala originalverifikatet är
   * det som gör DELKREDITERING möjlig utan att balansen kan spricka: en
   * proportionerlig skalning av ett befintligt verifikat avrundar momsen på
   * nytt och behöver inte gå ihop.
   *
   * VARFÖR 1510 OCH INTE ETT SKULDKONTO: den här vägen körs bara för fakturor
   * UTAN mottagen betalning, så kundfordran är fortfarande öppen och
   * krediteringen går rakt mot den. En BETALD faktura har redan reglerat 1510
   * till noll; att kreditera den skulle skapa ett tillgodohavande — en skuld
   * till hyresgästen på ett 2xxx-konto som ännu inte är fastställt. Den vägen
   * är därför spärrad i CreditNoteService, inte halvbyggd här.
   *
   * EGEN NAMNRYMD: `sourceId = credit-note:<id>`. Det unika indexet
   * (organizationId, source, sourceId) gör bokföringen idempotent — ett
   * dubbelklick eller ett omförsök ger samma verifikat, inte två. Samma mönster
   * som `invoice-reversal:<id>` och `reminder-fee-reversal:<id>`.
   */
  async createJournalEntryForCreditNote(
    creditNote: Invoice & { lines: InvoiceLine[] },
    organizationId: string,
    createdById: string,
    // Alltid atomisk: kreditnotan och dess verifikat skapas i samma transaktion.
    // Faller bokföringen ska dokumentet inte finnas.
    tx: Prisma.TransactionClient,
  ) {
    const normal = await this.buildInvoiceJournalLines(creditNote, organizationId, tx, true)
    // `atomic: true` ovan gör att en saknad kontoplan kastar i stället för att
    // returnera null. Kontrollen står kvar för typens skull.
    if (!normal) {
      throw new UnprocessableEntityException(
        `Kontoplanen saknar konton för kreditnota ${creditNote.invoiceNumber}`,
      )
    }

    const mirrored = this.buildReversalLines(
      normal.map((l) => ({
        accountId: l.accountId,
        debit: l.debit != null ? new Prisma.Decimal(l.debit) : null,
        credit: l.credit != null ? new Prisma.Decimal(l.credit) : null,
        description: l.description ?? null,
      })),
      'Kreditering',
    )

    return this.createNumberedEntry({
      organizationId,
      date: creditNote.issueDate,
      description: `Kreditnota ${creditNote.invoiceNumber}`,
      source: 'INVOICE',
      sourceId: `credit-note:${creditNote.id}`,
      createdById,
      lines: mirrored,
      idempotencyWhere: {
        organizationId,
        source: 'INVOICE',
        sourceId: `credit-note:${creditNote.id}`,
      },
      include: { lines: { include: { account: true } } },
      tx,
    })
  }

  // BFL 5 kap 7 §: verifikationen ska ange motparten. Fakturanumret räcker
  // tekniskt (motpart kan slås upp via fakturakedjan), men BFN:s allmänna råd
  // till 5 kap 7 § anger att motparten bör framgå direkt om det kan ske utan
  // svårigheter. Vi hämtar därför motpartsnamnet via faktura-/avi→tenant-
  // relationen och skriver in det i betalningsverifikatets beskrivning.
  //
  // Selekterar endast namnfälten (inga känsliga uppgifter). Företagsnamn först,
  // annars privatpersonens för-/efternamn. Saknas namn helt returneras null →
  // beskrivningen lämnas utan motpartssuffix (ingen tom parentes).
  private formatCounterparty(
    tenant: {
      companyName: string | null
      firstName: string | null
      lastName: string | null
    } | null,
  ): string | null {
    if (!tenant) return null
    const name =
      tenant.companyName?.trim() || `${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim()
    return name || null
  }

  // Org-scopad findFirst (inte findUnique på enbart id) — FIX 2-mönstret mot
  // multi-tenant-läckage. Anroparna validerar redan id mot org, men scopningen
  // hålls konsekvent i fall metoderna återanvänds från ett mindre strikt kontext.
  private async counterpartyForInvoice(
    invoiceId: string,
    organizationId: string,
    // #288 — samma skärpning som systerfunktionen nedan: läses den härifrån inuti
    // en transaktion ska den läsa i transaktionens värld, inte bredvid den.
    tx?: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await (tx ?? this.prisma).invoice.findFirst({
      where: { id: invoiceId, organizationId },
      select: { tenant: { select: { companyName: true, firstName: true, lastName: true } } },
    })
    return this.formatCounterparty(row?.tenant ?? null)
  }

  private async counterpartyForRentNotice(
    noticeId: string,
    organizationId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await (tx ?? this.prisma).rentNotice.findFirst({
      where: { id: noticeId, organizationId },
      select: { tenant: { select: { companyName: true, firstName: true, lastName: true } } },
    })
    return this.formatCounterparty(row?.tenant ?? null)
  }

  // BAS-bokning vid bankbetalning: 1930 (Företagskonto) Debet → 1510 (Kundfordringar) Kredit.
  //
  // Idempotent per ALLOKERING (#326 D), inte per banktransaktion. Här stod
  // tidigare att "samma transaktion inte kan bokas två gånger även om matchen
  // ångras och görs om" — det var sant om utfallet och fel om orsaken: en
  // ommatchning bokade inte om, den ÅTERANVÄNDE det gamla, redan reverserade
  // verifikatet och bokförde ingenting alls. Se `allocationId` nedan.
  async createJournalEntryForPayment(
    invoice: Pick<Invoice, 'id' | 'invoiceNumber' | 'total'>,
    transaction: Pick<BankTransaction, 'id' | 'date' | 'amount'>,
    organizationId: string,
    createdById: string | null,
    // ── #326 D: IDEMPOTENSEN NYCKLAS PÅ ALLOKERINGEN ────────────────────────
    //
    // Nyckeln var `transaction.id`. Det höll så länge en banktransaktion kunde
    // bokföras EXAKT en gång — vilket den kunde, av en slump: efter en
    // avmatchning låg allokeringen kvar och dess `bankTransactionId @unique`
    // gav P2002 på varje ommatchningsförsök. #326 B städar allokeringen, och
    // därmed föll den spärren bort.
    //
    // Utan den här nyckeln blir följden: ommatchning → `createNumberedEntry`
    // hittar det GAMLA, redan reverserade verifikatet under samma
    // (org, PAYMENT, sourceId), returnerar det, och callern ser ett
    // icke-null-svar. Ingen ny bokföring sker — men en ny allokering skrivs.
    // Fakturan ser betald ut medan 1510 är orörd. Samma felmekanism som #290
    // stängde på den manuella vägen, med en annan utlösare.
    //
    // Per allokering (unik UUID) får varje matchning sitt EGNA verifikat, och en
    // ommatchning efter avmatchning bokförs som den nya affärshändelse den är.
    //
    // OBLIGATORISK SEDAN #326 F1. Parametern var valfri, med ett undantag för
    // fuzzy-grenen som inte skapade någon allokering alls. Motiveringen där var
    // för smal: den handlade bara om att ommatchning inte kan nå en PAID
    // faktura, och sa ingenting om att den grenen samtidigt saknade allokering,
    // Deposit-synk och ett verifikat som kastar. F1 leder fuzzy genom
    // `applyMatchToInvoice`, som alltid allokerar — undantaget har därmed ingen
    // kvarvarande anropare, och det som var en valfri parameter med en tyst
    // fallback blir ett krav. En framtida gren kan inte längre av misstag
    // återanvända den gamla nyckeln genom att låta bli att skicka in något.
    //
    // (`reverseJournalEntryForPayment` behåller sin legacy-fallback — den läser
    // poster som redan är skrivna, och de kan bära den gamla nyckeln.)
    allocationId: string,
    // Valfri yttre transaktion — anges av bankavstämningens applyMatchToInvoice så
    // att statusflip, bank-länk och detta verifikat skapas ATOMISKT. Faller
    // bokföringen rullas hela matchningen tillbaka (ingen PAID utan verifikat).
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma
    const accounts = await db.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))

    const bankAccountId = accountByNumber.get(1930)
    const receivableId = accountByNumber.get(1510)

    if (!bankAccountId || !receivableId) return null

    const amount = Number(transaction.amount)
    if (amount <= 0) return null

    // A2 fail-closed (typ-medveten: vanlig faktura ELLER depositionsfaktura).
    await this.assertInvoiceReceivableBacked(db, organizationId, invoice.id, invoice.invoiceNumber)

    const counterparty = await this.counterpartyForInvoice(invoice.id, organizationId, tx)

    const sourceId = bankPaymentSourceId('invoice', allocationId)

    return this.createNumberedEntry({
      organizationId,
      date: transaction.date,
      description: `Inbetalning faktura ${invoice.invoiceNumber}${counterparty ? ` (${counterparty})` : ''}`,
      source: 'PAYMENT',
      sourceId,
      createdById,
      lines: [
        { accountId: bankAccountId, debit: amount, description: 'Inbetalning bank' },
        { accountId: receivableId, credit: amount, description: 'Reglering kundfordran' },
      ],
      idempotencyWhere: { organizationId, source: 'PAYMENT', sourceId },
      include: { lines: { include: { account: true } } },
      ...(tx ? { tx } : {}),
    })
  }

  // Manuell betalningsregistrering på en faktura (utan bankavstämning). Speglar
  // createJournalEntryForRentNoticeManualPayment: betalningssättet styr likvidkontot.
  //
  //   1930/1910  Likvidkonto     D  inbetalt belopp   (per betalningssätt)
  //   1510       Kundfordringar  K  inbetalt belopp
  //
  // Utan denna bokning markeras fakturan som betald medan 1510 står kvar öppen —
  // en affärshändelse (mottagen betalning) utan verifikation (BFL 5 kap 6 §).
  //
  // #290 (KRITISK FIX): idempotensen nycklas på ALLOKERINGEN (sourceId =
  // "invoice-manual-payment:<allocationId>"), INTE på fakturan. Samma form som
  // avi-vägen fick i PR 3b, av exakt samma skäl — faktura-vägen fick den bara
  // aldrig.
  //
  // Docblocken sa tidigare att "en manuell betalning reglerar fakturan i sin
  // helhet ... så en enda nyckel per faktura räcker". Det slutade vara sant med
  // C5: en delbetalning lämnar fakturan PARTIAL, och PARTIAL ingår i
  // PAYABLE_STATUSES → markAsPaidManually kan köras flera gånger mot SAMMA
  // faktura. Med faktura-nycklad sourceId hittade den ANDRA delbetalningen den
  // förstas verifikat, createNumberedEntry returnerade det befintliga, och
  // callern såg ett icke-null-svar → inget fel. Allokering + status skrevs,
  // huvudboken fick ingenting. Reproducerat mot riktig Postgres: 500 + 9 500 kr
  // gav fakturastatus PAID, 10 000 kr i allokeringar och 500 kr på 1930 — 1510
  // stod öppen med 9 500 kr på en faktura som sa sig vara betald (BFL 5 kap 6 §).
  //
  // Per allokering (unik UUID, samma strategi som bankvägens
  // sourceId=bankTransactionId) får varje delbetalning sitt EGNA verifikat.
  // Beloppet är det FAKTISKT inbetalda — vid delbetalning regleras fordran bara
  // delvis, korrekt dubbel bokföring.
  async createJournalEntryForInvoiceManualPayment(
    invoice: Pick<Invoice, 'id' | 'invoiceNumber'>,
    paidAmount: number,
    paidAt: Date,
    paymentMethod: PaymentMethod,
    organizationId: string,
    createdById: string | null,
    // InvoicePayment-radens id — allokeringen detta verifikat reglerar. BÅDA
    // anroparna skriver en sådan rad: markAsPaidManually sedan C5,
    // DepositsService.markPaid sedan #290 (den flippade tidigare
    // depositionsfakturan till PAID helt utan allokering, alltså osynlig för
    // computeInvoiceDebt som är sanningskällan för restskuld).
    allocationId: string,
    // Valfri yttre transaktion — anges av deposits-modulens markPaid så att
    // depositions-/faktura-statusflip och detta verifikat skapas ATOMISKT.
    tx?: Prisma.TransactionClient,
  ) {
    const amount = Number(paidAmount)
    if (!Number.isFinite(amount) || amount <= 0) return null

    const debitAccountNumber = PAYMENT_METHOD_TO_ACCOUNT[paymentMethod]

    const db = tx ?? this.prisma
    const accounts = await db.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const debitAccountId = accountByNumber.get(debitAccountNumber)
    const receivableId = accountByNumber.get(1510)
    if (!debitAccountId || !receivableId) {
      this.logger.error(
        `[Accounting] Likvidkonto ${debitAccountNumber} eller 1510 saknas i ` +
          `kontoplanen (org ${organizationId}) — betalningsverifikat för faktura ` +
          `${invoice.invoiceNumber} skapas ej.`,
      )
      return null
    }

    // A2 fail-closed (typ-medveten: en depositionsfaktura bokför sin 1510-debet
    // under 'deposit-invoice:<depositId>', inte invoice.id — accepteras via länkad
    // Deposit, annars falsk-nekas varje frisk depositionsbetalning).
    await this.assertInvoiceReceivableBacked(db, organizationId, invoice.id, invoice.invoiceNumber)

    const sourceId = `invoice-manual-payment:${allocationId}`
    const counterparty = await this.counterpartyForInvoice(invoice.id, organizationId, tx)

    return this.createNumberedEntry({
      organizationId,
      date: paidAt,
      description: `Inbetalning faktura ${invoice.invoiceNumber}${counterparty ? ` (${counterparty})` : ''}`,
      source: 'PAYMENT',
      sourceId,
      createdById,
      lines: [
        {
          accountId: debitAccountId,
          debit: amount,
          description: PAYMENT_METHOD_LABEL[paymentMethod],
        },
        { accountId: receivableId, credit: amount, description: 'Reglering kundfordran' },
      ],
      idempotencyWhere: { organizationId, source: 'PAYMENT', sourceId },
      include: { lines: { include: { account: true } } },
      ...(tx ? { tx } : {}),
    })
  }

  // #41/T2.2 — manuell betalning av en AVI-LÄNKAD deposition (ingen Invoice).
  // En aktiverings-deposition (Deposit.rentNoticeId satt, invoiceId null) har
  // ingen faktura att reglera via createJournalEntryForInvoiceManualPayment;
  // denna metod bokför likviden mot depositionsfordran: likvidkonto D / 1510 K.
  // Reglerar 1510:an som aktiveringen bokförde (1510 D / 2890 K). Nyckel per
  // deposit (deposit-manual-payment:<id>) — disjunkt från bankvägens
  // sourceId=bankTransaction.id, och Deposit-status-guarden i markPaid serialiserar
  // mot bankmatchningen så bara EN väg bokför (ingen dubbelbokning).
  async createJournalEntryForDepositManualPayment(
    depositId: string,
    organizationId: string,
    amount: number,
    paidAt: Date,
    paymentMethod: PaymentMethod,
    createdById: string | null,
    tx?: Prisma.TransactionClient,
  ) {
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) return null

    const debitAccountNumber = PAYMENT_METHOD_TO_ACCOUNT[paymentMethod]
    const db = tx ?? this.prisma
    const accounts = await db.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const debitAccountId = accountByNumber.get(debitAccountNumber)
    const receivableId = accountByNumber.get(1510)
    if (!debitAccountId || !receivableId) return null

    // A2b fail-closed (sjätte 1510-vägen, FAR HIGH): depositionens 1510-debet bokförs
    // under 'deposit-invoice:<depositId>' (createJournalEntryForDepositInvoice). Neka
    // betalningen om den saknas — annars spökkredit på en obokförd deposition.
    await this.assertReceivableAccrualBooked(
      db,
      organizationId,
      `deposit-invoice:${depositId}`,
      `deposition ${depositId}`,
    )

    const sourceId = `deposit-manual-payment:${depositId}`
    return this.createNumberedEntry({
      organizationId,
      date: paidAt,
      description: `Inbetalning deposition (manuell)`,
      source: 'PAYMENT',
      sourceId,
      createdById,
      lines: [
        { accountId: debitAccountId, debit: amt, description: PAYMENT_METHOD_LABEL[paymentMethod] },
        { accountId: receivableId, credit: amt, description: 'Reglering depositionsfordran' },
      ],
      idempotencyWhere: { organizationId, source: 'PAYMENT', sourceId },
      include: { lines: { include: { account: true } } },
      ...(tx ? { tx } : {}),
    })
  }

  // Intäktsverifikation vid avisering (BFL 1999:1078, LAGBROTT 2). När en
  // hyresavi skapas uppstår en hyresfordran som ska bokföras enligt
  // bokföringsmässiga grunder (god redovisningssed, BFL 4 kap 2 §):
  //
  //   1510 Kundfordringar    D  totalbelopp
  //   39xx Hyresintäkt       K  nettobelopp (konto per upplåtelsetyp)
  //   26xx Utgående moms     K  momsbelopp (endast om vatAmount > 0)
  //
  // Den efterföljande inbetalningen (createJournalEntryForRentNoticePayment)
  // reglerar fordran 1930 D / 1510 K — utan denna accrual skulle betalningen
  // sakna intäktsmotpost och hyresintäkten aldrig redovisas.
  //
  // Datumet sätts till första dagen i den period avin avser så att intäkten
  // periodiseras rätt vid räkenskapsårsskifte. Idempotent via sourceId
  // ("rent-notice:<id>"). Depositionsavier (type=DEPOSIT) är en skuld, inte
  // intäkt, och hoppas över — de hanteras av deposits-modulen.
  async createJournalEntryForRentNotice(
    notice: {
      id: string
      noticeNumber: string
      leaseId: string
      type: RentNoticeType
      amount: Decimal | number
      vatAmount: Decimal | number
      totalAmount: Decimal | number
      year: number
      month: number
    },
    organizationId: string,
    createdById: string | null,
    // Valfri yttre transaktion (T1.4 PR0): anges när hyresavin och dess
    // intäktsverifikat måste skapas ATOMISKT (bakdaterad-debitering-backfillen
    // skapar N avier och kan inte lämna en avi utan verifikat = orphan). Utan tx
    // beter sig metoden som förr (createNumberedEntry öppnar egen transaktion).
    // Speglar bookReminderFee/bookInterest.
    tx?: Prisma.TransactionClient,
  ) {
    if (notice.type === RentNoticeType.DEPOSIT) return null

    const db = tx ?? this.prisma
    const sourceId = `rent-notice:${notice.id}`
    const accounts = await db.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))

    // Intäktskonto utifrån lägenhetens/lokalens typ (bostad 3911, lokal 3913,
    // p-plats 3912, övrigt 3914). Org-scopad findFirst (FIX 2) — ett leaseId
    // från en annan org → null → fallback till 3914.
    const lease = await db.lease.findFirst({
      where: { id: notice.leaseId, organizationId },
      select: { unit: { select: { type: true } } },
    })
    // Anomali: hyresavins leaseId hittades ej i org → möjligt cross-tenant-
    // försök eller felkopplad lease. Logga; intäkten faller tillbaka till 3914.
    if (!lease) {
      this.logger.warn(
        `[Accounting] Lease ${notice.leaseId} hittades ej i org ${organizationId} ` +
          `för hyresavi ${notice.noticeNumber} — intäkt bokförs mot 3914 (fallback).`,
      )
    }
    const revenueAccountNumber = revenueAccountForUnitType(lease?.unit?.type ?? null)

    const receivableId = accountByNumber.get(1510)
    const revenueId = accountByNumber.get(revenueAccountNumber)
    if (!receivableId || !revenueId) {
      // T1.4 PR0: tidigare TYST `return null` → en felkonfigurerad kontoplan
      // gav en hyresavi UTAN intäktsverifikat (orphan-avi) utan att någon
      // larmades. Samma allvar och loggnivå som momskonto-fallet nedan.
      const missing = !receivableId ? 1510 : revenueAccountNumber
      this.logger.error(
        `[Accounting] Konto ${missing} saknas i kontoplanen (org ${organizationId}) — ` +
          `intäktsverifikat för hyresavi ${notice.noticeNumber} skapas ej.`,
      )
      // T1.4 PR1 (bokförings-expert CRITICAL): i ATOMISKT läge (tx angiven) får
      // detta INTE bli ett tyst null — då skulle den yttre transaktionen committa
      // avin UTAN verifikat (orphan-avi, BFL 5 kap). Kasta så tx:en rullas
      // tillbaka. Utan tx (best-effort) behålls null (oförändrat).
      if (tx) {
        throw new UnprocessableEntityException(
          `Kontoplanen saknar konto ${missing} — efterdebitering kan inte bokföras atomiskt`,
        )
      }
      return null
    }

    const net = Number(notice.amount)
    const vat = Number(notice.vatAmount)
    const total = Number(notice.totalAmount)
    if (total <= 0) return null

    const lines: Array<{
      accountId: string
      debit?: number
      credit?: number
      description: string
    }> = [{ accountId: receivableId, debit: total, description: `Hyresavi ${notice.noticeNumber}` }]

    // Moms krediteras separat på rätt 26xx-konto. Hellre INGEN verifikation
    // än en som döljer moms i intäktskontot eller bokar fel sats — det vore
    // felaktigt debiterad moms (ML 2 kap. 12 §; betalningsskyldigheten följer av
    // ML 16 kap. 23 §) och bryter mot god redovisningssed
    // (BFL 4 kap 2 §). Net krediteras alltid intäktskontot → posten balanserar.
    if (vat > 0 && net > 0) {
      const rate = Math.round((vat / net) * 100)
      const vatAccountNumber = VAT_TO_ACCOUNT[rate]
      if (!vatAccountNumber) {
        this.logger.error(
          `[Accounting] Okänd momssats ${rate}% för hyresavi ${notice.noticeNumber} — verifikation skapas ej`,
        )
        // T1.4 PR1: kasta i atomiskt läge (orphan-avi annars).
        if (tx) {
          throw new UnprocessableEntityException(
            `Okänd momssats ${rate}% — efterdebitering kan inte bokföras atomiskt`,
          )
        }
        return null
      }
      const vatAccountId = accountByNumber.get(vatAccountNumber)
      if (!vatAccountId) {
        this.logger.error(
          `[Accounting] Momskonto ${vatAccountNumber} saknas i kontoplanen för hyresavi ${notice.noticeNumber} — verifikation skapas ej`,
        )
        // T1.4 PR1: kasta i atomiskt läge (orphan-avi annars).
        if (tx) {
          throw new UnprocessableEntityException(
            `Kontoplanen saknar momskonto ${vatAccountNumber} — efterdebitering kan inte bokföras atomiskt`,
          )
        }
        return null
      }
      lines.push({ accountId: vatAccountId, credit: vat, description: `Moms ${rate}%` })
    }
    lines.push({
      accountId: revenueId,
      credit: net,
      description: `Hyresintäkt ${notice.month}/${notice.year}`,
    })

    // Periodisering: intäkten hör till den månad avin avser.
    const periodDate = new Date(Date.UTC(notice.year, notice.month - 1, 1))

    return this.createNumberedEntry({
      organizationId,
      date: periodDate,
      description: `Hyresavi ${notice.noticeNumber}`,
      source: 'INVOICE',
      sourceId,
      createdById,
      lines,
      idempotencyWhere: { organizationId, sourceId },
      include: { lines: { include: { account: true } } },
      ...(tx ? { tx } : {}),
    })
  }

  // Bokföring av förbrukningsersättning (IMD). Speglar createJournalEntryForRent-
  // Notice: kundfordran debiteras, intäkten krediteras netto, ev. moms separat.
  //
  //   1510 D  totalAmount                (kundfordran)
  //   3920|3970 K  netAmount             (el/värme resp. vatten – bruttoredovisat)
  //   2611 K  vatAmount   (ENDAST om vatStatus = TAXABLE_25)
  //
  // Datumet sätts till mätperiodens slut (periodEnd) — mätperioden styr räken-
  // skapsåret, ALDRIG skapandedatumet (jfr bokföringsbedömningen). Idempotent via
  // sourceId="consumption-charge:<id>" → dubbel confirm skapar inte dubbla
  // verifikat. Momsen tas från charge-snapshotet (PR 2), beräknas aldrig om.
  //
  // Bruttoredovisning: ENDAST intäktssidan bokförs här. Kostnaden (5020/5040)
  // hör till leverantörsfakturan och nettas aldrig mot ersättningen.
  async createJournalEntryForConsumptionCharge(
    charge: {
      id: string
      meterType: MeterType
      periodEnd: Date
      netAmount: Decimal | number
      vatStatus: ConsumptionVatStatus
      vatAmount: Decimal | number
      totalAmount: Decimal | number
    },
    organizationId: string,
    createdById: string | null,
  ) {
    const sourceId = `consumption-charge:${charge.id}`

    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))

    const revenueAccountNumber = CONSUMPTION_REVENUE_ACCOUNT_BY_METER_TYPE[charge.meterType]
    const receivableId = accountByNumber.get(1510)
    const revenueId = accountByNumber.get(revenueAccountNumber)
    if (!receivableId || !revenueId) {
      this.logger.error(
        `[Accounting] Konto saknas (1510 eller ${revenueAccountNumber}) för förbrukningspost ` +
          `${charge.id} — verifikation skapas ej`,
      )
      return null
    }

    const net = Number(charge.netAmount)
    const vat = Number(charge.vatAmount)
    const total = Number(charge.totalAmount)
    if (total <= 0) return null

    const label = METER_TYPE_LABEL[charge.meterType]
    const period = charge.periodEnd.toISOString().slice(0, 7) // YYYY-MM

    const lines: JournalLineInput[] = [
      { accountId: receivableId, debit: total, description: `Förbrukning ${label} ${period}` },
    ]

    // Momsraden tas DIREKT från charge-snapshotet — beräknas aldrig om (PR 2 äger
    // momsregeln via vatRateForRent). EXEMPT (bostad m.fl.) ger ingen 26xx-rad;
    // hellre INGEN verifikation än en med fel momsbehandling (felaktigt debiterad
    // moms: ML 2 kap. 12 §, betalningsskyldighet ML 16 kap. 23 §; god
    // redovisningssed BFL 4 kap 2 §).
    if (charge.vatStatus === 'TAXABLE_25' && vat > 0) {
      const vatAccountNumber = VAT_TO_ACCOUNT[25] // 2611
      const vatAccountId = vatAccountNumber ? accountByNumber.get(vatAccountNumber) : undefined
      if (!vatAccountId) {
        this.logger.error(
          `[Accounting] Momskonto ${vatAccountNumber} saknas för förbrukningspost ${charge.id} — verifikation skapas ej`,
        )
        return null
      }
      lines.push({ accountId: vatAccountId, credit: vat, description: 'Moms 25%' })
    }

    lines.push({
      accountId: revenueId,
      credit: net,
      description: `Förbrukningsersättning ${label} ${period}`,
    })

    return this.createNumberedEntry({
      organizationId,
      // Mätperiodens slut styr räkenskapsåret — inte skapandedatumet.
      date: charge.periodEnd,
      description: `Förbrukning ${label} ${period}`,
      source: 'INVOICE',
      sourceId,
      createdById,
      lines,
      idempotencyWhere: { organizationId, sourceId },
      include: { lines: { include: { account: true } } },
    })
  }

  // ── Teknisk förvaltning · Spår A PR 2 — MiscCharge-verifikat ────────────────
  // Bokför en övrig debiterbar post mot hyresgäst (skada, förlorad nyckel m.m.)
  // som en kundfordran. Speglar createJournalEntryForConsumptionCharge:
  //
  //   1510 D  total        (kundfordran)
  //   2611 K  vat          (ENDAST om vatStatus = TAXABLE_25 och vatAmount > 0)
  //   3990 K  net          (övrig rörelseintäkt)
  //
  // Belopp tas DIREKT från postens snapshot (Decimal → Number, ingen omräkning).
  // EXEMPT (bostad, ML 10 kap. 35 §) ger ingen 26xx-rad och net === total. Momsregeln
  // spikas ALDRIG i kod — vi läser vatStatus/vatAmount från posten så att en
  // framtida TAXABLE_25 (lokal m. frivillig skattskyldighet) faller ut av sig
  // självt utan kodändring i konteringen.
  //
  // Idempotent + gap-free via createNumberedEntry (unikt index (org, source,
  // sourceId), source = MISC_CHARGE). Två anrop ger EN entry — verifikatet, inte
  // status-fältet, är sanningskällan för "redan bokförd": även om status redan
  // är CONFIRMED men verifikatet saknas (ska ej hända) self-healar anropet och
  // skapar det. Statusflippen DRAFT → CONFIRMED sker ATOMISKT i samma transaktion
  // (inget CONFIRMED utan verifikat); ATTACHED/CANCELLED rörs aldrig.
  //
  // Anroparen (PR 3) kan skilja utfallen:
  //   • entry returneras → bokförd (ny ELLER idempotent träff)
  //   • BadRequest      → CANCELLED, går ej att boka
  //   • NotFound        → posten finns inte i org
  //   • null            → kontoplan saknar 1510/3990/2611 ELLER total ≤ 0 (loggas)
  //
  // Bokföringsdatum = incidentDate (när skadan/förlusten konstaterades), aldrig
  // createdAt — annars hamnar posten i fel räkenskapsår. Verifikat-texten är
  // PII-fri: den refererar ärendenumret (UND-xxxxx), aldrig MiscCharge.description
  // (fritext som kan innehålla hyresgästens namn) eller tenant.
  async createJournalEntryForMiscCharge(
    miscChargeId: string,
    organizationId: string,
    createdById: string | null,
  ) {
    const sourceId = `misc-charge:${miscChargeId}`

    // Org-scope via findFirst (speglar deposit-refund). Back-relationen ger
    // ärendenumret utan att läsa hyresgästens namn.
    const charge = await this.prisma.miscCharge.findFirst({
      where: { id: miscChargeId, organizationId },
      include: { maintenanceTicket: { select: { ticketNumber: true } } },
    })
    if (!charge) throw new NotFoundException('Debiteringsposten hittades inte')
    if (charge.status === 'CANCELLED') {
      // Distinkt från idempotent träff: en annullerad post får aldrig bokföras.
      throw new BadRequestException('Annullerad debiteringspost kan inte bokföras')
    }

    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))

    const receivableId = accountByNumber.get(1510)
    const revenueId = accountByNumber.get(3990)
    if (!receivableId || !revenueId) {
      this.logger.error(
        `[Accounting] Konto saknas (1510 eller 3990) för debiteringspost ` +
          `${charge.id} — verifikation skapas ej`,
      )
      return null
    }

    const net = Number(charge.netAmount)
    const vat = Number(charge.vatAmount)
    const total = Number(charge.totalAmount)
    if (total <= 0) return null

    // PII-fri referens: ärendenummer (UND-xxxxx) när källan är ett ärende, annars
    // en generisk källreferens. Aldrig hyresgästens namn eller fritext-beskrivning.
    const ref =
      charge.maintenanceTicket?.ticketNumber ??
      `${charge.sourceType}:${charge.sourceRefId.slice(0, 8)}`

    const lines: JournalLineInput[] = [
      { accountId: receivableId, debit: total, description: `Övrig debitering ${ref}` },
    ]

    // Momsraden tas DIREKT från snapshotet — beräknas aldrig om. v1 är posterna
    // EXEMPT (bostad) → ingen 26xx-rad. TODO: moms för lokal m. frivillig
    // skattskyldighet (ML 12 kap.) — väntar FAR-konsult, se docs/legal/45. När den
    // bekräftas räcker det att posten skapas med vatStatus=TAXABLE_25/vatAmount>0;
    // konteringen nedan hanterar redan momsraden utan kodändring.
    if (charge.vatStatus === 'TAXABLE_25' && vat > 0) {
      const vatAccountNumber = VAT_TO_ACCOUNT[25] // 2611
      const vatAccountId = vatAccountNumber ? accountByNumber.get(vatAccountNumber) : undefined
      if (!vatAccountId) {
        this.logger.error(
          `[Accounting] Momskonto ${vatAccountNumber} saknas för debiteringspost ${charge.id} — verifikation skapas ej`,
        )
        return null
      }
      lines.push({ accountId: vatAccountId, credit: vat, description: 'Moms 25%' })
    }

    lines.push({ accountId: revenueId, credit: net, description: `Övrig rörelseintäkt ${ref}` })

    // Verifikat + statusflipp ATOMISKT: faller bokföringen rullas statusbytet
    // tillbaka (inget CONFIRMED utan verifikat). createNumberedEntry förblir
    // idempotent inuti transaktionen via (org, source, sourceId).
    return this.prisma.$transaction(async (tx) => {
      const entry = await this.createNumberedEntry({
        organizationId,
        // Skadans/förlustens datum styr räkenskapsåret — inte skapandedatumet.
        date: charge.incidentDate,
        description: `Övrig debitering ${ref}`,
        source: 'MISC_CHARGE',
        sourceId,
        createdById,
        lines,
        idempotencyWhere: { organizationId, source: 'MISC_CHARGE', sourceId },
        include: { lines: { include: { account: true } } },
        tx,
      })

      // Status speglar verifikatet. Flippas bara DRAFT → CONFIRMED; ATTACHED (PR 4)
      // och CANCELLED rörs aldrig. Idempotent: redan CONFIRMED/ATTACHED → 0 rader.
      await tx.miscCharge.updateMany({
        where: { id: miscChargeId, organizationId, status: 'DRAFT' },
        data: { status: 'CONFIRMED' },
      })

      return entry
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  // ── Teknisk förvaltning · Spår A PR 3 — annullering av MiscCharge-verifikat ──
  // Skapar ett MOTVERIFIKAT (omvänd kontering 3990 D / 1510 K) — append-only, vi
  // raderar ALDRIG originalet (BFL 5 kap, Restrict). Speglar
  // reverseJournalEntryForPayment: läser originalet via (org, MISC_CHARGE,
  // sourceId='misc-charge:{id}'), byter plats debet↔kredit. Inget original (posten
  // var aldrig bokförd) → no-op. Idempotent via egen nyckel
  // sourceId='misc-charge-reversal:{id}' — andra annulleringen ger inget andra
  // motverifikat. Valfri `tx` så reversal + status-flip körs atomiskt (cancel-
  // flödet: faller reversalen flippas aldrig status → ingen halv-annullering).
  // ── Motverifikat: en mekanism, fem anropare ────────────────────────────────
  //
  // Ett verifikat ändras ALDRIG i efterhand. Ska en bokförd post tas tillbaka
  // sker det med ett nytt verifikat som vänder den, daterat den dag felet
  // upptäcktes — originalet står kvar precis som det var. Det är själva poängen:
  // det ska gå att se vad som faktiskt bokfördes, när felet upptäcktes och hur
  // det rättades. Ett bakåtdaterat "rättat" original hade sett ut som att posten
  // alltid varit rätt.
  //
  // Radvändningen och skrivningen fanns i FYRA identiska kopior (annullerad
  // debitering, annullerad hyresavi, makulerad faktura, hävd bankmatchning).
  // PR1c2 lade till en femte anropare — den operatörsstyrda rättelsen — och
  // samlade dem alla här. Samma regel på fem ställen är en regel som glider isär.

  /**
   * Vänder ett verifikats rader: debet blir kredit och tvärtom.
   *
   * `prefix` styr radbeskrivningen. De automatiska vägarna behåller sitt
   * engelska "Reversal" (oförändrat beteende); den operatörsstyrda rättelsen
   * använder svenska, eftersom den texten faktiskt läses av en hyresvärd.
   */
  private buildReversalLines(
    lines: Array<{
      accountId: string
      debit: Prisma.Decimal | null
      credit: Prisma.Decimal | null
      description: string | null
    }>,
    prefix = 'Reversal',
  ): JournalLineInput[] {
    return lines.map((l) => ({
      accountId: l.accountId,
      ...(l.debit != null ? { credit: Number(l.debit) } : {}),
      ...(l.credit != null ? { debit: Number(l.credit) } : {}),
      ...(l.description ? { description: `${prefix}: ${l.description}` } : {}),
    }))
  }

  /**
   * Skriver motverifikatet. Delad kropp för samtliga reverseringsvägar.
   *
   * Datumet är ALLTID dagens — aldrig originalets. Posten går därför genom
   * `allocate` som vilken bokföring som helst och träffar periodspärren om
   * innevarande period skulle vara stängd. Det finns medvetet ingen specialväg
   * förbi låset: en rättelse är en bokföring, inte ett undantag.
   *
   * Idempotent via det unika indexet (org, source, sourceId) — en redan skapad
   * reversering returneras i stället för att bokföras en gång till.
   *
   * ── ETT VERIFIKAT REVERSERAS EN GÅNG, OAVSETT VÄG ───────────────────────────
   *
   * `reversalOfEntryId` sätts HÄR, centralt, för samtliga vägar — inte av
   * anroparna. Fram till dess satte exakt EN av åtta vägar den (den manuella
   * operatörsrättelsen); de sju automatiska lämnade den tom. Följden var att
   * `@unique` på kolumnen bara skyddade manuell-mot-manuell, och att ett
   * verifikat kunde reverseras två gånger så snart de två vägarna korsades:
   *
   *   manuell först:     rättelsen nollar posten → annullering speglar den IGEN
   *   automatisk först:  `reversedBy` förblev NULL → operatörens guard passerade
   *
   * Båda ger negativ kundfordran och negativ intäkt på det dubbelräknade
   * beloppet. Varje enskilt verifikat balanserar; felet uppstår först i
   * sekvensen. Se CLAUDE.md, "Spärrar är riktade".
   *
   * ATT SÄTTA DEN CENTRALT ÄR STARKARE ÄN ATT KRÄVA DET AV ANROPARNA. En ny
   * reverseringsväg får skyddet automatiskt; ingen kan glömma ett argument. Det
   * som återstår att bevaka är i stället att någon skriver ett motverifikat
   * FÖRBI den här metoden — det fälls av `reversal-symmetry-guard.spec.ts`.
   */
  private async createReversalEntry(params: {
    organizationId: string
    original: {
      id: string
      description: string
      lines: Array<{
        accountId: string
        debit: Prisma.Decimal | null
        credit: Prisma.Decimal | null
        description: string | null
      }>
    }
    source: JournalEntrySource
    reversalSourceId: string
    description: string
    createdById: string | null
    linePrefix?: string
    include?: Prisma.JournalEntryInclude
    tx?: Prisma.TransactionClient
  }) {
    // ── LÄSBART FEL, INTE ETT RÅTT CONSTRAINT-FEL ─────────────────────────────
    //
    // `@unique` på `reversalOfEntryId` är sistahandsskyddet och skulle annars
    // slå till som P2002 → 500 hos operatören. Ett databasfel som når en
    // användare är en försämring, inte en förbättring: det säger inte vad som
    // hänt och pekar inte på rättelsen som redan finns.
    //
    // UNDANTAGET ÄR VÅR EGEN POST. Träffar vi en reversering med SAMMA
    // `sourceId` är det vår egen, tidigare körning — då ska idempotensen nedan
    // få göra sitt jobb och returnera den, precis som förut. Utan det här
    // undantaget hade varje retry blivit ett fel.
    const befintlig = await (params.tx ?? this.prisma).journalEntry.findFirst({
      where: { reversalOfEntryId: params.original.id, organizationId: params.organizationId },
      select: { series: true, verNumber: true, sourceId: true },
    })
    if (befintlig && befintlig.sourceId !== params.reversalSourceId) {
      throw new ConflictException(
        `Verifikatet är redan reverserat, med verifikat ${befintlig.series}${befintlig.verNumber}. ` +
          'Ett verifikat reverseras en gång — annars bokas samma belopp bort två gånger. ' +
          'Behöver du ändra igen, rätta reverseringen i stället.',
      )
    }

    return this.createNumberedEntry({
      organizationId: params.organizationId,
      // Rättelseverifikatet dateras till dagen det skapas, inte originalets datum.
      date: new Date(),
      description: params.description,
      source: params.source,
      sourceId: params.reversalSourceId,
      createdById: params.createdById,
      lines: this.buildReversalLines(params.original.lines, params.linePrefix),
      idempotencyWhere: {
        organizationId: params.organizationId,
        source: params.source,
        sourceId: params.reversalSourceId,
      },
      // Centralt, för ALLA vägar. Se docblocket ovan.
      reversalOfEntryId: params.original.id,
      ...(params.include ? { include: params.include } : {}),
      ...(params.tx ? { tx: params.tx } : {}),
    })
  }

  async reverseJournalEntryForMiscCharge(
    miscChargeId: string,
    organizationId: string,
    createdById: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma
    const sourceId = `misc-charge:${miscChargeId}`
    const original = await db.journalEntry.findFirst({
      where: { organizationId, source: 'MISC_CHARGE', sourceId },
      include: { lines: true },
    })
    if (!original) return

    await this.createReversalEntry({
      organizationId,
      original,
      source: 'MISC_CHARGE',
      reversalSourceId: `misc-charge-reversal:${miscChargeId}`,
      description: `Annullerad debitering: ${original.description}`,
      createdById,
      ...(tx ? { tx } : {}),
    })
  }

  // ── #301: motverifikat för DEPOSITIONENS accrual ───────────────────────────
  //
  // Depositionens 1510 D / 2890 K ligger i en EGEN NAMNRYMD:
  //   sourceId = `deposit-invoice:<depositId>`
  // …och nyckeln är DEPOSITIONENS id, inte fakturans eller avins.
  //
  // Det är hela poängen med #301. De två syskonfunktionerna nedan letar på
  // `<invoiceId>` respektive `rent-notice:<noticeId>` och kan därför ALDRIG träffa
  // depositionens post — inte för att den är fel-nycklad, utan för att den bor
  // någon annanstans. En "fix" som bara letar på fler ställen missar att
  // kopplingen faktura→deposition (eller avi→deposition) måste slås upp för att
  // nyckeln över huvud taget ska gå att konstruera.
  //
  // Uppslaget speglar assertInvoiceReceivableBacked, som redan gör exakt samma sak
  // för betalningsguarden. Ingen ny konvention — bara samma namnrymdshopp.
  //
  // BÅDA skapandevägarna bokför under samma nyckel (createJournalEntryForDeposit-
  // Invoice): DepositsService.create() via faktura, och ensureDepositForNotice()
  // via avi. Därför är depositId den enda gemensamma nämnaren och den enda nyckel
  // som fungerar för båda anroparna — avi-länkade depositioner saknar Invoice helt
  // och kan inte ens konstruera en invoiceId-nyckel.
  //
  // reasonPrefix kommer från anroparen (`Makulerad faktura` / `Annullerad hyresavi`)
  // så verifikatstexten visar VARFÖR reverseringen skedde — samma två prefix som
  // syskonen redan använder, ingen ny vokabulär. BFL 5 kap 6 §: verifikationen ska
  // ange vad transaktionen avser.
  //
  // Inget reversalOfEntryId: de systemtriggade syskonen sätter det inte, bara den
  // operatörsstyrda reverseJournalEntry (som behöver det för sin engångsspärr).
  async reverseJournalEntryForDepositAccrual(
    depositId: string,
    organizationId: string,
    reasonPrefix: string,
    createdById: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma
    const sourceId = `deposit-invoice:${depositId}`
    const original = await db.journalEntry.findFirst({
      where: { organizationId, source: 'INVOICE', sourceId },
      include: { lines: true },
    })
    if (!original) return

    await this.createReversalEntry({
      organizationId,
      original,
      source: 'INVOICE',
      // Speglar originalets nyckel, precis som misc-charge-reversal speglar
      // misc-charge och rent-notice-reversal speglar rent-notice. Idempotent:
      // två makuleringsförsök ger ETT motverifikat.
      reversalSourceId: `deposit-invoice-reversal:${depositId}`,
      description: `${reasonPrefix}: ${original.description}`,
      createdById,
      ...(tx ? { tx } : {}),
    })
  }

  // Motverifikat vid annullering av en hyresavi (cancelNotice). Intäkten bokas vid
  // avi-genereringen (createJournalEntryForRentNotice: 1510 D / 39xx K / ev. 26xx K,
  // sourceId="rent-notice:<id>"). Utan en reversering vid annullering kvarstår en
  // fantomintäkt, fantomfordran och — för lokal med moms — utgående moms som betalas
  // in för en affärshändelse som aldrig fullbordades (BFL 5 kap 5 §/9 §). Speglar
  // reverseJournalEntryForMiscCharge: byter debet/kredit, eget sourceId, idempotent.
  //
  // No-op om ingen originalpost finns. För en DEPOSIT-avi är det ALLTID fallet —
  // men det betyder inte att den saknar bokföring. Kommentaren här påstod tidigare
  // "DEPOSIT-avi som aldrig intäktsbokfördes", vilket var sant före #41 och fel
  // efter: sedan dess bokför ensureDepositForNotice alltid 1510 D / 2890 K, bara
  // under `deposit-invoice:<depositId>`. Den posten reverseras av
  // reverseJournalEntryForDepositAccrual ovan, som cancelNotice anropar separat.
  // No-op:en här är alltså korrekt — men bara för att någon annan tar den posten.
  /**
   * #518 — VERIFIKATET FÖR EN KREDITERING AV EN HYRESAVI.
   *
   *   39xx D  krediterat belopp        (intäkten sätts ned)
   *   1510 K  krediterat belopp        (kundfordran krymper)
   *
   * ── KONTONA LÄSES UR ORIGINALVERIFIKATET, DE HÄRLEDS ALDRIG PÅ NYTT ────────
   *
   * Det här är metodens viktigaste egenskap. `createJournalEntryForRentNotice`
   * väljer intäktskonto via `revenueAccountForUnitType(lease.unit.type)`, och
   * förbruknings- respektive övriga debiteringar bokförs av HELT andra vägar
   * (3920/3970 resp. 3990). Skulle krediteringen härleda kontot en andra gång
   * behöver bara en av dessa vägar ändra sig — eller lägenhetens typ hinna
   * ändras mellan avisering och kreditering — för att intäkten ska sättas ned på
   * ett konto den aldrig bokfördes på. Saldot per konto blir då fel åt två håll
   * samtidigt, medan verifikatet balanserar och alltså inte fälls av någon
   * kontroll.
   *
   * Genom att spegla originalet kan krediteringen per konstruktion inte träffa
   * ett konto originalet inte använde.
   *
   * ── FAIL-CLOSED PÅ ALLT SOM INTE ÄR EN REN TVÅRADIG POST ──────────────────
   *
   * Saknas originalverifikatet kastar vi (samma hållning som T5 A2b:s
   * `MissingAccrualError` i nedskrivningen: en fordran som aldrig bokförts kan
   * inte sättas ned). Har originalet fler än en intäktsrad bär posten moms eller
   * en uppdelning vi inte kan fördela utan att fatta ett momsbeslut — och det
   * beslutet ligger hos revisor/jurist (#370, #535 fråga 2). Skrivvägen spärrar
   * redan momsbärande poster; kontrollen här är andra lagret, för det fall en
   * framtida anropare når hit utan att ha gått genom spärren.
   */
  async createJournalEntryForRentNoticeCredit(
    credit: {
      id: string
      amount: Decimal | number
      creditedAt: Date
      lines: Array<{ amount: Decimal | number; sourceId: string; description: string }>
    },
    notice: { id: string; noticeNumber: string },
    organizationId: string,
    createdById: string | null,
    // ALLTID atomisk: krediteringen och dess verifikat skapas i samma
    // transaktion. Faller bokföringen ska nedsättningen inte finnas.
    tx: Prisma.TransactionClient,
  ) {
    const receivable = await tx.account.findFirst({
      where: { organizationId, number: 1510 },
      select: { id: true },
    })
    if (!receivable) {
      throw new UnprocessableEntityException(
        `Kontoplanen saknar konto 1510 — kreditering av avi ${notice.noticeNumber} kan inte bokföras`,
      )
    }

    const lines: JournalLineInput[] = []
    for (const rad of credit.lines) {
      const original = await tx.journalEntry.findFirst({
        where: { organizationId, sourceId: rad.sourceId },
        include: { lines: true },
      })
      if (!original) {
        throw new UnprocessableEntityException(
          `Posten som ska krediteras på avi ${notice.noticeNumber} saknar bokfört underlag ` +
            `(${rad.sourceId}). En fordran som aldrig bokförts kan inte sättas ned — ` +
            'bokföringen måste repareras först.',
        )
      }

      // Intäktssidan = allt som INTE är kundfordringskontot. Exakt en rad
      // förväntas; fler betyder moms eller en uppdelning vi inte får fördela.
      const intäktsrader = original.lines.filter((l) => l.accountId !== receivable.id)
      if (intäktsrader.length !== 1 || !intäktsrader[0]) {
        throw new UnprocessableEntityException(
          `Posten som ska krediteras på avi ${notice.noticeNumber} har ${intäktsrader.length} ` +
            'intäktsrader i sitt verifikat. En kreditering av en momsbärande eller uppdelad ' +
            'post kräver ett momsbeslut som inte är fattat — hantera den manuellt.',
        )
      }

      lines.push({
        accountId: intäktsrader[0].accountId,
        debit: Number(rad.amount),
        description: `Kreditering: ${rad.description}`,
      })
      lines.push({
        accountId: receivable.id,
        credit: Number(rad.amount),
        description: `Kreditering avi ${notice.noticeNumber}`,
      })
    }

    return this.createNumberedEntry({
      organizationId,
      // Dagens datum, aldrig avins period. En rättelse är en bokföring och ska
      // träffa periodspärren som vilken annan post som helst — samma regel som
      // `createReversalEntry` följer, och av samma skäl.
      date: credit.creditedAt,
      description: `Kreditering av hyresavi ${notice.noticeNumber}`,
      source: 'INVOICE',
      // EGEN NAMNRYMD. `rent-notice:<id>` bär avins accrual och
      // `rent-notice-reversal:<id>` dess annullering; krediteringen får en tredje
      // så att ingen av de befintliga reverseringsvägarna kan råka träffa den.
      // Nyckeln är per KREDITERING, inte per avi — en avi kan krediteras flera
      // gånger, och varje gång är en egen affärshändelse.
      sourceId: `rent-notice-credit:${credit.id}`,
      createdById,
      lines,
      idempotencyWhere: {
        organizationId,
        source: 'INVOICE',
        sourceId: `rent-notice-credit:${credit.id}`,
      },
      include: { lines: { include: { account: true } } },
      tx,
    })
  }

  async reverseJournalEntryForRentNotice(
    noticeId: string,
    organizationId: string,
    createdById: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma
    const sourceId = `rent-notice:${noticeId}`
    const original = await db.journalEntry.findFirst({
      where: { organizationId, source: 'INVOICE', sourceId },
      include: { lines: true },
    })
    if (!original) return

    await this.createReversalEntry({
      organizationId,
      original,
      source: 'INVOICE',
      reversalSourceId: `rent-notice-reversal:${noticeId}`,
      description: `Annullerad hyresavi: ${original.description}`,
      createdById,
      ...(tx ? { tx } : {}),
    })
  }

  // ── A: MOTVERIFIKAT FÖR PÅMINNELSEAVGIFTEN ─────────────────────────────────
  //
  // Avgiften (1510 D / 3593 K, momsfri) ligger i en EGEN namnrymd,
  // `reminder-fee:<dokumentId>`, och syskonen ovan letar på `<invoiceId>` respektive
  // `rent-notice:<id>`. De kan därför aldrig träffa den — samma namnrymdshopp som
  // #301, med skillnaden att nyckeln här går att konstruera direkt ur dokumentets
  // id. Utan det här anropet står en momsfri intäkt på 3593 och en fordran på 1510
  // kvar för ett dokument som makulerats (BFL 5 kap 6 §).
  //
  // `source` MÅSTE skickas in, och den skiljer sig mellan dokumenttyperna:
  //
  //   faktura:  source = INVOICE      sourceId = reminder-fee:<invoiceId>
  //   hyresavi: source = RENT_NOTICE  sourceId = reminder-fee:<noticeId>
  //
  // Nyckeln skiljer sig alltså på TVÅ axlar, inte en. En uppslagning som bara
  // vidgar sourceId-mönstret men gissar source hittar fortfarande ingenting —
  // det unika indexet är (org, source, sourceId).
  //
  // FAR (kartläggningen 2026-08-07): reversering är default utan undantagsväg.
  // Avgiftens rättsgrund är att gäldenären var i dröjsmål med en giltig fordran;
  // makuleras grunddokumentet faller den grunden i det överväldigande vanliga
  // fallet, och VOID bär inget skäl som kan skilja undantaget från regeln. Ska
  // avgiften undantagsvis stå kvar bokför operatören den manuellt på nytt — det
  // är den explicita mänskliga handlingen, och den lämnar ett eget verifikat.
  async reverseJournalEntryForReminderFee(
    source: JournalEntrySource,
    documentId: string,
    organizationId: string,
    reasonPrefix: string,
    createdById: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma
    const sourceId = `reminder-fee:${documentId}`
    const original = await db.journalEntry.findFirst({
      where: { organizationId, source, sourceId },
      include: { lines: true },
    })
    if (!original) return

    await this.createReversalEntry({
      organizationId,
      original,
      source,
      reversalSourceId: `reminder-fee-reversal:${documentId}`,
      // Originalets beskrivning bärs med — den namnger fakturanumret/avin och
      // motparten (BFL 5 kap 7 §, FAR M7 i #357). Ett motverifikat som bara sa
      // "Makulerad faktura" hade dolt VAD som vändes.
      description: `${reasonPrefix}: ${original.description}`,
      createdById,
      ...(tx ? { tx } : {}),
    })
  }

  // ── B: MOTVERIFIKAT FÖR DRÖJSMÅLSRÄNTAN — N POSTER, INTE EN ────────────────
  //
  // Räntan (1510 D / 8131 K) skiljer sig från alla andra motverifikat i systemet:
  // den har INTE en post per dokument utan EN POST PER KRISTALLISERINGSPUNKT,
  // `interest:<noticeId>:<YYYY-MM-DD>`. En `findFirst` hade vänt den första och
  // tyst lämnat resten — och en delvis reverserad räntefordran är värre än ingen,
  // eftersom den ser reverserad ut i verifikationslistan.
  //
  // HUR MÅNGA KAN DET FINNAS? Mätt och läst, i den ordningen:
  //
  //   MÄTT (eken_dev): max 1 per avi i dagens data. Det är ett GOLV, inte ett tak
  //     — ingen avi i dev har nått inkasso-redo, så den andra punkten har aldrig
  //     inträffat. Att designa mot den siffran vore att förväxla "har inte hänt"
  //     med "kan inte hända".
  //   LÄST: `crystallizeInterest` anropas från TVÅ ställen, båda i
  //     rent-reminder.service.ts — vid påminnelsen (rad 195) och vid inkasso-redo
  //     (rad 506). Det ger normalt två. Men anropet på rad 506 ligger FÖRE
  //     claimen på rad 510 och i en EGEN transaktion: faller flippen efter att
  //     räntan committats plockar nästa dygns cron upp avin igen (den är kvar i
  //     REMINDED), kristalliserar mot ett NYTT datum och skriver en tredje post.
  //     Antalet är alltså inte bundet av koden.
  //
  // Därför sveps hela prefixet. Kolonet i `interest:<id>:` är med med flit —
  // utan det hade prefixet kunnat matcha ett annat avi-id som råkar börja likadant.
  //
  // ⚠️ MOTVERIFIKATETS NYCKEL MÅSTE LIGGA UTANFÖR SVEPETS PREFIX.
  //
  // Den här funktionen både LETAR med ett prefix och SKRIVER nya poster. Föll
  // motverifikaten inom samma prefix skulle en andra körning reversera
  // reverseringarna — och idempotensen skyddar INTE mot det, eftersom de nya
  // posterna får nya, lediga nycklar. Skulden hade svängt fram och tillbaka en
  // gång per körning.
  //
  // `interest-reversal:<id>:<punkt>` ligger utanför `interest:<id>:` på ETT
  // TECKEN — bindestrecket där svepet väntar sig ett kolon. Det är en tunn
  // marginal, och den är avsiktlig men inte självklar: `interest:<id>:reversal:…`
  // hade sett minst lika rimligt ut och öppnat hålet direkt. Byt aldrig nyckeln
  // utan att kontrollera prefixet. accounting.fee-interest-reversal.spec.ts
  // ("SVEPET FÅR INTE PLOCKA UPP SINA EGNA MOTVERIFIKAT") jämför kodens faktiska
  // prefix mot dess faktiska skrivna nyckel och faller om de överlappar — mätt
  // genom att tillfälligt byta nyckeln till den överlappande formen.
  //
  // Avgiften har inte problemet: den slås upp med EXAKT sourceId, inte prefix.
  //
  // EN REVERSERING PER ORIGINAL, inte en klumpsumma: varje motverifikat pekar på
  // sin egen kristalliseringspunkt och bär dess datum i både nyckel och text.
  // En klumppost hade balanserat lika bra och gjort spårbarheten sämre.
  //
  // Räntan finns ENDAST på avi-sidan. `bookInterest` har exakt en anropare
  // (rent-interest.service.ts) och fakturavägen kristalliserar aldrig ränta —
  // därför tar den här funktionen ett noticeId och inget `source`-argument.
  // Bygg inte en fakturamotsvarighet "för symmetrins skull"; det finns ingen post
  // att vända där.
  async reverseJournalEntryForInterest(
    noticeId: string,
    organizationId: string,
    reasonPrefix: string,
    createdById: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma
    const prefix = `interest:${noticeId}:`
    const originals = await db.journalEntry.findMany({
      where: { organizationId, source: 'RENT_NOTICE', sourceId: { startsWith: prefix } },
      include: { lines: true },
      orderBy: { sourceId: 'asc' },
    })

    for (const original of originals) {
      // Kristalliseringspunktens datum bärs vidare till reverseringens nyckel, så
      // idempotensen blir per punkt precis som originalets. Två annulleringsförsök
      // ger ETT motverifikat per punkt.
      const punkt = original.sourceId!.slice(prefix.length)
      await this.createReversalEntry({
        organizationId,
        original,
        source: 'RENT_NOTICE',
        reversalSourceId: `interest-reversal:${noticeId}:${punkt}`,
        description: `${reasonPrefix}: ${original.description}`,
        createdById,
        ...(tx ? { tx } : {}),
      })
    }
  }

  // Motverifikat vid makulering av en faktura (Invoice VOID). Intäkten bokas redan
  // vid create() (createJournalEntryForInvoice: 1510 D / 39xx K / ev. 26xx K,
  // sourceId=invoice.id) oavsett status — även DRAFT. Utan reversering vid VOID
  // kvarstår fantomintäkt + utgående moms (BFL 5 kap 5 §/9 §). No-op om ingen
  // originalpost finns.
  async reverseJournalEntryForInvoice(
    invoiceId: string,
    organizationId: string,
    createdById: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma
    const original = await db.journalEntry.findFirst({
      where: { organizationId, source: 'INVOICE', sourceId: invoiceId },
      include: { lines: true },
    })
    if (!original) return

    await this.createReversalEntry({
      organizationId,
      original,
      source: 'INVOICE',
      reversalSourceId: `invoice-reversal:${invoiceId}`,
      description: `Makulerad faktura: ${original.description}`,
      createdById,
      ...(tx ? { tx } : {}),
    })
  }

  /**
   * OPERATÖRSSTYRD RÄTTELSE (T5 PR1c2): vänder ETT valt verifikat.
   *
   * Den femte anroparen av motverifikat-mekanismen, och den enda som en människa
   * startar. Den finns för att PR1c:s spärr ska peka på en ÅTGÄRD i stället för
   * en hänvisning: när en bokförd post är fel är rätt svar inte att öppna den
   * gamla månaden, utan att bokföra en rättelse i innevarande — och det ska vara
   * en knapp, inte en instruktion om att välja BAS-konton.
   *
   * MEDVETET RIKTAD, inte fri. Det finns ingen konto-väljare: funktionen vänder
   * ett specifikt, redan bokfört verifikat. Kontona och beloppen kommer från
   * originalet, så den som rättar behöver inte kunna kontoplanen. Fri kontering
   * finns kvar i AI-assistenten för de fall en ren vändning inte räcker.
   *
   * ORIGINALET RÖRS INTE. Ingen UPDATE, ingen DELETE — det står kvar exakt som
   * det bokfördes. Rättelsen är en NY post daterad idag, med en länk tillbaka.
   *
   * EN GÅNG PER VERIFIKAT. En andra rättelse hade tagit ut den första och lämnat
   * tre verifikat där en rättelse skedde. Har man rättat fel verifikat reverserar
   * man i stället SIN rättelse — den är också ett verifikat och får också rättas
   * en gång. Kontrollen finns här (begripligt besked) och som unikt index i DB
   * (spärr mot samtidiga dubbelklick).
   */
  async reverseJournalEntry(params: {
    entryId: string
    organizationId: string
    actorRole?: UserRole
    actorUserId: string | null
    reason: string
  }) {
    // Rollgrinden ligger HÄR, i chokepunkten — inte bara i controllern. En
    // rättelse skapar ett verifikat; det är en redovisningshandling.
    // Fail-closed: okänd eller saknad roll nekas.
    if (!params.actorRole || !REVERSAL_ROLES.includes(params.actorRole)) {
      throw new ForbiddenException('Du saknar behörighet att rätta ett verifikat')
    }

    const reason = params.reason?.trim() ?? ''
    if (reason.length < REVERSAL_REASON_MIN_LENGTH) {
      throw new BadRequestException(
        `Ange varför verifikatet rättas (minst ${REVERSAL_REASON_MIN_LENGTH} tecken). ` +
          'Skälet blir rättelsens beskrivning i huvudboken och går inte att ändra efteråt.',
      )
    }

    const original = await this.prisma.journalEntry.findFirst({
      where: { id: params.entryId, organizationId: params.organizationId },
      include: {
        lines: true,
        // `sourceId` behövs för att beskedet ska kunna säga VILKEN väg som
        // reverserade posten — se kontrollen nedan.
        reversedBy: { select: { series: true, verNumber: true, sourceId: true } },
      },
    })
    if (!original) throw new NotFoundException('Verifikation hittades inte')

    // ── REDAN REVERSERAT — OAVSETT AV VILKEN VÄG ────────────────────────────
    //
    // Kontrollen fanns, men täckte bara manuell-mot-manuell: de sju AUTOMATISKA
    // reverseringarna satte inte `reversalOfEntryId`, så `reversedBy` var NULL
    // för dem och operatören släpptes igenom till en andra reversering av en
    // post som annulleringen redan vänt. Sedan kolumnen sätts centralt i
    // `createReversalEntry` täcker den här raden båda vägarna.
    //
    // BESKEDET SKILJER PÅ VÄGARNA. "Redan rättat" är fel ord om posten vändes av
    // en annullering eller makulering — operatören letar då efter en rättelse
    // som inte finns, i stället för att förstå att dokumentet är annullerat.
    // `sourceId` bär vilken väg det var.
    if (original.reversedBy) {
      const { series, verNumber, sourceId } = original.reversedBy
      const manuell = sourceId?.startsWith('entry-reversal:') ?? false
      throw new ConflictException(
        manuell
          ? `Verifikatet är redan rättat, med verifikat ${series}${verNumber}. ` +
              'Ett verifikat rättas en gång — behöver du ändra igen, rätta rättelsen.'
          : `Verifikatet är redan reverserat av verifikat ${series}${verNumber}, som skapades ` +
              'när dokumentet annullerades eller makulerades. Beloppet är alltså redan bokat ' +
              'bort — en rättelse här skulle bokföra bort det en andra gång.',
      )
    }

    // ── FAKTURAN HAR EN KREDITNOTA — RIKTNING 1 AV ETT PAR ──────────────────
    //
    // PARET: "rätta ett fakturaverifikat som redan krediterats" (här) och
    // "kreditera en faktura vars verifikat redan rättats" (assessCreditability
    // i credit-note.service.ts). Båda behövs, och skälet är att de två
    // verifikaten ligger i SKILDA `sourceId`-namnrymder:
    //
    //     fakturan      INVOICE  <invoiceId>
    //     kreditnotan   INVOICE  credit-note:<creditNoteId>
    //     rättelsen     MANUAL   entry-reversal:<entryId>
    //
    // Ingen av dem slår upp någon annans. `createNumberedEntry` är idempotent
    // per (org, source, sourceId), så hade de delat namnrymd hade den andra
    // körningen hittat den första posten och bokfört ingenting — det är exakt
    // det som gör påminnelseavgiftens två vägar ofarliga. Här skiljer sig
    // nycklarna åt, och då finns inget skydd alls.
    //
    // FELET LIGGER I SEKVENSEN, INTE I VERIFIKATET. Var och en av de tre
    // posterna balanserar. Uppmätt på en faktura om 10 000 kr som först
    // helkrediterades och därefter fick sitt originalverifikat rättat:
    //
    //     1510:  D 10 000 − K 10 000 − K 10 000 = −10 000
    //     39xx:  K  8 000 − D  8 000 − D  8 000 = + 8 000
    //
    // En negativ kundfordran och en reverserad intäkt som inte motsvarar någon
    // affärshändelse. Varken den globala balansgrinden eller någon
    // verifikatkontroll kan se det, eftersom varje post för sig går ihop.
    //
    // VARFÖR EN EGEN FRÅGA OCH INTE ETT LÅN AV `reversedBy`: fälten svarar på
    // olika saker. `reversedBy` betyder "det HÄR verifikatet är vänt av ett
    // motverifikat" och bär ett unikt index — ETT motverifikat per post. En
    // faktura kan ha MÅNGA kreditnotor (delkreditering, upprepad). Att låta
    // kreditnotan sätta `reversalOfEntryId` hade därför fällt den andra
    // delkrediteringen på ett unikt index, och samtidigt fått
    // verifikationslistan att påstå "rättad" om en faktura som bara krympt.
    // Två frågor, två uppslag.
    //
    // VAD DEN HÄR GRINDEN INTE KAN SE. Den är en FÖRKONTROLL, precis som
    // `reversedBy`-grinden ovan: `reverseJournalEntry` tar inget radlås på
    // fakturan, och skrivningen sker först längre ned i `createReversalEntry`,
    // som öppnar sin egen transaktion. En kreditnota som skapas EFTER den här
    // läsningen men före rättelsens commit passerar alltså. Fönstret är smalt
    // och asymmetriskt: `createCreditNote` kör innanför `FOR UPDATE` på
    // fakturan och ser därför en rättelse som redan committats. Att stänga det
    // helt kräver att rättelsen tar samma radlås i samma transaktion som sin
    // skrivning — ett eget ärende, inte en rad här. Det ägs INTE av den här
    // filen, och den som läser grönt ska veta det.
    if (original.source === 'INVOICE' && original.sourceId && !original.sourceId.includes(':')) {
      const kreditnotor = await this.prisma.invoice.findMany({
        where: {
          organizationId: params.organizationId,
          creditedInvoiceId: original.sourceId,
          // En kreditnota KAN i dag inte makuleras (invoices.service.ts spärrar
          // VOID på isCreditNote). Filtret står här ändå: skulle den spärren
          // öppnas ska en makulerad kreditnota inte längre blockera, eftersom
          // dess belopp då inte påverkar fordran.
          status: { not: 'VOID' },
        },
        select: { invoiceNumber: true, total: true },
        orderBy: { invoiceNumber: 'asc' },
      })
      if (kreditnotor.length > 0) {
        const namn = kreditnotor.map((k) => k.invoiceNumber).join(', ')
        const summa = kreditnotor
          .reduce((s, k) => s.plus(k.total), new Prisma.Decimal(0))
          .toFixed(2)
        throw new ConflictException(
          `Fakturan är redan krediterad med ${
            kreditnotor.length === 1 ? 'kreditnota' : 'kreditnotorna'
          } ${namn} (${summa} kr). En rättelse här skulle bokföra bort samma ` +
            'belopp en andra gång och ge en negativ kundfordran. Ska mer skrivas ' +
            'ned: kreditera det som återstår. Blev krediteringen fel: bokför en ny ' +
            'faktura på beloppet — en kreditnota kan inte makuleras.',
        )
      }
    }

    const bookedOn = original.date.toISOString().slice(0, 10)
    const intendedDescription = `Rättelse av verifikat ${original.series}${original.verNumber} (bokfört ${bookedOn}): ${reason}`

    try {
      const created = await this.createReversalEntry({
        organizationId: params.organizationId,
        original,
        // MANUAL, inte originalets källa: det här är en operatörshandling, inte en
        // följd av en affärshändelse i något domänflöde. Det gör den dessutom
        // filtrerbar som "manuella poster" i verifikationslistan.
        source: 'MANUAL',
        reversalSourceId: `entry-reversal:${params.entryId}`,
        description: intendedDescription,
        createdById: params.actorUserId,
        linePrefix: 'Rättelse',
        // reversalOfEntryId sätts centralt i createReversalEntry, för alla vägar.
        include: { lines: { include: { account: true } } },
      })

      // IDEMPOTENSTRÄFF = någon annan hann före.
      //
      // `createNumberedEntry` returnerar en befintlig post i stället för att
      // skriva en dubblett. För de fyra AUTOMATISKA motverifikaten är det rätt:
      // varje anrop för samma sourceId är logiskt identiskt, så en retry ÄR
      // idempotent. Här är det inte det — `reason` är fritext, och två
      // samtidiga rättelser kan bära olika skäl. Utan den här kontrollen får
      // förloraren "rättelse bokförd" för en post som bär MOTPARTENS skäl,
      // medan hens eget tyst kastades. Skälet är dokumenterat som något som
      // "går inte att ändra efteråt" — då får det inte tyst försvinna.
      //
      // Beskrivningen är deterministisk ur (originalets nummer, dess datum,
      // skälet), så en avvikelse betyder att posten skrevs av någon annan.
      // Skrev de exakt samma skäl är utfallet detsamma som avsett och vi säger
      // inget — då hände faktiskt det användaren bad om.
      if (created.description !== intendedDescription) {
        // Fångas INTE av catch-blocket nedan: isIdempotencyRaceConflict kräver en
        // PrismaClientKnownRequestError, så en ConflictException faller igenom
        // till `throw err` oförändrad.
        throw new ConflictException(
          `Verifikatet rättades precis av någon annan, med verifikat ${created.series}${created.verNumber}. ` +
            'Ditt angivna skäl bokfördes inte — ladda om sidan och läs vad som redan står.',
        )
      }
      return created
    } catch (err) {
      // SAMTIDIGHET: kontrollen av `reversedBy` ovan sker före skrivningen, så
      // två dubbelklick kan båda passera den. Den som förlorar krockar på ett
      // unikt index — utan den här översättningen får hen en rå 500 och en
      // CRITICAL i Sentry för vad som i praktiken är ett dubbelklick.
      //
      // MEN: JournalEntry har TRE unika index, och de betyder INTE samma sak.
      // (org, source, sourceId) och reversalOfEntryId betyder båda "någon hann
      // före med rättelsen". (org, series, fiscalYear, verNumber) betyder att
      // verifikationsserien fått en dubblett — ett allvarligt fel som måste
      // fortsätta upp som ett fel, inte maskeras som en ofarlig krock. Därför
      // disambiguering på err.meta.target (lärdomen från plattforms-
      // fakturanumret, #214), inte en blind P2002-fångst.
      if (isIdempotencyRaceConflict(err)) {
        const winner = await this.prisma.journalEntry.findFirst({
          where: { reversalOfEntryId: params.entryId },
          select: { series: true, verNumber: true },
        })
        throw new ConflictException(
          winner
            ? `Verifikatet är redan rättat, med verifikat ${winner.series}${winner.verNumber}. ` +
                'Ett verifikat rättas en gång — behöver du ändra igen, rätta rättelsen.'
            : 'Verifikatet rättades precis av någon annan. Ladda om sidan.',
        )
      }
      throw err
    }
  }

  // Bokslutspost: upplupen förbrukningsintäkt (IMD). Förbrukning som är konsumerad
  // men ännu OMÄTT vid räkenskapsårets slut (mätaren läses först i januari) saknar
  // ett ACTUAL-verifikat i rätt år. Här periodiseras den estimerade intäkten:
  //
  //   Accrual (datum = räkenskapsårets slut, normalt 31/12):
  //     1790 D  total        (upplupen intäkt, interimsfordran)
  //     3920|3970 K  net     (el/värme resp. vatten — bruttoredovisat)
  //     2611 K  vat          (endast om vatStatus = TAXABLE_25)
  //   Reversal (datum = nästa räkenskapsårs första dag, normalt 1/1) — speglar
  //   accrual rad för rad så intäkten inte dubbelräknas när den verkliga (ACTUAL)
  //   förbrukningen bokförs:
  //     3920|3970 D  net   / 2611 D vat   / 1790 K total
  //
  // Bruttoredovisning: endast intäktssidan. Idempotent via separata sourceId för
  // accrual respektive reversal → bokslutet kan köras om utan dubbla poster.
  // Detta är en BOKSLUTSPOST — den materialiseras ALDRIG som en ConsumptionCharge
  // och hamnar aldrig på en avi/faktura (jfr ACTUAL-flödet).
  async createConsumptionAccrualEntry(
    params: {
      meterId: string
      meterType: MeterType
      fiscalYear: number
      yearEndDate: Date
      reversalDate: Date
      netAmount: number
      vatStatus: ConsumptionVatStatus
      vatAmount: number
      totalAmount: number
    },
    organizationId: string,
    createdById: string | null,
  ) {
    const { meterId, meterType, fiscalYear, yearEndDate, reversalDate } = params
    const net = params.netAmount
    const vat = params.vatAmount
    const total = params.totalAmount
    if (total <= 0) return null

    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))

    const accrualAccountId = accountByNumber.get(1790)
    const revenueId = accountByNumber.get(CONSUMPTION_REVENUE_ACCOUNT_BY_METER_TYPE[meterType])
    if (!accrualAccountId || !revenueId) {
      this.logger.error(
        `[Accounting] Konto saknas (1790 eller intäktskonto) för upplupen förbrukning ` +
          `mätare ${meterId} ${fiscalYear} — bokslutspost skapas ej`,
      )
      return null
    }

    let vatAccountId: string | undefined
    if (params.vatStatus === 'TAXABLE_25' && vat > 0) {
      const vatNumber = VAT_TO_ACCOUNT[25] // 2611
      vatAccountId = vatNumber ? accountByNumber.get(vatNumber) : undefined
      if (!vatAccountId) {
        this.logger.error(
          `[Accounting] Momskonto 2611 saknas för upplupen förbrukning mätare ${meterId} — bokslutspost skapas ej`,
        )
        return null
      }
    }

    const label = METER_TYPE_LABEL[meterType]
    // Mätarreferens i verifikattexten (BFL 5 kap 7 §) — sambandet ska kunna
    // fastställas utan att slå upp sourceId.
    const meterRef = meterId.slice(0, 8)
    const accrualSourceId = `consumption-accrual:${meterId}:${fiscalYear}`
    const reversalSourceId = `consumption-accrual-reversal:${meterId}:${fiscalYear}`

    const accrualLines: JournalLineInput[] = [
      { accountId: accrualAccountId, debit: total, description: `Upplupen förbrukning ${label}` },
    ]
    if (vatAccountId)
      accrualLines.push({ accountId: vatAccountId, credit: vat, description: 'Moms 25%' })
    accrualLines.push({
      accountId: revenueId,
      credit: net,
      description: `Upplupen förbrukningsersättning ${label} ${fiscalYear}`,
    })

    const reversalLines: JournalLineInput[] = [
      { accountId: revenueId, debit: net, description: `Återföring upplupen förbrukning ${label}` },
    ]
    if (vatAccountId)
      reversalLines.push({ accountId: vatAccountId, debit: vat, description: 'Moms 25%' })
    reversalLines.push({
      accountId: accrualAccountId,
      credit: total,
      description: `Återföring upplupen intäkt ${label} ${fiscalYear}`,
    })

    // Accrual (räkenskapsårets slut) + reversal (nästa års första dag) skapas
    // ATOMISKT i EN transaktion: en halvfärdig periodisering (accrual utan
    // reversal) skulle dubbelräkna intäkten nästa år. Antingen båda eller inget.
    // createNumberedEntry förblir idempotent inuti transaktionen via sourceId.
    return this.prisma.$transaction(async (tx) => {
      const accrual = await this.createNumberedEntry({
        organizationId,
        date: yearEndDate,
        description: `Bokslut: upplupen förbrukning ${label} ${fiscalYear} (mätare ${meterRef})`,
        source: 'MANUAL',
        sourceId: accrualSourceId,
        createdById,
        lines: accrualLines,
        idempotencyWhere: { organizationId, sourceId: accrualSourceId },
        include: { lines: { include: { account: true } } },
        tx,
      })

      const reversal = await this.createNumberedEntry({
        organizationId,
        date: reversalDate,
        description: `Bokslut: återföring upplupen förbrukning ${label} ${fiscalYear} (mätare ${meterRef})`,
        source: 'MANUAL',
        sourceId: reversalSourceId,
        createdById,
        lines: reversalLines,
        idempotencyWhere: { organizationId, sourceId: reversalSourceId },
        include: { lines: { include: { account: true } } },
        tx,
      })

      return { accrual, reversal }
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  // ── Årsavslutsverifikatet (#704 PR 2) ─────────────────────────────────────
  /**
   * Bokför årsavslutsverifikatet — resultatkontonas nollställning mot "Årets
   * resultat". ENDA publika ingången till `createNumberedEntry` för det flödet.
   *
   * VARFÖR EN EGEN METOD OCH INTE EN PUBLIK `createNumberedEntry`:
   * `createNumberedEntry` är privat med flit — den bär balansgrinden,
   * idempotensnyckelns org-scopning och sekvensallokeringen, och varje ny
   * anropare är en ny chans att skicka in en nyckel som inte är unik nog. Den
   * här metoden fixerar `source`, `sourceId` och `idempotencyWhere` så
   * anroparen inte kan välja dem fel.
   *
   * `source = 'MANUAL'`, inte ett nytt enumvärde: samma val som den befintliga
   * bokslutsposten för omätt förbrukning (`runYearEndAccrual`), som också är en
   * systemskapad bokslutspost under MANUAL. Ett nytt `YEAR_END`-värde hade varit
   * ärligare men kräver en migration och en genomgång av varje switch på
   * `source`; det är ett eget ärende, inte en bieffekt av årsstängningen.
   *
   * `sourceId = 'year-end:<fiscalYear>'` — det unika indexet
   * (organizationId, source, sourceId) ÄR idempotensen. Två samtidiga
   * stängningar av samma år kan därför inte ge två verifikat.
   *
   * `tx` är OBLIGATORISK här, till skillnad från i `createNumberedEntry`.
   * Verifikatet får aldrig finnas utan sin `FiscalYearClose`-rad eller tvärtom:
   * ett årsavslut utan stängning ser ut som en dubbelbokning nästa gång någon
   * försöker stänga, och en stängning utan verifikat låser året med
   * resultatkontona kvar.
   */
  async createYearEndResultEntry(params: {
    organizationId: string
    fiscalYear: number
    date: Date
    lines: JournalLineInput[]
    createdById?: string | null
    tx: Prisma.TransactionClient
  }) {
    const sourceId = `year-end:${params.fiscalYear}`
    return this.createNumberedEntry({
      organizationId: params.organizationId,
      date: params.date,
      description: `Bokslut: resultatavräkning räkenskapsåret ${params.fiscalYear}`,
      source: 'MANUAL',
      sourceId,
      createdById: params.createdById ?? null,
      lines: params.lines,
      idempotencyWhere: { organizationId: params.organizationId, sourceId },
      include: { lines: { include: { account: true } } },
      tx: params.tx,
    })
  }

  // Bokföring av hyresinbetalning (RentNotice). Använder samma BAS-konton som
  // Invoice-betalning (1930 D bank / 1510 K kundfordran) — hyresavin är en
  // kundfordran på samma sätt. Vi indexerar med samma source='PAYMENT' och
  // (sedan #326 D) en allokerings-nycklad sourceId, så
  // reverseJournalEntryForPayment fungerar för båda typerna utan särfall.
  //
  // Bankavstämnings-härdning PR 3b — valfri `tx`: när verifikatet måste skapas
  // ATOMISKT tillsammans med allokeringen + ev. status-flip (partiell bankmatchning,
  // applyMatchToRentNotice). Beloppet är `transaction.amount` = det FAKTISKT
  // allokerade delbeloppet, så samma funktion bokför både full betalning och
  // delbetalning utan särfall. Kontoslagning + verifikatet körs på `tx` när den
  // anges; counterparty-läsningen är ren statisk data och får gå på poolen.
  // T5 A2 (fail-closed — F1-fällan på intäkts-betalningssidan): en inbetalning
  // krediterar 1510 (reglerar fordran). Om fordrans-DEBETEN (accrual-verifikatet)
  // aldrig bokförts blir 1510-krediten en "spökkredit" → obalanserad huvudbok
  // (BFL 5 kap 6 §). Speglar deposit/reconciliation-F1-mönstret (som redan gatar
  // via länkad Deposit). Verifierar att accrual-verifikatet (source='INVOICE',
  // sourceId=<accrualSourceId>: 'rent-notice:<id>' för avi, invoice.id för faktura)
  // existerar; annars NEKAS betalningsbokningen (kastar) — aldrig tyst kreditering.
  // Efter A1 har nya avier/fakturor alltid sin accrual atomiskt → detta träffar
  // bara pre-A1-orphans tills A3 reparerat dem (exakt rätt: en orphan-avi ska inte
  // kunna få en spökkredit-betalning innan den reparerats).
  private async hasReceivableAccrual(
    db: Prisma.TransactionClient,
    organizationId: string,
    accrualSourceId: string,
  ): Promise<boolean> {
    const accrual = await db.journalEntry.findFirst({
      where: { organizationId, source: 'INVOICE', sourceId: accrualSourceId },
      select: { id: true },
    })
    return accrual != null
  }

  private failClosedNoAccrual(label: string, organizationId: string, accrualKey: string): never {
    this.logger.error(
      `[Accounting] FAIL-CLOSED: ${label} saknar bokförd fordran (accrual '${accrualKey}', ` +
        `org ${organizationId}) — 1510 krediteras INTE (skulle kreditera utan motsvarande ` +
        `debet = spökkredit). Intäktsverifikatet måste repareras (T5 A3) först.`,
    )
    throw new MissingAccrualError(
      `${label} saknar bokförd fordran — kan inte kreditera 1510 utan att skapa en ` +
        `obalanserad huvudbok (BFL 5:6). Avins/fakturans intäktsverifikat måste repareras först.`,
    )
  }

  // Avi-vägens accrual är entydigt nycklad 'rent-notice:<id>'.
  private async assertReceivableAccrualBooked(
    db: Prisma.TransactionClient,
    organizationId: string,
    accrualSourceId: string,
    label: string,
  ): Promise<void> {
    if (await this.hasReceivableAccrual(db, organizationId, accrualSourceId)) return
    this.failClosedNoAccrual(label, organizationId, accrualSourceId)
  }

  // Faktura-vägen är TYP-medveten: en vanlig faktura bokför sin fordran under
  // sourceId=invoice.id, men en DEPOSITIONSFAKTURA (Invoice.type='DEPOSIT',
  // Deposit.invoiceId satt) bokför sin 1510-debet under 'deposit-invoice:<depositId>'
  // (createJournalEntryForDepositInvoice). Guarden accepterar därför BÅDA: annars
  // skulle varje frisk depositionsbetalning falsk-nekas. En länkad Deposit ⇔ atomiskt
  // bokförd deposit-invoice-accrual (T5 A1) — samma strukturgaranti reconciliation
  // redan litar på (#41/#109). Fail-closed bara om INGEN av nycklarna finns.
  private async assertInvoiceReceivableBacked(
    db: Prisma.TransactionClient,
    organizationId: string,
    invoiceId: string,
    invoiceNumber: string,
  ): Promise<void> {
    if (await this.hasReceivableAccrual(db, organizationId, invoiceId)) return
    const deposit = await db.deposit.findFirst({
      where: { organizationId, invoiceId },
      select: { id: true },
    })
    if (
      deposit &&
      (await this.hasReceivableAccrual(db, organizationId, `deposit-invoice:${deposit.id}`))
    )
      return
    this.failClosedNoAccrual(`faktura ${invoiceNumber}`, organizationId, invoiceId)
  }

  async createJournalEntryForRentNoticePayment(
    notice: { id: string; noticeNumber: string; type?: RentNoticeType },
    transaction: Pick<BankTransaction, 'id' | 'date' | 'amount'>,
    organizationId: string,
    createdById: string | null,
    tx?: Prisma.TransactionClient,
    // #326 D — allokerings-nycklad idempotens. Se motiveringen vid
    // `createJournalEntryForPayment`. Avi-vägen hade SAMMA nyckelform och
    // därmed samma fälla; att den inte var nåbar via ommatchning berodde på att
    // `RentNoticePayment.bankTransactionId @unique` fyllde samma tillfälliga
    // roll som fakturasidans. Båda vägarna nycklas nu likadant.
    allocationId?: string,
  ) {
    const db = tx ?? this.prisma
    const accounts = await db.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const bankAccountId = accountByNumber.get(1930)
    const receivableId = accountByNumber.get(1510)
    if (!bankAccountId || !receivableId) return null

    // A2 fail-closed. DEPOSIT-avier gatas redan av callern (länkad Deposit-existens,
    // #41/#109) och deras accrual är deposit-invoice-nycklad, inte rent-notice: →
    // hoppa guarden här för DEPOSIT (annars falsk-nekas en frisk depositionsbetalning).
    if (notice.type !== RentNoticeType.DEPOSIT) {
      await this.assertReceivableAccrualBooked(
        db,
        organizationId,
        `rent-notice:${notice.id}`,
        `hyresavi ${notice.noticeNumber}`,
      )
    }

    // Beloppet bokförs på transaction.amount (= det allokerade delbeloppet vid
    // partiell bankmatchning). Avins totalAmount styr INTE verifikatet.
    const amount = Number(transaction.amount)
    if (amount <= 0) return null

    const counterparty = await this.counterpartyForRentNotice(notice.id, organizationId)

    const sourceId = allocationId
      ? bankPaymentSourceId('rent-notice', allocationId)
      : transaction.id

    return this.createNumberedEntry({
      organizationId,
      date: transaction.date,
      description: `Inbetalning hyresavi ${notice.noticeNumber}${counterparty ? ` (${counterparty})` : ''}`,
      source: 'PAYMENT',
      sourceId,
      createdById,
      lines: [
        { accountId: bankAccountId, debit: amount, description: 'Inbetalning bank' },
        { accountId: receivableId, credit: amount, description: 'Reglering hyresfordran' },
      ],
      idempotencyWhere: { organizationId, source: 'PAYMENT', sourceId },
      include: { lines: { include: { account: true } } },
      ...(tx ? { tx } : {}),
    })
  }

  // FIX 9 · PR 6 — Manuell betalningsregistrering av en hyresavi (markAsPaid).
  // Sluter intäktscykeln: PR 2 bokförde fordran vid avisering (1510 D / 39xx K),
  // och denna post reglerar fordran när betalningen registreras manuellt:
  //
  //   1930/1910/1934  Likvidkonto    D  inbetalt belopp   (per betalningssätt)
  //   1510            Kundfordringar K  inbetalt belopp
  //
  // Till skillnad från createJournalEntryForRentNoticePayment (som matchar en
  // importerad BankTransaction vid bankavstämning) finns här ingen transaktion —
  // betalningssättet styr debetkontot.
  //
  // PR 3b (KRITISK FIX): idempotensen nycklas på ALLOKERINGEN (sourceId =
  // "rent-notice-payment:<allocationId>"), INTE på avin. Tidigare nyckel på avi-id
  // var ofarlig så länge markAsPaid bara kunde köras EN gång per avi (den flippade
  // PAID direkt). D5 (PR 3b) låter en delbetalning lämna avin obetald → markAsPaid
  // kan nu köras flera gånger mot SAMMA avi. Med avi-nycklad sourceId skulle den
  // ANDRA delbetalningens verifikat kollidera mot den första (createNumberedEntry
  // returnerar det befintliga) → allokering + paidAmount uppdateras men 1510/likvid
  // bokförs ALDRIG → 1510 understiger Σ allokeringar (BFL 5 kap 6 §-brott). Per
  // allokering (unik UUID, samma strategi som bankvägens sourceId=bankTransactionId)
  // får varje delbetalning sitt EGNA verifikat. Beloppet är det FAKTISKT inbetalda
  // (paidAmount) — vid delbetalning regleras fordran bara delvis, korrekt dubbel bokföring.
  //
  // Depositionsavier (type=DEPOSIT) hoppas över: deras 1510/2890-flöde ägs av
  // deposits-modulen (createJournalEntryForDepositInvoice), inte avisering.
  async createJournalEntryForRentNoticeManualPayment(
    notice: { id: string; noticeNumber: string; type: RentNoticeType },
    paidAmount: number,
    paidAt: Date,
    paymentMethod: PaymentMethod,
    organizationId: string,
    createdById: string | null,
    allocationId: string,
    // Valfri yttre transaktion — anges av AviseringService.markAsPaid så att
    // claim, allokering och detta verifikat skapas ATOMISKT (#108). Faller
    // bokföringen rullas HELA registreringen tillbaka av databasen, inte av ett
    // catch-block som förutsätter att processen fortfarande lever.
    tx?: Prisma.TransactionClient,
  ) {
    if (notice.type === RentNoticeType.DEPOSIT) return null

    const amount = Number(paidAmount)
    if (!Number.isFinite(amount) || amount <= 0) return null

    const debitAccountNumber = PAYMENT_METHOD_TO_ACCOUNT[paymentMethod]

    const db = tx ?? this.prisma
    const accounts = await db.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const debitAccountId = accountByNumber.get(debitAccountNumber)
    const receivableId = accountByNumber.get(1510)
    if (!debitAccountId || !receivableId) {
      this.logger.error(
        `[Accounting] Likvidkonto ${debitAccountNumber} eller 1510 saknas i ` +
          `kontoplanen (org ${organizationId}) — betalningsverifikat för hyresavi ` +
          `${notice.noticeNumber} skapas ej.`,
      )
      return null
    }

    // A2 fail-closed: RENT-only (DEPOSIT hoppas ovan). Neka om avins accrual saknas.
    // A2 läses genom SAMMA klient som skriver — annars kan grinden se ett annat
    // snapshot än verifikatet skrivs mot.
    await this.assertReceivableAccrualBooked(
      db,
      organizationId,
      `rent-notice:${notice.id}`,
      `hyresavi ${notice.noticeNumber}`,
    )

    const sourceId = `rent-notice-payment:${allocationId}`

    const counterparty = await this.counterpartyForRentNotice(notice.id, organizationId, tx)

    return this.createNumberedEntry({
      organizationId,
      date: paidAt,
      description: `Inbetalning hyresavi ${notice.noticeNumber}${counterparty ? ` (${counterparty})` : ''}`,
      source: 'PAYMENT',
      sourceId,
      createdById,
      lines: [
        {
          accountId: debitAccountId,
          debit: amount,
          description: PAYMENT_METHOD_LABEL[paymentMethod],
        },
        { accountId: receivableId, credit: amount, description: 'Reglering hyresfordran' },
      ],
      idempotencyWhere: { organizationId, source: 'PAYMENT', sourceId },
      include: { lines: { include: { account: true } } },
      ...(tx ? { tx } : {}),
    })
  }

  // Reverse av betalningsverifikat: skapar ett motverifikat (debet/kredit byter
  // plats) — append-only, vi raderar aldrig en tidigare bokad post.
  async reverseJournalEntryForPayment(
    transactionId: string,
    organizationId: string,
    createdById: string | null,
    // Valfri yttre transaktion — när reverseringen måste ske atomiskt med en
    // statusåterställning (unmatch). Utan den körs den fristående som förut.
    tx?: Prisma.TransactionClient,
    // ── #326 D: ALLOKERINGENS NYCKEL, MED LEGACY-FALLBACK ───────────────────
    //
    // Sedan D nycklas bankvägens betalningsverifikat på ALLOKERINGEN, inte på
    // banktransaktionen. Reverseringen måste leta efter samma nyckel som
    // skrivaren använde — därför skickar `unmatchTransaction` in den
    // allokering den är på väg att radera.
    //
    // FALLBACK PÅ `transactionId` ÄR INTE VALFRI. Poster skrivna FÖRE D bär
    // fortfarande den gamla nyckeln, och en reversering som inte hittar sitt
    // original är en TYST no-op (`if (!original) return`) — avmatchningen skulle
    // se ut att lyckas medan verifikatet står kvar och 1510 blir dubbelkrediterad
    // vid nästa matchning. Fallbacken är alltså skillnaden mellan en migrering
    // och en tyst dataförstörelse.
    allocationSourceId?: string,
  ): Promise<void> {
    const db = tx ?? this.prisma

    // Ny nyckel först, gammal som fallback. Ordningen spelar roll bara i
    // teorin (en och samma betalning kan inte ha båda), men den uttrycker vilken
    // som är den gällande formen.
    const candidates = [
      ...(allocationSourceId ? [allocationSourceId] : []),
      transactionId, // legacy: poster skrivna före #326 D
    ]

    for (const sourceId of candidates) {
      const original = await db.journalEntry.findFirst({
        where: { organizationId, source: 'PAYMENT', sourceId },
        include: { lines: true },
      })
      if (!original) continue

      await this.createReversalEntry({
        organizationId,
        original,
        source: 'PAYMENT',
        reversalSourceId: `reversal:${sourceId}`,
        description: `Hävd matchning: ${original.description}`,
        createdById,
        ...(tx ? { tx } : {}),
      })
      return
    }
  }

  // BAS för registrering av deposition: 1510 D (kundfordran) / 2890 K (skuld
  // för mottagen deposition). 2890 (Övriga kortfristiga skulder, beskrivning
  // "Mottagna depositioner") är rätt BAS 2024-konto — depositionen är en skuld
  // till hyresgästen tills avflyttning. Tidigare felaktigt 2490; även 2820 är
  // fel då det officiellt avser löneskulder. Posten skrivs en gång per deposit
  // (idempotent).
  async createJournalEntryForDepositInvoice(
    depositId: string,
    organizationId: string,
    amount: number,
    invoiceNumber: string,
    issueDate: Date,
    createdById: string | null,
    // #41: valfri yttre transaktion. Aktiverings-vägen skapar Deposit-raden och
    // bokför denna accrual ATOMISKT (Deposit finns ⇔ 1510 D/2890 K bokförd) så att
    // matchningens fail-closed-gating (länkad Deposit) aldrig kan matcha en avi
    // vars 1510 saknar debet (F1-fällan). Utelämnas → fristående (manuella vägen).
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma
    const sourceId = `deposit-invoice:${depositId}`
    const accounts = await db.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const receivableId = accountByNumber.get(1510)
    const liabilityId = accountByNumber.get(2890)
    if (!receivableId || !liabilityId) return null

    return this.createNumberedEntry({
      organizationId,
      date: issueDate,
      description: `Deposition ${invoiceNumber}`,
      source: 'INVOICE',
      sourceId,
      createdById,
      lines: [
        { accountId: receivableId, debit: amount, description: 'Depositionsfordran' },
        { accountId: liabilityId, credit: amount, description: 'Mottagen deposition' },
      ],
      idempotencyWhere: { organizationId, sourceId },
      ...(tx ? { tx } : {}),
    })
  }

  // BAS för återbetalning av deposition: 2890 D (skulden minskar)
  // / 1930 K (bank) för återbetald del. Eventuella avdrag krediteras 3040
  // (skadeersättningar) istället, så bokföringen alltid balanserar.
  async createJournalEntryForDepositRefund(
    depositId: string,
    organizationId: string,
    refundAmount: number,
    deductionsTotal: number,
    transactionDate: Date,
    createdById: string | null,
    // #25/T2.2: valfri yttre transaktion så refund() kan boka verifikatet ATOMISKT
    // med statusbytet och kasta (→ rollback) om det uteblir.
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma
    const sourceId = `deposit-refund:${depositId}`
    const total = refundAmount + deductionsTotal
    if (total <= 0) return null

    const accounts = await db.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const liabilityId = accountByNumber.get(2890)
    const bankId = accountByNumber.get(1930)
    const damageRevenueId = accountByNumber.get(3040)
    if (!liabilityId || !bankId) return null

    const lines: Array<{
      accountId: string
      debit?: number
      credit?: number
      description: string
    }> = [{ accountId: liabilityId, debit: total, description: 'Återförd depositionsskuld' }]
    if (refundAmount > 0) {
      lines.push({ accountId: bankId, credit: refundAmount, description: 'Återbetalning bank' })
    }
    if (deductionsTotal > 0 && damageRevenueId) {
      lines.push({
        accountId: damageRevenueId,
        credit: deductionsTotal,
        description: 'Avdrag (skador)',
      })
    } else if (deductionsTotal > 0) {
      // #56/T2.2: TIDIGARE fallback bokade avdraget på 1510 när konto 3040 saknades.
      // Det tyst-omklassificerade en SKADEERSÄTTNING (intäkt) till en KUNDFORDRAN
      // — fel affärshändelse (BFL 5:6) och risk för ogrundad 1510-kreditering utan
      // motsvarande fordran. Nu: saknat 3040 → null → refund() KASTAR och rullas
      // tillbaka. Kontoplanen måste innehålla 3040 innan skadeavdrag kan bokföras.
      return null
    }

    return this.createNumberedEntry({
      organizationId,
      date: transactionDate,
      description: `Återbetalning deposition`,
      source: 'PAYMENT',
      sourceId,
      createdById,
      lines,
      idempotencyWhere: { organizationId, sourceId },
      ...(tx ? { tx } : {}),
    })
  }

  // ── MANUELL BOKFÖRING: MÄNNISKANS VÄG ─────────────────────────────────────
  //
  // De två metoderna nedan finns för att `create_journal_entry` och
  // `record_expense` var två av sju AI-verktyg UTAN mänsklig väg
  // (`tool-human-path.baseline.json`): AI:n kunde bokföra en verifikation som
  // hyresvärden inte kunde bokföra själv. Delmängdsregeln kräver att människan
  // kan minst lika mycket.
  //
  // De duplicerar INTE verktygets kontering: kontouppslag, momsdelning och
  // balanskrav byggs av samma rena funktioner som AI-vägen använder
  // (`manual-entry.ts`).
  //
  // SKRIVNINGEN är däremot inte delad, och det ska inte läsas fel. De två
  // metoderna här går ut i `createNumberedEntry` — balansgrind (C1), gap-fritt
  // nummer, idempotens per `(organizationId, source, sourceId)`. AI-vägen har
  // sin EGEN transaktion i `tool-executor.service.ts`. En ny spärr som läggs i
  // `createNumberedEntry` gäller alltså människovägen och inte AI-vägen; att
  // unifiera dem är ett eget arbete.
  //
  // SKILLNADEN MOT AI-VÄGEN ÄR NAMNRYMDEN, och den är avsiktlig: `source` är
  // 'MANUAL' här och 'AI' där. Idempotensen gäller per namnrymd, så en
  // hyresvärd som medvetet bokför samma belopp som AI:n nyss bokförde får ett
  // EGET verifikat i stället för att tystas bort som en dubblett av något hen
  // inte gjorde.

  /**
   * Fritt verifikat, bokfört av en människa.
   *
   * `idempotencyKey` är anroparens egen nyckel och blir `sourceId`. Två anrop
   * med samma nyckel ger EN journalpost — samma egenskap som AI-vägen har, och
   * av samma skäl: ett omtag efter en tappad uppkoppling får inte bli två
   * verifikat i huvudboken.
   *
   * Kastar `UnprocessableEntityException` när verifikatet inte balanserar eller
   * ett konto saknas, med ett SPECIFIKT svenskt meddelande — det går rakt ut
   * till hyresvärden, och "ogiltig indata" hade tvingat hen att gissa vilken rad
   * som var fel.
   */
  async createManualJournalEntry(params: {
    organizationId: string
    date: Date
    description: string
    lines: readonly RadIndata[]
    idempotencyKey: string
    createdById?: string | null
    attachmentUrl?: string | null
    /**
     * NAMNRYMDEN. 'MANUAL' för människans väg, 'AI' för verktygets.
     *
     * Idempotensen gäller per `(organizationId, source, sourceId)`, så de två
     * namnrymderna kan inte tysta varandra: en hyresvärd som medvetet bokför
     * samma belopp som AI:n nyss bokförde får ett EGET verifikat i stället för
     * att avvisas som en dubblett av något hen inte gjorde.
     */
    source?: 'MANUAL' | 'AI'
    /** AI-ursprunget, mjuk referens till AiToolExecution. Bara AI-vägen. */
    aiToolExecutionId?: string | null
    /**
     * Körs INUTI verifikatets transaktion, i båda utfallen. AI-vägen skriver
     * sitt utförandespår här — G0 kräver att spåret och effekten är atomiska.
     */
    efterSkrivning?: (
      tx: Prisma.TransactionClient,
      entry: { id: string },
      redanFanns: boolean,
    ) => Promise<void>
  }) {
    const { organizationId, date, description } = params
    const source = params.source ?? 'MANUAL'

    if (Number.isNaN(date.getTime())) {
      throw new UnprocessableEntityException('Ogiltigt datum.')
    }
    if (!description.trim()) {
      throw new UnprocessableEntityException('Verifikatet behöver en beskrivning.')
    }
    // Förhandsbesked, INTE spärren — den verkställande kontrollen sitter i
    // `allocate()` inuti transaktionen. Frågan ställs via samma delade
    // uppslagning som AI-vägen (`closed-period.ts`), så de aldrig kan svara
    // olika; en egen kopia hade blivit en tyst tillåtare den dag
    // representationen ändras.
    if (await isPeriodClosed(this.prisma, organizationId, date)) {
      throw new UnprocessableEntityException(
        `Bokföringsperioden ${periodKeyOf(periodOfDate(date))} är stängd. Ändra datum eller återöppna perioden.`,
      )
    }

    const konton = await this.kontouppslag(organizationId)
    const byggt = byggVerifikatrader(params.lines, konton)
    if (!byggt.ok) throw new UnprocessableEntityException(byggt.fel)

    return this.createNumberedEntry({
      organizationId,
      date,
      description: description.trim(),
      source,
      sourceId: params.idempotencyKey,
      createdById: params.createdById ?? null,
      lines: byggt.rader,
      idempotencyWhere: { organizationId, source, sourceId: params.idempotencyKey },
      ...(params.attachmentUrl ? { attachmentUrl: params.attachmentUrl } : {}),
      // `!== undefined`: AI-vägen skickar alltid fältet (null när ingen körning
      // förhandsallokerats) och ska då få kolumnen skriven som null — precis som
      // dess egen transaktion gjorde före #790.
      ...(params.aiToolExecutionId !== undefined
        ? { aiToolExecutionId: params.aiToolExecutionId }
        : {}),
      ...(params.efterSkrivning ? { efterSkrivning: params.efterSkrivning } : {}),
      include: { lines: { include: { account: true } } },
    })
  }

  /**
   * Utgift, bokförd av en människa: kostnad (netto) debet, ingående moms debet
   * om den finns, bank kredit (brutto).
   *
   * `belopp` är BRUTTO — det som lämnar 1930. Momsen bryts UT ur det, den läggs
   * inte till. Se `byggUtgiftsrader` för varför den riktningen är utskriven.
   */
  async recordManualExpense(params: {
    organizationId: string
    date: Date
    idempotencyKey: string
    createdById?: string | null
    attachmentUrl?: string | null
    utgift: UtgiftIndata
    /**
     * NAMNRYMDEN. 'MANUAL' för människans väg, 'AI' för verktygets.
     *
     * Idempotensen gäller per `(organizationId, source, sourceId)`, så de två
     * namnrymderna kan inte tysta varandra: en hyresvärd som medvetet bokför
     * samma belopp som AI:n nyss bokförde får ett EGET verifikat i stället för
     * att avvisas som en dubblett av något hen inte gjorde.
     */
    source?: 'MANUAL' | 'AI'
    /** AI-ursprunget, mjuk referens till AiToolExecution. Bara AI-vägen. */
    aiToolExecutionId?: string | null
    /**
     * Körs INUTI verifikatets transaktion, i båda utfallen. AI-vägen skriver
     * sitt utförandespår här — G0 kräver att spåret och effekten är atomiska.
     */
    efterSkrivning?: (
      tx: Prisma.TransactionClient,
      entry: { id: string },
      redanFanns: boolean,
    ) => Promise<void>
  }) {
    const { organizationId, date } = params
    const source = params.source ?? 'MANUAL'

    if (Number.isNaN(date.getTime())) {
      throw new UnprocessableEntityException('Ogiltigt datum.')
    }
    if (!params.utgift.beskrivning.trim()) {
      throw new UnprocessableEntityException('Utgiften behöver en beskrivning.')
    }
    if (await isPeriodClosed(this.prisma, organizationId, date)) {
      throw new UnprocessableEntityException(
        `Bokföringsperioden ${periodKeyOf(periodOfDate(date))} är stängd. Ändra datum eller återöppna perioden.`,
      )
    }

    const konton = await this.kontouppslag(organizationId)
    const byggt = byggUtgiftsrader(params.utgift, konton)
    if (!byggt.ok) throw new UnprocessableEntityException(byggt.fel)

    return this.createNumberedEntry({
      organizationId,
      date,
      description: `Utgift: ${params.utgift.beskrivning.trim()}`,
      source,
      sourceId: params.idempotencyKey,
      createdById: params.createdById ?? null,
      lines: byggt.rader,
      idempotencyWhere: { organizationId, source, sourceId: params.idempotencyKey },
      ...(params.attachmentUrl ? { attachmentUrl: params.attachmentUrl } : {}),
      // `!== undefined`: AI-vägen skickar alltid fältet (null när ingen körning
      // förhandsallokerats) och ska då få kolumnen skriven som null — precis som
      // dess egen transaktion gjorde före #790.
      ...(params.aiToolExecutionId !== undefined
        ? { aiToolExecutionId: params.aiToolExecutionId }
        : {}),
      ...(params.efterSkrivning ? { efterSkrivning: params.efterSkrivning } : {}),
      include: { lines: { include: { account: true } } },
    })
  }

  // ── LEVERANTÖRSFAKTURA: FAKTURAMETODENS TVÅ VERIFIKAT ─────────────────────
  //
  // Båda går genom `createNumberedEntry`, alltså samma chokepunkt som människans
  // fria verifikat och som AI-vägen sedan #792: balansgrind (C1), org-scopad
  // idempotensnyckel (C0), gap-fritt nummer, race-återhämtning.
  //
  // TVÅ SKILDA sourceId, inte en. Mottagandet och betalningen är två
  // affärshändelser vid två tidpunkter; en gemensam nyckel hade gjort
  // betalningen till en idempotensträff på mottagandet — alltså tyst ingen
  // bokföring alls, och en skuld som aldrig regleras i huvudboken.

  /**
   * STEG 1 — bokför en MOTTAGEN leverantörsfaktura.
   *
   * Kostnad (netto) debet, ingående moms debet, 2440 kredit (brutto). Datumet är
   * FAKTURADATUM, inte betaldatum: kostnaden hör till den period fakturan avser.
   */
  async bookSupplierInvoiceReceipt(params: {
    organizationId: string
    invoiceId: string
    date: Date
    supplierName: string
    description: string
    expenseAccount: number
    totalAmount: number
    vatAmount?: number
    createdById?: string | null
    attachmentUrl?: string | null
    /**
     * Yttre transaktion. Registerraden och verifikatet MÅSTE skrivas atomiskt —
     * en faktura utan verifikat är en skuld som inte syns i balansräkningen.
     * Med inskickad `tx` äger anroparen rollbacken, och en idempotenskollision
     * kastar vidare i stället för att återhämtas; det är rätt här, eftersom
     * kollisionen då också ska rulla tillbaka registerraden.
     */
    tx?: Prisma.TransactionClient
  }) {
    const { organizationId, date } = params

    if (Number.isNaN(date.getTime())) {
      throw new UnprocessableEntityException('Ogiltigt fakturadatum.')
    }
    if (await isPeriodClosed(this.prisma, organizationId, date)) {
      throw new UnprocessableEntityException(
        `Bokföringsperioden ${periodKeyOf(periodOfDate(date))} är stängd. Ändra fakturadatum eller återöppna perioden.`,
      )
    }

    const konton = await this.kontouppslag(organizationId)
    const byggt = byggLeverantorsfakturarader(
      {
        belopp: params.totalAmount,
        ...(params.vatAmount !== undefined ? { moms: params.vatAmount } : {}),
        kontonummer: params.expenseAccount,
        beskrivning: params.description,
      },
      konton,
    )
    if (!byggt.ok) throw new UnprocessableEntityException(byggt.fel)

    const sourceId = receiptSourceId(params.invoiceId)
    return this.createNumberedEntry({
      organizationId,
      date,
      description: `Leverantörsfaktura: ${params.supplierName} — ${params.description}`,
      source: 'SUPPLIER_INVOICE',
      sourceId,
      createdById: params.createdById ?? null,
      lines: byggt.rader,
      idempotencyWhere: { organizationId, source: 'SUPPLIER_INVOICE', sourceId },
      ...(params.attachmentUrl ? { attachmentUrl: params.attachmentUrl } : {}),
      ...(params.tx ? { tx: params.tx } : {}),
      include: { lines: { include: { account: true } } },
    })
  }

  /**
   * STEG 2 — bokför BETALNINGEN av en leverantörsfaktura.
   *
   * 2440 debet, 1930 kredit, BRUTTO på båda. Ingen moms: den drogs av vid
   * mottagandet, och att röra 2641 igen hade dubblerat avdraget — ett fel som
   * BALANSERAR och därför inte syns i någon balansgrind.
   *
   * Datumet är BETALDATUM. Tillsammans nettar de två stegen 2440 till noll.
   */
  async bookSupplierInvoicePayment(params: {
    organizationId: string
    invoiceId: string
    paidDate: Date
    supplierName: string
    totalAmount: number
    createdById?: string | null
    /** Se `bookSupplierInvoiceReceipt` — samma atomicitetskrav. */
    tx?: Prisma.TransactionClient
  }) {
    const { organizationId, paidDate } = params

    if (Number.isNaN(paidDate.getTime())) {
      throw new UnprocessableEntityException('Ogiltigt betalningsdatum.')
    }
    if (await isPeriodClosed(this.prisma, organizationId, paidDate)) {
      throw new UnprocessableEntityException(
        `Bokföringsperioden ${periodKeyOf(periodOfDate(paidDate))} är stängd. Ändra betalningsdatum eller återöppna perioden.`,
      )
    }

    const konton = await this.kontouppslag(organizationId)
    const byggt = byggLeverantorsbetalningsrader(params.totalAmount, konton)
    if (!byggt.ok) throw new UnprocessableEntityException(byggt.fel)

    const sourceId = paymentSourceId(params.invoiceId)
    return this.createNumberedEntry({
      organizationId,
      date: paidDate,
      description: `Betald leverantörsfaktura: ${params.supplierName}`,
      source: 'SUPPLIER_INVOICE',
      sourceId,
      createdById: params.createdById ?? null,
      lines: byggt.rader,
      idempotencyWhere: { organizationId, source: 'SUPPLIER_INVOICE', sourceId },
      ...(params.tx ? { tx: params.tx } : {}),
      include: { lines: { include: { account: true } } },
    })
  }

  /**
   * MAKULERING — vänder mottagningsverifikatet.
   *
   * Datumet är DAGEN RÄTTELSEN GÖRS, inte fakturadatumet. En rättelse bokförs
   * när den upptäcks; att backdatera den till ursprungsdatumet hade ändrat ett
   * redan avslutat resultat, och i en stängd period hade den inte gått igenom
   * alls. Är rättelsedagens period stängd faller den här — vilket är rätt svar
   * och inte ett hinder att gå runt.
   *
   * ── MEDVETEN FÖRENKLING ÖVER ÅRSGRÄNS ───────────────────────────────────
   *
   * Mottogs fakturan i år N och makuleras i N+1, går reverseringen genom
   * RESULTATRÄKNINGEN i N+1: N:s resultat bär kvar kostnaden, N+1:s blir
   * motsvarande högre. För ett oväsentligt belopp är det branschpraxis. För ett
   * VÄSENTLIGT belopp kräver god redovisningssed rättelse mot balanserat
   * resultat i stället — och väsentlighet är en bedömning, inte en beräkning, så
   * den kan inte automatiseras här. UI:t VARNAR när gränsen korsas
   * (`makuleringKorsarRakenskapsar`) och hänvisar till revisorn; koden spärrar
   * inte, eftersom det vanliga fallet är det oväsentliga.
   */
  async bookSupplierInvoiceCancellation(params: {
    organizationId: string
    invoiceId: string
    date: Date
    supplierName: string
    description: string
    expenseAccount: number
    totalAmount: number
    vatAmount?: number
    createdById?: string | null
    /** Se `bookSupplierInvoiceReceipt` — samma atomicitetskrav. */
    tx?: Prisma.TransactionClient
  }) {
    const { organizationId, date } = params

    if (Number.isNaN(date.getTime())) {
      throw new UnprocessableEntityException('Ogiltigt makuleringsdatum.')
    }
    if (await isPeriodClosed(this.prisma, organizationId, date)) {
      throw new UnprocessableEntityException(
        `Bokföringsperioden ${periodKeyOf(periodOfDate(date))} är stängd. Återöppna perioden för att bokföra makuleringen.`,
      )
    }

    const konton = await this.kontouppslag(organizationId)
    const byggt = byggLeverantorsfakturareverseringsrader(
      {
        belopp: params.totalAmount,
        ...(params.vatAmount !== undefined ? { moms: params.vatAmount } : {}),
        kontonummer: params.expenseAccount,
        beskrivning: params.description,
      },
      konton,
    )
    if (!byggt.ok) throw new UnprocessableEntityException(byggt.fel)

    const sourceId = cancellationSourceId(params.invoiceId)
    return this.createNumberedEntry({
      organizationId,
      date,
      description: `Makulerad leverantörsfaktura: ${params.supplierName} — ${params.description}`,
      source: 'SUPPLIER_INVOICE',
      sourceId,
      createdById: params.createdById ?? null,
      lines: byggt.rader,
      idempotencyWhere: { organizationId, source: 'SUPPLIER_INVOICE', sourceId },
      ...(params.tx ? { tx: params.tx } : {}),
      include: { lines: { include: { account: true } } },
    })
  }

  /**
   * Spärren mot att makulera en BETALD faktura, som en tjänstemetod.
   *
   * Ligger här och inte i controllern därför att den är en redovisningsregel:
   * makulering nollar ingenting i huvudboken, så en "makulerad" betald faktura
   * hade lämnat både kostnaden och betalningen kvar medan listan påstod att
   * posten inte finns. Rättelsen är ett motverifikat.
   */
  assertMayCancelSupplierInvoice(faktura: { paidAt: Date | null; cancelledAt: Date | null }): void {
    const skäl = cancelBlockedReason(faktura)
    if (skäl) throw new UnprocessableEntityException(skäl)
  }

  /**
   * Kontoplanen som nummer → id, för människovägen. Formningen delas med
   * AI-vägen genom `kontouppslagAv`; själva hämtningen gör varje väg själv, så
   * att den delade regeln inte drar med sig ett DI-beroende (se manual-entry.ts).
   */
  private async kontouppslag(organizationId: string): Promise<Kontouppslag> {
    return kontouppslagAv(
      await this.prisma.account.findMany({
        where: { organizationId },
        select: { id: true, number: true },
      }),
    )
  }
}
