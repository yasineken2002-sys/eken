import { describe, it, expect } from 'vitest'
import { sanitizeFilename } from './download'

/**
 * `sanitizeFilename` är den rena halvan av download.ts. Den andra halvan,
 * `openPresignedDownload`, rör DOM:en och provas inte här — webs vitest kör i
 * node-miljö med flit (se vitest.config.ts). Det är en medveten gräns, inte en
 * glömska: den funktionen hör hemma i ett prov med jsdom den dagen ett sådant
 * behövs.
 *
 * Påståendet: filnamnet som når webbläsarens `download`-attribut ska vara
 * ofarligt, ändligt och aldrig tomt.
 */

describe('sanitizeFilename', () => {
  it('släpper igenom ett normalt filnamn orört', () => {
    expect(sanitizeFilename('avtal-2026.pdf')).toBe('avtal-2026.pdf')
    expect(sanitizeFilename('Avi (kopia) 3.pdf')).toBe('Avi (kopia) 3.pdf')
  })

  it('ersätter tecken som inte hör hemma i ett filnamn', () => {
    // Sökvägsseparatorer är det som betyder något: ett filnamn som innehåller
    // "/" eller ".." är inte ett filnamn längre.
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('/')
    expect(sanitizeFilename('a/b\\c.pdf')).toBe('a_b_c.pdf')
    expect(sanitizeFilename('rapport:2026*.pdf')).toBe('rapport_2026_.pdf')
  })

  it('slår ihop en följd av otillåtna tecken till ETT understreck', () => {
    // Regexen är `+`-kvantifierad. Utan det blir namnen absurt långa.
    expect(sanitizeFilename('a###b')).toBe('a_b')
  })

  it('trimmar kanterna före sanering', () => {
    expect(sanitizeFilename('   avtal.pdf   ')).toBe('avtal.pdf')
  })

  it('kapar vid 200 tecken', () => {
    const långt = 'a'.repeat(500) + '.pdf'
    expect(sanitizeFilename(långt)).toHaveLength(200)
  })

  it('faller tillbaka när ingenting återstår — aldrig ett tomt filnamn', () => {
    // Ett tomt `download`-attribut får webbläsaren att hitta på ett eget namn,
    // ofta "download" utan ändelse.
    expect(sanitizeFilename('')).toBe('fil')
    expect(sanitizeFilename('   ')).toBe('fil')
    expect(sanitizeFilename('///')).not.toBe('')
  })

  it('respekterar en egen fallback', () => {
    expect(sanitizeFilename('', 'avi.pdf')).toBe('avi.pdf')
  })

  it('DOKUMENTERAD BEGRÄNSNING: å/ä/ö ersätts, eftersom \\w är ASCII', () => {
    // Det här provet FASTSTÄLLER inte att beteendet är önskvärt — det gör
    // synligt att det finns. `\w` är ASCII-definierat (samma familj som
    // ordgräns-fällan i CLAUDE.md), så "Jönsson" blir "J_nsson" i ett svenskt
    // system. Ändras regexen till att tillåta bokstäver med diakriter ska det
    // här provet ändras MEDVETET, inte upptäckas av en trasig nedladdning.
    expect(sanitizeFilename('hyresavi-jönsson.pdf')).toBe('hyresavi-j_nsson.pdf')
  })
})
