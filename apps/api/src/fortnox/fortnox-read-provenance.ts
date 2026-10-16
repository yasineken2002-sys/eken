export type Egen = {
  journalEntryId: string
  revision: number | null
  perMal: Map<number, number[]>
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
