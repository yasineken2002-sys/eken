import { ConflictException } from '@nestjs/common'
import { AccountingPeriodEventType, EventActorType } from '@prisma/client'
import type { AccountingPeriodEventReasonCategory, Prisma } from '@prisma/client'
import { stockholmCivilDate, stockholmFiscalYear } from '../common/time/stockholm-period'
import { resolveActorType } from '../common/ai-origin/ai-origin.context'

/**
 * Stängda bokföringsperioder — EN sanningskälla för frågan "är perioden öppen?".
 *
 * Bakgrund: kontrollen fanns i tre kopior (verifikationsnummer.service.ts,
 * consumption.service.ts och rent-backfill.service.ts) som alla läste
 * `ClosedAccountingPeriod` på var sitt sätt. Samma regel på tre ställen är en
 * regel som förr eller senare glider isär — särskilt den subtila delen: vilken
 * period ett datum tillhör avgörs av datumet i SVENSK CIVIL TID, inte i UTC.
 * Utan det kunde en post 1 januari 00:30 skrivas in i december och därmed förbi
 * en redan stängd period (samma fälla som H5 stängde för periodhärledningen).
 *
 * VIKTIGT om ansvarsfördelningen: den här modulen VERKSTÄLLER inget eget lås.
 * Den enda punkt som faktiskt hindrar en bokföring är fortfarande
 * `VerifikationsnummerService.allocate` — varje JournalEntry i kodbasen får sitt
 * nummer där, i samma transaktion som posten skapas, så en stängd period kan
 * inte kringgås. Modulen samlar bara UPPSLAGNINGEN så att alla frågar likadant,
 * och låter andra vägar ställa frågan TIDIGT (innan de hunnit göra halva jobbet)
 * i stället för att träffa spärren mitt i ett flöde.
 *
 * ── PR1b: VAD frågan ställs MOT bytte, INTE vad den betyder ─────────────────
 *
 * Tidigare: `ClosedAccountingPeriod.findUnique(org, år, månad) !== null`.
 * Nu:       händelsen med HÖGST `seq` för (org, år, månad) har type = CLOSED.
 *
 * Betydelsen är identisk — en period utan händelser är öppen, en period vars
 * senaste händelse är CLOSED är stängd — men representationen bär nu hela
 * kedjan (stängd → öppnad av vem och varför → stängd igen) i stället för ett
 * tillstånd som skrivs över. `allocate` självt är ORÖRT; hela bytet ligger här.
 *
 * TVÅ REGLER SOM INTE FÅR BRYTAS I DEN HÄR FILEN:
 *
 *  1. FRÅGA ALDRIG MED TYPFILTER. Uppslagningen hämtar den senaste händelsen
 *     OAVSETT typ och inspekterar `type` efteråt. En fråga som filtrerar på typ
 *     ställer en annan fråga än den vi tror: `where: { type: 'REOPENED' }` läser
 *     som "har perioden någonsin återöppnats → öppen", vilket gör perioden
 *     permanent öppen även efter en omstängning. Det är den enda vägen härifrån
 *     till en TYST TILLÅTARE — ett verifikat som landar i en stängd period utan
 *     att någon spärr säger ifrån. Testat i closed-period.derivation.spec.ts.
 *
 *  2. `organizationId` I VARJE WHERE. Den gamla `findUnique` på den sammansatta
 *     nyckeln kunde inte glömma org-scopet; en `findFirst` kan. En glömd
 *     org-scopning betyder att en ANNAN organisations händelser avgör om DIN
 *     period är stängd.
 *
 * ── #704 PR 1: TVÅ DIMENSIONER, INTE EN ────────────────────────────────────
 *
 * Modulen svarar numera på TVÅ frågor, och de är olika meningar:
 *
 *   MÅNADEN         AccountingPeriodEvent(org, year, month) — kalenderår +
 *                   kalendermånad 1–12, härledd ur datumet i svensk civil tid.
 *   RÄKENSKAPSÅRET  FiscalYearClose(org, fiscalYear) — härlett med
 *                   `stockholmFiscalYear` ur `Organization.fiscalYearStartMonth`.
 *
 * De går inte att slå ihop: med startmånad 5 består räkenskapsåret 2026 av
 * månadsnycklarna 2026-05 … 2027-04 — TVÅ kalenderår — så det finns inget
 * (year, month)-par som namnger året. Motiveringen i sin helhet står vid
 * modellen i schema.prisma.
 *
 * ÅRET FRÅGAS FÖRE MÅNADEN i `assertPeriodOpen`, och ordningen är inte
 * godtycklig: ett stängt år har alla sina månader stängda (PR 2:s precheck
 * kräver det), så med månaden först hade årsmeddelandet varit oåtkomligt och
 * operatören alltid fått veta fel sak om varför datumet är låst.
 *
 * Att ordningen är entydig vilar på `seq` (per-period monoton räknare), inte på
 * `createdAt`: två händelser i samma millisekund skulle annars ge godtycklig
 * ordning — och godtycklig ordning på just den här frågan betyder "perioden är
 * slumpvis öppen". Se docblocket på modellen i schema.prisma.
 */

