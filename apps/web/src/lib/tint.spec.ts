import { describe, it, expect } from 'vitest'
import { tint, TINT } from './tint'

/**
 * Filens påstående: bytet från strängkonkatenering (`${color}14`) till `tint()`
 * ska vara FÄRGNEUTRALT för hex, och samtidigt göra det möjligt att skicka en
 * CSS-variabel utan att tinten faller bort.
 *
 * Regressionen den skrevs mot är tyst: `var(--ev-brand)14` är ogiltig CSS, så
 * tinten försvann helt utan att något kastade.
 */

describe('tint — hex', () => {
  it('översätter hex till rgba med alfan som TAL', () => {
    expect(tint('#000000', 0.5)).toBe('rgba(0, 0, 0, 0.5)')
    expect(tint('#ffffff', 1)).toBe('rgba(255, 255, 255, 1)')
  })

  it('läser alla tre kanalerna, inte bara en', () => {
    // Ett prov på #000000 ensamt hade varit grönt även om g och b lästes ur
    // fel position i strängen.
    expect(tint('#0a141e', 0.5)).toBe('rgba(10, 20, 30, 0.5)')
  })

  it('är skiftlägesokänsligt', () => {
    expect(tint('#AABBCC', 0.25)).toBe(tint('#aabbcc', 0.25))
  })

  it('tål omgivande blanksteg', () => {
    expect(tint('  #0a141e  ', 0.5)).toBe('rgba(10, 20, 30, 0.5)')
  })
})

describe('tint — allt annat', () => {
  it('blandar CSS-variabler med color-mix i stället för att ge ogiltig CSS', () => {
    // Hela syftet med funktionen. Utfallet ska vara giltig CSS som webbläsaren
    // löser upp vid rendering.
    expect(tint('var(--ev-brand)', 0.5)).toBe(
      'color-mix(in srgb, var(--ev-brand) 50%, transparent)',
    )
  })

  it('behandlar kortformen #abc som icke-hex — den matchar inte sexsiffersformen', () => {
    // Dokumenterar gränsen: bara exakt sex hexsiffror går rgba-vägen.
    expect(tint('#abc', 0.5)).toContain('color-mix')
  })

  it('hanterar rgb() och färgnamn', () => {
    expect(tint('rgb(1, 2, 3)', 0.1)).toBe('color-mix(in srgb, rgb(1, 2, 3) 10%, transparent)')
    expect(tint('red', 0.2)).toBe('color-mix(in srgb, red 20%, transparent)')
  })
})

describe('TINT-nivåerna', () => {
  it('motsvarar exakt de gamla hex-suffixen', () => {
    // Påståendet "bit för bit identiskt med ${hex}14". Glider talen är bytet
    // inte längre färgneutralt, och ingen skulle märka det.
    expect(TINT.faint).toBeCloseTo(0x08 / 255, 10)
    expect(TINT.soft).toBeCloseTo(0x14 / 255, 10)
    expect(TINT.medium).toBeCloseTo(0x18 / 255, 10)
  })

  it('är stigande', () => {
    expect(TINT.faint).toBeLessThan(TINT.soft)
    expect(TINT.soft).toBeLessThan(TINT.medium)
  })
})
