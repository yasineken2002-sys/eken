import { describe, it, expect } from 'vitest'
import { sourceTarget, shortId } from './source-links'

/**
 * Filens påstående: en länk som inte leder dit den utger sig för att leda är
 * ett FALSKT PÅSTÅENDE om att posten går att slå upp. Tabeller utan destination
 * ska därför ge `null` och renderas som text — inte länkas till närmaste sida
 * för att allt ska se lika klickbart ut.
 */

describe('sourceTarget', () => {
  it('ger route och etikett för en tabell med destination', () => {
    expect(sourceTarget('Lease')).toEqual({ route: '/leases', label: 'Avtal' })
  })

  it('ger NULL för de tre tabeller som medvetet saknar vy', () => {
    // Uppräknade i filens kommentar som "medvetet, inte glömt". Skulle någon
    // länka dem till närmaste sida vore det just det falska påståendet.
    for (const tabell of ['KeyHandover', 'MiscCharge', 'TenantAnonymizationLog']) {
      expect(sourceTarget(tabell), `${tabell} fick en destination`).toBeNull()
    }
  })

  it('ger null för en okänd tabell i stället för att gissa', () => {
    expect(sourceTarget('HittePåTabell')).toBeNull()
    expect(sourceTarget('')).toBeNull()
  })

  it('pekar alltid på en absolut route när den pekar någonstans', () => {
    for (const tabell of ['Lease', 'InvoiceEvent', 'RentNoticeEvent', 'Meter', 'UnitEquipment']) {
      const mål = sourceTarget(tabell)
      expect(mål).not.toBeNull()
      expect(mål?.route).toMatch(/^\//)
      expect(mål?.label).toBeTruthy()
    }
  })

  it('låter två tabeller dela vy men behålla var sin etikett', () => {
    // Meter och ConsumptionCharge går båda till /consumption. Etiketten säger
    // vad användaren kommer TILL, och får inte slås ihop.
    expect(sourceTarget('Meter')?.route).toBe(sourceTarget('ConsumptionCharge')?.route)
    expect(sourceTarget('Meter')?.label).not.toBe(sourceTarget('ConsumptionCharge')?.label)
  })
})

describe('shortId', () => {
  it('kortar långa id och markerar att något klipptes', () => {
    const uuid = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
    expect(shortId(uuid)).toBe('0f1e2d3c…')
    // Ellipsen är inte dekoration: utan den ser fragmentet ut som ett helt id.
    expect(shortId(uuid)).toContain('…')
  })

  it('lämnar korta id orörda — och lägger inte på ellips', () => {
    expect(shortId('abc123')).toBe('abc123')
    expect(shortId('abc123')).not.toContain('…')
    expect(shortId('')).toBe('')
  })

  it('klipper först vid mer än åtta tecken', () => {
    // Gränsfallet åt båda håll, så en ändring från > till >= syns.
    expect(shortId('12345678')).toBe('12345678')
    expect(shortId('123456789')).toBe('12345678…')
  })
})
