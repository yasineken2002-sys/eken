import { createHash } from 'node:crypto'
import {
  contextBindingDigest,
  contextExtendRoot,
  contextHeaderDigest,
  contextInitialRoot,
  contextPageDigest,
  type ContextManifest,
} from './fortnox-read-context-format'

const hash = (literal: string) => createHash('sha256').update(literal, 'utf8').digest('hex')
const input = {
  financialYearId: 1,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
}

describe('Extraherat kontextformat bevarar lagrade v1-hashbytes', () => {
  it('hela hashgrafen motsvarar handskrivna JSON-literal utan produktens serializer', () => {
    const sourceDigest = 'a'.repeat(64)
    const connection = { id: 'c', generation: 0, databaseNumber: 1, orgNumber: null }
    const manifest: ContextManifest = {
      version: 1,
      input,
      sourceDigest,
      connection,
      collections: {
        MAPPINGS: { itemCount: 1, pageCount: 1, root: '' },
        OWN_EXPORTS: { itemCount: 0, pageCount: 0, root: '' },
      },
    }
    const header = { id: 's', organizationId: 'o', runId: 'r', manifest }
    const binding = hash(
      `{"connection":{"databaseNumber":1,"generation":0,"id":"c","orgNumber":null},"input":{"costAccounts":[5170],"financialYearId":1,"periodFrom":"2026-10-01","periodTo":"2026-10-31"},"organizationId":"o","runId":"r","snapshotId":"s","sourceDigest":"${sourceDigest}","version":1}`,
    )
    expect(contextBindingDigest(header)).toBe(binding)

    const mappingRoot = hash(`{"binding":"${binding}","kind":"MAPPINGS","version":1}`)
    const exportRoot = hash(`{"binding":"${binding}","kind":"OWN_EXPORTS","version":1}`)
    expect(contextInitialRoot(binding, 'MAPPINGS')).toBe(mappingRoot)
    expect(contextInitialRoot(binding, 'OWN_EXPORTS')).toBe(exportRoot)

    const items = [
      { type: 'PROJECT' as const, code: '10', propertyId: 'p', propertyName: 'Å\n"\\😀' },
    ]
    const page = hash(
      String.raw`{"binding":"${binding}","itemCount":1,"items":[{"code":"10","propertyId":"p","propertyName":"Å\n\"\\😀","type":"PROJECT"}],"kind":"MAPPINGS","page":1,"version":1}`,
    )
    expect(contextPageDigest(binding, 'MAPPINGS', 1, items)).toBe(page)
    const root = hash(`{"digest":"${page}","itemCount":1,"page":1,"previousRoot":"${mappingRoot}"}`)
    expect(contextExtendRoot(mappingRoot, 1, 1, page)).toBe(root)
    manifest.collections.MAPPINGS.root = root
    manifest.collections.OWN_EXPORTS.root = exportRoot

    const literal = `{"id":"s","manifest":{"collections":{"MAPPINGS":{"itemCount":1,"pageCount":1,"root":"${root}"},"OWN_EXPORTS":{"itemCount":0,"pageCount":0,"root":"${exportRoot}"}},"connection":{"databaseNumber":1,"generation":0,"id":"c","orgNumber":null},"input":{"costAccounts":[5170],"financialYearId":1,"periodFrom":"2026-10-01","periodTo":"2026-10-31"},"sourceDigest":"${sourceDigest}","version":1},"organizationId":"o","runId":"r"}`
    expect(contextHeaderDigest(header)).toBe(hash(literal))
    expect(contextHeaderDigest(JSON.parse(literal) as typeof header)).toBe(hash(literal))
  })

  it('sidbytes behåller noll/null, kontoordning och dubletter utan normalisering', () => {
    const binding = 'b'.repeat(64)
    const items = [
      {
        voucher: '1|L|2',
        journalEntryId: 'j',
        revision: 0,
        perMal: [{ account: 5170, sources: [5160, 5150, 5160] }],
      },
      { voucher: '1|L|1', journalEntryId: 'j', revision: null, perMal: [] },
      { voucher: '1|L|1', journalEntryId: 'j', revision: null, perMal: [] },
    ]
    const literal = `{"binding":"${binding}","itemCount":3,"items":[{"journalEntryId":"j","perMal":[{"account":5170,"sources":[5160,5150,5160]}],"revision":0,"voucher":"1|L|2"},{"journalEntryId":"j","perMal":[],"revision":null,"voucher":"1|L|1"},{"journalEntryId":"j","perMal":[],"revision":null,"voucher":"1|L|1"}],"kind":"OWN_EXPORTS","page":2,"version":1}`
    expect(contextPageDigest(binding, 'OWN_EXPORTS', 2, items)).toBe(hash(literal))
    expect(contextPageDigest(binding, 'OWN_EXPORTS', 1, items)).not.toBe(hash(literal))
    expect(contextPageDigest(binding, 'OWN_EXPORTS', 2, [...items].reverse())).not.toBe(
      hash(literal),
    )
    expect(contextPageDigest(binding, 'OWN_EXPORTS', 2, items.slice(0, 2))).not.toBe(hash(literal))
  })
})
