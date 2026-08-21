/**
 * #IB, #UB och #RES i SIE4-exporten.
 *
 * TVÅ SLAGS TESTER, och det andra är det som betyder något:
 *
 *  1. GOLDEN-FIL på en känd, konstruerad bokföring. Fäller när filen ändrar form.
 *     Balansposterna går att räkna för hand ur testdatan — uträkningen står i
 *     kommentarerna nedan, så att en läsare kan se att siffran är RÄTT och inte
 *     bara att den är STABIL.
 *
 *  2. INVARIANTEN, som läser den producerade filen och räknar om saldona ur dess
 *     EGNA #TRANS-rader: för varje konto ska `#IB + Σtransaktioner = #UB`, och
 *     `#RES` ska stämma mot samma rader. Den kan inte vara grön med fel
 *     teckenkonvention, och är därför kanariefågeln: återanvänder någon
 *     rapportvändningen från getBalanceSheet blir den röd.
 *
 * Bokföringen nedan är konstruerad, beloppen runda och kontona verkliga
 * BAS-konton. Inga personuppgifter förekommer.
 */

import { encodeCp437 } from './cp437'
import { sieSignedAmount } from './accounting.service'

// ── Den konstruerade bokföringen ────────────────────────────────────────────
//
// Räkenskapsår = kalenderår. Exporten går 2026-01-01 → 2026-06-30 (PARTIELL,
// precis som SIE4-flikens standardval "innevarande år t.o.m. idag").
//
// FÖRRA ÅRET (2025) — hamnar i #IB 0 och i år -1:
//   V1  2025-03-01  1930 D 50 000        (bank in)
//                   2890 K 50 000        (depositionsskuld)
//   V2  2025-12-31  1510 D 12 000        (kundfordran hyra dec)
//                   3911 K 12 000        (hyresintäkt)
//
// I ÅR (2026), inom exportfönstret:
//   V3  2026-02-01  1930 D 12 000        (hyran betald)
//                   1510 K 12 000
//   V4  2026-03-01  5020 D  4 000        (el)
//                   1930 K  4 000
//   V5  2026-04-01  1510 D  6 000        (hyra april, obetald)
//                   3911 K  6 000
//   V6  2026-05-01  1930 D  3 000        (ny deposition)
//                   2890 K  3 000
//   V7  2026-06-01  1930 D  5 000        (ägartillskott)
//                   2081 K  5 000        ← EGET KAPITAL, den kontogrupp en
//                                          revisor granskar hårdast
//
// V5 och V6 finns för INVARIANTENS skull: de ger ett intäktskonto och ett
// skuldkonto RÖRELSE inuti exportfönstret. Utan rörelse överlever en konsekvent
// teckenvändning identiteten IB + rörelse = UB (båda leden vänds, rörelsen är
// noll) — och då mäter kanariefågeln ingenting.
//
// UTANFÖR exportfönstret (2026-09-01) — ska INTE påverka något, eftersom
// cutoff = `to`:
//   V8  2026-09-01  5020 D  9 999
//                   1930 K  9 999
//
// ── HANDRÄKNINGEN, år 0 (2026), cutoff 2026-06-30 ──────────────────────────
//
//   #IB 0  (allt med datum < 2026-01-01)
//     1930  +50 000            (V1 debet)
//     2890  −50 000            (V1 kredit → NEGATIVT, trots att skuld är
//                               kontots normalsaldo — det är SIE-konventionen)
//     1510  +12 000            (V2 debet)
//     3911  —                  resultatkonto, ingen ingående balans
//
//   #UB 0  (allt med datum <= 2026-06-30)
//     1930  50 000 + 12 000 − 4 000 + 3 000 + 5 000 = +66 000
//     2890  −50 000 − 3 000                          = −53 000
//     1510  12 000 − 12 000 + 6 000                  = +6 000
//     2081  −5 000                                   (V7 kredit)
//     5020  resultatkonto, ingen utgående balans
//
//   #RES 0  (2026-01-01 <= datum <= 2026-06-30)
//     5020  +4 000            (V4 debet)
//     3911  −6 000            (V5 kredit → NEGATIVT)
//
// ── Om år -1 ────────────────────────────────────────────────────────────────
//
// Exporten ovan (2026-01-01 → 2026-06-30) spänner BARA ett räkenskapsår, så den
// innehåller varken #RAR -1 eller några -1-saldon. Årsindex -1 prövas i stället
// av testet som exporterar 2025-01-01 → 2026-06-30, där handräkningen står i
// testet självt — inklusive att ett avslutat år får sitt EGET årsslut som
// cutoff, inte exportens `to`.

