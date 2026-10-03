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

export interface SeparateLedgerParsed {
  sha256: string
  antal: number
  summaOre: number
  poster: { postId: string; ore: number }[]
}

/** Specifikation av separat reskontra: rubrik `postId;belopp`, en post per rad. */
export function tolkaSpecifikation(
  text: string,
): { ok: true; spec: SeparateLedgerParsed } | { ok: false; error: string } {
  const rader = delaCsv(text)
  if (rader.length < 2) return { ok: false, error: 'Specifikationen har inga poster.' }
  const huvud = (rader[0] ?? []).map((h) => h.trim())
  const iId = huvud.indexOf('postId')
  const iBel = huvud.indexOf('belopp')
  if (iId < 0 || iBel < 0) return { ok: false, error: 'Rubrikraden ska vara postId;belopp.' }
  const poster: { postId: string; ore: number }[] = []
  const sett = new Set<string>()
  for (let r = 1; r < rader.length; r++) {
    const id = (rader[r]?.[iId] ?? '').trim()
    const ore = kronorTillOre((rader[r]?.[iBel] ?? '').trim())
    if (!id) return { ok: false, error: `Rad ${r}: postId saknas.` }
    if (sett.has(id)) return { ok: false, error: `Rad ${r}: postId ${id} förekommer två gånger.` }
    if (ore === null || ore === 0)
      return { ok: false, error: `Rad ${r}: belopp saknas eller är inte exakt.` }
    sett.add(id)
    poster.push({ postId: id, ore })
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
