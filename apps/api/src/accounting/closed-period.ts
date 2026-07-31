import { ConflictException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { stockholmCivilDate } from '../common/time/stockholm-period'

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
 */

/** En period identifierad som kalenderår + kalendermånad (1–12). */
export interface PeriodKey {
  year: number
  month: number
}

/** Minsta Prisma-yta hjälparna behöver — funkar med både PrismaService och tx. */
type PeriodClient = Pick<Prisma.TransactionClient, 'closedAccountingPeriod'>

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
 */
export async function isPeriodClosed(
  client: PeriodClient,
  organizationId: string,
  date: Date,
): Promise<boolean> {
  const { year, month } = periodOfDate(date)
  const closed = await client.closedAccountingPeriod.findUnique({
    where: { organizationId_year_month: { organizationId, year, month } },
    select: { id: true },
  })
  return closed !== null
}

/**
 * PUNKTKONTROLL: kastar ConflictException om datumets period är stängd.
 *
 * Anropas dels av `allocate` (den verkställande punkten, i samma tx som posten),
 * dels av flöden som vill ge ett begripligt besked INNAN de börjat skriva.
 *
 * Meddelandet är medvetet handlingsanvisande: rätt redovisningsåtgärd vid en
 * stängd period är att bokföra i innevarande period, inte att öppna det stängda
 * året. Den som ändå måste öppna gör det som en egen, spårad handling.
 */
export async function assertPeriodOpen(
  client: PeriodClient,
  organizationId: string,
  date: Date,
  context?: string,
): Promise<void> {
  if (await isPeriodClosed(client, organizationId, date)) {
    const label = periodKeyOf(periodOfDate(date))
    throw new ConflictException(
      `Bokföringsperioden ${label} är stängd${context ? ` — ${context}` : ''}. ` +
        'Bokför i innevarande period i stället, eller be en behörig användare ' +
        'öppna perioden igen (loggas).',
    )
  }
}

/**
 * BULKFORM: vilka av de angivna perioderna är stängda?
 *
 * För flöden som klassificerar många månader på en gång (backfillens
 * gap-detektion) och som INTE ska kasta, utan märka upp och hoppa över. Returnerar
 * en mängd med nycklar på formen `2026-03` (se `periodKeyOf`).
 *
 * `months` utelämnad → alla organisationens stängda perioder (billigare än N
 * uppslag när anroparen ändå itererar ett långt spann).
 */
export async function getClosedPeriods(
  client: PeriodClient,
  organizationId: string,
  months?: readonly PeriodKey[],
): Promise<Set<string>> {
  const rows = await client.closedAccountingPeriod.findMany({
    where: {
      organizationId,
      ...(months && months.length > 0
        ? { OR: months.map((m) => ({ year: m.year, month: m.month })) }
        : {}),
    },
    select: { year: true, month: true },
  })
  return new Set(rows.map((r) => periodKeyOf(r)))
}
