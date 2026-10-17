import type { LedgerReadResult } from './fortnox-ledger'

export type Egen = {
  journalEntryId: string
  revision: number | null
  perMal: Map<number, number[]>
}

/** Egna exporters frysta källkonton berikar rader utan att påverka summeringen. */
export function enrichEvenoLedgerResult(
  result: LedgerReadResult,
  ownExports: ReadonlyMap<string, Egen>,
): LedgerReadResult {
  if (!result.rows) return result
  return {
    ...result,
    rows: result.rows.map((r) => {
      const e = r.evenoExport ? ownExports.get(r.voucher) : undefined
      if (!e) return r
      const kallor = e.perMal.get(r.account) ?? []
      return {
        ...r,
        evenoSource: {
          journalEntryId: e.journalEntryId,
          // Entydigt bara om exakt ett Eveno-konto mappades till detta Fortnox-konto.
          sourceAccount: kallor.length === 1 ? kallor[0]! : null,
          mappingRevision: e.revision,
        },
      }
    }),
  }
}

/** Källkonto per målkonto ur exportens frysta utkast (TESTKUND-008 K5.3; äldre utkast 1:1). */
export function kallkonton(draft: unknown): Omit<Egen, 'journalEntryId'> {
  const d = (draft ?? {}) as {
    provenance?: {
      lines?: Array<{ localAccountNumber?: unknown; externalAccountNumber?: unknown }>
    }
    kontomappning?: { revision?: unknown }
  }
  const perMal = new Map<number, number[]>()
  for (const l of d.provenance?.lines ?? []) {
    if (
      !Number.isSafeInteger(l.localAccountNumber) ||
      !Number.isSafeInteger(l.externalAccountNumber)
    )
      continue
    const lista = perMal.get(l.externalAccountNumber as number) ?? []
    if (!lista.includes(l.localAccountNumber as number)) lista.push(l.localAccountNumber as number)
    perMal.set(l.externalAccountNumber as number, lista)
  }
  const rev = d.kontomappning?.revision
  return { perMal, revision: Number.isSafeInteger(rev) ? (rev as number) : null }
}
