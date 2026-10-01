/**
 * Fortnox-underlag till AI — deterministiskt, färdigräknat, SKUGGLÄGE.
 *
 * Följer AI-kontraktet (INKOMMET/AI/KONTRAKT-OCH-KARTA.md):
 *  - Separat namngiven Fortnox-observation; ändrar inte Evenos siffror och läggs
 *    aldrig ihop med dem (auktoritet förblir EVENO_LOCAL).
 *  - Summor kommer färdiga från servern ur hela mängden — inga listor att summera.
 *  - "Återläst per <tid>", aldrig "aktuellt" (ingen beslutad aktualitetspolicy).
 *  - Ofullständig/saknad läsning → inga belopp alls, uttryckligen inte 0.
 *  - Ingen anslutning alls → inget block (dagens kontext oförändrad för alla
 *    organisationer utan Fortnox).
 *  - Fritext från Fortnox (beskrivningar) skickas inte med.
 */

export interface FortnoxAiSnapshot {
  connection: {
    status: 'ACTIVE' | 'AUTH_LOST' | 'DISCONNECTED'
    fortnoxDatabaseNumber: number
    fortnoxCompanyName: string | null
  } | null
  latestRead: AiReadRow | null
  latestCompleteRead: AiReadRow | null
}

export interface AiReadRow {
  id: string
  status: string
  financialYearId: number
  financialYearStart: Date | null
  financialYearEnd: Date | null
  periodFrom: Date
  periodTo: Date
  startedAt: Date
  completedAt: Date | null
  reason: string | null
  costAccounts: number[]
  uncertainties: unknown
  summary: unknown
}

interface Summary {
  totalOre: number
  byProperty: Array<{ propertyName: string; amountOre: number }>
  unmappedDimensions: Array<{ dimensionType: string; code: string; amountOre: number }>
  unallocatedOre: number
  uncertainRemovedOre: number
  evenoExportOre: number
}

/** Öre → "1 234,56 kr" exakt (heltalsaritmetik, ingen flyttalsdivision). */
export function formatOre(ore: number): string {
  const neg = ore < 0
  const abs = Math.abs(ore)
  const kr = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const cents = String(abs % 100).padStart(2, '0')
  return `${neg ? '−' : ''}${kr},${cents} kr`
}

const day = (d: Date) => d.toISOString().slice(0, 10)

function stockholm(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d)
}

const CONNECTION_TEXT = {
  ACTIVE: 'aktiv',
  AUTH_LOST: 'inloggningen har upphört – nya läsningar kräver att kunden ansluter igen',
  DISCONNECTED: 'frånkopplad – inga nya läsningar',
} as const

export function formatFortnoxShadowForAi(s: FortnoxAiSnapshot, now: Date = new Date()): string[] {
  if (!s.connection) return []
  const c = s.connection
  const lines = [
    '',
    '## FORTNOX-ÅTERLÄSNING (skuggläge – separat källa)',
    'Detta är en observation ur Fortnox huvudbok. Den ändrar INTE Evenos egna siffror ovan och får aldrig läggas ihop med dem.',
    `Källa: Fortnox, företag ${c.fortnoxCompanyName ?? 'namn okänt'} (databasnummer ${c.fortnoxDatabaseNumber}). Anslutning: ${CONNECTION_TEXT[c.status]}.`,
  ]

  const done = s.latestCompleteRead
  if (!done || !done.completedAt || !isSummary(done.summary)) {
    lines.push(
      'Ingen komplett återläsning finns. Säg att Fortnox-underlag saknas. Ange INGA Fortnox-belopp – inte heller 0.',
    )
  } else {
    const sum = done.summary
    const ageMin = Math.max(0, Math.round((now.getTime() - done.completedAt.getTime()) / 60000))
    const year =
      done.financialYearStart && done.financialYearEnd
        ? `${day(done.financialYearStart)}–${day(done.financialYearEnd)} enligt Fortnox`
        : 'gränser ej verifierade'
    lines.push(
      `Senast kompletta återläsning: period ${day(done.periodFrom)}–${day(done.periodTo)} (räkenskapsår ${year}), återläst per ${stockholm(done.completedAt)} (${ageMin} min sedan). Säg "återläst per …", inte "aktuellt".`,
      `Mått: Nettobelopp för valda konton (debet − kredit på bokförda verifikatrader) – konto ${done.costAccounts.join(', ')}. Det är INTE hela bolagets resultat, inte fakturatotaler, moms eller betalningar.`,
      `Summa: ${formatOre(sum.totalOre)}`,
    )
    for (const p of sum.byProperty)
      lines.push(`  Fastighet ${p.propertyName}: ${formatOre(p.amountOre)}`)
    lines.push(`  Ofördelat (rader utan dimension): ${formatOre(sum.unallocatedOre)}`)
    for (const u of sum.unmappedDimensions) {
      lines.push(
        `  Okopplad ${u.dimensionType === 'PROJECT' ? 'projektkod' : 'kostnadsställe'} ${u.code}: ${formatOre(u.amountOre)} (tillhör ingen känd fastighet)`,
      )
    }
    lines.push(
      'Ofördelade och okopplade belopp får INTE läggas på någon fastighet. En fastighet som saknas i listan har inga fördelade rader – säg inte att dess kostnad är 0 om det finns ofördelat belopp.',
    )
    if (sum.uncertainRemovedOre) {
      lines.push(
        `Ej medräknat (rader markerade som borttagna, oklar innebörd): ${formatOre(sum.uncertainRemovedOre)}`,
      )
    }
    if (sum.evenoExportOre) {
      lines.push(
        `Varav verifikat som Eveno själv exporterat: ${formatOre(sum.evenoExportOre)} – redan en del av Evenos bokföring; lägg aldrig ihop.`,
      )
    }
    const unc = Array.isArray(done.uncertainties)
      ? (done.uncertainties as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    if (unc.length) {
      lines.push('Kända begränsningar:')
      for (const u of unc.slice(0, 5)) lines.push(`  - ${u}`)
      if (unc.length > 5) lines.push(`  - … och ${unc.length - 5} till`)
    }
  }

  const last = s.latestRead
  if (last && (!done || last.id !== done.id) && last.status !== 'RUNNING') {
    lines.push(
      `Senaste läsförsök (${stockholm(last.completedAt ?? last.startedAt)}) blev ofullständigt: ${last.reason ?? last.status}. ${done ? 'Beloppen ovan kommer från den tidigare kompletta läsningen.' : ''}`.trim(),
    )
  }
  return lines
}

function isSummary(x: unknown): x is Summary {
  if (!x || typeof x !== 'object') return false
  const s = x as Record<string, unknown>
  return (
    Number.isSafeInteger(s.totalOre) &&
    Number.isSafeInteger(s.unallocatedOre) &&
    Array.isArray(s.byProperty) &&
    Array.isArray(s.unmappedDimensions)
  )
}
