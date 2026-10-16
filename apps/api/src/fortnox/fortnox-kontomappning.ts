/**
 * TESTKUND-20261004/008 — KONTOMAPPNING för Fortnox-export: ren logik (KONTRAKT-008 §1–§3).
 *
 * En mappningsrad gäller exakt (roll, källkonto, behandling) → målkonto. Rollen och behandlingen
 * härleds ur verifikatets källa (fortnox-radklass.ts), aldrig ur kundens val. Servern bedömer
 * målkontots momskod TEKNISKT; bara FORENLIG kan godkännas. Det tekniska utfallet godkänner
 * aldrig kontots innebörd — det gör kundens uttryckliga godkännande av revisionen (K3.4).
 *
 * TEKNISK TABELL (fryst, inte kundkonfigurerbar):
 *
 *   HYRESINTAKT / MOMSFRI   MF → FORENLIG. [POLICY 006-A / B-2] Skatteverket "Fylla i
 *                           momsdeklarationen", fält 42: momsfri uthyrning av fastigheter. MF bevisar
 *                           INTE innebörd (KRITERIER-006-A A-2: MF bärs även av 3920/3990).
 *                           Null/tom/saknad kod → EJ_BELAGD (aldrig automatiskt OK, B-1 öppen).
 *                           Varje annan kod (HFS = fält 08 frivillig beskattning, MP1–MP3, U*, I,
 *                           okänd) → KONFLIKT.
 *   balans- och kostnads-   Utan momskod (null/'') → FORENLIG i betydelsen "ingen motsägelse"
 *   roller / EJ_TILLAMPLIG  (K3.3; R0-REAL-001: 1510, 1930, 2440, 2890, 5170 saknar momskod).
 *                           Fältet saknas i svaret → EJ_BELAGD. Varje momskod → KONFLIKT.
 *   INGAENDE_MOMS /         I → FORENLIG (R0-REAL-001: 2641 «Debiterad ingående moms» = I).
 *   AVDRAGSGILL             Null/tom/saknad → EJ_BELAGD. Annan kod → KONFLIKT.
 *
 * För alla: målkontot måste finnas för räkenskapsåret och vara aktivt, annars KONFLIKT.
 */
import { createHash } from 'node:crypto'
import {
  FORTNOX_ROLE_TREATMENT,
  type FortnoxAccountRole,
  type FortnoxVatTreatment,
} from '@eken/shared'

export type Roll = FortnoxAccountRole
export type Momsbehandling = FortnoxVatTreatment
export type Teknik = 'FORENLIG' | 'KONFLIKT' | 'EJ_BELAGD'

/** Målkontots fakta ur GET /3/accounts/{n}?financialyear= i samma stund. */
export interface Malfakta {
  exists: boolean
  name: string | null
  active: boolean | null
  /** null/'' = utan momskod. */
  vatCode: string | null
  /** false = fältet VATCode saknades i svaret (inte detsamma som null/tomt). */
  vatCodePresent: boolean
  year: number | null
}

export const BALANSROLLER: readonly Roll[] = [
  'KUNDFORDRAN',
  'LIKVID',
  'DEPOSITIONSSKULD',
  'KUNDTILLGODOSKULD',
  'LEVERANTORSSKULD',
  'KOSTNAD',
]

/**
 * KONTRAKTSBESKED-008 V4: startavstämningen läser Fortnox 1510 och 2890 per nummer
 * (kundstart/opening-fortnox-balance.ts). Därför kan v1 bara godkänna just dessa mål för rollerna
 * KUNDFORDRAN och DEPOSITIONSSKULD — i BÅDA vägarna, så att test- och kundväg inte skiljer sig.
 */
export const LASTA_MAL: Partial<Record<Roll, number>> = {
  KUNDFORDRAN: 1510,
  DEPOSITIONSSKULD: 2890,
}

/**
 * TESTKUND-010 F-009-1: KONTOKLASS per roll — EN gemensam regel för källsidan (radklassen) och
 * målsidan (utkast, godkännande, exportens färska kontroll). Källa: BAS-kontoplanens klasser
 * (BAS 2026; R0-REAL-001 för 1868238): 19 kassa och bank, 1510 kundfordringar, 2440/24
 * leverantörsskulder, 264 ingående moms, 2890 övriga kortfristiga skulder (V4), 3 rörelsens
 * intäkter, 4–8 kostnader. Radklassen krävde redan 19xx för LIKVID på källsidan (`arLikvid`).
 * En inbetalning som debiterar ett resultatkonto är en strukturell motsägelse, inte en
 * tolkningsfråga: utanför klassen = KONFLIKT, och ett innehållsgodkännande kan aldrig överrida det.
 */