/** En period identifierad som kalenderår + kalendermånad (1–12). */
export interface PeriodKey {
  year: number
  month: number
}

/**
 * Minsta Prisma-yta LÄSNINGARNA behöver — funkar med både PrismaService och tx.
 * `$queryRaw` krävs av bulkformen (DISTINCT ON, se getClosedPeriodStates).
 */
type PeriodClient = Pick<Prisma.TransactionClient, 'accountingPeriodEvent' | '$queryRaw'>

/**
 * Minsta Prisma-yta ÅRSFRÅGAN behöver, utöver månadens.
 *
 * `organization` ingår därför att räkenskapsåret HÄRLEDS här och ingen annanstans.
 * Alternativet — att låta anroparen skicka in `fiscalYearStartMonth` — hade gjort
 * härledningen till något varje anropare kan få fel, och felet vore tyst: fel
 * startmånad ger fel år, och fel år slår upp en rad som inte finns. Då är svaret
 * "året är öppet", vilket är exakt fel riktning. En PK-uppslagning per verifikat
 * är billigare än den klassen av fel.
 */
type FiscalYearClient = PeriodClient &
  Pick<Prisma.TransactionClient, 'organization' | 'fiscalYearClose'>

/**
 * Minsta Prisma-yta SKRIVNINGEN behöver. `closedAccountingPeriod` ingår för
 * speglingen (rollback-fallskärmen) — se appendPeriodClosedEvent.
 */
type PeriodWriteClient = Pick<
  Prisma.TransactionClient,
  'accountingPeriodEvent' | 'closedAccountingPeriod'
>

/**
 * Minsta Prisma-yta ÅTERÖPPNINGEN behöver. Medvetet SNÄVARE än
 * `PeriodWriteClient`: `closedAccountingPeriod` saknas, så det är strukturellt
 * omöjligt för återöppningen att röra speglingen. Se appendPeriodReopenedEvent.
 */
type PeriodReopenClient = Pick<Prisma.TransactionClient, 'accountingPeriodEvent'>

/** `2026-03` — nyckelform som används i mängder och felmeddelanden. */
export function periodKeyOf(period: PeriodKey): string {
  return `${period.year}-${String(period.month).padStart(2, '0')}`
}

/** Perioden ett datum tillhör, avgjort i svensk civil tid (aldrig UTC). */
export function periodOfDate(date: Date): PeriodKey {
  const { year, month } = stockholmCivilDate(date)
  return { year, month }
}

/**
 * Är perioden som datumet tillhör stängd? Ren läsning — kastar inte.
 * Använd `assertPeriodOpen` när svaret ska stoppa en skrivning.
 *
 * Det här är punktformen som `allocate` anropar i varje verifikations-
 * transaktion: ett indexträff (organizationId, year, month, seq DESC) + LIMIT 1.
 * INGET typfilter — se regel 1 i filens docblock.
 *
 * VAD DEN INTE KAN SE (#704 PR 1): räkenskapsåret. Den här funktionen svarar
 * ENBART på månadsfrågan och säger "öppen" om ett datum i ett stängt
 * räkenskapsår vars månad råkar vara öppen. Hela frågan ställs av
 * `assertPeriodOpen` — det är den som grindar `allocate` och därmed varje
 * verifikat. Anropare som bara vill ge ett FÖRHANDSBESKED (AI-verktygens
 * precheck i tool-executor.service.ts) använder fortfarande den här och kan
 * därför missa ett stängt år; utfallet är ett sent men korrekt nej från
 * allocate, aldrig ett verifikat som slinker igenom.
 */
