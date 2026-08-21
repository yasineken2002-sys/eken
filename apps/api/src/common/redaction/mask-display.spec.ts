/**
 * Maskering vid VISNING (#507).
 *
 * INGA VERKLIGA PERSONUPPGIFTER. Personnumret nedan är konstruerat på ett datum
 * som inte finns (30 februari), e-posten pekar på en reserverad testdomän, och
 * kontonumren är påhittade. Ingen av dem kan tillhöra någon.
 */

import { maskAiContentForDisplay, maskForDisplay } from './mask-display'
import { DISPLAY_PATTERNS, REPLACEMENT } from './patterns'

/** Värden som MÅSTE maskeras — ett per mönster i DISPLAY_PATTERNS. */
const MÅSTE_MASKERAS: Array<{ vad: string; värde: string }> = [
  { vad: 'personnummer', värde: '19000230-0000' },
  { vad: 'personnummer utan sekel', värde: '000230-0000' },
  { vad: 'organisationsnummer', värde: '556000-0001' },
  { vad: 'e-post', värde: 'ingen.person@example.invalid' },
  { vad: 'mobilnummer', värde: '070-000 00 00' },
  { vad: 'fast nummer', värde: '08-000 00 00' },
  { vad: 'OCR-nummer', värde: '00000000019' },
  { vad: 'bankgiro', värde: '0000-0001' },
  { vad: 'plusgiro', värde: '0000000-1' },
  { vad: 'clearing + konto', värde: '0000-1, 000 000 000-1' },
  { vad: 'IBAN', värde: 'SE00 0000 0000 0000 0000 0001' },
]

describe('maskForDisplay', () => {
  it.each(MÅSTE_MASKERAS)('maskerar $vad', ({ värde }) => {
    const ut = maskForDisplay(`Underlaget innehåller ${värde} i löptext.`)
    expect(ut).toContain(REPLACEMENT)
    expect(ut).not.toContain(värde)
  })

  it('lämnar vanlig text orörd', () => {
    const text = 'Hyresgästen hörde av sig om en droppande kran i badrummet.'
    expect(maskForDisplay(text)).toBe(text)
  })

  it('MASKERAR INTE NAMN — det är ett beslut, inte en lucka', () => {
    // Se docblocket i mask-display.ts: ett mönster på namn träffar antingen för
    // brett (ortnamn, rubriker) eller för smalt (bara vanliga förnamn), och båda
    // är sämre än att inte maskera alls. Testet fastnaglar beslutet så att en
    // framtida "förbättring" med en namnregex blir synlig här.
    const text = 'Anna Karlsson på Stora Torget 4 ringde om Hyra Januari.'
    expect(maskForDisplay(text)).toBe(text)
  })

  it('lämnar belopp och årtal i fred', () => {
    const text = 'Fakturan på 10 000 kr förföll 2026-03-31 och avser period 2026.'
    expect(maskForDisplay(text)).toBe(text)
  })

  it('maskerar flera förekomster i samma sträng', () => {
    const ut = maskForDisplay('Kontakt: ingen@example.invalid och 070-000 00 00.')
    expect(ut).not.toContain('example.invalid')
    expect(ut).not.toContain('070-000 00 00')
  })

  it('är idempotent — maskerad text maskeras inte sönder', () => {
    const en = maskForDisplay('Personnummer 19000230-0000.')
    expect(maskForDisplay(en)).toBe(en)
  })
})

// ── KANARIEFÅGEL ─────────────────────────────────────────────────────────────
//
// De namngivna testerna ovan skyddar mot specifika återfall: tas ETT mönster
// bort faller just dess rad. De upptäcker inte att listan krympt på ett sätt
// ingen skrev ett test för — och en mönsterlista är precis den sortens sak som
// någon "städar" i.
//
// Kanariefågeln binder antalet: varje mönster i DISPLAY_PATTERNS måste ha ett
// värde i MÅSTE_MASKERAS som faktiskt maskeras. Läggs ett mönster till utan ett
// prov, eller tas ett bort, blir den här röd i stället för tyst grön.
describe('KANARIEFÅGEL — mönsterlistan mäter fortfarande', () => {
  it('varje värde i provuppsättningen maskeras', () => {
    const omaskerade = MÅSTE_MASKERAS.filter(
      ({ värde }) => !maskForDisplay(värde).includes(REPLACEMENT),
    )
    expect(omaskerade.map((o) => o.vad)).toEqual([])
  })

  it('provuppsättningen täcker minst lika många fall som listan har mönster', () => {
    // Antalet är poängen: en lista som tappat ett mönster upptäcks inte av en
    // provuppsättning som krympt i samma commit.
    expect(MÅSTE_MASKERAS.length).toBeGreaterThanOrEqual(DISPLAY_PATTERNS.length)
  })

  it('och ren text ger INGEN maskering (maskeraren maskerar inte allt)', () => {
    expect(maskForDisplay('Ingen känslig uppgift här alls.')).not.toContain(REPLACEMENT)
  })
})

describe('maskAiContentForDisplay — rekursivt över ett samtal', () => {
  const samtal = {
    id: 'conv-1',
    title: 'Fråga om 19000230-0000',
    messages: [
      { role: 'user', content: 'Vad är saldot för ingen@example.invalid?' },
      { role: 'assistant', content: 'Avin har OCR 00000000019.' },
    ],
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }

  it('maskerar i titel och i varje meddelande', () => {
    const ut = maskAiContentForDisplay(samtal)
    expect(ut.title).not.toContain('19000230-0000')
    expect(ut.messages[0]!.content).not.toContain('example.invalid')
    expect(ut.messages[1]!.content).not.toContain('00000000019')
  })

  it('rör inte id, roller eller datum', () => {
    const ut = maskAiContentForDisplay(samtal)
    expect(ut.id).toBe('conv-1')
    expect(ut.messages[0]!.role).toBe('user')
    expect(ut.createdAt).toEqual(samtal.createdAt)
  })

  it('MUTERAR INTE indata — lagrad rad orörd', () => {
    const kopia = JSON.parse(JSON.stringify({ ...samtal, createdAt: undefined }))
    maskAiContentForDisplay(kopia)
    expect(kopia.title).toContain('19000230-0000')
    expect(kopia.messages[0].content).toContain('example.invalid')
  })
})
