/**
 * Backfillens spegelkontroll — och kanariefåglarna som gör den till en mätning.
 *
 * Namnrymden FÖRESLÅR paret, speglingen AVGÖR. Den ordningen är hela poängen:
 * en uppräkning av åtta namnformer kan vara fel utan att någon märker det, men
 * en spegelkontroll kan bara vara grön om raderna faktiskt tar ut varandra.
 *
 * Därför matas kontrollen här med par som MÅSTE avvisas. Utan de fallen vet vi
 * inte om `speglar()` diskriminerar eller bara returnerar true.
 */

import { Prisma } from '@prisma/client'

import { byggForslag, härledOriginalSourceId, speglar } from './backfill-reversal-links'

const D = (n: number) => new Prisma.Decimal(n)
const rad = (accountId: string, debit?: number, credit?: number) => ({
  accountId,
  debit: debit != null ? D(debit) : null,
  credit: credit != null ? D(credit) : null,
})

/** Hyresavins accrual: 1510 D 10 000 / 3911 K 10 000. */
const ORIGINAL = [rad('1510', 10_000), rad('3911', undefined, 10_000)]
/** Dess exakta spegel. */
const SPEGEL = [rad('1510', undefined, 10_000), rad('3911', 10_000)]

describe('härledningen ur namnrymden — ett FÖRSLAG, inget mer', () => {
  it('känner igen de automatiska formerna', () => {
    expect(härledOriginalSourceId('rent-notice-reversal:rn-1')).toBe('rent-notice:rn-1')
    expect(härledOriginalSourceId('reminder-fee-reversal:rn-1')).toBe('reminder-fee:rn-1')
    expect(härledOriginalSourceId('misc-charge-reversal:mc-1')).toBe('misc-charge:mc-1')
    expect(härledOriginalSourceId('deposit-invoice-reversal:d-1')).toBe('deposit-invoice:d-1')
    // FAKTURAN ÄR UNDANTAGET: dess accrual bär bara id:t, utan prefix. Den här
    // raden stod först som `'invoice:inv-1'` — jag skrev in samma felaktiga
    // antagande i både regeln och testet, så testet var grönt och bevisade
    // ingenting. Torrkörningen mot dev fällde det.
    expect(härledOriginalSourceId('invoice-reversal:inv-1')).toBe('inv-1')
    // Sammansatta nycklar (id + datum resp. id + räkenskapsår) måste överleva.
    expect(härledOriginalSourceId('interest-reversal:rn-1:2026-08-20')).toBe(
      'interest:rn-1:2026-08-20',
    )
    expect(härledOriginalSourceId('consumption-accrual-reversal:m-1:2026')).toBe(
      'consumption-accrual:m-1:2026',
    )
    // Betalningsvägen: `reversal:<hela originalets sourceId>`.
    expect(härledOriginalSourceId('reversal:rent-notice-payment:p-1')).toBe(
      'rent-notice-payment:p-1',
    )
  })

  it('KANARIEFÅGEL: okända och ohanterade former ger null — de gissas ALDRIG', () => {
    // En okänd namnrymd ska rapporteras som ohanterad, inte tolkas.
    expect(härledOriginalSourceId('rent-notice:rn-1')).toBeNull()
    expect(härledOriginalSourceId('nagot-helt-annat')).toBeNull()
    expect(härledOriginalSourceId('reversal:')).toBeNull()
    // `entry-reversal:` har ALLTID satt länken och har inget att backfilla.
    expect(härledOriginalSourceId('entry-reversal:je-1')).toBeNull()
  })
})