export async function isPeriodClosed(
  client: PeriodClient,
  organizationId: string,
  date: Date,
): Promise<boolean> {
  const { year, month } = periodOfDate(date)
  const latest = await client.accountingPeriodEvent.findFirst({
    where: { organizationId, year, month },
    orderBy: { seq: 'desc' },
    select: { type: true },
  })
  return latest?.type === AccountingPeriodEventType.CLOSED
}

/**
 * PUNKTKONTROLL: kastar ConflictException om datumet är låst — av MÅNADEN eller
 * av RÄKENSKAPSÅRET. Hela frågan, till skillnad från `isPeriodClosed`.
 *
 * Anropas dels av `allocate` (den verkställande punkten, i samma tx som posten),
 * dels av flöden som vill ge ett begripligt besked INNAN de börjat skriva.
 *
 * Meddelandet är medvetet handlingsanvisande, och de två fallen anvisar OLIKA
 * saker: en stängd månad kan öppnas igen av en behörig användare (spårat), ett
 * stängt räkenskapsår kan det inte. Ett gemensamt "perioden är stängd" hade
 * skickat operatören att leta efter en återöppningsknapp som inte finns.
 */
/**
 * Räkenskapsåret ett datum tillhör, plus organisationens startmånad.
 *
 * ENDA härledningen av räkenskapsår i spärrvägen. Den delar formel med
 * `VerifikationsnummerService.fiscalYearFor` genom att båda anropar
 * `stockholmFiscalYear` — samma skäl som för månaden: svensk civil tid, aldrig
 * UTC. En verifikation daterad 1 maj 00:30 svensk tid är 30 april 22:30 UTC och
 * hade annars räknats till FÖREGÅENDE räkenskapsår vid startmånad 5.
 *
 * Saknas organisationen faller vi tillbaka på kalenderår (startmånad 1), precis
 * som `allocate`. Det är ofarligt här: en organisation som inte finns kan inte ha
 * en FiscalYearClose-rad, så svaret blir "öppet" oavsett vilket år vi härleder.
 */
async function fiscalYearOfDate(
  client: FiscalYearClient,
  organizationId: string,
  date: Date,
): Promise<{ fiscalYear: number; startMonth: number }> {
  const org = await client.organization.findUnique({
    where: { id: organizationId },
    select: { fiscalYearStartMonth: true },
  })
  const startMonth = org?.fiscalYearStartMonth ?? 1
  return { fiscalYear: stockholmFiscalYear(date, startMonth), startMonth }
}

/**
 * Räkenskapsårets namn för en människa: `2026` vid kalenderår, `2026/2027` vid
 * brutet år.
 *
 * Brutet år MÅSTE visas med båda kalenderåren. "Räkenskapsåret 2026 är stängt"
 * om ett år som löper maj 2026–april 2027 läses av operatören som kalenderåret
 * 2026, och då ser ett avvisat datum i mars 2027 ut som ett fel i systemet i
 * stället för som ett korrekt nej.
 */
export function fiscalYearLabel(fiscalYear: number, startMonth: number): string {
  return startMonth === 1 ? String(fiscalYear) : `${fiscalYear}/${fiscalYear + 1}`
}

/** Räkenskapsåret som datumet tillhör, om det är stängt. Ren läsning — kastar inte. */
export async function findClosedFiscalYear(
  client: FiscalYearClient,
  organizationId: string,
  date: Date,
): Promise<{ fiscalYear: number; startMonth: number; closedAt: Date } | null> {
  const { fiscalYear, startMonth } = await fiscalYearOfDate(client, organizationId, date)
  // findUnique på det sammansatta unik-villkoret: org-scopet kan inte glömmas
  // bort (regel 2 i filens docblock), och en rad = året är stängt. Det finns
  // ingen återöppning att härleda bort — se modellens docblock.
  const row = await client.fiscalYearClose.findUnique({
    where: { organizationId_fiscalYear: { organizationId, fiscalYear } },
    select: { closedAt: true },
  })
  return row ? { fiscalYear, startMonth, closedAt: row.closedAt } : null
}

