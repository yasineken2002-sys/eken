/**
 * H1 — OCR-numret allokeras ur en sekvens per organisation.
 *
 * Två defekter ersattes:
 *
 *   RACE          `tenant.count() + 1` utanför transaktion — två samtidiga
 *                 tilldelningar byggde samma nummer.
 *   PREFIXHINKEN  `(första fyra hex ur org-UUID mod 9000) + 1000` rymde 9000
 *                 värden. Vid 112 organisationer var risken 50 % att minst två
 *                 delade prefix, och då fick deras tenant #1 identiskt OCR.
 *                 Med dåvarande GLOBALA unikhet kastade den andra P2002 och
 *                 hyresgästen fick inget OCR alls.
 *
 * Unikheten är numera `@@unique([organizationId, ocrNumber])`. Det är tillåtet —
 * och avsiktligt — att två organisationer delar nummer, eftersom varje uppslag
 * bär organisationen.
 */

import { OcrService, formatTenantOcr } from './ocr.service'
import { isValidOcrNumber } from '@eken/shared'

/** Räknare per org — samma isolering som sekvenstabellens primärnyckel ger. */
function rigg(opts: { befintligtOcr?: string } = {}) {
  const räknare = new Map<string, number>()
  const uppdaterade: Array<{ id: string; ocrNumber: string }> = []

  const queryRaw = jest.fn().mockResolvedValue([])
  const tx = {
    // Radlåset på hyresgästen — utan det kan två samtidiga anrop båda läsa
    // "saknar OCR" och konsumera var sitt sekvensnummer (mätt i bevisriggen).
    $queryRaw: queryRaw,
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ ocrNumber: opts.befintligtOcr ?? null }),
      update: jest.fn().mockImplementation(({ where, data }) => {
        uppdaterade.push({ id: where.id, ocrNumber: data.ocrNumber })
        return Promise.resolve({})
      }),
    },
    tenantOcrSequence: {
      upsert: jest.fn().mockImplementation(({ where }: { where: { organizationId: string } }) => {
        const nästa = (räknare.get(where.organizationId) ?? 0) + 1
        räknare.set(where.organizationId, nästa)
        return Promise.resolve({ lastNumber: nästa })
      }),
    },
  }
  const prisma = { $transaction: (cb: (t: unknown) => unknown) => cb(tx) }
  return { service: new OcrService(prisma as never), tx, uppdaterade, queryRaw }
}

describe('formatTenantOcr — formen', () => {
  it('elva siffror: tio löpnummer + Luhn', () => {
    expect(formatTenantOcr(1)).toHaveLength(11)
    expect(formatTenantOcr(1)).toMatch(/^\d{11}$/)
  })

  it('numren validerar mot bankgirostandarden i @eken/shared', () => {
    for (const n of [1, 2, 42, 999, 1_000_000, 9_999_999_999]) {
      expect(isValidOcrNumber(formatTenantOcr(n))).toBe(true)
    }
  })

  it('samma längd som de nummer som redan delats ut (11 siffror)', () => {
    // Prod bar `45910000016` när ändringen gjordes. Nya nummer ska inte gå att
    // skilja från gamla på formen — bara på att de saknar inbäddad betydelse.
    expect('45910000016').toHaveLength(11)
    expect(formatTenantOcr(2)).toHaveLength(11)
  })

  it('KANARIEFÅGEL: numret bär INGET org-prefix', () => {
    // Prefixet togs bort med flit. Återinförs det ser fältet ut att identifiera
    // organisationen utan att garantera det — och den tron är hela H1-defekten.
    // Bevis: samma löpnummer ger samma OCR oavsett organisation, så numret kan
    // omöjligt koda org-identitet.
    expect(formatTenantOcr(1)).toBe(formatTenantOcr(1))
    // Och de tio första siffrorna är rent löpnummer, inget annat.
    expect(formatTenantOcr(7).slice(0, 10)).toBe('0000000007')
  })
})

