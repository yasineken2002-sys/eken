/** Endast experiment: ingen import från producenten eller bokföringsvägen. */
import {
  normalisera,
  namnTraff,
  ocrAvstand,
  type Bankrad,
  type Kandidat,
  type RankadKandidat,
} from '../payment/payment-candidates'

/** Matcha hela referensen, inte HY-60 inuti HY-601 eller en del av ett ord. */
export function harHelReferens(text: string, referens: string): boolean {
  const ref = normalisera(referens)
  return ref.length > 0 && ` ${normalisera(text)} `.includes(` ${ref} `)
}

export function berikaReferenser(
  rad: Bankrad,
  poster: readonly Kandidat[],
  befintliga: readonly RankadKandidat[],
): { kandidater: RankadKandidat[]; referenser: string[]; tvetydigtNamn: boolean } {
  const explicita = poster.filter((p) => harHelReferens(rad.text, p.nummer))
  const tillagda = explicita.filter((p) => !befintliga.some((k) => k.id === p.id))
  const kandidater = [
    ...befintliga,
    ...tillagda.map((p) => ({
      ...p,
      ocrAvstand: ocrAvstand(rad.rawOcr, p.ocr),
      beloppsavvikelse: Math.abs(rad.belopp - p.utestaende),
      dagarFranForfall: Math.round(
        Math.abs(rad.datum.getTime() - p.forfallodatum.getTime()) / 86400000,
      ),
      namnTraff: namnTraff(rad.text, p.motpartNamn),
      signaler: ['hela avinumret står i banktexten; identifiering, inte bokföringsbeslut'],
    })),
  ]
  const namnposter = poster.filter((p) => namnTraff(rad.text, p.motpartNamn))
  const personer = new Set(namnposter.map((p) => p.motpartId).filter((id) => id !== null))
  const helaNamn = new Set(
    namnposter
      .filter((p) => p.motpartNamn && harHelReferens(rad.text, p.motpartNamn))
      .map((p) => p.motpartId)
      .filter((id) => id !== null),
  )
  const ocrSignal = poster.some((p) => {
    const avstand = ocrAvstand(rad.rawOcr, p.ocr)
    return avstand !== null && avstand <= 1
  })
  return {
    kandidater,
    referenser: explicita.map((p) => p.id),
    // En enda fullständig personidentitet eller OCR/referens kan skilja namn.
    // Kandidaterna behålls även vid konflikt; beslutet markeras som oklart.
    tvetydigtNamn: explicita.length === 0 && !ocrSignal && personer.size > 1 && helaNamn.size !== 1,
  }
}