/** Är räkenskapsåret som datumet tillhör stängt? Ren läsning — kastar inte. */
export async function isFiscalYearClosed(
  client: FiscalYearClient,
  organizationId: string,
  date: Date,
): Promise<boolean> {
  return (await findClosedFiscalYear(client, organizationId, date)) !== null
}

/** Räkenskapsårets stängning, för den som ska visa eller grinda på den. */
export interface FiscalYearCloseState {
  fiscalYear: number
  closedAt: Date
}

/**
 * BULKFORM: vilka av de angivna räkenskapsåren är stängda?
 *
 * För årsstängningens precheck, som behöver veta om NÅGOT tidigare år med
 * bokföring i sig står öppet. Egen fråga i stället för N punktuppslag: mängden
 * är känd i förväg och en `in`-fråga räcker.
 */
export async function getClosedFiscalYears(
  client: FiscalYearClient,
  organizationId: string,
  fiscalYears: readonly number[],
): Promise<Set<number>> {
  if (fiscalYears.length === 0) return new Set()
  const rows = await client.fiscalYearClose.findMany({
    where: { organizationId, fiscalYear: { in: [...fiscalYears] } },
    select: { fiscalYear: true },
  })
  return new Set(rows.map((r) => r.fiscalYear))
}

/** Är ETT namngivet räkenskapsår stängt? Punktform, för prechecken. */
export async function findFiscalYearClose(
  client: FiscalYearClient,
  organizationId: string,
  fiscalYear: number,
): Promise<FiscalYearCloseState | null> {
  const row = await client.fiscalYearClose.findUnique({
    where: { organizationId_fiscalYear: { organizationId, fiscalYear } },
    select: { closedAt: true },
  })
  return row ? { fiscalYear, closedAt: row.closedAt } : null
}

/** Ett stängt räkenskapsår med sitt avslutsverifikat — underlag för översikten. */
export interface FiscalYearCloseWithEntry {
  fiscalYear: number
  closedAt: Date
  /** `null` när inget verifikat skrevs (inget resultatkonto hade saldo). */
  entry: { id: string; series: string; verNumber: number } | null
}

/**
 * BULKFORM MED VERIFIKAT: de angivna årens stängningar, för översiktskortet.
 *
 * Skild från `getClosedFiscalYears` (som bara svarar ja/nej) därför att korten
 * ska visa VILKET verifikat som låste året — ett revisionsspår är inte läsbart
 * om man måste leta upp numret själv. Joinen ligger här och inte hos anroparen,
 * av samma skäl som all annan uppslagning av periodtillstånd: en enda adress.
 */
export async function getFiscalYearCloses(
  client: FiscalYearClient,
  organizationId: string,
  fiscalYears: readonly number[],
): Promise<FiscalYearCloseWithEntry[]> {
  if (fiscalYears.length === 0) return []
  const rows = await client.fiscalYearClose.findMany({
    where: { organizationId, fiscalYear: { in: [...fiscalYears] } },
    select: {
      fiscalYear: true,
      closedAt: true,
      journalEntry: { select: { id: true, series: true, verNumber: true } },
    },
  })
  return rows.map((r) => ({
    fiscalYear: r.fiscalYear,
    closedAt: r.closedAt,
    entry: r.journalEntry
      ? {
          id: r.journalEntry.id,
          series: r.journalEntry.series,
          verNumber: r.journalEntry.verNumber,
        }
      : null,
  }))
}

/**
 * SKRIVNINGEN: låser räkenskapsåret (#704 PR 2).
 *
 * MÅSTE anropas med en transaktionsklient, och SIST i den. Raden är append-only
 * i databasen (`append_only_guard_actor('closedById')`), så `journalEntryId` går
 * inte att fylla i efterhand — hela kontraktet står vid modellen i
 * schema.prisma.
 *
 * INGEN EGEN TILLSTÅNDSKONTROLL HÄR, till skillnad från
 * `appendPeriodReopenedEvent`. Skälet är att skyddet är STRUKTURELLT: unik-
 * villkoret (organizationId, fiscalYear) gör en andra stängning omöjlig, och
 * eftersom det inte finns någon återöppning av ett år finns ingen kedja vars
 * ordning kan bli fel. En `findFirst` före insert:en hade varit den sortens
 * kontroll som inte låser något och därför inte skyddar något (se
 * createNumberedEntrys docblock om samma sak). Anroparen frågar
 * `findFiscalYearClose` FÖRE transaktionen för att kunna ge ett begripligt
 * besked; P2002 härifrån är den verkliga spärren.
 */
