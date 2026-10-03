/**
 * KUNDSTART-001 §4 + §11 (BYGGLEDARE-002): startavstämning per konto. Ren funktion.
 *
 * En differens mellan paketets totaler och kundens Fortnox-saldo per brytdatum kan INTE
 * godkännas bort. Tre utfall, inget fjärde:
 *  - AVSTAMD:   differensen är 0.
 *  - AVGRANSAD: hela (positiva) differensen förklaras av en uppladdad specifikation av en
 *               separat reskontra — sha256, antal poster och summa öre, där summan är
 *               EXAKT lika med differensen. Kontot kallas aldrig avstämt.
 *  - DIFFERENS: allt annat. Blockerar aktivering och varje påstående om fullständigt
 *               övertagande.
 * Saknas ett saldo är paketet inte avstämt alls (status null) — det blockerar också.
 *
 * Tecken: 1510 anges som debetsaldo och 2890 som kreditsaldo, båda som positiva tal.
 * Differens = Fortnox − paket. En negativ differens (paketet säger mer än Fortnox) kan
 * inte förklaras av en separat reskontra och förblir DIFFERENS.
 */
import { brytdatumIso } from './cutover'

export type Konto = '1510' | '2890'
export const KONTON: Konto[] = ['1510', '2890']

export interface SeparatSpec {
  sha256: string
  antal: number
  summaOre: number
  beskrivning: string
  filnamn: string
  /** S5-1: den separata reskontrans system och ansvarig (obligatoriska). */
  system: string
  ansvarig: string
  poster: { postId: string; motpart: string; dokument: string; ore: number }[]
}

export interface KontoAvstamning {
  konto: Konto
  paketOre: number
  fortnoxOre: number | null
  differensOre: number | null
  spec: Omit<SeparatSpec, 'poster'> | null
  status: 'AVSTAMD' | 'AVGRANSAD' | 'DIFFERENS' | 'SALDO_SAKNAS'
  text: string
}

export interface Avstamning {
  status: 'AVSTAMD' | 'AVGRANSAD' | 'DIFFERENS' | null
  konton: KontoAvstamning[]
  beraknad: string
}

const kr = (ore: number) =>
  `${(ore / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`

export function stamAv(input: {
  cutover: Date
  paketOre: Record<Konto, number>
  fortnoxOre: Record<Konto, number | null>
  spec: Partial<Record<Konto, SeparatSpec | null>>
  nu?: Date
}): Avstamning {
  const datum = brytdatumIso(input.cutover)
  const konton: KontoAvstamning[] = KONTON.map((konto) => {
    const paketOre = input.paketOre[konto]
    const fortnoxOre = input.fortnoxOre[konto]
    const s = input.spec[konto] ?? null
    const specUt = s
      ? {
          sha256: s.sha256,
          antal: s.antal,
          summaOre: s.summaOre,
          beskrivning: s.beskrivning,
          filnamn: s.filnamn,
          system: s.system,
          ansvarig: s.ansvarig,
        }
      : null
    if (fortnoxOre === null)
      return {
        konto,
        paketOre,
        fortnoxOre,
        differensOre: null,
        spec: specUt,
        status: 'SALDO_SAKNAS',
        text: `Fortnox-saldo för ${konto} per ${datum} är inte angivet — kontot är inte avstämt.`,
      }
    const differensOre = fortnoxOre - paketOre
    if (differensOre === 0)
      return {
        konto,
        paketOre,
        fortnoxOre,
        differensOre,
        spec: specUt,
        status: 'AVSTAMD',
        text: `Konto ${konto} är avstämt per ${datum}: paketet ${kr(paketOre)} = Fortnox ${kr(fortnoxOre)}.`,
      }
    if (s && differensOre > 0 && s.summaOre === differensOre && s.antal > 0)
      return {
        konto,
        paketOre,
        fortnoxOre,
        differensOre,
        spec: specUt,
        status: 'AVGRANSAD',
        text:
          `Avgränsat övertagande — kontot ${konto} är INTE avstämt i sin helhet; ` +
          `${kr(differensOre)} ligger i separat reskontra enligt specifikation ` +
          `${s.filnamn} (sha256 ${s.sha256.slice(0, 12)}…, ${s.antal} poster med identitet; ` +
          `system ${s.system}, ansvarig ${s.ansvarig}): ${s.beskrivning}`,
      }
    const specFel = s
      ? ` Specifikationen ${s.filnamn} summerar ${kr(s.summaOre)} och förklarar inte differensen exakt.`
      : ''
    return {
      konto,
      paketOre,
      fortnoxOre,
      differensOre,
      spec: specUt,
      status: 'DIFFERENS',
      text:
        `Oförklarad differens på konto ${konto} per ${datum}: Fortnox ${kr(fortnoxOre)}, ` +
        `paketet ${kr(paketOre)}, differens ${kr(differensOre)}.${specFel} Differensen kan ` +
        'inte godkännas bort; den löses med specificerade rader (ny paketversion), en ' +
        'spårbar rättelse i Fortnox eller en verifierbar specifikation av separat reskontra.',
    }
  })
  const st = konton.map((k) => k.status)
  const status = st.includes('SALDO_SAKNAS')
    ? null
    : st.includes('DIFFERENS')
      ? 'DIFFERENS'
      : st.includes('AVGRANSAD')
        ? 'AVGRANSAD'
        : 'AVSTAMD'
  return { status, konton, beraknad: (input.nu ?? new Date()).toISOString() }
}
