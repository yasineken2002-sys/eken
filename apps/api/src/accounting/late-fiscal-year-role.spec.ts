/**
 * ROLLSPÄRREN FÖR SEN BOKFÖRING — den enda kontrollen som hindrar en MANAGER
 * eller ADMIN från att använda den nya vägen.
 *
 * ── VARFÖR FILEN FINNS ──────────────────────────────────────────────────────
 *
 * `late-fiscal-year-posting.db.spec.ts` skrev i sitt docblock att rollspärren
 * "prövas i late-fiscal-year-role.spec.ts". Den filen fanns inte. Ett påstående
 * om täckning som pekar på en fil som inte existerar är värre än ingen täckning
 * alls: nästa person läser det som att frågan är avklarad och tittar inte igen.
 *
 * ── VAD DEN MÄTER, OCH VAD DEN INTE KAN SE ──────────────────────────────────
 *
 * `assertFarBokforaSent` är en ren funktion; det här är hela dess kontrakt.
 * Filen kan INTE se att controllerna faktiskt anropar den före tjänsten — den
 * påkopplingen ägs av `authz-surface.golden.txt` och av controllernas egna
 * rader. Att skilja de två åt är poängen: en grön spec här betyder att regeln
 * är rätt, inte att den är påkopplad.
 */
import { ForbiddenException } from '@nestjs/common'

import { assertFarBokforaSent } from './closed-period'

describe('assertFarBokforaSent — bara OWNER får bokföra i ett stängt räkenskapsår', () => {
  it('OWNER släpps igenom', () => {
    expect(() => assertFarBokforaSent('OWNER')).not.toThrow()
  })

  // Rollerna som FÅR registrera betalningar men INTE flytta dem. Att de står
  // uppräknade och inte bara "någon annan roll" är avsiktligt: endpointen
  // släpper in MANAGER och ADMIN, så det är exakt de två som annars hade kunnat
  // använda vägen av misstag.
  it.each(['MANAGER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'])('%s avvisas', (roll) => {
    expect(() => assertFarBokforaSent(roll)).toThrow(ForbiddenException)
  })

  it('saknad roll avvisas — ett osatt fält är inte ett ja', () => {
    expect(() => assertFarBokforaSent(undefined)).toThrow(ForbiddenException)
  })

  it('meddelandet säger att beslutet inte går att ångra', () => {
    // Texten är det operatören faktiskt möter. En spärr som bara säger "nekad"
    // skickar hen att leta efter en återöppningsknapp som inte finns för ett
    // räkenskapsår.
    expect(() => assertFarBokforaSent('MANAGER')).toThrow(/kan inte öppnas igen/i)
  })
})