export async function appendFiscalYearClose(
  tx: Pick<Prisma.TransactionClient, 'fiscalYearClose'>,
  params: {
    organizationId: string
    fiscalYear: number
    closedAt: Date
    closedById?: string | null
    journalEntryId?: string | null
    summary: Prisma.InputJsonValue
  },
): Promise<{ id: string }> {
  const rad = await tx.fiscalYearClose.create({
    data: {
      organizationId: params.organizationId,
      fiscalYear: params.fiscalYear,
      closedAt: params.closedAt,
      ...(params.closedById ? { closedById: params.closedById } : {}),
      ...(params.journalEntryId ? { journalEntryId: params.journalEntryId } : {}),
      summary: params.summary,
    },
    select: { id: true },
  })
  return rad
}

export async function assertPeriodOpen(
  client: FiscalYearClient,
  organizationId: string,
  date: Date,
  context?: string,
): Promise<void> {
  // ÅRET FÖRST — se filens docblock. Ett stängt år har alla sina månader
  // stängda, så den omvända ordningen hade gjort årsmeddelandet oåtkomligt.
  const closedYear = await findClosedFiscalYear(client, organizationId, date)
  if (closedYear) {
    const label = fiscalYearLabel(closedYear.fiscalYear, closedYear.startMonth)
    throw new ConflictException(
      `Räkenskapsåret ${label} är stängt${context ? ` — ${context}` : ''}. ` +
        'Ett stängt räkenskapsår kan inte öppnas igen. Bokför i innevarande ' +
        'räkenskapsår i stället.',
    )
  }

  if (await isPeriodClosed(client, organizationId, date)) {
    const label = periodKeyOf(periodOfDate(date))
    throw new ConflictException(
      `Bokföringsperioden ${label} är stängd${context ? ` — ${context}` : ''}. ` +
        'Bokför i innevarande period i stället, eller be en behörig användare ' +
        'öppna perioden igen (loggas).',
    )
  }
}

/** En period som är stängd just nu, med tidpunkten för den GÄLLANDE stängningen. */
export interface ClosedPeriodState extends PeriodKey {
  /** createdAt på den SENASTE CLOSED-händelsen — inte den första, om perioden omstängts. */
  closedAt: Date
}

/**
 * BULKFORM: organisationens samtliga perioder som är stängda just nu.
 *
 * DISTINCT ON plockar den senaste händelsen per (år, månad) — utan typfilter,
 * precis som punktformen — och först därefter filtreras CLOSED fram. Skrivet i
 * rå SQL för att uttrycka "senaste per grupp" i ETT anrop; Prismas `distinct`
 * hade behövt hämta hem varje periods hela historik och sålla i Node.
 *
 * Ordningen (seq DESC) är samma entydiga ordning som punktformen använder — de
 * två får aldrig kunna svara olika på samma period.
 */
export async function getClosedPeriodStates(
  client: PeriodClient,
  organizationId: string,
): Promise<ClosedPeriodState[]> {
  const rows = await client.$queryRaw<
    Array<{ year: number; month: number; type: string; createdAt: Date }>
  >`
    SELECT DISTINCT ON ("year", "month")
      "year", "month", "type"::text AS "type", "createdAt"
    FROM "AccountingPeriodEvent"
    WHERE "organizationId" = ${organizationId}
    ORDER BY "year", "month", "seq" DESC
  `
  return rows
    .filter((r) => r.type === AccountingPeriodEventType.CLOSED)
    .map((r) => ({ year: Number(r.year), month: Number(r.month), closedAt: r.createdAt }))
}