describe('spegelkontrollen — acceptanskriteriet', () => {
  it('en exakt spegel godkänns', () => {
    expect(speglar(ORIGINAL, SPEGEL)).toBe(true)
  })

  it('KANARIEFÅGEL: ett par som INTE speglar avvisas — fel belopp', () => {
    // Samma konton, rätt tecken, men 9 000 mot 10 000. Ett par som namnrymden
    // hade accepterat utan invändning.
    const fel = [rad('1510', undefined, 9_000), rad('3911', 9_000)]
    expect(speglar(ORIGINAL, fel)).toBe(false)
  })

  it('KANARIEFÅGEL: fel KONTO avvisas, trots rätt belopp', () => {
    const fel = [rad('1510', undefined, 10_000), rad('3913', 10_000)]
    expect(speglar(ORIGINAL, fel)).toBe(false)
  })

  it('KANARIEFÅGEL: SAMMA tecken avvisas — en kopia är ingen reversering', () => {
    // Det farligaste fallet: en post som ser ut som originalet. Länkas den blir
    // huvudboken dubbelt debiterad OCH påstår att det var en rättelse.
    expect(speglar(ORIGINAL, ORIGINAL)).toBe(false)
  })

  it('KANARIEFÅGEL: en EXTRA rad avvisas, även om de gemensamma speglar', () => {
    const fel = [...SPEGEL, rad('1930', 500), rad('1510', undefined, 500)]
    expect(speglar(ORIGINAL, fel)).toBe(false)
  })

  it('KANARIEFÅGEL: nollposter godkänns inte — de speglar formellt allt', () => {
    const noll = [rad('1510', 0), rad('3911', undefined, 0)]
    expect(speglar(noll, noll)).toBe(false)
  })

  it('en post som inte summerar till noll avvisas — obalans speglar ingenting', () => {
    const obalans = [rad('1510', 10_000), rad('3911', undefined, 9_000)]
    expect(speglar(obalans, SPEGEL)).toBe(false)
  })

  it('flera rader mot SAMMA konto aggregeras innan jämförelsen', () => {
    const delat = [rad('1510', 6_000), rad('1510', 4_000), rad('3911', undefined, 10_000)]
    expect(speglar(delat, SPEGEL)).toBe(true)
  })
})

describe('byggForslag — namnrymd + spegling tillsammans', () => {
  const post = (o: {
    id: string
    sourceId: string
    lines: ReturnType<typeof rad>[]
    ver: number
    reversalOfEntryId?: string | null
  }) => ({
    id: o.id,
    organizationId: 'org-1',
    series: 'A',
    verNumber: o.ver,
    source: 'INVOICE',
    sourceId: o.sourceId,
    reversalOfEntryId: o.reversalOfEntryId ?? null,
    lines: o.lines,
  })

  it('ett äkta par föreslås som speglande', () => {
    const f = byggForslag([
      post({ id: 'o1', sourceId: 'rent-notice:rn-1', lines: ORIGINAL, ver: 7 }),
      post({ id: 'r1', sourceId: 'rent-notice-reversal:rn-1', lines: SPEGEL, ver: 8 }),
    ])
    expect(f).toEqual([
      {
        reverseringId: 'r1',
        reverseringVer: 'A8',
        originalId: 'o1',
        originalVer: 'A7',
        utfall: 'speglar',
      },
    ])
  })

  it('KANARIEFÅGEL: namnrymden matchar PERFEKT men raderna speglar inte → avvisas', () => {
    // Precis det fall som gör kontrollen mätt i stället för gissad. `sourceId`
    // är exakt rätt; beloppen är det inte.
    const f = byggForslag([
      post({ id: 'o1', sourceId: 'rent-notice:rn-1', lines: ORIGINAL, ver: 7 }),
      post({
        id: 'r1',
        sourceId: 'rent-notice-reversal:rn-1',
        lines: [rad('1510', undefined, 4_000), rad('3911', 4_000)],
        ver: 8,
      }),
    ])
    expect(f[0]!.utfall).toBe('speglar-inte')
  })

  it('saknat original rapporteras, gissas inte', () => {
    const f = byggForslag([
      post({ id: 'r1', sourceId: 'rent-notice-reversal:rn-1', lines: SPEGEL, ver: 8 }),
    ])
    expect(f[0]!.utfall).toBe('original-saknas')
    expect(f[0]!.originalId).toBeNull()
  })

  it('IDEMPOTENS: en redan länkad post plockas inte upp', () => {
    const f = byggForslag([
      post({ id: 'o1', sourceId: 'rent-notice:rn-1', lines: ORIGINAL, ver: 7 }),
      post({
        id: 'r1',
        sourceId: 'rent-notice-reversal:rn-1',
        lines: SPEGEL,
        ver: 8,
        reversalOfEntryId: 'o1',
      }),
    ])
    expect(f).toEqual([])
  })

  it('org-gränsen korsas ALDRIG: samma sourceId i två orgar paras inte ihop', () => {
    const f = byggForslag([
      {
        ...post({ id: 'o1', sourceId: 'rent-notice:rn-1', lines: ORIGINAL, ver: 7 }),
        organizationId: 'org-A',
      },
      {
        ...post({ id: 'r1', sourceId: 'rent-notice-reversal:rn-1', lines: SPEGEL, ver: 8 }),
        organizationId: 'org-B',
      },
    ])
    expect(f[0]!.utfall).toBe('original-saknas')
  })
})
