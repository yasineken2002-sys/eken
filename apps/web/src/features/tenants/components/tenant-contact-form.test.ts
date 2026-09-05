import { describe, expect, it } from 'vitest'
import {
  bygguppdatering,
  epostSerRimligUt,
  kontaktFel,
  type Kontaktutkast,
} from './tenant-contact-form'

/**
 * Formulärets regler. Vitest renderar ingenting (`environment: 'node'`), så
 * provet ställs mot de rena funktionerna — vilket är skälet till att de bor
 * utanför komponenten.
 */

const utkast = (email: string, phone = ''): Kontaktutkast => ({ email, phone })

describe('kontaktFel', () => {
  it('giltig adress ger null', () => {
    expect(kontaktFel(utkast('anna@exempel.se'))).toBeNull()
  })

  it('TOM e-post avvisas med skälet, inte bara "ogiltig"', () => {
    // Meddelandet ska säga VARFÖR fältet inte får tömmas: hyresgästen nås via
    // adressen. "E-post krävs" hade lämnat frågan varför.
    const fel = kontaktFel(utkast(''))
    expect(fel).toContain('kan inte tas bort')
  })

  it('blanktecken räknas som tomt', () => {
    expect(kontaktFel(utkast('   '))).toContain('kan inte tas bort')
  })

  it.each(['ingen-snabel', '@ledande', 'avslutande@', 'med mellanslag@x.se'])(
    'uppenbart trasig adress "%s" avvisas',
    (v) => {
      expect(kontaktFel(utkast(v))).toContain('giltig')
    },
  )
})

describe('epostSerRimligUt — MEDVETET grov', () => {
  it('släpper igenom det servern skulle acceptera', () => {
    // Kontrollen är en bekvämlighet, inte auktoriteten. En egen exakt regex hade
    // blivit en andra sanning som avviker från serverns `@IsEmail()` — och
    // avvikelsen visar sig som ett fält användaren inte får spara trots att
    // adressen är giltig.
    for (const adress of ['a@b.se', 'anna.andersson+tag@exempel.co.uk', 'x@y']) {
      expect(epostSerRimligUt(adress)).toBe(true)
    }
  })
})

describe('bygguppdatering — bara det som ändrats', () => {
  const utgang: Kontaktutkast = { email: 'anna@exempel.se', phone: '070-1234567' }

  it('oförändrat ger null — ingen tom rad i historiken', () => {
    // Skälet är spårbarhet, inte sparsamhet: en PATCH som skriver tillbaka samma
    // e-post är en ändring i hyresgästens historik som ingen gjorde.
    expect(bygguppdatering(utgang, { ...utgang })).toBeNull()
  })

  it('bara e-post ändrad → bara e-post skickas', () => {
    expect(bygguppdatering(utgang, { ...utgang, email: 'ny@exempel.se' })).toEqual({
      email: 'ny@exempel.se',
    })
  })

  it('bara telefon ändrad → bara telefon skickas', () => {
    expect(bygguppdatering(utgang, { ...utgang, phone: '070-0000000' })).toEqual({
      phone: '070-0000000',
    })
  })

  it('båda ändrade → båda skickas', () => {
    expect(bygguppdatering(utgang, { email: 'ny@exempel.se', phone: '08-123456' })).toEqual({
      email: 'ny@exempel.se',
      phone: '08-123456',
    })
  })

  it('TELEFON får tömmas och skickas då som tom sträng, inte undefined', () => {
    // `undefined` hade betytt "rör inte fältet" och numret hade blivit kvar.
    // En hyresgäst som byter till att bara nås via e-post ska kunna det.
    const u = bygguppdatering(utgang, { ...utgang, phone: '' })
    expect(u).toEqual({ phone: '' })
    expect(u).toHaveProperty('phone')
  })

  it('omgivande blanktecken räknas inte som en ändring', () => {
    expect(
      bygguppdatering(utgang, { email: '  anna@exempel.se  ', phone: ' 070-1234567 ' }),
    ).toBeNull()
  })

  it('utgångsläge utan telefon: att skriva in ett nummer är en ändring', () => {
    const tomt: Kontaktutkast = { email: 'a@b.se', phone: '' }
    expect(bygguppdatering(tomt, { ...tomt, phone: '070-1' })).toEqual({ phone: '070-1' })
  })
})