/**
 * BULKFORM: vilka av de angivna perioderna är stängda?
 *
 * För flöden som klassificerar många månader på en gång (backfillens
 * gap-detektion) och som INTE ska kasta, utan märka upp och hoppa över. Returnerar
 * en mängd med nycklar på formen `2026-03` (se `periodKeyOf`).
 *
 * `months` utelämnad → alla organisationens stängda perioder.
 */
export async function getClosedPeriods(
  client: PeriodClient,
  organizationId: string,
  months?: readonly PeriodKey[],
): Promise<Set<string>> {
  const closed = await getClosedPeriodStates(client, organizationId)
  const wanted = months && months.length > 0 ? new Set(months.map(periodKeyOf)) : null
  return new Set(closed.map(periodKeyOf).filter((k) => wanted == null || wanted.has(k)))
}

/**
 * SKRIVNINGEN: lägger en CLOSED-händelse för perioden.
 *
 * MÅSTE anropas med en transaktionsklient — händelsen och speglingen nedan ska
 * stå och falla ihop.
 *
 * `seq` allokeras som max(seq)+1 för perioden inuti transaktionen. Två samtidiga
 * stängningar läser båda samma max, försöker skriva samma seq, och det unika
 * indexet (organizationId, year, month, seq) låter exakt en vinna — den andra
 * får P2002. Det är samma serialisering som det gamla unika indexet
 * (organizationId, year, month) gav, bara flyttad till en nyckel som tål flera
 * händelser per period.
 *
 * SPEGLINGEN till `ClosedAccountingPeriod` är INTE en andra sanningskälla: ingen
 * kodväg läser den tabellen längre (CI-vakt: check-period-lookup-source.mjs).
 * Den finns enbart som rollback-fallskärm under övergången — rullas API:t
 * tillbaka till PR1a-kod läser den koden den gamla tabellen, och utan speglingen
 * hade varje period som stängts under övergångsfönstret tyst blivit öppen igen.
 * Speglingen tas bort tillsammans med tabellen i PR1d.
 *
 * ENDAST CLOSED: det finns medvetet ingen väg härifrån att skriva REOPENED.
 * Återöppning är PR1c och kräver egna grindar (roll, skäl, räkenskapsårsspärr)
 * som inte ska kunna kringgås av att någon råkar anropa en generisk hjälpare.
 */
