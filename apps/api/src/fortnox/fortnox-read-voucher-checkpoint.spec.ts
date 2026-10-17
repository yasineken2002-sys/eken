import { createHash } from 'node:crypto'
import { parseVoucherManifestPage } from './fortnox-read-voucher-checkpoint'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const voucher = (number = 2) => ({
  Year: 1,
  VoucherSeries: 'L',
  VoucherNumber: number,
  UnknownProviderField: { body: 'SYNTHETIC_MANIFEST' },
})
const envelope = (items: unknown[] = [voucher()], meta: Record<string, unknown> = {}) => ({
  MetaInformation: {
    '@CurrentPage': 1,
    '@TotalPages': 1,
    '@TotalResources': items.length,
    ...meta,
  },
  Vouchers: items,
})

describe('Gemensam manifestparser bevarar v1:s listsemantik', () => {
  it('hashar hela råobjektet men sparar bara ordnade nycklar och hash, med handskrivet facit', () => {
    const entryDigest = sha(
      '{"UnknownProviderField":{"body":"SYNTHETIC_MANIFEST"},"VoucherNumber":2,"VoucherSeries":"L","Year":1}',
    )
    const entries = [
      { key: '1|L|2', digest: entryDigest },
      { key: '1|L|2', digest: entryDigest },
    ]
    const expectedDigest = sha(
      `{"entries":[{"digest":"${entryDigest}","key":"1|L|2"},{"digest":"${entryDigest}","key":"1|L|2"}],"itemCount":2,"page":1,"totalPages":3,"totalResources":2}`,
    )
    const parsed = parseVoucherManifestPage(
      envelope([voucher(), voucher()], { '@TotalPages': 3 }),
      1,
    )
    expect(parsed).toStrictEqual({
      page: 1,
      totalPages: 3,
      totalResources: 2,
      itemCount: 2,
      entries,
      digest: expectedDigest,
    })
    expect(JSON.stringify(parsed)).not.toContain('SYNTHETIC_MANIFEST')
  })

  it('ignorerar objektens nyckelordning men upptäcker ändrat okänt råfält', () => {
    const original = parseVoucherManifestPage(envelope(), 1)
    const reordered = {
      UnknownProviderField: { body: 'SYNTHETIC_MANIFEST' },
      VoucherNumber: 2,
      VoucherSeries: 'L',
      Year: 1,
    }
    expect(parseVoucherManifestPage(envelope([reordered]), 1)).toStrictEqual(original)
    const changed = parseVoucherManifestPage(
      envelope([{ ...reordered, UnknownProviderField: { body: 'CHANGED' } }]),
      1,
    )
    expect(changed?.entries[0]?.key).toBe(original?.entries[0]?.key)
    expect(changed?.entries[0]?.digest).not.toBe(original?.entries[0]?.digest)
    expect(changed?.digest).not.toBe(original?.digest)
  })

  it.each([
    { page: 1, totalPages: 0, totalResources: 0 },
    { page: 1, totalPages: 1, totalResources: 0 },
    { page: 2, totalPages: 3, totalResources: 3 },
  ])('bevarar tom giltig sida $page av $totalPages utan ceil-regel', (meta) => {
    expect(
      parseVoucherManifestPage(
        envelope([], {
          '@CurrentPage': meta.page,
          '@TotalPages': meta.totalPages,
          '@TotalResources': meta.totalResources,
        }),
        1,
      ),
    ).toMatchObject({ ...meta, itemCount: 0, entries: [] })
  })

  it('gränsen 100 gäller ingående objekt även när alla har samma identitet', () => {
    const parsed = parseVoucherManifestPage(
      envelope(
        Array.from({ length: 100 }, () => voucher()),
        { '@TotalResources': 1 },
      ),
      1,
    )
    expect(parsed?.itemCount).toBe(100)
    expect(parsed?.entries).toHaveLength(100)
    expect(new Set(parsed?.entries.map((entry) => entry.key)).size).toBe(1)
    expect(
      parseVoucherManifestPage(
        envelope(
          Array.from({ length: 101 }, () => voucher()),
          { '@TotalResources': 1 },
        ),
        1,
      ),
    ).toBeNull()
  })

  it('bevarar parserns befintliga safe-meta-gräns utan att låtsas utöka DB:s Int-kolumner', () => {
    expect(
      parseVoucherManifestPage(envelope([], { '@TotalPages': Number.MAX_SAFE_INTEGER }), 1),
    ).toMatchObject({ totalPages: Number.MAX_SAFE_INTEGER })
  })

  it('bevarar nummer noll och befintlig decimal nyckelform utan ny valideringsregel', () => {
    expect(parseVoucherManifestPage(envelope([voucher(0)]), 1)?.entries[0]?.key).toBe('1|L|0')
    expect(
      parseVoucherManifestPage(envelope([voucher(Number.MAX_SAFE_INTEGER + 1)]), 1)?.entries[0]
        ?.key,
    ).toBe('1|L|9007199254740992')
  })

  it.each([
    { name: 'null envelope', body: null },
    { name: 'array envelope', body: [] },
    { name: 'saknad metadata', body: { Vouchers: [] } },
    { name: 'array metadata', body: { MetaInformation: [], Vouchers: [] } },
    { name: 'saknad lista', body: { MetaInformation: envelope().MetaInformation } },
    { name: 'sida noll', body: envelope([], { '@CurrentPage': 0 }) },
    { name: 'fraktionell sida', body: envelope([], { '@CurrentPage': 1.5 }) },
    { name: 'sidnummer som sträng', body: envelope([], { '@CurrentPage': '1' }) },
    {
      name: 'osäkert sidantal',
      body: envelope([], { '@TotalPages': Number.MAX_SAFE_INTEGER + 1 }),
    },
    { name: 'negativt totalantal', body: envelope([], { '@TotalResources': -1 }) },
    {
      name: 'osäkert totalantal',
      body: envelope([], { '@TotalResources': Number.MAX_SAFE_INTEGER + 1 }),
    },
    { name: 'sida utanför total', body: envelope([], { '@CurrentPage': 2 }) },
    {
      name: 'tom special med fel sida',
      body: envelope([], { '@CurrentPage': 2, '@TotalPages': 0 }),
    },
    {
      name: 'tom special med resurser',
      body: envelope([], { '@TotalPages': 0, '@TotalResources': 1 }),
    },
    {
      name: 'tom special med objekt',
      body: envelope([voucher()], { '@TotalPages': 0, '@TotalResources': 0 }),
    },
    { name: 'null verifikat', body: envelope([null]) },
    { name: 'array verifikat', body: envelope([[]]) },
    { name: 'fel år', body: envelope([{ ...voucher(), Year: 2 }]) },
    { name: 'år som sträng', body: envelope([{ ...voucher(), Year: '1' }]) },
    { name: 'negativt nummer', body: envelope([voucher(-1)]) },
    { name: 'nummer i exponentform', body: envelope([voucher(1e21)]) },
    { name: 'för lång serie', body: envelope([{ ...voucher(), VoucherSeries: 'ABCDEFGHIJK' }]) },
    { name: 'ogiltig serie', body: envelope([{ ...voucher(), VoucherSeries: 'L|' }]) },
  ])('nekar $name med samma parsergräns som v1', ({ body }) => {
    expect(parseVoucherManifestPage(body, 1)).toBeNull()
  })
})
