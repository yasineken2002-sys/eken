import type { Bankrad, Kandidat } from '../payment/payment-candidates'
import { provaKandidater } from '../payment/payment-candidates'
import { berikaReferenser } from './experiment-betalningsreferenser'
import type { Betalningsbedomning } from './experiment-betalningsbedomning'
import { granskaBetalningsbedomning, type GranskadBetalning } from './experiment-betalningsgrind'

export interface Grindmatpunkt {
  id: string
  repetition: number
  status: string
  facit: Betalningsbedomning
  facitProvmatchning: boolean | null
  fore: Betalningsbedomning | null
  efter: GranskadBetalning
  foreRatt: boolean
  efterRatt: boolean
  tidigareKorrektForlorat: boolean
  felaktigProvmatchning: boolean
  missadProvmatchning: boolean
}
export function sammaBedomning(a: Betalningsbedomning | null, b: Betalningsbedomning): boolean {
  return (
    a !== null &&
    a.hantering === b.hantering &&
    JSON.stringify([...a.avier].sort()) === JSON.stringify([...b.avier].sort())
  )
}
export function matGrindprov(
  c: {
    id: string
    rad: Bankrad
    poster: Kandidat[]
    facit: Betalningsbedomning
    provmatchning?: boolean
  },
  fore: Betalningsbedomning | null,
  repetition: number,
  status: string,
): Grindmatpunkt {
  const regel = provaKandidater(c.rad, c.poster)
  const kandidater = berikaReferenser(
    c.rad,
    c.poster,
    regel.typ === 'KANDIDATER' ? regel.kandidater : [],
  ).kandidater
  const efter = granskaBetalningsbedomning(c.rad, c.poster, kandidater, fore, true)
  const foreRatt = sammaBedomning(fore, c.facit)
  const efterRatt = sammaBedomning(efter.bedomning, c.facit)
  return {
    id: c.id,
    repetition,
    status,
    facit: c.facit,
    facitProvmatchning: c.provmatchning ?? null,
    fore,
    efter,
    foreRatt,
    efterRatt,
    tidigareKorrektForlorat: foreRatt && !efterRatt,
    felaktigProvmatchning:
      Boolean(efter.provmatchning) && (!efterRatt || c.provmatchning === false),
    missadProvmatchning: c.provmatchning === true && !efter.provmatchning,
  }
}
export function sammanfattaGrindprov(rows: readonly Grindmatpunkt[]) {
  const medAutomatikfacit = rows.filter((r) => r.facitProvmatchning !== null)
  const valda = medAutomatikfacit.filter((r) => r.efter.provmatchning)
  return {
    antal: rows.length,
    grundfall: new Set(rows.map((r) => r.id)).size,
    foreRatt: rows.filter((r) => r.foreRatt).length,
    efterRatt: rows.filter((r) => r.efterRatt).length,
    tidigareKorrektForlorat: rows.filter((r) => r.tidigareKorrektForlorat).length,
    bortfall: rows.filter((r) => !r.fore).length,
    provmatchningar: rows.filter((r) => r.efter.provmatchning).length,
    provmatchningarMedFacit: valda.length,
    felaktigaProvmatchningar: medAutomatikfacit.length
      ? valda.filter((r) => r.felaktigProvmatchning).length
      : null,
    missadeProvmatchningar: medAutomatikfacit.length
      ? medAutomatikfacit.filter((r) => r.missadProvmatchning).length
      : null,
    precisionPaValda: valda.length
      ? valda.filter((r) => !r.felaktigProvmatchning).length / valda.length
      : null,
    tackning: medAutomatikfacit.length ? valda.length / medAutomatikfacit.length : null,
    underlag: 'SYNTETISKT' as const,
    mal99_1BelagtIDrift: false as const,
    automatiskVerkstallning: false as const,
  }
}
