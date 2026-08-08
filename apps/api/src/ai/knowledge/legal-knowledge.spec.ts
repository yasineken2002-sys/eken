import { LEGAL_KNOWLEDGE, LEGAL_DOCUMENT_IDS, getLegalDocument } from './legal-knowledge'

/**
 * Etapp 1 — fundamentet. Verifierar att den runtime-inbäddade lagtext-katalogen
 * laddar, bär metadata (säkerhetsgap D: verifierad-per), och att den verifierade
 * texten faktiskt innehåller den korrekta besittningsskydds-regeln (samma som
 * #129-fixen bygger på). Ingen retrieval/AI testas här — den byggs i Etapp 2.
 */
describe('Legal knowledge — runtime-katalog (Etapp 1)', () => {
  it('innehåller alla fem verifierade juridiklagar', () => {
    expect(LEGAL_DOCUMENT_IDS).toEqual(
      expect.arrayContaining([
        'hyreslagen',
        'bostadsrattslagen',
        'diskrimineringslagen',
        'bokforingslagen',
        'ranteslagen',
      ]),
    )
    expect(LEGAL_KNOWLEDGE).toHaveLength(5)
  })

  // #382: mervärdesskattelagen (1994:200) upphävdes 2023-07-01 och ersattes av
  // 2023:200 med ny struktur och andra paragrafnummer. Korpusen får inte
  // innehålla den — citat-integriteten hindrar PÅHITTADE lagrum men säger
  // ingenting om UPPHÄVDA: en paragraf som verkligen fanns 2026-05-29 citeras
  // med full trovärdighet som "gällande lydelse". Uppmätt före borttagningen:
  // relevansdomaren svarade JA på ML-chunkar för en momsfråga (3/3), varpå
  // koden hade tryckt "SFS 1994:200, gällande lydelse verifierad 2026-05-29".
  it('innehåller INTE den upphävda mervärdesskattelagen (1994:200)', () => {
    expect(LEGAL_DOCUMENT_IDS).not.toContain('mervardesskattelagen')
    expect(getLegalDocument('mervardesskattelagen')).toBeUndefined()
    for (const doc of LEGAL_KNOWLEDGE) {
      expect(doc.sfs).not.toBe('1994:200')
    }
  })

  it('varje dokument bär komplett metadata (säkerhetsgap D — versionering)', () => {
    for (const doc of LEGAL_KNOWLEDGE) {
      expect(doc.id).toMatch(/^[a-z]+$/)
      expect(doc.titel.length).toBeGreaterThan(0)
      expect(doc.sfs).toMatch(/^\d{4}:\d+$/)
      expect(doc.verifieradPer).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(doc.kalla).toMatch(/^https?:\/\//)
      expect(doc.innehall.length).toBeGreaterThan(50)
    }
  })

  it('getLegalDocument slår upp på id och returnerar undefined för okänt id', () => {
    const h = getLegalDocument('hyreslagen')
    expect(h?.sfs).toBe('1970:994')
    expect(h?.verifieradPer).toBe('2026-05-29')
    expect(getLegalDocument('finns-inte')).toBeUndefined()
  })

  it('hyreslagens verifierade text har KORREKT besittningsskydd (andrahand = tvåår)', () => {
    const h = getLegalDocument('hyreslagen')!
    // § 45 — tvåårsregeln gäller andrahandsupplåtelse, inte förstahand
    expect(h.innehall).toContain('## 45 §')
    expect(h.innehall).toContain('upplåtelse av en lägenhet i andra hand')
    expect(h.innehall).toContain('längre än två år i följd')
    // § 46 — förstahandshyresgästens förlängningsrätt (besittningsskydd)
    expect(h.innehall).toContain('## 46 §')
    expect(h.innehall).toContain('rätt till förlängning av avtalet')
  })

  it('innehållet är ordagrann lagtext (markdown med paragraf-rubriker)', () => {
    const h = getLegalDocument('hyreslagen')!
    expect(h.innehall.startsWith('# Hyreslagen')).toBe(true)
    // Frontmattern ska INTE läcka in i innehållet (den är metadata)
    expect(h.innehall).not.toContain('verifierad_per:')
  })
})
