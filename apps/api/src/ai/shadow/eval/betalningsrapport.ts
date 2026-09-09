import { z } from 'zod'
import {
  provaKandidater,
  beloppsutfall,
  type Bankrad,
  type RankadKandidat,
} from '../payment/payment-candidates'
import { tolkaBetalningssvar } from '../payment/payment-shadow.service'
import { INGEN_AVI, OKAND_MOTPART, SKUGGFALT_BETALNING } from '../payment/payment-fields'

const datum = z.string().date()
export const BetalningskorpusSchema = z
  .object({
    poster: z
      .array(
        z.object({
          id: z.string().min(1),
          sort: z.enum(['AVI', 'FAKTURA']),
          nummer: z.string(),
          ocr: z.string().nullable(),
          utestaende: z.number().finite().nonnegative(),
          forfallodatum: datum,
          motpartId: z.string().nullable(),
          motpartNamn: z.string().nullable(),
        }),
      )
      .min(1),
    bankrader: z
      .array(
        z.object({
          id: z.string().min(1),
          datum,
          text: z.string(),
          belopp: z.number().finite().positive(),
          rawOcr: z.string().nullable(),
          facit: z.object({
            avi: z.string().nullable(),
            belopp: z.enum(['FULL', 'DEL']).nullable(),
            motpart: z.string().nullable(),
            grupp: z.string().min(1),
            skal: z.string(),
            regel: z.literal('INGEN_FRAGA').optional(),
          }),
        }),
      )
      .min(1),
  })
  .superRefine((korpus, ctx) => {
    for (const samling of [korpus.poster, korpus.bankrader]) {
      if (new Set(samling.map((r) => r.id)).size !== samling.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'Korpusens id:n måste vara unika inom varje samling',
        })
      }
    }
    for (const rad of korpus.bankrader) {
      if (
        rad.facit.avi !== null &&
        rad.facit.avi !== INGEN_AVI &&
        !korpus.poster.some((p) => p.id === rad.facit.avi)
      ) {
        ctx.addIssue({ code: 'custom', message: `Facit pekar på okänd post: ${rad.id}` })
      }
    }
  })
export type Betalningskorpus = z.infer<typeof BetalningskorpusSchema>
type Svar = Record<string, string | null>
export interface Modellutfall {
  input: unknown
  stopReason: string | null
  tokensIn: number
  tokensUt: number
}
// Bara bankrad och kandidater passerar gränsen. Facit får aldrig nå modellen.
export type Betalningsmodell = (
  rad: Bankrad,
  kandidater: readonly RankadKandidat[],
) => Promise<Modellutfall>

export interface Betalningsmatpunkt {
  id: string
  grupp: string
  kontroll: boolean
  regelTyp: string
  antalKandidater: number
  rattPostIMangden: boolean | null
  facit: Svar
  regler: Svar | null
  kombinerat: Svar | null
  modellstatus: 'EJ_BEHOV' | 'AVSTANGD' | 'SVAR' | 'AVVISAT' | 'FEL' | 'EJ_KORD'
}

/** Saknat/avvisat svar behåller sin plats i nämnaren. Bara saknat FACIT undantas. */
export function faltmatning(rader: readonly Betalningsmatpunkt[], lage: 'regler' | 'kombinerat') {
  return SKUGGFALT_BETALNING.map(({ nyckel, etikett }) => {
    const medFacit = rader.filter((r) => !r.kontroll && r.facit[nyckel] != null)
    const ratt = medFacit.filter((r) => r[lage]?.[nyckel] === r.facit[nyckel]).length
    const besvarade = medFacit.filter((r) => r[lage]?.[nyckel] != null).length
    return {
      falt: nyckel,
      etikett,
      ratt,
      antal: medFacit.length,
      besvarade,
      saknadeSvar: medFacit.length - besvarade,
      procent: medFacit.length === 0 ? null : (100 * ratt) / medFacit.length,
    }
  })
}

