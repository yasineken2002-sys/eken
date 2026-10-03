/**
 * KUNDSTART-009 (BYGGLEDARE-009, C2 REVIEW-7743349A §3): första Eveno-perioden.
 *
 * Version 1 kan inte representera en period från brytdatum som redan är fakturerad eller
 * betald i tidigare system (förskott, framtida perioder). Eveno skulle då fakturera den igen.
 * Därför BLOCKERAS kundstarten (paketets godkännande och kundaktiveringen) om:
 *  - det kontrollerade, periodbundna registret ur tidigare system saknas (täckning saknas), eller
 *  - registret har minst en post (fakturerad eller betald) för en period från brytdatum.
 * Registret är underlaget, inte en kryssruta: det har filhash, system, ansvarig och täckning
 * (från brytdatum t.o.m. minst brytdatumets månads sista dag) och binds till paketet.
 *
 * Fortnox-läsningen från brytdatum (1510, intäkts- och förskottskonton) är en KOMPLETTERANDE
 * riskkontroll. Frånvaro av träffar bevisar ingenting (en framtida period kan vara fakturerad
 * och slutbetald före brytdatum, och underlag kan vara obokade) — den kan bara blockera.
 */
import type { Prisma } from '@prisma/client'
import { brytAr, brytdatumIso } from './cutover'
import type { RegisterPost } from './opening-csv'

export interface ForstaPeriodRegister {
  sha256: string
  filnamn: string
  system: string
  ansvarig: string
  tackningFran: string
  tackningTill: string
  intaktskonton: number[]
  forskottskonton: number[]
  antal: number
  poster: RegisterPost[]
  registreradAv: string
  registreradTid: string
}

export function registerHinder(reg: unknown, cutover: Date): string | null {
  const r = reg as ForstaPeriodRegister | null
  const b = brytdatumIso(cutover)
  if (!r || typeof r !== 'object' || typeof r.sha256 !== 'string')
    return (
      `Underlag för första perioden saknas: ladda upp tidigare systemets periodbundna ` +
      `fakturerings- och betalningsregister för perioder från brytdatum ${b} (även fullt ` +
      'betalda poster). Utan täckning är kundstarten blockerad.'
    )
  if (r.antal > 0)
    return (
      `Tidigare system har ${r.antal} fakturerade eller betalda poster för perioder från ` +
      `brytdatum ${b} (register ${r.filnamn}, sha ${r.sha256.slice(0, 12)}…). Version 1 kan inte ` +
      'representera förskott eller redan debiterade framtida perioder — kundstarten är ' +
      'blockerad (kundgräns). Välj ett senare brytdatum eller hantera perioderna i tidigare system.'
    )
  return null
}

/** Täckningen ska börja på brytdatum och räcka minst t.o.m. brytdatumets månads sista dag. */
export function tackningOk(fran: string, till: string, cutover: Date): string | null {
  const b = brytAr(cutover)
  const sista = new Date(Date.UTC(b.year, b.month, 0)).toISOString().slice(0, 10)
  if (fran !== brytdatumIso(cutover))
    return `Täckningen ska börja på brytdatum ${brytdatumIso(cutover)}.`
  if (!/^\d{4}-\d{2}-\d{2}$/.test(till) || till < sista)
    return `Täckningen ska räcka minst till ${sista} (brytdatumets månads sista dag).`
  return null
}

/**
 * Kompletterande riskkontroll ur Fortnox-läsning (kan bara blockera). Kräver en COMPLETE
 * läsning från räkenskapsårets början över brytdatum som omfattar 1510 och registrets
 * intäkts- och förskottskonton.
 */
export async function fortnoxRiskkontroll(
  db: Prisma.TransactionClient,
  organizationId: string,
  connectionId: string,
  cutover: Date,
  reg: ForstaPeriodRegister,
): Promise<string | null> {
  const b = brytdatumIso(cutover)
  const konton = [...new Set([1510, ...reg.intaktskonton, ...reg.forskottskonton])]
  const run = await db.fortnoxReadRun.findFirst({
    where: {
      organizationId,
      connectionId,
      status: 'COMPLETE',
      periodTo: { gte: cutover },
      periodFrom: { lte: cutover },
      costAccounts: { hasEvery: konton },
    },
    orderBy: { startedAt: 'desc' },
  })
  if (!run)
    return (
      `Riskkontroll saknas: gör en komplett Fortnox-läsning som omfattar brytdatum ${b} och ` +
      `kontona ${konton.join(', ')}.`
    )
  const rader =
    (
      run.rows as {
        rows?: Array<{
          account: number
          amountOre: number
          transactionDate: string
          evenoExport: boolean
          bucket: string
        }>
      } | null
    )?.rows ?? []
  const efter = rader.filter(
    (x) =>
      konton.includes(x.account) &&
      x.transactionDate >= b &&
      !x.evenoExport &&
      x.bucket !== 'UNCERTAIN_REMOVED',
  )
  if (efter.length > 0)
    return (
      `Fortnox har ${efter.length} verifikatrader från tidigare system på eller efter brytdatum ${b} ` +
      `på konto ${[...new Set(efter.map((x) => x.account))].join(', ')} — första perioden kan redan ` +
      'vara fakturerad eller betald. Kundstarten är blockerad.'
    )
  const ib =
    (run.summary as { balanceBroughtForwardOre?: Record<string, number | null> } | null)
      ?.balanceBroughtForwardOre ?? {}
  for (const k of reg.forskottskonton) {
    const ingaende = ib[String(k)]
    if (typeof ingaende !== 'number')
      return `Förskottskonto ${k} saknar ingående balans i läsningen — saldot kan inte prövas.`
    const saldo =
      ingaende +
      rader
        .filter((x) => x.account === k && x.bucket !== 'UNCERTAIN_REMOVED')
        .reduce((s, x) => s + x.amountOre, 0)
    if (saldo !== 0)
      return `Förskottskonto ${k} har saldo ${saldo / 100} kr i Fortnox — förskott för första perioden kan finnas. Kundstarten är blockerad.`
  }
  return null
}
