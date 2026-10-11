/**
 * KUNDSTART-001 §3, §10 A6, §12.9 (BYGGLEDARE-003 p3): öppningskomponenten — EN formel
 * för balansrapporten, AI-verktygen och data-kontexten.
 *
 * Öppningen bokförs inte i Eveno (ingen JournalEntry). Evenos lokala 1510/2890 kan därför
 * gå negativa när en historisk fordran betalas eller en historisk deposition återbetalas;
 * det förklaras av komponenten, som alltid redovisas som EGEN märkt rad:
 *
 *   saldo per datum D, D ≥ brytdatum:  lokal inkl. öppning = verifikat t.o.m. D + komponent
 *     1510: komponent = Σ openAmount för FORDRAN-rader i verkställda paket
 *     2890: komponent = Σ openAmount för DEPOSITION-rader i verkställda paket (kreditsaldo)
 *   saldo per datum D, D < brytdatum:  komponent 0 — historiken finns bara i Fortnox.
 *   periodrörelser (resultat, kontorörelse för en period): komponenten ingår ALDRIG.
 *
 * Detta är en BEGRÄNSAD 1510/2890-avstämning, inte en full balansräkning med alla
 * Fortnox-konton. Utkast och ej verkställda paket ingår aldrig.
 */
import type { Prisma } from '@prisma/client'
import { brytdatumIso } from './cutover'
import { kronorTillOre } from './opening-csv'

export const BEGRANSNING =
  'Begränsad 1510/2890-avstämning för öppningen — inte en full balansräkning med alla Fortnox-konton.'

export interface Oppningskomponent {
  brytdatum: string
  galler: boolean
  /** Naturligt tecken: 1510 debetsaldo +, 2890 kreditsaldo +. I KRONOR (två decimaler). */
  konton: { '1510': number; '2890': number }
  paket: {
    id: string
    sourceSha256: string
    executedAt: string | null
    avstamning: string | null
    nollOppning: boolean
  }[]
  text: string
  begransning: string
  avstamningstexter: string[]
}

const kr = (ore: number) => Math.round(ore) / 100

export async function oppningskomponent(
  db: Prisma.TransactionClient,
  organizationId: string,
  asOf: string | Date,
): Promise<Oppningskomponent | null> {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { billingCutoverDate: true },
  })
  const paket = await db.openingPackage.findMany({
    where: { organizationId, status: 'EXECUTED' },
    orderBy: { executedAt: 'asc' },
    select: {
      id: true,
      sourceSha256: true,
      executedAt: true,
      reconciliationStatus: true,
      reconciliation: true,
      zeroOpening: true,
      cutoverDate: true,
      rows: { select: { kind: true, openAmount: true } },
    },
  })
  if (!org?.billingCutoverDate || paket.length === 0) return null
  const brytdatum = brytdatumIso(org.billingCutoverDate)
  const datum = typeof asOf === 'string' ? asOf.slice(0, 10) : asOf.toISOString().slice(0, 10)
  const galler = datum >= brytdatum
  let f = 0
  let d = 0
  for (const p of paket)
    for (const r of p.rows) {
      const ore = kronorTillOre(r.openAmount.toFixed(2)) ?? 0
      if (r.kind === 'RECEIVABLE') f += ore
      else d += ore
    }
  const senaste = paket[paket.length - 1]!
  const texter = (
    (senaste.reconciliation as { konton?: { text: string }[] } | null)?.konton ?? []
  ).map((k) => k.text)
  const ids = paket
    .map((p) => `${p.id.slice(0, 8)} (sha ${p.sourceSha256.slice(0, 12)}…)`)
    .join(', ')
  return {
    brytdatum,
    galler,
    konton: { '1510': galler ? kr(f) : 0, '2890': galler ? kr(d) : 0 },
    paket: paket.map((p) => ({
      id: p.id,
      sourceSha256: p.sourceSha256,
      executedAt: p.executedAt?.toISOString() ?? null,
      avstamning: p.reconciliationStatus,
      nollOppning: p.zeroOpening,
    })),
    text: galler
      ? `Öppningskomponent (externt bokförd i Fortnox före brytdatum ${brytdatum}, paket ${ids}). ` +
        'Ingår inte i Evenos verifikatsummor och exporteras aldrig.'
      : `Datumet ${datum} ligger före brytdatum ${brytdatum}: historiken finns bara i Fortnox, ` +
        'och öppningskomponenten ingår inte.',
    begransning: BEGRANSNING,
    avstamningstexter: texter,
  }
}

/** Historisk skuld (OPENING-avier, öppen rest) — egen post, aldrig i Evenos förfallna skuld. */
export async function historiskSkuld(db: Prisma.TransactionClient, organizationId: string) {
  const avier = await db.rentNotice.findMany({
    where: { organizationId, origin: 'OPENING_PACKAGE', status: 'OPENING' },
    select: { totalAmount: true, payments: { select: { amount: true } } },
  })
  let ore = 0
  for (const a of avier) {
    const total = kronorTillOre(a.totalAmount.toFixed(2)) ?? 0
    const betalt = a.payments.reduce((s, p) => s + (kronorTillOre(p.amount.toFixed(2)) ?? 0), 0)
    ore += Math.max(0, total - betalt)
  }
  return { antal: avier.length, belopp: kr(ore) }
}