export const KONTOKLASS: Readonly<Record<Roll, readonly [number, number]>> = {
  LIKVID: [1900, 1999],
  KUNDFORDRAN: [1510, 1510],
  DEPOSITIONSSKULD: [2890, 2890],
  // Teknisk skuldklass: eget kapital ligger utanför. Intervallet väljer inget
  // kundkonto och bevisar inte kontots innebörd; den måste godkännas uttryckligen.
  // Kundtillgodo är en egen roll och har inget låst mål eller depositionsförval.
  KUNDTILLGODOSKULD: [2300, 2999],
  LEVERANTORSSKULD: [2400, 2499],
  INGAENDE_MOMS: [2640, 2649],
  HYRESINTAKT: [3000, 3999],
  KOSTNAD: [4000, 8999],
}
export const iKontoklass = (roll: Roll, konto: number) =>
  konto >= KONTOKLASS[roll][0] && konto <= KONTOKLASS[roll][1]
export const klassText = (roll: Roll) => {
  const [a, b] = KONTOKLASS[roll]
  return a === b ? `${a}` : `${a}–${b}`
}

export const ROLL_TEXT: Record<Roll, string> = {
  KUNDFORDRAN: 'kundfordran',
  HYRESINTAKT: 'hyresintäkt',
  LIKVID: 'bank/likvid',
  DEPOSITIONSSKULD: 'depositionsskuld',
  KUNDTILLGODOSKULD: 'kundtillgodoskuld',
  KOSTNAD: 'kostnad',
  INGAENDE_MOMS: 'ingående moms',
  LEVERANTORSSKULD: 'leverantörsskuld',
}

export const BEHANDLING_TEXT: Record<Momsbehandling, string> = {
  EJ_TILLAMPLIG: 'ingen moms på raden',
  MOMSFRI: 'momsfri (belagd bostadshyra)',
  AVDRAGSGILL: 'avdragsgill ingående moms',
}

export const tillatetPar = (roll: Roll, behandling: Momsbehandling) =>
  FORTNOX_ROLE_TREATMENT[roll] === behandling

const tom = (k: string | null) => k === null || k === ''

/** Teknisk bedömning av ett målkonto för (roll, behandling). Ren funktion. */
export function teknik(
  roll: Roll,
  behandling: Momsbehandling,
  f: Malfakta,
  financialYearId: number,
  malNummer: number,
): { teknik: Teknik; skal: string } {
  if (!tillatetPar(roll, behandling))
    return { teknik: 'KONFLIKT', skal: 'behandlingen gäller inte för rollen' }
  if (!iKontoklass(roll, malNummer))
    return {
      teknik: 'KONFLIKT',
      skal: `kontoklass: ${ROLL_TEXT[roll]} kräver ett konto i ${klassText(roll)}`,
    }
  if (!f.exists || (f.year !== null && f.year !== financialYearId))
    return { teknik: 'KONFLIKT', skal: 'kontot finns inte i Fortnox för räkenskapsåret' }
  if (f.active !== true) return { teknik: 'KONFLIKT', skal: 'kontot är inaktivt i Fortnox' }
  const kod = f.vatCode
  if (roll === 'HYRESINTAKT') {
    if (!f.vatCodePresent || tom(kod))
      return {
        teknik: 'EJ_BELAGD',
        skal: 'kontot saknar momskod — momsfri hyra kan inte beläggas (policy B-1 öppen)',
      }
    if (kod === 'MF')
      return {
        teknik: 'FORENLIG',
        skal: 'momskod MF är tekniskt förenlig med momsfri bostadshyra (policy 006-A/B-2); kontots innebörd godkänns separat',
      }
    return {
      teknik: 'KONFLIKT',
      skal: `momskod ${kod} motsäger momsfri bostadshyra`,
    }
  }
  if (roll === 'INGAENDE_MOMS') {
    if (!f.vatCodePresent || tom(kod))
      return { teknik: 'EJ_BELAGD', skal: 'kontot saknar momskod för ingående moms' }
    if (kod === 'I') return { teknik: 'FORENLIG', skal: 'momskod I (ingående moms)' }
    return { teknik: 'KONFLIKT', skal: `momskod ${kod} är inte ingående moms (I)` }
  }
  // Balans- och kostnadsroller utan moms på raden.
  if (!f.vatCodePresent) return { teknik: 'EJ_BELAGD', skal: 'momskoden saknas i Fortnox svar' }
  if (tom(kod)) return { teknik: 'FORENLIG', skal: 'ingen momskod — ingen motsägelse' }
  return { teknik: 'KONFLIKT', skal: `momskod ${kod} på ett konto utan moms på raden` }
}