/** Samma facit-rader för båda armarna; reglernas obesvarade fall räknas också. */
export function sammanfattaBetalningar(rader: readonly Betalningsmatpunkt[], medModell: boolean) {
  const regler = faltmatning(rader, 'regler')
  const kombinerat = faltmatning(rader, 'kombinerat')
  const kontroller = rader.filter((r) => r.kontroll)
  const felKontroller = rader
    .filter((r) => r.kontroll !== (r.regelTyp === 'INGEN_FRAGA'))
    .map((r) => r.id)
  const recallRader = rader.filter((r) => !r.kontroll && r.rattPostIMangden !== null)
  const tekniskaFel = rader
    .filter((r) => ['FEL', 'EJ_KORD', 'AVVISAT'].includes(r.modellstatus))
    .map((r) => r.id)
  return {
    antal: rader.length,
    kontroller: { antal: kontroller.length, fel: felKontroller },
    recall: {
      ratt: recallRader.filter((r) => r.rattPostIMangden).length,
      antal: recallRader.length,
    },
    regler,
    kombinerat,
    skillnadProcentenheter: kombinerat.map((m, i) => ({
      falt: m.falt,
      skillnad:
        m.procent === null || regler[i]?.procent == null ? null : m.procent - regler[i]!.procent!,
    })),
    tekniskaFel,
    // Minst 80 % på ALLA fält, med verklig modellkörning och utan tekniska bortfall.
    etappB: !medModell
      ? 'BLOCKERAT'
      : felKontroller.length === 0 &&
          tekniskaFel.length === 0 &&
          kombinerat.every((m) => m.procent !== null && m.procent >= 80)
        ? 'GODKAND'
        : 'UNDERKAND',
    grupper: [...new Set(rader.map((r) => r.grupp))].sort().map((grupp) => ({
      grupp,
      regler: faltmatning(
        rader.filter((r) => r.grupp === grupp),
        'regler',
      ),
      kombinerat: faltmatning(
        rader.filter((r) => r.grupp === grupp),
        'kombinerat',
      ),
    })),
  }
}

export async function mataBetalningar(korpus: Betalningskorpus, modell?: Betalningsmodell) {
  const kandidater = korpus.poster.map((p) => ({ ...p, forfallodatum: new Date(p.forfallodatum) }))
  const rader: Betalningsmatpunkt[] = []
  let tokensIn = 0
  let tokensUt = 0
  let avbruten = false
  let modellanrop = 0
  for (const r of korpus.bankrader) {
    const rad: Bankrad = {
      id: r.id,
      datum: new Date(r.datum),
      text: r.text,
      belopp: r.belopp,
      rawOcr: r.rawOcr,
    }
    const regel = provaKandidater(rad, kandidater)
    const nej = { avi: INGEN_AVI, belopp: 'FULL', motpart: OKAND_MOTPART }
    const punkt: Betalningsmatpunkt = {
      id: r.id,
      grupp: r.facit.grupp,
      kontroll: r.facit.regel === 'INGEN_FRAGA',
      regelTyp: regel.typ,
      antalKandidater: regel.typ === 'KANDIDATER' ? regel.kandidater.length : 0,
      rattPostIMangden:
        r.facit.avi === null || r.facit.avi === INGEN_AVI
          ? null
          : regel.typ === 'KANDIDATER' && regel.kandidater.some((k) => k.id === r.facit.avi),
      facit: { avi: r.facit.avi, belopp: r.facit.belopp, motpart: r.facit.motpart },
      regler: regel.typ === 'INGEN' ? nej : null,
      kombinerat: regel.typ === 'INGEN' ? nej : null,
      modellstatus: 'EJ_BEHOV',
    }
    if (regel.typ === 'KANDIDATER') {
      if (!modell) punkt.modellstatus = 'AVSTANGD'
      else if (avbruten) punkt.modellstatus = 'EJ_KORD'
      else {
        try {
          modellanrop++
          const svar = await modell(rad, regel.kandidater)
          tokensIn += svar.tokensIn
          tokensUt += svar.tokensUt
          const val =
            svar.stopReason === 'max_tokens'
              ? null
              : tolkaBetalningssvar(svar.input, regel.kandidater)
          punkt.modellstatus = val ? 'SVAR' : 'AVVISAT'
          if (val) {
            const vald = regel.kandidater.find((k) => k.id === val.avi)
            punkt.kombinerat = {
              avi: val.avi,
              belopp: vald ? beloppsutfall(rad.belopp, vald.utestaende) : 'FULL',
              motpart: vald?.motpartId ?? OKAND_MOTPART,
            }
          }
        } catch {
          // Avbryt fler anrop vid nät-/kreditfel, men spara HELA nämnaren.
          // Råfel kan bära banktext eller credentials och hör inte i rapporten.
          punkt.modellstatus = 'FEL'
          avbruten = true
        }
      }
    }
    rader.push(punkt)
  }
  return {
    ...sammanfattaBetalningar(rader, modell !== undefined),
    rader,
    usage: { tokensIn, tokensUt, modellanrop, komplett: !avbruten },
  }
}
