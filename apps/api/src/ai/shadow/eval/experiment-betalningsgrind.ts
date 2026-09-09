/** Endast mätexperiment. Får inte kopplas till bankens skrivväg genom detta bygge. */
import type { Bankrad, Kandidat, RankadKandidat } from '../payment/payment-candidates'
import { normalisera, ocrAvstand } from '../payment/payment-candidates'
import { harHelReferens } from './experiment-betalningsreferenser'
import { tolkaBedomning, type Betalningsbedomning } from './experiment-betalningsbedomning'

export interface GranskadBetalning {
  bedomning: Betalningsbedomning | null
  ursprungligBedomning: Betalningsbedomning | null
  kandidater: string[]
  skal: string[]
  /** En observation att mäta mot facit, aldrig ett exekveringstillstånd. */
  provmatchning: { avi: string; beloppOre: string } | null
  automatiskVerkstallning: false
}

/** Decimaler från läsmodellen: högst två decimaler, ingen binär avrundning. */
export function beloppIOre(belopp: number): bigint | null {
  if (!Number.isFinite(belopp) || belopp < 0) return null
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(belopp))
  if (!match) return null
  const ore = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  return ore <= BigInt(Number.MAX_SAFE_INTEGER) ? ore : null
}

export function klassificeraBelopp(
  inbetalt: number,
  skuld: number,
): 'FULL' | 'DEL' | 'OVERSKOTT' | null {
  const betalt = beloppIOre(inbetalt)
  const kvar = beloppIOre(skuld)
  if (betalt === null || kvar === null || betalt <= 0n || kvar <= 0n) return null
  const differens = betalt - kvar
  return differens > 100n ? 'OVERSKOTT' : differens >= -100n ? 'FULL' : 'DEL'
}

function referensfakta(text: string, poster: readonly Kandidat[]) {
  const kanda = poster.filter((p) => harHelReferens(text, p.nummer))
  const prefix = new Set(
    poster.flatMap((p) => {
      const m = /^([\p{L}]{1,12})[\s-]+\d/u.exec(p.nummer)
      return m ? [m[1]!.toLocaleLowerCase('sv-SE')] : []
    }),
  )
  // Upptäck också en explicit identifierare som INTE finns bland öppna poster.
  // Oigenkända format stängs för provmatchning av den snävare textformen nedan.
  const namnda = [...text.matchAll(/(?<![\p{L}\p{N}])([\p{L}]{1,12})[\s-]+(\d[\p{L}\p{N}-]*)/gu)]
    .filter((m) => prefix.has(m[1]!.toLocaleLowerCase('sv-SE')))
    .map((m) => normalisera(m[0]))
  const okanda = namnda.filter((ref) => !poster.some((p) => normalisera(p.nummer) === ref))
  const dubblett = kanda.some(
    (p) => poster.filter((other) => normalisera(other.nummer) === normalisera(p.nummer)).length > 1,
  )
  return { kanda, okanda, dubblett }
}

function enkelBanktext(text: string, post: Kandidat): boolean {
  // Utvärderingskandidaten begränsas till en enkel positiv textform. Vi försöker
  // inte göra regex till en allmän tolk av negationer, rättelser eller instruktioner.
  let rest = ` ${normalisera(text)} `
  for (const part of [post.nummer, post.motpartNamn, post.ocr]) {
    if (part) rest = rest.split(` ${normalisera(part)} `).join(' ')
  }
  const ord = rest.trim().split(/\s+/).filter(Boolean)
  return ord.every((word) =>
    ['hyra', 'betalning', 'delbetalning', 'inbetalning', 'avi', 'faktura'].includes(word),
  )
}

