/**
 * KUNDSTART-001 §12.6 (T1-4–T1-6): Fortnox-saldo för 1510 och 2890 per brytdatum ur en
 * faktisk återläsning — aldrig manuellt inmatat.
 *
 * Saldo per brytdatum = Fortnox `BalanceBroughtForward` (årets IB) + Σ verifikatrader
 * från årets början till och med DAGEN FÖRE brytdatum. Läsningen måste:
 *  - vara COMPLETE (inte med osäkerhet, inte partiell);
 *  - gälla organisationens aktuella anslutning och Fortnox-databas, och vara startad
 *    efter anslutningens senaste koppling;
 *  - omfatta 1510 och 2890, med periodFrom = årets början enligt Fortnox och
 *    periodTo = dagen före brytdatum;
 *  - bära IB för båda kontona (saknad IB är inte 0);
 *  - vara den SENASTE läsningen av kontona — en nyare läsning gör den inaktuell.
 * 2890 redovisas som positiv skuld (= −Fortnox-saldo; Fortnox tecken är debet +).
 */
import type { FortnoxConnection, FortnoxReadRun, Prisma } from '@prisma/client'
import { brytdatumIso } from './cutover'

export interface FortnoxSaldoPerBrytdatum {
  readRunId: string
  completedAt: string
  saldo1510Ore: number
  saldo2890Ore: number
  detalj: {
    konto: '1510' | '2890'
    ingaendeOre: number
    rorelseOre: number
    rader: number
  }[]
}

const dag = (d: Date) => d.toISOString().slice(0, 10)

export function dagenForeBrytdatum(cutover: Date): string {
  return dag(new Date(cutover.getTime() - 24 * 3600 * 1000))
}

export function saldoUrLasning(
  run: Pick<
    FortnoxReadRun,
    | 'id'
    | 'organizationId'
    | 'connectionId'
    | 'fortnoxDatabaseNumber'
    | 'status'
    | 'financialYearStart'
    | 'periodFrom'
    | 'periodTo'
    | 'costAccounts'
    | 'startedAt'
    | 'completedAt'
    | 'summary'
    | 'rows'
  >,
  conn: Pick<FortnoxConnection, 'id' | 'fortnoxDatabaseNumber' | 'connectedAt' | 'status'> | null,
  cutover: Date,
): { ok: true; saldo: FortnoxSaldoPerBrytdatum } | { ok: false; skal: string } {
  const fel = (skal: string) => ({ ok: false as const, skal })
  if (!conn || conn.status !== 'ACTIVE') return fel('Ingen aktiv Fortnox-anslutning.')
  if (run.status !== 'COMPLETE')
    return fel(
      `Läsningen är ${run.status}, inte COMPLETE — en ofullständig eller osäker läsning kan inte stämma av öppningen.`,
    )
  if (run.connectionId !== conn.id || run.fortnoxDatabaseNumber !== conn.fortnoxDatabaseNumber)
    return fel('Läsningen gäller inte den aktuella Fortnox-anslutningen och databasen.')
  if (run.startedAt < conn.connectedAt)
    return fel('Läsningen gjordes före anslutningens senaste koppling — läs om.')
  if (!run.completedAt) return fel('Läsningen saknar slutförandetid.')
  if (!run.financialYearStart || dag(run.periodFrom) !== dag(run.financialYearStart))
    return fel('Läsningen måste börja på räkenskapsårets första dag enligt Fortnox.')
  const sista = dagenForeBrytdatum(cutover)
  if (dag(run.periodTo) !== sista)
    return fel(
      `Läsningen måste sluta dagen före brytdatum (${sista}); den slutar ${dag(run.periodTo)}.`,
    )
  if (!run.costAccounts.includes(1510) || !run.costAccounts.includes(2890))
    return fel('Läsningen måste omfatta konto 1510 och 2890.')
  const summary = run.summary as { balanceBroughtForwardOre?: Record<string, number | null> } | null
  const ib = summary?.balanceBroughtForwardOre
  if (!ib || typeof ib['1510'] !== 'number' || typeof ib['2890'] !== 'number')
    return fel(
      'Läsningen saknar Fortnox ingående balans (BalanceBroughtForward) för 1510 eller 2890 — saknad IB tolkas aldrig som 0.',
    )
  // Läsningen lagrar { rows, references } (fortnox-readback.service.ts).
  const lagrat = run.rows as { rows?: unknown } | null
  const rows = Array.isArray(lagrat?.rows)
    ? (lagrat.rows as Array<{ account: number; amountOre: number; bucket: string }>)
    : null
  if (!rows) return fel('Läsningen saknar rader.')
  const detalj = (['1510', '2890'] as const).map((konto) => {
    const r = rows.filter((x) => x.account === Number(konto) && x.bucket !== 'UNCERTAIN_REMOVED')
    return {
      konto,
      ingaendeOre: ib[konto] as number,
      rorelseOre: r.reduce((s, x) => s + x.amountOre, 0),
      rader: r.length,
    }
  })
  const d1510 = detalj[0]!
  const d2890 = detalj[1]!
  return {
    ok: true,
    saldo: {
      readRunId: run.id,
      completedAt: run.completedAt.toISOString(),
      saldo1510Ore: d1510.ingaendeOre + d1510.rorelseOre,
      saldo2890Ore: -(d2890.ingaendeOre + d2890.rorelseOre),
      detalj,
    },
  }
}

/** Senaste läsningen som omfattar både 1510 och 2890 (oavsett status). */
export async function senasteSaldolasning(db: Prisma.TransactionClient, organizationId: string) {
  return db.fortnoxReadRun.findFirst({
    where: { organizationId, costAccounts: { hasEvery: [1510, 2890] } },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  })
}

export function brytdatumText(cutover: Date): string {
  return `per brytdatum ${brytdatumIso(cutover)} (t.o.m. ${dagenForeBrytdatum(cutover)})`
}
