import type Anthropic from '@anthropic-ai/sdk'
import { beloppsutfall, provaKandidater } from '../payment/payment-candidates'
import {
  betalningsverktyg,
  byggBetalningsprompt,
  tolkaBetalningssvar,
} from '../payment/payment-shadow.service'
import { berikaReferenser } from './experiment-betalningsreferenser'
import {
  bedomningsprompt,
  bedomningsverktyg,
  tolkaBedomning,
} from './experiment-betalningsbedomning'
import type { Betalningsbedomning } from './experiment-betalningsbedomning'
import type { VerklighetslikBetalning } from './verklighetslika-betalningar'

export const BETALNINGSARMAR = ['befintlig', 'uppdelad', 'referensstod'] as const
export type Betalningsarm = (typeof BETALNINGSARMAR)[number]
export interface Modellobservation {
  input: unknown
  stopReason: string | null
  usage: { input_tokens: number; output_tokens: number }
  rawResponse?: unknown
}
export type Provanrop = (request: {
  prompt: string
  tool: Anthropic.Tool
}) => Promise<Modellobservation>
export interface VerklighetslikMatpunkt {
  id: string
  repetition: number
  arm: Betalningsarm
  kontroll: boolean
  kontrollRatt: boolean
  status: 'KONTROLL' | 'REGEL' | 'SVAR' | 'AVVISAT' | 'API_FEL' | 'EJ_KORD'
  regelTyp: string
  kandidater: string[]
  gamlaKandidaterKvar: boolean
  facitIMangden: boolean | null
  tvetydigtNamn: boolean
  facit: { forslag: string; bedomning: Betalningsbedomning }
  forslag: string | null
  bedomning: Betalningsbedomning | null
  heltRatt: boolean
  identitetRatt: boolean | null
  hanteringRatt: boolean | null
  felaktigtForslag: boolean
  missatForslag: boolean
  felaktigReferens: boolean
  request?: { prompt: string; tool: Anthropic.Tool }
  response?: Modellobservation
}

