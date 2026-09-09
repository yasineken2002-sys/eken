/** Fryst syntetisk kund, inte en uppmätt fördelning av riktiga bankbetalningar. */
import { createHash } from 'node:crypto'

export const KUNDFLODE_VERSION = 'kundflode-2000-v1'
export const MAX_MANUELLA = 20
export const ANTAL_BETALNINGAR = 2000
export const ANTAL_HYRESGASTER = 200
export const ANTAL_MANADER = 10

export type Betalningstyp =
  | 'OCR'
  | 'AVINUMMER'
  | 'DELBETALNING'
  | 'SAMLINGSBETALNING'
  | 'NAMN_OCH_PERIOD'
  | 'FELSKRIVEN_OCR'
  | 'INGEN_IDENTIFIERARE'
  | 'OVERBETALNING'
  | 'MOTSTRIDIGA_IDENTIFIERARE'

export interface Testhyresgast {
  index: number
  fastighet: number
  lagenhet: string
  fornamn: string
  efternamn: string
  hyraOre: number
}

export interface Testavi {
  id: string
  hyresgast: number
  period: number
  year: number
  month: number
  beloppOre: number
  nummer: string
  forfallodatum: string
}

export interface Testbetalning {
  id: string
  typ: Betalningstyp
  hyresgast: number
  period: number
  datum: string
  beloppOre: number
  text: string
  ocrFranHyresgast: number | null
  felskrivOcr: boolean
  /** Facit ligger separat från de bankfält som importeras/modellen får se. */
  facit: {
    avseddAvi: string
    allokeringar: { avi: string; beloppOre: number }[]
    granskningKravsAvUnderlaget: boolean
    skal: string
  }
}

