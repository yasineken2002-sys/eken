import { describe, it, expect } from 'vitest'
import { summarizeGaps } from './gap-summary'
import type { GapResult, GapStatus } from '../api/history.api'

/**
 * "DEN VIKTIGASTE FUNKTIONEN I HELA FLIKEN", enligt filens egen rubrik, och
 * skälet är att två helt olika besked ser likadana ut i ett gränssnitt som bara
 * visar det som finns:
 *
 *   "inget saknas"                    ← ett friskintyg
 *   "vi vet inte vad som borde hänt"  ← frånvaro av kunskap
 *
 * Proven riktas mot de tre reglerna filen ställer upp, och särskilt mot
 * fallback-riktningen: det okända ska FRAMHÄVAS, inte tystas.
 */

const gap = (status: string, key = `k-${status}`): GapResult =>
  ({ key, label: key, status, source: 'LEASE', detail: '' }) as unknown as GapResult

describe('summarizeGaps — okänd status', () => {
  it('framhäver en status funktionen inte känner igen, i stället för att godkänna den', () => {
    // Kärnan i regel 3. `GapStatus` är VÅR KOPIA av API:ts typ, så ett femte
    // utfall kan dyka upp utan att kompilatorn säger något. Ett `default:
    // uppfyllt` hade gjort det till ett tyst godkännande.
    const s = summarizeGaps([gap('NÅGOT_NYTT_FRÅN_API' as GapStatus)])
    expect(s.antalOkända).toBe(1)
    expect(s.framhävda).toHaveLength(1)
    expect(s.vilande).toHaveLength(0)
    expect(s.alltUppfyllt).toBe(false)
  })

  it('nämner det okända i meningen, så någon kan agera på det', () => {
    const s = summarizeGaps([gap('UPPFYLLD'), gap('ZZ_OKÄND' as GapStatus)])
    expect(s.mening).toContain('känns inte igen')
  })
})

describe('summarizeGaps — alltUppfyllt kräver alla fyra villkoren', () => {
  it('är sant bara när något är mätbart och inget brustit, är odefinierat eller okänt', () => {
    expect(summarizeGaps([gap('UPPFYLLD'), gap('GÄLLER_EJ')]).alltUppfyllt).toBe(true)
  })

  it('är FALSKT när ingenting är mätbart — tomhet är inget friskintyg', () => {
    // Utan villkoret "minst en mätbar" hade en tom lista renderat grönt, vilket
    // är exakt den lugna tomma ytan filen finns för att undvika.
    expect(summarizeGaps([]).alltUppfyllt).toBe(false)
    expect(summarizeGaps([gap('GÄLLER_EJ')]).alltUppfyllt).toBe(false)
  })

  it('är falskt vid en lucka', () => {
    expect(summarizeGaps([gap('UPPFYLLD'), gap('LUCKA')]).alltUppfyllt).toBe(false)
  })

  it('är falskt vid en odefinierad förväntan', () => {
    expect(summarizeGaps([gap('UPPFYLLD'), gap('ODEFINIERAD')]).alltUppfyllt).toBe(false)
  })

  it('är falskt vid en okänd status', () => {
    expect(summarizeGaps([gap('UPPFYLLD'), gap('ZZ' as GapStatus)]).alltUppfyllt).toBe(false)
  })
})

describe('summarizeGaps — indelningen', () => {
  it('låter bara UPPFYLLD och GÄLLER_EJ vila hopfällda', () => {
    const s = summarizeGaps([gap('UPPFYLLD'), gap('GÄLLER_EJ'), gap('LUCKA'), gap('ODEFINIERAD')])
    expect(s.vilande.map((g) => g.status).sort()).toEqual(['GÄLLER_EJ', 'UPPFYLLD'])
    expect(s.framhävda.map((g) => g.status)).toEqual(['LUCKA', 'ODEFINIERAD'])
  })

  it('sorterar luckor före odefinierade — en bruten förväntan är mer akut', () => {
    const s = summarizeGaps([gap('ODEFINIERAD'), gap('LUCKA')])
    expect(s.framhävda[0]?.status).toBe('LUCKA')
  })

  it('tappar inga rader: framhävda + vilande = indata', () => {
    // Totalitetsprovet. En rad som varken framhävs eller vilar är en rad som
    // försvunnit ur gränssnittet utan att något blivit rött.
    const in_ = [
      gap('UPPFYLLD'),
      gap('LUCKA'),
      gap('GÄLLER_EJ'),
      gap('ODEFINIERAD'),
      gap('ZZ' as GapStatus),
    ]
    const s = summarizeGaps(in_)
    expect(s.framhävda.length + s.vilande.length).toBe(in_.length)
  })
})

describe('summarizeGaps — meningen ovanför raderna', () => {
  it('säger rakt ut när ingenting går att beräkna', () => {
    expect(summarizeGaps([]).mening).toBe(
      'Inga förväntningar är definierade — ingen lucka kan beräknas här.',
    )
  })

  it('DET KRITISKA FALLET: noll luckor men odefinierade får inte låta som ett friskintyg', () => {
    // Filens egen markering. Meningen måste säga att kunskap SAKNAS, inte att
    // allt är bra — annars är hela luckberäkningen förlorad i formuleringen.
    const s = summarizeGaps([gap('UPPFYLLD'), gap('ODEFINIERAD')])
    expect(s.antalLuckor).toBe(0)
    expect(s.mening).toContain('vi vet inte vad som borde ha hänt')
    expect(s.mening).toContain('odefinierad')
  })

  it('räknar luckor mot MÄTBARA, inte mot alla rader', () => {
    // Nämnaren är det som gör talet ärligt: 1 av 2 mätbara, inte 1 av 4 rader.
    const s = summarizeGaps([gap('LUCKA'), gap('UPPFYLLD'), gap('GÄLLER_EJ'), gap('GÄLLER_EJ')])
    expect(s.antalMätbara).toBe(2)
    expect(s.mening).toContain('1 lucka')
    expect(s.mening).toContain('2 mätbara')
  })
})
