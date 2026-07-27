/**
 * SIE4 — teckenkodning (H2) och #RAR (H3).
 *
 * Två bekräftade brott mot SIE 4B-specifikationen:
 *
 *  H2  Filen deklarerade `#FORMAT PC8` men skrevs som UTF-8. Specen tillåter
 *      ingen annan teckenuppsättning:
 *        §5.8      "Teckenrepertoaren i filen ska vara IBM PC 8-bitars extended
 *                   ASCII (Codepage 437)"
 *        §#FORMAT  "Tills vidare tillåter standarden endast IBM Extended 8-bit
 *                   ASCII (PC8 - codepage 437)"
 *      Ett "ö" blev två UTF-8-byte som CP437 läser som två skräptecken — i
 *      kontonamn och verifikationstexter, alltså precis det en revisor läser.
 *
 *  H3  `#RAR 0` bar exportens datumintervall i stället för räkenskapsårets.
 *      §#RAR pt 1: "Räkenskapsårets start och slutdatum anges i formatet
 *      ÅÅÅÅMMDD. Årsnr sätts till 0 för innevarande år." Exporterade man en
 *      månad påstod filen att räkenskapsåret var den månaden.
 */

import { AccountingService, fiscalYearsCovering } from './accounting.service'
import { decodeCp437, encodeCp437 } from './cp437'

function makeService(opts: { fiscalYearStartMonth?: number; accountName?: string } = {}) {
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        name: 'Åkerlunds Fastigheter AB',
        orgNumber: '556000-0001',
        fiscalYearStartMonth: opts.fiscalYearStartMonth ?? 1,
      }),
    },
    journalEntry: {
      findMany: jest.fn().mockResolvedValue([
        {
          date: new Date('2026-06-15T00:00:00Z'),
          series: 'A',
          verNumber: 1,
          description: 'Hyresavi — Östermalm, lägenhet 3',
          lines: [
            { debit: 1250, credit: null, account: { number: 1510 } },
            { debit: null, credit: 1250, account: { number: 3911 } },
          ],
        },
      ]),
    },
    account: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ number: 3911, name: opts.accountName ?? 'Hyresintäkter, bostäder' }]),
    },
  }
  return new AccountingService(prisma as never, {} as never)
}

describe('H2 — filen skrivs i den deklarerade kodningen (CP437)', () => {
  it('svenska tecken i kontonamn och verifikationstext round-trippar', async () => {
    const service = makeService({ accountName: 'Räntekostnader för lån' })
    const buffer = await service.exportSie4('org-1', '2026-01-01', '2026-12-31')

    // Läses tillbaka som CP437 — inte som UTF-8.
    const text = decodeCp437(buffer)
    expect(text).toContain('Åkerlunds Fastigheter AB')
    expect(text).toContain('Räntekostnader för lån')
    expect(text).toContain('Hyresavi — Östermalm, lägenhet 3'.replace('—', '-'))
    expect(text).toContain('#FORMAT PC8')
  })

  it('bytena är CP437, INTE UTF-8 (ett ö är en byte, inte två)', async () => {
    const service = makeService({ accountName: 'Övriga rörelseintäkter' })
    const buffer = await service.exportSie4('org-1', '2026-01-01', '2026-12-31')

    // 0x94 = ö i CP437 ("rörelse"). I UTF-8 hade samma tecken varit två byte
    // (0xC3 0xB6) — det är hela skillnaden testet finns för.
    expect(buffer.includes(0x94)).toBe(true)
    // 0xC3 är UTF-8:ens fortsättningsbyte för latin-1-tecken — får inte finnas.
    // (0xC3 är i CP437 tecknet '╤', som inte förekommer i vår testdata.)
    expect(buffer.includes(0xc3)).toBe(false)

    // Tolkas bufferten felaktigt som UTF-8 blir resultatet trasigt — beviset
    // för att kodningen faktiskt bytt.
    expect(buffer.toString('utf8')).toContain('�')
  })

  it('ren ASCII är oförändrad (SIE-nyckelorden rörs inte)', () => {
    const ascii = '#VER "A" 1 20260615 "Faktura F-2026-0001"'
    expect(decodeCp437(encodeCp437(ascii))).toBe(ascii)
  })

  it('tecken utanför CP437 ersätts deterministiskt, aldrig tyst tappade', () => {
    // Typografiska tecken som kan smyga in i ett kontonamn via copy-paste.
    expect(decodeCp437(encodeCp437('A–B'))).toBe('A-B')
    expect(decodeCp437(encodeCp437('“citat”'))).toBe('"citat"')
    // Helt omappningsbart → '?', inte bortfall.
    expect(decodeCp437(encodeCp437('汉'))).toBe('?')
  })
})

describe('H3 — #RAR bär räkenskapsåret, inte exportintervallet', () => {
  it('månadsexport → #RAR visar HELA räkenskapsåret', async () => {
    const service = makeService({ fiscalYearStartMonth: 1 })
    const text = decodeCp437(await service.exportSie4('org-1', '2026-06-01', '2026-06-30'))

    // Detta fäller den gamla koden: den skrev exportintervallet.
    expect(text).toContain('#RAR 0 20260101 20261231')
    expect(text).not.toContain('#RAR 0 20260601 20260630')
  })

  it('brutet räkenskapsår (maj–april) härleds ur fiscalYearStartMonth', async () => {
    const service = makeService({ fiscalYearStartMonth: 5 })
    const text = decodeCp437(await service.exportSie4('org-1', '2026-06-01', '2026-06-30'))
    expect(text).toContain('#RAR 0 20260501 20270430')
  })

  it('export FÖRE startmånaden hör till föregående räkenskapsår', async () => {
    const service = makeService({ fiscalYearStartMonth: 5 })
    // Mars 2026 ligger i räkenskapsåret som började maj 2025.
    const text = decodeCp437(await service.exportSie4('org-1', '2026-03-01', '2026-03-31'))
    expect(text).toContain('#RAR 0 20250501 20260430')
  })
})

describe('fiscalYearsCovering — numrering enligt §#RAR', () => {
  it('kalenderår: årsnr 0 = året exporten slutar i', () => {
    expect(fiscalYearsCovering('2026-06-01', '2026-06-30', 1)).toEqual([
      { number: 0, start: '20260101', end: '20261231' },
    ])
  })

  it('export över två räkenskapsår ger en rad per år, äldre negativt', () => {
    expect(fiscalYearsCovering('2025-11-01', '2026-02-28', 1)).toEqual([
      { number: 0, start: '20260101', end: '20261231' },
      { number: -1, start: '20250101', end: '20251231' },
    ])
  })

  it('brutet räkenskapsår får korrekt slutdatum (dagen före nästa start)', () => {
    expect(fiscalYearsCovering('2026-06-01', '2026-06-30', 7)).toEqual([
      { number: 0, start: '20250701', end: '20260630' },
    ])
  })

  it('skottår hanteras (räkenskapsår som slutar 29 februari)', () => {
    expect(fiscalYearsCovering('2024-01-15', '2024-01-20', 3)).toEqual([
      { number: 0, start: '20230301', end: '20240229' },
    ])
  })
})