export function testUuid(label: string): string {
  const h = createHash('sha256').update(`${KUNDFLODE_VERSION}:${label}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export function skapaKundflode() {
  const fornamn = [
    'Liv',
    'Noel',
    'Maja',
    'Axel',
    'Elin',
    'Oskar',
    'Alma',
    'Hugo',
    'Sara',
    'Erik',
    'Vera',
    'Nils',
    'Ellen',
    'Arvid',
    'Klara',
    'Isak',
    'Astrid',
    'Elias',
    'Freja',
    'Viktor',
  ]
  const efternamn = [
    'Bergman',
    'Lindgren',
    'Sundberg',
    'Holmgren',
    'Ekstrom',
    'Nyberg',
    'Lundqvist',
    'Sandberg',
    'Wikstrom',
    'Forsberg',
  ]
  const hyresgaster: Testhyresgast[] = Array.from({ length: ANTAL_HYRESGASTER }, (_, index) => ({
    index,
    fastighet: Math.floor(index / 20),
    lagenhet: String(1001 + (index % 20)),
    fornamn: fornamn[index % fornamn.length]!,
    efternamn: efternamn[Math.floor(index / fornamn.length)]!,
    // Återkommande hyror: belopp ska inte råka bli en unik personidentifierare.
    hyraOre: 510_000 + (index % 20) * 27_500 + (index % 3) * 25,
  }))
  // Kompletta månader oktober 2025–juli 2026, med både årsskifte och varierande längd.
  const avier: Testavi[] = []
  for (let period = 0; period < ANTAL_MANADER; period++) {
    const d = new Date(Date.UTC(2025, 9 + period, 28))
    for (const tenant of hyresgaster) {
      avier.push({
        id: `avi-${tenant.index}-${period}`,
        hyresgast: tenant.index,
        period,
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        beloppOre: tenant.hyraOre,
        nummer: `AVI-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(tenant.index + 1).padStart(4, '0')}`,
        forfallodatum: d.toISOString(),
      })
    }
  }
  const betalningar: Testbetalning[] = []
  for (const avi of avier) {
    const t = hyresgaster[avi.hyresgast]!
    const namn = `${t.fornamn} ${t.efternamn}`
    const periodtext = new Date(avi.forfallodatum).toLocaleDateString('sv-SE', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    })
    const day = 25 + (t.index % 4)
    const datum = new Date(Date.UTC(avi.year, avi.month - 1, day)).toISOString()
    const base: Testbetalning = {
      id: `betalning-${t.index}-${avi.period}`,
      typ: 'OCR',
      hyresgast: t.index,
      period: avi.period,
      datum,
      beloppOre: avi.beloppOre,
      text: `Hyra ${namn}`,
      ocrFranHyresgast: t.index,
      felskrivOcr: false,
      facit: {
        avseddAvi: avi.id,
        allokeringar: [{ avi: avi.id, beloppOre: avi.beloppOre }],
        granskningKravsAvUnderlaget: false,
        skal: 'Systemtilldelad OCR och rätt skuld.',
      },
    }
    if (t.index < 15) {
      // 15 hushåll betalar två månader tillsammans. Ingen bankrad den första månaden.
      if (avi.period % 2 === 0) continue
      base.typ = 'SAMLINGSBETALNING'
      base.beloppOre *= 2
      base.text = `Hyra ${namn}`
      base.facit.allokeringar = [
        { avi: `avi-${t.index}-${avi.period - 1}`, beloppOre: avi.beloppOre },
        { avi: avi.id, beloppOre: avi.beloppOre },
      ]
      base.facit.skal = 'Samma hyresgästs OCR; två öppna månader betalas äldst först.'
    } else if (t.index < 30 && avi.period % 2 === 0) {
      const first = Math.floor(avi.beloppOre * 0.4)
      for (const [part, ore] of [first, avi.beloppOre - first].entries()) {
        betalningar.push({
          ...base,
          id: `${base.id}-del-${part + 1}`,
          typ: 'DELBETALNING',
          datum: new Date(Date.UTC(avi.year, avi.month - 1, part === 0 ? 24 : 29)).toISOString(),
          beloppOre: ore,
          text: `Delbetalning ${namn}`,
          facit: {
            ...base.facit,
            allokeringar: [{ avi: avi.id, beloppOre: ore }],
            skal: 'Två olika bankhändelser reglerar samma avi med 40/60 procent.',
          },
        })
      }
      continue
    } else if (t.index >= 30 && t.index < 48) {
      base.typ = 'AVINUMMER'
      base.ocrFranHyresgast = null
      base.text = `Hyra ${avi.nummer} ${namn}`
      base.facit.skal = 'Helt systemtilldelat avinummer i banktexten.'
    } else if (t.index >= 48 && t.index < 54) {
      base.typ = 'NAMN_OCH_PERIOD'
      base.ocrFranHyresgast = null
      base.text = `Hyra ${periodtext} ${namn}`
      base.facit.skal = 'Fullständigt namn och uttrycklig månad; saknar OCR och avinummer.'
    } else if (t.index >= 54 && t.index < 56) {
      base.typ = 'FELSKRIVEN_OCR'
      base.felskrivOcr = true
      base.text = `Hyra ${periodtext} ${namn}`
      base.facit.skal = 'Fel kontrollsiffra i OCR; namn och månad anger avsedd skuld.'
    } else if (t.index === 56) {
      base.typ = 'INGEN_IDENTIFIERARE'
      base.ocrFranHyresgast = null
      base.text = 'Inbetalning'
      base.facit = {
        ...base.facit,
        allokeringar: [],
        granskningKravsAvUnderlaget: true,
        skal: 'Generatorn känner betalaren, men bankraden saknar identifierande uppgifter. Facit får inte användas som dolt stöd.',
      }
    } else if (t.index === 57) {
      base.typ = 'OVERBETALNING'
      base.beloppOre += 2500
      base.text = `Hyra ${avi.nummer} ${namn}`
      base.facit = {
        ...base.facit,
        allokeringar: [],
        granskningKravsAvUnderlaget: true,
        skal: '25 kr extra avser uttryckligen denna avi. Fördelning av överskott saknar kundbeslut.',
      }
    } else if (t.index === 58) {
      base.typ = 'MOTSTRIDIGA_IDENTIFIERARE'
      base.ocrFranHyresgast = 118
      base.text = `Hyra ${avi.nummer} ${namn}`
      base.facit = {
        ...base.facit,
        allokeringar: [],
        granskningKravsAvUnderlaget: true,
        skal: 'OCR pekar på ett annat hushåll än avinummer och fullnamn; kräver kontroll.',
      }
    }
    betalningar.push(base)
  }
  betalningar.sort((a, b) => a.datum.localeCompare(b.datum) || a.id.localeCompare(b.id))
  if (betalningar.length !== ANTAL_BETALNINGAR)
    throw new Error('Fel storlek på den frysta kundpopulationen')
  return { version: KUNDFLODE_VERSION, hyresgaster, avier, betalningar }
}