const KONTON = [
  { id: 'a-1510', number: 1510, name: 'Kundfordringar', type: 'ASSET' },
  { id: 'a-1930', number: 1930, name: 'Företagskonto', type: 'ASSET' },
  { id: 'a-2081', number: 2081, name: 'Aktiekapital', type: 'EQUITY' },
  { id: 'a-2890', number: 2890, name: 'Övriga kortfristiga skulder', type: 'LIABILITY' },
  { id: 'a-3911', number: 3911, name: 'Hyresintäkter bostäder', type: 'REVENUE' },
  { id: 'a-5020', number: 5020, name: 'El', type: 'EXPENSE' },
] as const

type Rad = { accountId: string; debit: number | null; credit: number | null }
type Ver = { date: string; series: string; verNumber: number; description: string; lines: Rad[] }

const D = (accountId: string, belopp: number): Rad => ({ accountId, debit: belopp, credit: null })
const K = (accountId: string, belopp: number): Rad => ({ accountId, debit: null, credit: belopp })

const VERIFIKAT: Ver[] = [
  {
    date: '2025-03-01',
    series: 'A',
    verNumber: 1,
    description: 'Deposition mottagen',
    lines: [D('a-1930', 50000), K('a-2890', 50000)],
  },
  {
    date: '2025-12-31',
    series: 'A',
    verNumber: 2,
    description: 'Hyra december',
    lines: [D('a-1510', 12000), K('a-3911', 12000)],
  },
  {
    date: '2026-02-01',
    series: 'A',
    verNumber: 3,
    description: 'Hyra betald',
    lines: [D('a-1930', 12000), K('a-1510', 12000)],
  },
  {
    date: '2026-03-01',
    series: 'A',
    verNumber: 4,
    description: 'Elräkning',
    lines: [D('a-5020', 4000), K('a-1930', 4000)],
  },
  {
    date: '2026-04-01',
    series: 'A',
    verNumber: 5,
    description: 'Hyra april',
    lines: [D('a-1510', 6000), K('a-3911', 6000)],
  },
  {
    date: '2026-05-01',
    series: 'A',
    verNumber: 6,
    description: 'Ny deposition',
    lines: [D('a-1930', 3000), K('a-2890', 3000)],
  },
  {
    date: '2026-06-01',
    series: 'A',
    verNumber: 7,
    description: 'Ägartillskott',
    lines: [D('a-1930', 5000), K('a-2081', 5000)],
  },
  {
    date: '2026-09-01',
    series: 'A',
    verNumber: 8,
    description: 'EFTER exportfönstret — ska inte synas',
    lines: [D('a-5020', 9999), K('a-1930', 9999)],
  },
]

/**
 * Prisma-dubbel som svarar på exakt de frågor exportSie4 ställer.
 *
 * Filtreringen görs här i testet, mot samma datumvillkor som koden skickar in —
 * det är ett medvetet val: en dubbel som ignorerade `where` hade gjort testet
 * blint för precis de avgränsningar (`lt yearStart`, `lte cutoff`) som är hela
 * poängen med #IB/#UB/#RES.
 */