export async function appendPeriodClosedEvent(
  tx: PeriodWriteClient,
  params: {
    organizationId: string
    year: number
    month: number
    actorUserId?: string | null
    actorLabel?: string | null
    summary: Prisma.InputJsonValue
  },
): Promise<{ seq: number }> {
  const { organizationId, year, month, summary } = params
  const actorUserId = params.actorUserId ?? null
  const actorLabel = params.actorLabel ?? null

  const last = await tx.accountingPeriodEvent.findFirst({
    where: { organizationId, year, month },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  const seq = (last?.seq ?? 0) + 1

  await tx.accountingPeriodEvent.create({
    data: {
      organizationId,
      year,
      month,
      seq,
      type: AccountingPeriodEventType.CLOSED,
      // Ingen känd aktör (AI-vägen utan användare, interna anropare) → SYSTEM.
      // Vi fabricerar aldrig en användare som inte fanns.
      actorType: resolveActorType(actorUserId ? EventActorType.USER : EventActorType.SYSTEM),
      ...(actorUserId ? { actorUserId } : {}),
      ...(actorLabel ? { actorLabel } : {}),
      summary,
    },
  })

  // Spegling — se docblocket ovan. Write-only, läses av ingen.
  //
  // UPSERT, inte create: den gamla tabellen har kvar sitt unika index
  // (organizationId, year, month) och tål därför bara EN rad per period. I PR1b
  // spelar det ingen roll — en period stängs en gång, och en andra stängning
  // stoppas av prechecken innan den når hit. Men i PR1c skriver en OMSTÄNGNING
  // efter återöppning en andra CLOSED-händelse via just den här funktionen, och
  // ett `create` hade då krockat med den kvarvarande spegelraden. Krocken sker i
  // samma transaktion som händelsen → hela den legitima omstängningen rullas
  // tillbaka, och P2002-hanteringen hos anroparen rapporterar det som "perioden
  // är redan stängd" — fel besked, och ett fel som inget test i PR1b hade övat.
  //
  // Upserten ändrar INGENTING i PR1b:s beteende: create-grenen är identisk med
  // det som skrevs förut, och update-grenen är oåtkomlig så länge ingen kan
  // stänga en period två gånger. Den finns för att PR1c inte ska ärva en dold
  // spärr i en tabell som enligt sin egen kommentar inte längre är auktoritativ.
  //
  // SERIALISERINGEN PÅVERKAS INTE: händelsen skrivs FÖRE speglingen, så två
  // samtidiga stängningar krockar redan på (organizationId, year, month, seq)
  // och den förlorande transaktionen når aldrig hit.
  await tx.closedAccountingPeriod.upsert({
    where: { organizationId_year_month: { organizationId, year, month } },
    create: {
      organizationId,
      year,
      month,
      ...(actorUserId ? { closedById: actorUserId } : {}),
      summary,
    },
    // Speglingen ska visa den GÄLLANDE stängningen — samma sak som händelsen med
    // högst seq säger. `closedById: null` är avsiktligt tillåtet: en omstängning
    // utan känd aktör ska inte ärva den förra stängningens användare.
    update: {
      closedAt: new Date(),
      closedById: actorUserId,
      summary,
    },
  })

  return { seq }
}

/**
 * SKRIVNINGEN: lägger en REOPENED-händelse för perioden (T5 PR1c).
 *
 * MÅSTE anropas med en transaktionsklient. `seq` allokeras med samma
 * max(seq)+1-formel och samma unika index som stängningen, så en samtidig
 * återöppning och omstängning kan aldrig båda vinna: den ena får P2002.
 *
 * RÖR INTE `ClosedAccountingPeriod` — varken raderar eller uppdaterar den.
 * Klienttypen saknar tabellen, så det är inte ens möjligt härifrån. Två skäl:
 *
 *  1. Det BEHÖVS inte. Speglingen skrivs som `upsert` (PR1b), så en senare
 *     omstängning fungerar oavsett om spegelraden ligger kvar (`update`-grenen)
 *     eller är borta (`create`-grenen). Ingen spegel-logik i återöppningen alls
 *     är alltså den enklaste korrekta implementationen.
 *
 *  2. Att lämna raden ger RÄTT FELRIKTNING gratis. Speglingens hela syfte är
 *     rollback-skydd: rullas API:t tillbaka till PR1a-kod läser den koden den
 *     gamla tabellen. Med raden kvar läses en återöppnad period som fortfarande
 *     STÄNGD — användaren är låst en stund till, men ingen bokföring läcker in i
 *     en period som någon medvetet stängt. Hade återöppningen raderat raden vore
 *     felriktningen den motsatta: gammal kod hade tyst släppt in bokföring.
 *
 * Följden är att speglingen blir INAKTUELL för en period som återöppnats och
 * inte stängts igen — den säger "stängd" medan sanningen säger "öppen". Det är
 * ofarligt eftersom ingen kodväg läser den, men PR1d får INTE försöka
 * konsistenskontrollera de två mot varandra före DROP: de kommer legitimt att
 * säga olika saker.
 *
 * ROLL, ORSAK OCH RÄKENSKAPSÅR grindas i `AccountingPeriodService.reopenPeriod`
 * — den här funktionen skriver bara händelsen och ska aldrig anropas utan att ha
 * passerat dem.
 *
 * TILLSTÅNDSKONTROLLEN ligger dock HÄR, inuti transaktionen, och det är
 * avsiktligt. Tjänsten kontrollerar också att perioden är stängd, men den
 * kontrollen sker UTANFÖR transaktionen och är därmed bara en snabb-nej för
 * UX:ens skull. Mellan den och skrivningen finns ett fönster:
 *
 *   A: läser "stängd" → öppnar tx → skriver REOPENED(seq n+1) → committar
 *   B: läser "stängd" (före A:s commit) → öppnar tx EFTER A → läser seq n+1
 *      → skriver REOPENED(seq n+2)
 *
 * B får ett eget, unikt seq och krockar därför INTE med unik-indexet. Utan en
 * kontroll här hade kedjan blivit `CLOSED → REOPENED → REOPENED` — två
 * återöppningar utan mellanliggande stängning, tyst, från ett dubbelklick i två
 * flikar. Ingen bokföring hamnar fel av det (perioden är öppen i båda fallen),
 * men historiken är hela poängen med den här modellen: den ska gå att läsa som
 * `stängd → öppnad → stängd` av den som granskar långt senare.
 *
 * Kontrollen kostar ingenting extra — samma `findFirst` som ger `seq` bär redan
 * `type`. Den ÄKTA samtidigheten (båda läser samma seq) fångas som förut av
 * unik-indexet och kastar P2002, som anroparen översätter till ett begripligt
 * besked.
 */
export async function appendPeriodReopenedEvent(
  tx: PeriodReopenClient,
  params: {
    organizationId: string
    year: number
    month: number
    reason: string
    reasonCategory: AccountingPeriodEventReasonCategory
    actorUserId?: string | null
    actorLabel?: string | null
  },
): Promise<{ seq: number }> {
  const { organizationId, year, month, reason, reasonCategory } = params
  const actorUserId = params.actorUserId ?? null
  const actorLabel = params.actorLabel ?? null

  const last = await tx.accountingPeriodEvent.findFirst({
    where: { organizationId, year, month },
    orderBy: { seq: 'desc' },
    select: { seq: true, type: true },
  })

  // ATOMÄR TILLSTÅNDSKONTROLL — samma läsning som ger `seq` avgör också om
  // perioden faktiskt är stängd, i SAMMA transaktion som skrivningen. Se
  // docblocket ovan för fönstret detta stänger.
  if (last?.type !== AccountingPeriodEventType.CLOSED) {
    throw new ConflictException(
      `Perioden ${periodKeyOf({ year, month })} är inte stängd och kan därför inte öppnas igen.`,
    )
  }

  const seq = last.seq + 1

  await tx.accountingPeriodEvent.create({
    data: {
      organizationId,
      year,
      month,
      seq,
      type: AccountingPeriodEventType.REOPENED,
      actorType: resolveActorType(actorUserId ? EventActorType.USER : EventActorType.SYSTEM),
      ...(actorUserId ? { actorUserId } : {}),
      ...(actorLabel ? { actorLabel } : {}),
      reason,
      reasonCategory,
      // Ingen summary: en återöppning har ingen ögonblicksbild att ta. Tvingas
      // också av CHECK i DB.
    },
  })

  return { seq }
}

/**
 * Hur många gånger varje period har återöppnats, nyckelad `2026-03`.
 *
 * För översikten: en period som varit öppnad ska synas som det i listan, annars
 * måste man klicka in på varje period för att upptäcka att den har en historia.
 * Egen fråga i stället för att bakas in i `getClosedPeriodStates` — den senare
 * svarar på "vad gäller NU", den här på "vad har hänt".
 */
export async function getReopenCounts(
  client: PeriodClient,
  organizationId: string,
): Promise<Map<string, number>> {
  const rows = await client.accountingPeriodEvent.groupBy({
    by: ['year', 'month'],
    where: { organizationId, type: AccountingPeriodEventType.REOPENED },
    _count: { _all: true },
  })
  return new Map(rows.map((r) => [periodKeyOf(r), r._count._all]))
}

/** En händelse i periodens historik, i den ordning `seq` ger. */
export interface PeriodHistoryEvent {
  seq: number
  type: AccountingPeriodEventType
  createdAt: Date
  actorLabel: string | null
  reason: string | null
  reasonCategory: AccountingPeriodEventReasonCategory | null
  summary: Prisma.JsonValue | null
}

/**
 * Hela kedjan för EN period, äldst först — `[stängd → öppnad → stängd]`.
 *
 * Läsning för historikvyn. `seq` följer med ut som ordningsnyckel men är intern:
 * UI:t visar aldrig siffran, bara ordningen den ger.
 */
export async function getPeriodHistory(
  client: PeriodClient,
  organizationId: string,
  year: number,
  month: number,
): Promise<PeriodHistoryEvent[]> {
  return client.accountingPeriodEvent.findMany({
    where: { organizationId, year, month },
    orderBy: { seq: 'asc' },
    select: {
      seq: true,
      type: true,
      createdAt: true,
      actorLabel: true,
      reason: true,
      reasonCategory: true,
      summary: true,
    },
  })
}
