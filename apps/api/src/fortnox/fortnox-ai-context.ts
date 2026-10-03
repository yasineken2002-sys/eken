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
  exports:
    | (Record<'DRY_RUN_READY' | 'BLOCKED' | 'UNKNOWN' | 'CONFIRMED', number> &
        Partial<Record<'SENDING' | 'REJECTED' | 'RECEIPT_IDENTIFIED' | 'RECEIPT_MISMATCH', number>>)
    | null
  /** Faktiskt läge för sändning till DETTA företag (skrivare + företagslista). Saknas = av. */
  sendingEnabled?: boolean
  /** KUNDSTART: sändningen vilar på en godkänd kundaktivering (inte testföretaget). */
  customerActivation?: boolean
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
  /** Företaget läsningen faktiskt gällde (sparat vid läsningen). */
  fortnoxDatabaseNumber: number
  coverage: unknown
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

/** Klocktid i svensk tid med uttrycklig zonmärkning (FINAL-003). */
function stockholm(d: Date): string {
  const tid = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d)
  return `${tid} svensk tid`
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
    if (done.fortnoxDatabaseNumber !== c.fortnoxDatabaseNumber) {
      lines.push(
        `OBS: den kompletta läsningen gäller Fortnox-företag med databasnummer ${done.fortnoxDatabaseNumber}, inte den nuvarande anslutningen. Använd den inte som underlag för nuvarande företag.`,
      )
    }
    lines.push(
      `Läs-id ${done.id}. ${coverageText(done.coverage)}`,
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
    if (done.costAccounts.includes(1510) || done.costAccounts.includes(2890)) {
      // KUNDSTART §3: öppningen före brytdatum är bokförd i Fortnox (IB/verifikat) och
      // finns som EGEN öppningskomponent i Eveno — samma belopp ur två källor.
      lines.push(
        'Konto 1510/2890 i Fortnox omfattar öppningen före brytdatum. Evenos öppningskomponent är samma belopp ur en annan källa – lägg aldrig ihop dem.',
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
  if (last && (!done || last.id !== done.id)) {
    lines.push(
      last.status === 'RUNNING'
        ? `En läsning (id ${last.id}) pågår sedan ${stockholm(last.startedAt)}; dess resultat är inte känt än.`
        : `Senaste läsförsök (id ${last.id}, ${stockholm(last.completedAt ?? last.startedAt)}) blev ofullständigt: ${last.reason ?? last.status}. ${done ? 'Beloppen ovan kommer från den tidigare kompletta läsningen.' : ''}`.trim(),
    )
  }
  const ex = s.exports
  // Låsta lägen som kräver människa (okänt, avvisat, avvikande kvitto) och skickade
  // men ännu inte verifierade — inget av dem får läsas som "inte skickat".
  const needs = ex ? ex.UNKNOWN + (ex.REJECTED ?? 0) + (ex.RECEIPT_MISMATCH ?? 0) : 0
  const pending = ex ? (ex.SENDING ?? 0) + (ex.RECEIPT_IDENTIFIED ?? 0) : 0
  if (ex && (needs || pending || ex.BLOCKED || ex.DRY_RUN_READY || ex.CONFIRMED)) {
    const head =
      s.sendingEnabled === true && s.customerActivation === true
        ? 'Exportkö till Fortnox (sändning är aktiverad för detta kundföretag genom ett godkänt kundbeslut av ägaren; varje verifikat skickas först efter uttrycklig bekräftelse, och beslutet upphör vid ändrad anslutning, serie eller mappning)'
        : s.sendingEnabled === true
          ? 'Exportkö till Fortnox (sändning är aktiverad endast för detta testföretag; varje verifikat skickas först efter uttrycklig bekräftelse)'
          : 'Exportkö till Fortnox (endast förhandskontroll; sändning är avstängd i väntan på leverantörsbesked om dubblettskydd)'
    lines.push(
      `${head}: ${ex.DRY_RUN_READY} klara utkast, ${ex.BLOCKED} spärrade, ${ex.CONFIRMED} bekräftade` +
        (pending ? `, ${pending} skickade men ännu inte verifierade` : '') +
        (needs ? `, ${needs} med okänt eller avvisat utfall som kräver manuell avstämning.` : '.'),
    )
  }
  return lines
}

/** Täckning per resurs ur läsningens sparade coverage; okända tal uppfinns inte. */
function coverageText(coverage: unknown): string {
  if (!coverage || typeof coverage !== 'object') return 'Täckning: okänd.'
  const parts: string[] = []
  for (const [path, v] of Object.entries(coverage as Record<string, unknown>)) {
    const c = (v ?? {}) as Record<string, unknown>
    const num = (x: unknown) => (Number.isSafeInteger(x) ? String(x) : '?')
    parts.push(
      `${path}: sidor ${num(c.pages)}/${num(c.totalPages)}, poster ${num(c.itemsSeen)}/${num(c.totalResources)}`,
    )
  }
  return parts.length ? `Täckning: ${parts.join('; ')}.` : 'Täckning: okänd.'
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