export function granskaBetalningsbedomning(
  rad: Bankrad,
  poster: readonly Kandidat[],
  kandidater: readonly RankadKandidat[],
  input: unknown,
  komplettUnderlag = false,
): GranskadBetalning {
  const raw = tolkaBedomning(input, kandidater)
  const result: GranskadBetalning = {
    bedomning: raw ? { avier: [...raw.avier], hantering: raw.hantering } : null,
    ursprungligBedomning: raw,
    kandidater: kandidater.map((p) => p.id),
    skal: [],
    provmatchning: null,
    automatiskVerkstallning: false,
  }
  const oklart = (skal: string) => {
    result.skal.push(skal)
    result.bedomning = { avier: [], hantering: 'OKLART' }
    return result
  }
  if (!raw) {
    result.skal.push('OTOLKBART_MODELLSVAR')
    return result
  }
  if (
    new Set(poster.map((p) => p.id)).size !== poster.length ||
    kandidater.some((p) => !poster.some((original) => original.id === p.id))
  )
    return oklart('OGILTIGT_UNDERLAG')
  const pengar = beloppIOre(rad.belopp)
  if (
    pengar === null ||
    pengar <= 0n ||
    !Number.isFinite(rad.datum.getTime()) ||
    poster.some(
      (p) => beloppIOre(p.utestaende) === null || !Number.isFinite(p.forfallodatum.getTime()),
    )
  )
    return oklart('OGILTIGT_UNDERLAG')
  const refs = referensfakta(rad.text, poster)
  if (refs.okanda.length) return oklart('OKAND_UTTRYCKLIG_REFERENS')
  if (refs.dubblett) return oklart('DUBBELT_AVINUMMER')
  const allaOcr = poster.filter((p) => {
    const distance = ocrAvstand(rad.rawOcr, p.ocr)
    return distance !== null && distance <= 1
  })
  const exaktaOcr = allaOcr.filter((p) => ocrAvstand(rad.rawOcr, p.ocr) === 0)
  const ocr = exaktaOcr.length ? exaktaOcr : allaOcr
  const namn = poster.filter((p) => p.motpartNamn && harHelReferens(rad.text, p.motpartNamn))
  const personer = new Set(namn.map((p) => p.motpartId).filter(Boolean))
  if (ocr.length > 1) return oklart('TVETYDIG_OCR')
  if (ocr.length && refs.kanda.length && !refs.kanda.some((p) => p.id === ocr[0]!.id))
    return oklart('OCR_REFERENS_KONFLIKT')
  if (ocr.length && !refs.kanda.length && personer.size === 1 && !personer.has(ocr[0]!.motpartId))
    return oklart('OCR_NAMN_KONFLIKT')
  if (!refs.kanda.length && !ocr.length && personer.size > 1) return oklart('TVETYDIG_PERSON')
  if (!raw.avier.length || raw.hantering === 'OKLART') return oklart('MODELLEN_KAN_INTE_AVGORA')
  const valda = raw.avier.map((id) => poster.find((p) => p.id === id)!)
  if (refs.kanda.length && valda.some((p) => !refs.kanda.some((ref) => ref.id === p.id)))
    return oklart('VAL_UTAN_REFERENSSTOD')
  if (ocr.length && !valda.some((p) => p.id === ocr[0]!.id)) return oklart('VAL_MOT_OCR')
  if (!refs.kanda.length && !ocr.length) {
    if (personer.size === 1 && valda.some((p) => !personer.has(p.motpartId)))
      return oklart('VAL_MOT_NAMN')
    if (
      valda.some(
        (selected) =>
          selected.motpartId &&
          poster.filter(
            (p) =>
              p.motpartId === selected.motpartId &&
              p.sort === selected.sort &&
              p.forfallodatum <= rad.datum &&
              p.utestaende > 0,
          ).length > 1,
      )
    )
      return oklart('FLERA_FORFALLNA_UTAN_REFERENS')
  }
  if (valda.length > 1) {
    if (!valda.every((p) => refs.kanda.some((ref) => ref.id === p.id)))
      return oklart('FLERA_UTAN_UTTRYCKLIGT_STOD')
    result.bedomning = {
      avier: [...raw.avier],
      hantering: raw.hantering === 'RETUR' ? 'RETUR' : 'FLERA',
    }
    result.skal.push('BELOPPSFORDELNING_KRAVER_GRANSKNING')
    return result
  }
  const vald = valda[0]!
  const kategori = klassificeraBelopp(rad.belopp, vald.utestaende)
  if (!kategori) return oklart('OGILTIG_SKULD')
  result.bedomning = { avier: [vald.id], hantering: raw.hantering === 'RETUR' ? 'RETUR' : kategori }
  if (result.bedomning.hantering !== raw.hantering) result.skal.push('BELOPP_RAKNAT_I_ORE')
  if (!komplettUnderlag) result.skal.push('UNDERLAGETS_FULLSTANDIGHET_OKAND')
  if (rad.rawOcr && (!/^[0-9\s-]+$/.test(rad.rawOcr) || !ocr.length))
    result.skal.push('OCR_UTAN_VERIFIERBART_STOD')
  const enkelReferens = refs.kanda.length === 1 && refs.kanda[0]!.id === vald.id
  const ocrMedNamn =
    ocr.length === 1 &&
    ocr[0]!.id === vald.id &&
    personer.size === 1 &&
    personer.has(vald.motpartId)
  if (!enkelReferens && !ocrMedNamn) result.skal.push('SAKNAR_SARSKILJANDE_IDENTIFIERARE')
  if (!enkelBanktext(rad.text, vald)) result.skal.push('TEXT_KRAVER_MANUELL_TOLKNING')
  if (refs.kanda.length > 1) result.skal.push('FLERA_REFERENSER_I_TEXT')
  if (pengar > beloppIOre(vald.utestaende)!) result.skal.push('BELOPP_OVERSTIGER_SKULD')
  if (result.bedomning.hantering === 'RETUR') result.skal.push('RETUR_KRAVER_GRANSKNING')
  if (!vald.motpartId) result.skal.push('MOTPART_SAKNAS')
  if (result.skal.every((s) => s === 'BELOPP_RAKNAT_I_ORE')) {
    result.provmatchning = { avi: vald.id, beloppOre: pengar.toString() }
  }
  return result
}
