/**
 * KUNDSTART-001: tolkning av öppningspaketets CSV (mallen i KUNDUNDERLAG.md) och av en
 * specifikation för separat reskontra. Rena funktioner utan databas — samma indata ger
 * alltid samma rader, fel och sha256 (validering ska vara deterministisk och idempotent).
 *
 * Belopp hanteras i ÖRE (heltal) hela vägen; kronor med komma eller punkt och högst två
 * decimaler godtas, annat avvisas i stället för att avrundas.
 */
import { createHash } from 'crypto'

export const OPENING_CSV_HEADER = [
  'radId',
  'typ',
  'hyresgast',
  'avtal',
  'fastighet',
  'enhet',
  'periodAr',
  'periodManad',
  'forfallodag',
  'ursprungligtBelopp',
  'oppetBelopp',
  'mottagetDatum',
] as const

export type OpeningCsvKind = 'RECEIVABLE' | 'DEPOSIT'

export interface ParsedOpeningRow {
  rowNo: number
  sourceId: string
  kind: OpeningCsvKind | null
  tenantRef: string
  leaseRef: string | null
  propertyRef: string | null
  unitRef: string | null
  periodYear: number | null
  periodMonth: number | null
  dueDate: Date | null
  receivedDate: Date | null
  originalOre: number | null
  openOre: number | null
  errors: string[]
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Kronor ('1 234,50', '1234.5', '-12') → öre. null om värdet inte är ett exakt belopp. */
/**
 * ACK-009: EN beloppsgräns för allt i kundstarten — paketrader, specifikationer och
 * Fortnox-saldon lagras som Decimal(12,2) i kronor, alltså högst 9 999 999 999,99 kr
 * (999 999 999 999 öre). Över gränsen är det ett fel med skäl, aldrig avrundning eller 500.
 */
export const MAX_BELOPP_ORE = 999_999_999_999
export const MAX_BELOPP_TEXT = '9 999 999 999,99 kr'
export const inomBeloppsgrans = (ore: number) => Math.abs(ore) <= MAX_BELOPP_ORE

export function kronorTillOre(raw: string): number | null {
  const s = raw.replace(/[\s ]/g, '').replace(',', '.')
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null
  const neg = s.startsWith('-')
  const [hel, dec = ''] = (neg ? s.slice(1) : s).split('.')
  const ore = Number(hel) * 100 + Number(dec.padEnd(2, '0'))
  if (!Number.isSafeInteger(ore)) return null
  return neg ? -ore : ore
}

export function oreTillKronorStr(ore: number): string {
  const neg = ore < 0
  const a = Math.abs(ore)
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`
}

/** 'ÅÅÅÅ-MM-DD' → UTC-midnatt (DATE-kolumn). null om ogiltigt. */
export function tolkaDatum(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return dt
}

/** Semikolonseparerad CSV med citattecken ("a;b" och "" som escape). */
export function delaCsv(text: string): string[][] {
  const rader: string[][] = []
  let rad: string[] = []
  let falt = ''
  let iCitat = false
  const t = text.replace(/^﻿/, '')
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (iCitat) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          falt += '"'
          i++
        } else iCitat = false
      } else falt += c
    } else if (c === '"') iCitat = true
    else if (c === ';') {
      rad.push(falt)
      falt = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++
      rad.push(falt)
      falt = ''
      if (rad.some((f) => f.trim() !== '')) rader.push(rad)
      rad = []
    } else falt += c
  }
  rad.push(falt)
  if (rad.some((f) => f.trim() !== '')) rader.push(rad)
  return rader
}

export type OpeningCsvResult =
  | { ok: true; rows: ParsedOpeningRow[]; sha256: string }
  | { ok: false; error: string }

export function tolkaOpeningCsv(text: string): OpeningCsvResult {
  const rader = delaCsv(text)
  if (rader.length === 0) return { ok: false, error: 'Filen är tom.' }
  const huvud = (rader[0] ?? []).map((h) => h.trim())
  const saknas = OPENING_CSV_HEADER.filter((h) => !huvud.includes(h))
  if (saknas.length > 0)
    return {
      ok: false,
      error: `Rubrikraden saknar kolumn(er): ${saknas.join(', ')}. Använd mallen i kundunderlaget.`,
    }
  if (rader.length === 1) return { ok: false, error: 'Filen har inga rader utöver rubriken.' }
  const idx = Object.fromEntries(OPENING_CSV_HEADER.map((h) => [h, huvud.indexOf(h)])) as Record<
    (typeof OPENING_CSV_HEADER)[number],
    number
  >

  const rows: ParsedOpeningRow[] = []
  const settaId = new Map<string, number>()
  for (let r = 1; r < rader.length; r++) {
    const cell = (k: (typeof OPENING_CSV_HEADER)[number]) => (rader[r]?.[idx[k]] ?? '').trim()
    const errors: string[] = []
    const rowNo = r
    const sourceId = cell('radId')
    if (!sourceId) errors.push('radId saknas.')
    else if (settaId.has(sourceId))
      errors.push(`radId ${sourceId} förekommer två gånger (rad ${settaId.get(sourceId)}).`)
    else settaId.set(sourceId, rowNo)

    const typ = cell('typ').toUpperCase()
    const kind: OpeningCsvKind | null =
      typ === 'FORDRAN' ? 'RECEIVABLE' : typ === 'DEPOSITION' ? 'DEPOSIT' : null
    if (!kind) errors.push(`typ måste vara FORDRAN eller DEPOSITION (fick "${cell('typ')}").`)

    const tenantRef = cell('hyresgast')
    if (!tenantRef) errors.push('hyresgast saknas (OCR-nummer eller e-post).')

    const tal = (k: (typeof OPENING_CSV_HEADER)[number]) => {
      const v = cell(k)
      if (!v) return null
      return /^\d+$/.test(v) ? Number(v) : NaN
    }
    const periodYear = tal('periodAr')
    const periodMonth = tal('periodManad')
    const datum = (k: (typeof OPENING_CSV_HEADER)[number]) => {
      const v = cell(k)
      if (!v) return null
      const d = tolkaDatum(v)
      if (!d) errors.push(`${k} "${v}" är inget giltigt datum (ÅÅÅÅ-MM-DD).`)
      return d
    }
    const dueDate = datum('forfallodag')
    const receivedDate = datum('mottagetDatum')
    const belopp = (k: (typeof OPENING_CSV_HEADER)[number]) => {
      const v = cell(k)
      if (!v) {
        errors.push(`${k} saknas.`)
        return null
      }
      const o = kronorTillOre(v)
      if (o === null) errors.push(`${k} "${v}" är inget exakt belopp (högst två decimaler).`)
      else if (!inomBeloppsgrans(o)) {
        errors.push(`${k} "${v}" överstiger gränsen ${MAX_BELOPP_TEXT}.`)
        return null
      }
      return o
    }
    const originalOre = belopp('ursprungligtBelopp')
    const openOre = belopp('oppetBelopp')

    if (kind === 'RECEIVABLE') {
      if (periodYear === null || periodMonth === null)
        errors.push('FORDRAN kräver periodAr och periodManad.')
      else if (
        Number.isNaN(periodYear) ||
        Number.isNaN(periodMonth) ||
        periodMonth < 1 ||
        periodMonth > 12 ||
        periodYear < 2000
      )
        errors.push('Ogiltig period.')
      if (!dueDate && !cell('forfallodag')) errors.push('FORDRAN kräver forfallodag.')
      if (cell('mottagetDatum')) errors.push('mottagetDatum gäller bara DEPOSITION.')
    }
    if (kind === 'DEPOSIT') {
      if (!receivedDate && !cell('mottagetDatum'))
        errors.push('DEPOSITION kräver mottagetDatum (enligt underlag).')
      if (cell('periodAr') || cell('periodManad') || cell('forfallodag'))
        errors.push('period och forfallodag gäller bara FORDRAN.')
    }
    if (openOre !== null && openOre <= 0) errors.push('oppetBelopp måste vara större än 0.')
    if (originalOre !== null && openOre !== null && openOre > originalOre)
      errors.push('oppetBelopp får inte vara större än ursprungligtBelopp.')

    rows.push({
      rowNo,
      sourceId,
      kind,
      tenantRef,
      leaseRef: cell('avtal') || null,
      propertyRef: cell('fastighet') || null,
      unitRef: cell('enhet') || null,
      periodYear: kind === 'RECEIVABLE' && Number.isFinite(periodYear) ? periodYear : null,
      periodMonth: kind === 'RECEIVABLE' && Number.isFinite(periodMonth) ? periodMonth : null,
      dueDate,
      receivedDate,
      originalOre,
      openOre,
      errors,
    })
  }
  return { ok: true, rows, sha256: sha256Hex(text) }
}

export interface SpecPost {
  postId: string
  motpart: string
  dokument: string
  dokumentdatum: string
  forfallodag: string
  ore: number
}

export interface SeparateLedgerParsed {
  sha256: string
  antal: number
  summaOre: number
  poster: SpecPost[]
}

export const SPEC_HUVUD = [
  'postId',
  'motpart',
  'dokument',
  'dokumentdatum',
  'forfallodag',
  'belopp',
] as const

/**
 * KUNDSTART-011 (S5-1): specifikation av separat reskontra. Varje post ska bära spårbar
 * identitet — motpart (kund-id och namn), dokument (fakturanummer eller verifikat),
 * dokumentdatum, förfallodag och belopp > 0. Unikt postId och unik (motpart, dokument).
 * Negativa poster och nollposter avvisas: ingen dold kvittning. En fil med bara
 * postId;belopp duger inte — då förblir differensen DIFFERENS.
 */
export function tolkaSpecifikation(
  text: string,
): { ok: true; spec: SeparateLedgerParsed } | { ok: false; error: string } {
  const rader = delaCsv(text)
  if (rader.length < 2) return { ok: false, error: 'Specifikationen har inga poster.' }
  const huvud = (rader[0] ?? []).map((h) => h.trim())
  const saknas = SPEC_HUVUD.filter((h) => !huvud.includes(h))
  if (saknas.length > 0)
    return {
      ok: false,
      error: `Specifikationen saknar kolumn(er): ${saknas.join(', ')}. Rubriken ska vara ${SPEC_HUVUD.join(';')} — identitet per post är obligatorisk.`,
    }
  const ix = Object.fromEntries(SPEC_HUVUD.map((h) => [h, huvud.indexOf(h)])) as Record<
    (typeof SPEC_HUVUD)[number],
    number
  >
  const poster: SpecPost[] = []
  const settId = new Set<string>()
  const settDok = new Set<string>()
  for (let r = 1; r < rader.length; r++) {
    const c = (k: (typeof SPEC_HUVUD)[number]) => (rader[r]?.[ix[k]] ?? '').trim()
    const post = {
      postId: c('postId'),
      motpart: c('motpart'),
      dokument: c('dokument'),
      dokumentdatum: c('dokumentdatum'),
      forfallodag: c('forfallodag'),
    }
    for (const [k, v] of Object.entries(post))
      if (!v) return { ok: false, error: `Rad ${r}: ${k} saknas — varje post kräver identitet.` }
    if (!tolkaDatum(post.dokumentdatum) || !tolkaDatum(post.forfallodag))
      return { ok: false, error: `Rad ${r}: dokumentdatum och forfallodag ska vara ÅÅÅÅ-MM-DD.` }
    const ore = kronorTillOre(c('belopp'))
    if (ore === null) return { ok: false, error: `Rad ${r}: belopp saknas eller är inte exakt.` }
    if (ore <= 0)
      return {
        ok: false,
        error: `Rad ${r}: belopp måste vara större än 0 — kvittade eller negativa poster godtas inte.`,
      }
    if (!inomBeloppsgrans(ore))
      return { ok: false, error: `Rad ${r}: beloppet överstiger gränsen ${MAX_BELOPP_TEXT}.` }
    if (settId.has(post.postId))
      return { ok: false, error: `Rad ${r}: postId ${post.postId} förekommer två gånger.` }
    const dok = `${post.motpart}\u0000${post.dokument}`
    if (settDok.has(dok))
      return {
        ok: false,
        error: `Rad ${r}: samma motpart och dokument (${post.dokument}) förekommer två gånger.`,
      }
    settId.add(post.postId)
    settDok.add(dok)
    poster.push({ ...post, ore })
  }
  return {
    ok: true,
    spec: {
      sha256: sha256Hex(text),
      antal: poster.length,
      summaOre: poster.reduce((s, p) => s + p.ore, 0),
      poster,
    },
  }
}

// ── KUNDSTART-009: register för FÖRSTA perioden ur tidigare system ─────────────────
export const REGISTER_HUVUD = [
  'radId',
  'hyresgast',
  'avtal',
  'periodAr',
  'periodManad',
  'dokument',
  'fakturerat',
  'betalt',
] as const

export interface RegisterPost {
  radId: string
  hyresgast: string
  avtal: string
  periodAr: number
  periodManad: number
  dokument: string
  faktureratOre: number
  betaltOre: number
}

/**
 * Tidigare systemets periodbundna fakturerings- och betalningsregister för perioder FRÅN
 * brytdatum — även fullt betalda poster. En fil med bara rubrikraden betyder "inga poster i
 * registret för täckningsperioden". Strikt tolkning: saknade fält, ogiltig period eller
 * belopp utanför gränsen avvisar hela filen.
 */
export function tolkaForstaPeriodRegister(
  text: string,
): { ok: true; sha256: string; poster: RegisterPost[] } | { ok: false; error: string } {
  const rader = delaCsv(text)
  if (rader.length === 0) return { ok: false, error: 'Registret är tomt — rubrikraden krävs.' }
  const huvud = (rader[0] ?? []).map((h) => h.trim())
  const saknas = REGISTER_HUVUD.filter((h) => !huvud.includes(h))
  if (saknas.length > 0)
    return { ok: false, error: `Registret saknar kolumn(er): ${saknas.join(', ')}.` }
  const ix = Object.fromEntries(REGISTER_HUVUD.map((h) => [h, huvud.indexOf(h)])) as Record<
    (typeof REGISTER_HUVUD)[number],
    number
  >
  const poster: RegisterPost[] = []
  for (let r = 1; r < rader.length; r++) {
    const c = (k: (typeof REGISTER_HUVUD)[number]) => (rader[r]?.[ix[k]] ?? '').trim()
    for (const k of ['radId', 'hyresgast', 'avtal', 'dokument'] as const)
      if (!c(k)) return { ok: false, error: `Rad ${r}: ${k} saknas.` }
    const ar = Number(c('periodAr'))
    const man = Number(c('periodManad'))
    if (!Number.isInteger(ar) || ar < 2000 || !Number.isInteger(man) || man < 1 || man > 12)
      return { ok: false, error: `Rad ${r}: ogiltig period.` }
    const f = kronorTillOre(c('fakturerat') || '0')
    const b = kronorTillOre(c('betalt') || '0')
    if (f === null || b === null || f < 0 || b < 0)
      return { ok: false, error: `Rad ${r}: fakturerat och betalt ska vara exakta belopp ≥ 0.` }
    if (!inomBeloppsgrans(f) || !inomBeloppsgrans(b))
      return { ok: false, error: `Rad ${r}: beloppet överstiger gränsen ${MAX_BELOPP_TEXT}.` }
    if (f === 0 && b === 0)
      return { ok: false, error: `Rad ${r}: en post måste ha fakturerat eller betalt belopp.` }
    poster.push({
      radId: c('radId'),
      hyresgast: c('hyresgast'),
      avtal: c('avtal'),
      periodAr: ar,
      periodManad: man,
      dokument: c('dokument'),
      faktureratOre: f,
      betaltOre: b,
    })
  }
  return { ok: true, sha256: sha256Hex(text), poster }
}