/** V4 och K3.1 vid godkännande: varför en rad inte kan godkännas (null = kan godkännas). */
export function godkannandeHinder(r: {
  role: Roll
  targetAccountNumber: number
  technical: Teknik
  technicalReason: string
}): string | null {
  // F-009-1: kontoklassen prövas oberoende av den sparade tekniken (äldre revisioner).
  if (!iKontoklass(r.role, r.targetAccountNumber))
    return `kontoklass: ${ROLL_TEXT[r.role]} kräver ett konto i ${klassText(r.role)}`
  if (r.technical !== 'FORENLIG') return r.technicalReason
  const last = LASTA_MAL[r.role]
  if (last !== undefined && r.targetAccountNumber !== last)
    return (
      `${ROLL_TEXT[r.role]} måste mappas till Fortnox ${last} i denna version — ` +
      `startavstämningen läser ${last}; annat målkonto stöds inte än`
    )
  return null
}

/** Har målkontot ändrats sedan ögonblicksbilden (K6.2)? Null = oförändrat. */
export function drift(
  bild: {
    targetExists: boolean
    targetName: string | null
    targetActive: boolean | null
    targetVatCode: string | null
    targetVatCodePresent: boolean
    targetYear: number | null
  },
  nu: Malfakta,
): string | null {
  const skillnader: string[] = []
  if (bild.targetExists !== nu.exists) skillnader.push('finns')
  if (bild.targetName !== nu.name) skillnader.push('namn')
  if (bild.targetActive !== nu.active) skillnader.push('aktivitet')
  if (
    bild.targetVatCodePresent !== nu.vatCodePresent ||
    (bild.targetVatCode ?? '') !== (nu.vatCode ?? '')
  )
    skillnader.push('momskod')
  if (bild.targetYear !== nu.year) skillnader.push('år')
  return skillnader.length ? skillnader.join(', ') : null
}

/** Fortnox kontosvar → Malfakta (samma tolkning överallt). */
export function malfaktaUrSvar(
  nummer: number,
  body: { Account?: Record<string, unknown> } | null | undefined,
): Malfakta {
  const a = body?.Account
  const exists = !!a && a.Number === nummer
  const vat = a?.VATCode
  return {
    exists,
    name: exists && typeof a!.Description === 'string' ? (a!.Description as string) : null,
    active: exists ? a!.Active === true : null,
    vatCode: exists && typeof vat === 'string' ? vat : null,
    vatCodePresent: exists && vat !== undefined,
    year: exists && Number.isSafeInteger(a!.Year) ? (a!.Year as number) : null,
  }
}

export const SAKNAS: Malfakta = {
  exists: false,
  name: null,
  active: null,
  vatCode: null,
  vatCodePresent: false,
  year: null,
}

export interface RevisionInnehall {
  organizationId: string
  revision: number
  connectionId: string
  connectionGeneration: number
  fortnoxDatabaseNumber: number
  fortnoxOrgNumber: string
  financialYearId: number
  financialYearFrom: string
  financialYearTo: string
  rows: Array<{
    role: Roll
    vatTreatment: Momsbehandling
    sourceAccountNumber: number
    sourceAccountName: string
    targetAccountNumber: number
    targetExists: boolean
    targetName: string | null
    targetActive: boolean | null
    targetVatCode: string | null
    targetVatCodePresent: boolean
    targetYear: number | null
    technical: Teknik
  }>
}

/** Kanonisk sha256 över bindning + rader (sorterade) inkl. ögonblicksbild och teknik. */
export function innehallsSha(x: RevisionInnehall): string {
  const rader = [...x.rows]
    .map((r) => [
      r.role,
      r.vatTreatment,
      r.sourceAccountNumber,
      r.sourceAccountName,
      r.targetAccountNumber,
      r.targetExists,
      r.targetName,
      r.targetActive,
      r.targetVatCode,
      r.targetVatCodePresent,
      r.targetYear,
      r.technical,
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return createHash('sha256')
    .update(
      JSON.stringify([
        x.organizationId,
        x.revision,
        x.connectionId,
        x.connectionGeneration,
        x.fortnoxDatabaseNumber,
        x.fortnoxOrgNumber,
        x.financialYearId,
        x.financialYearFrom,
        x.financialYearTo,
        rader,
      ]),
      'utf8',
    )
    .digest('hex')
}

export const nyckel = (roll: Roll, konto: number, behandling: Momsbehandling) =>
  `${roll}|${konto}|${behandling}`