function prismaDouble(medFörraÅret = true) {
  const verifikat = medFörraÅret ? VERIFIKAT : VERIFIKAT.filter((v) => v.date >= '2026-01-01')
  const iso = (d: unknown) => new Date(d as string).toISOString().slice(0, 10)

  return {
    organization: {
      findUnique: async () => ({
        name: 'Testbolaget AB',
        orgNumber: '556000-0001',
        fiscalYearStartMonth: 1,
      }),
    },
    account: {
      findMany: async () => KONTON.map((k) => ({ ...k })),
    },
    journalEntry: {
      findMany: async ({ where }: { where: { date: { gte: Date; lte: Date } } }) =>
        verifikat
          .filter((v) => v.date >= iso(where.date.gte) && v.date <= iso(where.date.lte))
          .map((v) => ({
            ...v,
            date: new Date(`${v.date}T00:00:00Z`),
            lines: v.lines.map((l) => ({
              ...l,
              account: KONTON.find((k) => k.id === l.accountId)!,
            })),
          })),
    },
    journalEntryLine: {
      groupBy: async ({ where }: { where: { journalEntry: { date: Record<string, Date> } } }) => {
        const d = where.journalEntry.date
        const passar = (datum: string) =>
          (d.lt === undefined || datum < iso(d.lt)) &&
          (d.lte === undefined || datum <= iso(d.lte)) &&
          (d.gte === undefined || datum >= iso(d.gte))

        const per = new Map<string, { debit: number; credit: number }>()
        for (const v of verifikat.filter((v) => passar(v.date))) {
          for (const l of v.lines) {
            const nu = per.get(l.accountId) ?? { debit: 0, credit: 0 }
            nu.debit += l.debit ?? 0
            nu.credit += l.credit ?? 0
            per.set(l.accountId, nu)
          }
        }
        return [...per].map(([accountId, s]) => ({
          accountId,
          _sum: { debit: s.debit, credit: s.credit },
        }))
      },
    },
  }
}

async function exportera(
  medFörraÅret = true,
  from = '2026-01-01',
  to = '2026-06-30',
): Promise<string> {
  // Importeras lazily så att jest.mock i andra sviter inte påverkar den här.
  const { AccountingService } = await import('./accounting.service')
  const svc = Object.create(AccountingService.prototype) as {
    exportSie4: (org: string, from: string, to: string) => Promise<Buffer>
  }
  Object.defineProperty(svc, 'prisma', { value: prismaDouble(medFörraÅret) })
  const buf = await svc.exportSie4('org-1', from, to)
  // Filen är CP437-kodad; avkoda tillbaka för jämförelse.
  return buf.toString('latin1')
}

/** Plockar ut poster av en typ som `[årsindex, konto, belopp]`. */
function poster(fil: string, tag: string): Array<[number, number, number]> {
  return fil
    .split('\n')
    .filter((r) => r.startsWith(`${tag} `))
    .map((r) => {
      const [, år, konto, belopp] = r.split(/\s+/)
      return [Number(år), Number(konto), Number(belopp)] as [number, number, number]
    })
}