describe('assignOcrToTenant', () => {
  it('allokerar ur sekvensen och skriver numret på hyresgästen', async () => {
    const { service, tx, uppdaterade } = rigg()
    const ocr = await service.assignOcrToTenant('tenant-1', 'org-1')

    expect(ocr).toBe('00000000019')
    expect(uppdaterade).toEqual([{ id: 'tenant-1', ocrNumber: '00000000019' }])
    expect(tx.tenantOcrSequence.upsert).toHaveBeenCalledTimes(1)
  })

  it('scopet är organisationen', async () => {
    const { service, tx } = rigg()
    await service.assignOcrToTenant('tenant-1', 'org-1')

    const arg = tx.tenantOcrSequence.upsert.mock.calls[0][0]
    expect(arg.where).toEqual({ organizationId: 'org-1' })
    expect(arg.update).toEqual({ lastNumber: { increment: 1 } })
  })

  it('ett befintligt OCR returneras oförändrat — och sekvensen rörs inte', async () => {
    // Ett OCR som byts är en betalning som inte matchar. Gamla nummer sitter på
    // avier och i hyresgästernas autogiron.
    const { service, tx } = rigg({ befintligtOcr: '45910000016' })
    await expect(service.assignOcrToTenant('tenant-1', 'org-1')).resolves.toBe('45910000016')
    expect(tx.tenantOcrSequence.upsert).not.toHaveBeenCalled()
    expect(tx.tenant.update).not.toHaveBeenCalled()
  })

  it('KÄRNAN I H1: två organisationer FÅR dela nummer — ingen kollision', async () => {
    // Före ändringen delade prefixhinken ut samma prefix till olika orgar, och
    // den globala unikheten gjorde då den andra tilldelningen omöjlig.
    const { service } = rigg()
    const a = await service.assignOcrToTenant('tenant-a', 'org-a')
    const b = await service.assignOcrToTenant('tenant-b', 'org-b')

    expect(a).toBe(b) // samma löpnummer i två orgar — tillåtet, och avsikten
    expect(a).toBe('00000000019')
  })

  it('samma org räknar uppåt', async () => {
    const { service } = rigg()
    const första = await service.assignOcrToTenant('t1', 'org-1')
    const andra = await service.assignOcrToTenant('t2', 'org-1')

    expect(första).not.toBe(andra)
    expect(andra.slice(0, 10)).toBe('0000000002')
  })

  it('KANARIEFÅGEL: radlåset tas FÖRE läsningen', async () => {
    // Bevisriggen mätte att utan låset ger två parallella anrop för samma
    // hyresgäst två OLIKA nummer (…019 och …028) — sekvenslåset serialiserar
    // allokeringen, men inte beslutet att allokera. Tas låset bort igen ska det
    // här falla.
    const { service, queryRaw, tx } = rigg()
    await service.assignOcrToTenant('tenant-1', 'org-1')

    expect(queryRaw).toHaveBeenCalled()
    expect(String(queryRaw.mock.calls[0][0])).toContain('FOR UPDATE')
    // Låset först, läsningen sedan.
    expect(queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(
      tx.tenant.findUnique.mock.invocationCallOrder[0]!,
    )
  })
})

describe('validateOcrNumber — en regel, ett ställe', () => {
  it('delegerar till @eken/shared i stället för en egen, lösare regel', () => {
    // Tjänsten hade en egen `/^\d{2,}$/` + Luhn — lösare än shareds
    // `/^\d{4,25}$/`, och utan anropare. Två svar på samma fråga.
    const service = new OcrService({} as never)
    for (const ocr of ['00000000019', '45910000016']) {
      expect(service.validateOcrNumber(ocr)).toBe(isValidOcrNumber(ocr))
      expect(service.validateOcrNumber(ocr)).toBe(true)
    }
    // Tre siffror avvisas nu — den gamla tjänstregeln hade släppt igenom dem.
    expect(service.validateOcrNumber('018')).toBe(false)
    expect(service.validateOcrNumber('018')).toBe(isValidOcrNumber('018'))
  })
})