export async function mataVerklighetslikBetalning(
  item: VerklighetslikBetalning,
  arm: Betalningsarm,
  repetition: number,
  anrop?: Provanrop,
): Promise<VerklighetslikMatpunkt> {
  const regel = provaKandidater(item.rad, item.poster)
  const gamla = regel.typ === 'KANDIDATER' ? regel.kandidater : []
  const stod = berikaReferenser(item.rad, item.poster, gamla)
  const kandidater = arm === 'referensstod' ? stod.kandidater : gamla
  const target =
    arm === 'befintlig' ? (item.forslag === 'INGEN' ? [] : [item.forslag]) : item.bedomning.avier
  const row: VerklighetslikMatpunkt = {
    id: item.id,
    repetition,
    arm,
    kontroll: item.exaktOcrKontroll === true,
    kontrollRatt: (regel.typ === 'INGEN_FRAGA') === (item.exaktOcrKontroll === true),
    status: 'EJ_KORD',
    regelTyp: regel.typ,
    kandidater: kandidater.map((k) => k.id),
    gamlaKandidaterKvar: gamla.every((k) => kandidater.some((candidate) => candidate.id === k.id)),
    facitIMangden: target.length ? target.every((id) => kandidater.some((k) => k.id === id)) : null,
    tvetydigtNamn: arm === 'referensstod' && stod.tvetydigtNamn,
    facit: { forslag: item.forslag, bedomning: item.bedomning },
    forslag: null,
    bedomning: null,
    heltRatt: false,
    identitetRatt: null,
    hanteringRatt: null,
    felaktigtForslag: false,
    missatForslag: false,
    felaktigReferens: false,
  }
  if (regel.typ === 'INGEN_FRAGA') {
    row.status = 'KONTROLL'
    return row
  }
  if (!kandidater.length) {
    row.status = 'REGEL'
    if (arm === 'befintlig') row.forslag = 'INGEN'
    else row.bedomning = { avier: [], hantering: 'OKLART' }
  } else {
    // Endast observationerna går in i modellen, aldrig item.scenario eller facit.
    row.request =
      arm === 'befintlig'
        ? {
            prompt: byggBetalningsprompt(item.rad, kandidater),
            tool: betalningsverktyg(kandidater),
          }
        : { prompt: bedomningsprompt(item.rad, kandidater), tool: bedomningsverktyg(kandidater) }
    if (anrop) {
      try {
        row.response = await anrop(row.request)
        row.status = 'AVVISAT'
        if (row.response.stopReason === 'tool_use') {
          if (arm === 'befintlig') {
            const parsed = tolkaBetalningssvar(row.response.input, kandidater)
            if (parsed) {
              row.forslag = parsed.avi
              row.status = 'SVAR'
            }
          } else {
            const parsed = tolkaBedomning(row.response.input, kandidater)
            if (parsed) {
              row.bedomning = row.tvetydigtNamn ? { avier: [], hantering: 'OKLART' } : parsed
              row.status = 'SVAR'
            }
          }
        }
      } catch {
        row.status = 'API_FEL'
      }
    }
  }
  if (arm === 'befintlig') {
    row.heltRatt = row.forslag === item.forslag
    row.felaktigtForslag =
      row.forslag !== null && row.forslag !== 'INGEN' && row.forslag !== item.forslag
    row.missatForslag = row.forslag === 'INGEN' && item.forslag !== 'INGEN'
    // Beloppsetiketten bildas av produktionsregeln, inte av modellen.
    if (row.heltRatt && item.forslag !== 'INGEN') {
      const selected = kandidater.find((k) => k.id === row.forslag)!
      row.heltRatt =
        beloppsutfall(item.rad.belopp, selected.utestaende) === item.bedomning.hantering
    }
  } else {
    row.identitetRatt =
      row.bedomning !== null &&
      JSON.stringify([...row.bedomning.avier].sort()) ===
        JSON.stringify([...item.bedomning.avier].sort())
    row.hanteringRatt = row.bedomning?.hantering === item.bedomning.hantering
    row.heltRatt = row.identitetRatt && row.hanteringRatt
    row.felaktigReferens =
      row.bedomning?.avier.some((id) => !item.bedomning.avier.includes(id)) ?? false
  }
  return row
}

export function sammanfattaVerklighetslikaBetalningar(rows: readonly VerklighetslikMatpunkt[]) {
  return BETALNINGSARMAR.map((arm) => {
    const all = rows.filter((r) => r.arm === arm)
    const scored = all.filter((r) => !r.kontroll)
    const covered = scored.filter((r) => r.facitIMangden !== null)
    return {
      arm,
      antal: scored.length,
      heltRatt: scored.filter((r) => r.heltRatt).length,
      kontrollfel: all.filter((r) => !r.kontrollRatt).length,
      kontroller: all.filter((r) => r.kontroll).length,
      identitetRatt: arm === 'befintlig' ? null : scored.filter((r) => r.identitetRatt).length,
      hanteringRatt: arm === 'befintlig' ? null : scored.filter((r) => r.hanteringRatt).length,
      felaktigaForslag:
        arm === 'befintlig' ? scored.filter((r) => r.felaktigtForslag).length : null,
      missadeForslag: arm === 'befintlig' ? scored.filter((r) => r.missatForslag).length : null,
      felaktigaReferenser:
        arm === 'befintlig' ? null : scored.filter((r) => r.felaktigReferens).length,
      bortfall: scored.filter((r) =>
        ['AVVISAT', 'API_FEL', 'EJ_KORD', 'KONTROLL'].includes(r.status),
      ).length,
      facitIMangden: { ratt: covered.filter((r) => r.facitIMangden).length, antal: covered.length },
      gamlaKandidaterBorttagna: all.filter((r) => !r.gamlaKandidaterKvar).length,
    }
  })
}