describe('SIE4 — #IB, #UB och #RES', () => {
  it('handräknade balansposter för år 0', async () => {
    const fil = await exportera()

    // #IB 0 — se handräkningen överst.
    expect(poster(fil, '#IB').filter(([år]) => år === 0)).toEqual([
      [0, 1510, 12000],
      [0, 1930, 50000],
      [0, 2890, -50000],
    ])

    // #UB 0 — 1510 är 0 och utelämnas.
    expect(poster(fil, '#UB').filter(([år]) => år === 0)).toEqual([
      [0, 1510, 6000],
      [0, 1930, 66000],
      [0, 2081, -5000],
      [0, 2890, -53000],
    ])

    // #RES 0 — elkostnaden positiv, hyresintäkten negativ (kredit).
    expect(poster(fil, '#RES').filter(([år]) => år === 0)).toEqual([
      [0, 3911, -6000],
      [0, 5020, 4000],
    ])
  })

  it('en export som SPÄNNER två räkenskapsår ger både index 0 och -1', async () => {
    // 2025-01-01 → 2026-06-30 täcker två räkenskapsår, alltså #RAR 0 och #RAR -1.
    //
    // HANDRÄKNING år -1 (2025), cutoff = min(2025-12-31, 2026-06-30) = 2025-12-31:
    //   #IB  -1  allt < 2025-01-01                → inget → INGA RADER
    //   #UB  -1  allt <= 2025-12-31               1930 +50 000
    //                                             2890 −50 000
    //                                             1510 +12 000  (V2, ännu obetald)
    //   #RES -1  2025-01-01 → 2025-12-31          3911 −12 000  (kredit → negativt)
    //
    // Att #UB -1 skiljer sig från #UB 0 är själva poängen med cutoff per år:
    // ett avslutat år får sitt eget årsslut, inte exportens slutdatum.
    const fil = await exportera(true, '2025-01-01', '2026-06-30')

    expect(fil).toContain('#RAR 0 ')
    expect(fil).toContain('#RAR -1 ')

    expect(poster(fil, '#IB').filter(([år]) => år === -1)).toEqual([])
    expect(poster(fil, '#UB').filter(([år]) => år === -1)).toEqual([
      [-1, 1510, 12000],
      [-1, 1930, 50000],
      [-1, 2890, -50000],
    ])
    expect(poster(fil, '#RES').filter(([år]) => år === -1)).toEqual([[-1, 3911, -12000]])
  })

  it('avslutat år får sitt eget årsslut som cutoff, inte exportens `to`', async () => {
    const fil = await exportera(true, '2025-01-01', '2026-06-30')
    const ub = (år: number, konto: number) =>
      poster(fil, '#UB').find(([a, k]) => a === år && k === konto)?.[2]
    // 1930: 50 000 vid 2025 års slut, 66 000 vid exportens slut.
    expect(ub(-1, 1930)).toBe(50000)
    expect(ub(0, 1930)).toBe(66000)
    // Eget kapital tillkom först 2026 → ingen -1-rad, men en 0-rad.
    expect(ub(-1, 2081)).toBeUndefined()
    expect(ub(0, 2081)).toBe(-5000)
  })

  it('ett kreditsaldo är NEGATIVT även på ett skuldkonto', async () => {
    // Teckenfällan, som ett eget påstående: 2890 har kreditsaldo och ska ha
    // minustecken. En rapportvänd konvention hade gett +50000 här.
    const fil = await exportera()
    expect(poster(fil, '#UB')).toContainEqual([0, 2890, -53000])
    expect(poster(fil, '#UB')).not.toContainEqual([0, 2890, 53000])
  })

  it('cutoff är `to` — verifikat efter exportfönstret påverkar inte saldona', async () => {
    const fil = await exportera()
    // V5 (2026-09-01) bokför 9 999 på 5020 och 1930. Syns de i saldona är
    // cutoff fel.
    expect(fil).not.toContain('9999.00')
    expect(poster(fil, '#RES').find(([år, konto]) => år === 0 && konto === 5020)?.[2]).toBe(4000)
  })

  it('saldon på noll utelämnas helt — ingen 0.00-rad', async () => {
    const fil = await exportera()
    expect(fil).not.toMatch(/^#(IB|UB|RES) -?\d+ \d+ 0\.00$/m)
    // 3911 har ingen ingående balans (resultatkonto) och saknas i #IB.
    expect(poster(fil, '#IB').find(([år, konto]) => år === 0 && konto === 3911)).toBeUndefined()
  })

  it('posterna har INGET {}-fält, till skillnad från #TRANS', async () => {
    const fil = await exportera()
    for (const rad of fil.split('\n').filter((r) => /^#(IB|UB|RES) /.test(r))) {
      expect(rad).not.toContain('{}')
    }
    expect(fil).toMatch(/#TRANS \d+ \{\}/)
  })

  it('en organisation UTAN föregående år får inga -1-saldon, utan specialkod', async () => {
    const fil = await exportera(false)
    expect(poster(fil, '#IB').filter(([år]) => år === -1)).toEqual([])
    expect(poster(fil, '#UB').filter(([år]) => år === -1)).toEqual([])
    expect(poster(fil, '#RES').filter(([år]) => år === -1)).toEqual([])
    // Och inga nollrader har smugit sig in i stället.
    expect(fil).not.toMatch(/ 0\.00$/m)
  })

  it('saldoposterna står FÖRE verifikationerna', async () => {
    const fil = await exportera()
    expect(fil.indexOf('#UB ')).toBeLessThan(fil.indexOf('#VER '))
    expect(fil.indexOf('#KONTO ')).toBeLessThan(fil.indexOf('#IB '))
  })
})

// ── INVARIANTEN / KANARIEFÅGELN ─────────────────────────────────────────────
//
// Räknar om saldona ur filens EGNA #TRANS-rader. En trasig teckenkonvention kan
// inte passera: vänds tecknet i saldoposterna men inte i #TRANS (eller tvärtom)
// slutar likheten gälla omedelbart.
describe('KANARIEFÅGEL — filen stämmer mot sina egna #TRANS-rader', () => {
  /** Summerar filens #TRANS per konto, för verifikat inom exportfönstret. */
  function transPerKonto(fil: string): Map<number, number> {
    const per = new Map<number, number>()
    for (const rad of fil.split('\n')) {
      const m = rad.trim().match(/^#TRANS (\d+) \{\} (-?\d+\.\d{2})$/)
      if (!m) continue
      const konto = Number(m[1])
      per.set(konto, (per.get(konto) ?? 0) + Number(m[2]))
    }
    return per
  }

  it('#IB 0 + Σ#TRANS = #UB 0 för varje balanskonto', async () => {
    const fil = await exportera()
    const trans = transPerKonto(fil)
    const ib = new Map(
      poster(fil, '#IB')
        .filter(([år]) => år === 0)
        .map(([, k, v]) => [k, v]),
    )
    const ub = new Map(
      poster(fil, '#UB')
        .filter(([år]) => år === 0)
        .map(([, k, v]) => [k, v]),
    )

    const konton = new Set([...ib.keys(), ...ub.keys()])
    expect(konton.size).toBeGreaterThan(0)
    for (const konto of konton) {
      const väntat = (ib.get(konto) ?? 0) + (trans.get(konto) ?? 0)
      expect({ konto, ub: ub.get(konto) ?? 0 }).toEqual({ konto, ub: väntat })
    }
  })

  it('#RES 0 = Σ#TRANS för varje resultatkonto', async () => {
    const fil = await exportera()
    const trans = transPerKonto(fil)
    const res = new Map(
      poster(fil, '#RES')
        .filter(([år]) => år === 0)
        .map(([, k, v]) => [k, v]),
    )

    for (const [konto, belopp] of res) {
      expect({ konto, trans: trans.get(konto) ?? 0 }).toEqual({ konto, trans: belopp })
    }
  })

  it('sieSignedAmount är formeln båda sidor använder', () => {
    // Fäller om någon byter formel på ena stället: debet positivt, kredit negativt.
    expect(sieSignedAmount(50000, null)).toBe(50000)
    expect(sieSignedAmount(null, 50000)).toBe(-50000)
    expect(sieSignedAmount(12000, 4000)).toBe(8000)
  })
})

// ── GOLDEN-FIL ──────────────────────────────────────────────────────────────
//
// Hela filen, tecken för tecken. Fäller när formen ändras — även när siffrorna
// råkar bli desamma. Uppdateras med UPDATE_SIE_GOLDEN=1, aldrig automatiskt:
// en ändring ska kosta en medveten handling och hamna i en PR någon läser.
describe('SIE4 golden-fil', () => {
  it('hela filen matchar den godkända formen', async () => {
    const { readFileSync, writeFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const path = join(__dirname, 'sie-balance-records.golden.txt')

    const fil = await exportera()
      // #GEN bär dagens datum och skulle göra filen ny varje dygn.
      .then((f) => f.replace(/^#GEN \d{8}$/m, '#GEN <genereringsdatum>'))

    if (process.env['UPDATE_SIE_GOLDEN'] === '1') {
      writeFileSync(path, fil, 'latin1')
    }
    expect(existsSync(path)).toBe(true)
    expect(fil).toBe(readFileSync(path, 'latin1'))
  })

  it('golden-filen är CP437-kodad — å/ä/ö får inte bli skräp', () => {
    // Deklarationen #FORMAT PC8 i filen måste stämma med bytena.
    const cp437 = encodeCp437('Övriga kortfristiga skulder').toString('latin1')
    expect(cp437).not.toBe('Övriga kortfristiga skulder')
  })
})
