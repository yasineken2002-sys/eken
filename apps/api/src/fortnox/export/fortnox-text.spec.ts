import { MockFortnoxLedgerReader } from '../fortnox-providers'
import { FakeFortnoxApi } from '../fortnox-fake-api.testing'
import {
  buildFortnoxVoucherDraft,
  type FortnoxVoucherDraftConfig,
  type LocalJournalEntrySnapshot,
} from './fortnox-voucher-draft'
import { TEXT_REGEL_VERSION, fortnoxText, type FortnoxTextFalt } from './fortnox-text'

/**
 * TESTKUND-016 (KRITERIER-H4-016 K2.2, V-H4-4): kontraktsprov för exporttexten.
 *
 * ORAKEL: Fortnox teckenklass ORDAGRANT som publicerad (Formats & Encoding, Valid characters,
 * hämtad 2026-10-09, sha256 b18d69cb…), omskriven till JS här i provet oberoende av produktkoden.
 * Om produktens validator eller mappning ändras utan att källan gör det, fäller provet.
 */
const KALLKLASS =
  String.raw`[\p{L}\’\\\x{0308}\x{030a}a-zåäöéáœæøüA-ZÅÄÖÉÁÜŒÆØ0-9 –:\.` +
  '`' +
  String.raw`´’,;\^¤#%§£$€¢¥©™°&\/\(\)=\+\-\*_\!?²³®½\@\x{00a0}\n\r]*`
const ORAKEL = new RegExp(
  '^' +
    KALLKLASS.replace(/\\x\{([0-9a-f]+)\}/gi, '\\u{$1}')
      .replace(/\\’/g, '’')
      .replace(/\\!/g, '!')
      .replace(/\\@/g, '@') +
    '$',
  'u',
)
const iKlassen = (s: string) => ORAKEL.test(s)

function fixture() {
  const proof = {
    organizationId: 'org-1',
    externalDatabaseNumber: 900001,
    evidenceRef: 'verified:test-only',
  }
  const entry: LocalJournalEntrySnapshot = {
    inputOrigin: 'PERSISTED_JOURNAL_ENTRY',
    id: 'entry-1',
    organizationId: 'org-1',
    date: '2026-10-01',
    eventDate: null,
    description: 'Supplier invoice booking',
    reference: 'local-reference',
    source: 'SUPPLIER_INVOICE',
    sourceId: 'supplier-invoice:inv-1',
    aiToolExecutionId: null,
    fiscalYear: 2026,
    series: 'A',
    verNumber: 7,
    reversalOfEntryId: null,
    lines: [
      {
        id: 'line-1',
        journalEntryId: 'entry-1',
        accountId: 'acc-5170',
        debit: '100.10',
        credit: null,
        description: 'Repair',
        account: { id: 'acc-5170', organizationId: 'org-1', number: 5170 },
      },
      {
        id: 'line-2',
        journalEntryId: 'entry-1',
        accountId: 'acc-2440',
        debit: null,
        credit: '100.10',
        description: null,
        account: { id: 'acc-2440', organizationId: 'org-1', number: 2440 },
      },
    ],
  }
  const config: FortnoxVoucherDraftConfig = {
    organizationId: 'org-1',
    externalCompany: {
      organizationNumber: '556000-0001',
      databaseNumber: 900001,
      evidenceRef: 'verified:company',
    },
    financialYear: {
      ...proof,
      localFiscalYear: 2026,
      id: 17,
      voucherYear: 17,
      fromDate: '2026-07-01',
      toDate: '2027-06-30',
    },
    voucherSeries: { ...proof, code: 'L', financialYearId: 17 },
    accounts: [
      {
        ...proof,
        localAccountId: 'acc-5170',
        localAccountNumber: 5170,
        externalAccountNumber: 5180,
      },
      {
        ...proof,
        localAccountId: 'acc-2440',
        localAccountNumber: 2440,
        externalAccountNumber: 2440,
      },
    ],
    dimensions: {
      ...proof,
      mode: 'OMIT',
      reason: 'Verified whole-company export without dimensions.',
    },
  }
  return { entry, config, proof }
}

/** Deterministisk PRNG (mulberry32) — samma fall vid varje körning. */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const KANT = [...'–:.`´’,;^¤#%§£$€¢¥©™°&/()=+-*_!?²³®½@\\ \n\r åäöéáœæøüÅÄÖÉÁÜŒÆØ']
const UTANFOR = [...'"\'<>[]{|}~\t\u0000\u001f\u007f—‒―­​﻿́̂']
const BOKSTAVER = [...'aZqéŁżßñçЖжΩλ日本한ā']
const KOMBINERANDE = ['̈', '̊', '́', '̧']
const EMOJI = ['🏠', '👍🏽', '🇸🇪', '\u{1F600}']

function slumptext(r: () => number): string {
  const n = Math.floor(r() * 41)
  let s = ''
  for (let i = 0; i < n; i++) {
    const p = r()
    const pool =
      p < 0.3
        ? BOKSTAVER
        : p < 0.55
          ? KANT
          : p < 0.65
            ? ['–', '—', ' — ', ' – ']
            : p < 0.72
              ? KOMBINERANDE
              : p < 0.78
                ? EMOJI
                : p < 0.86
                  ? UTANFOR
                  : null
    s += pool
      ? pool[Math.floor(r() * pool.length)]!
      : String.fromCodePoint(Math.floor(r() * 0x2fff) + 1)
  }
  return s
}

describe('fortnoxText — Fortnox teckenklass (TESTKUND-016)', () => {
  it('orakel: källans klass innehåller U+2013, kolon, &, é, ü, komma och punkt men inte U+2014', () => {
    for (const c of ['–', ':', '&', 'é', 'ü', ',', '.', 'Ł'])
      expect([c, iKlassen(c)]).toEqual([c, true])
    for (const c of ['—', '"', "'", '\t', '<', '~']) expect([c, iKlassen(c)]).toEqual([c, false])
  })

  it('K2.2(a) generativt: 20 000 slumptexter per fält → exporttext helt i klassen, eller stopp med exakt de kodpunkter som ligger utanför — aldrig något annat', () => {
    const r = prng(20261009)
    const falt: FortnoxTextFalt[] = ['Description', 'TransactionInformation', 'Comments']
    let ok = 0,
      stopp = 0
    for (let i = 0; i < 20000; i++) {
      const ra = slumptext(r)
      for (const f of falt) {
        const res = fortnoxText(ra, f)
        const forvantad = f === 'Comments' ? ra : ra.split('—').join('–')
        const utanfor = [...forvantad].filter((c) => !iKlassen(c))
        if (res.ok) {
          ok++
          expect(res.export).toBe(forvantad)
          expect(iKlassen(res.export)).toBe(true)
          expect([...res.export].length).toBe([...ra].length)
          const antal = f === 'Comments' ? 0 : ra.split('—').length - 1
          expect(res.mappningar).toEqual(antal ? [{ fran: 'U+2014', till: 'U+2013', antal }] : [])
        } else {
          stopp++
          expect(utanfor.length).toBeGreaterThan(0)
          expect(res.tecken.map((t) => t.tecken)).toEqual(utanfor)
          expect(
            res.tecken.every(
              (t) =>
                t.kodpunkt ===
                `U+${t.tecken.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`,
            ),
          ).toBe(true)
        }
      }
    }
    // Fördelningen ska pröva båda utfallen ordentligt.
    expect(ok).toBeGreaterThan(5000)
    expect(stopp).toBeGreaterThan(5000)
  })

  it('Comments mappas aldrig (K1.4): U+2014 i Comments stoppar', () => {
    expect(fortnoxText('a — b', 'Comments')).toEqual({
      ok: false,
      tecken: [{ kodpunkt: 'U+2014', tecken: '—', position: 2 }],
    })
  })
})

/**
 * V-H4-4: varje Eveno-mall som kan bli ett exporterat verifikat (accounting.service.ts), med
 * realistiska värden, genom transformern och provdubbeln. Mallar med U+2014 mappas; övriga
 * skickas oförändrade. Ingen avvisning och inget onödigt stopp.
 */
const MALLAR: Array<[string, string]> = [
  ['hyresavi', 'Hyresavi AVI-2026-10-0001'],
  ['hyresintäkt (radtext)', 'Hyresintäkt 10/2026'],
  ['moms (radtext)', 'Moms 25%'],
  ['inbetalning hyresavi', 'Inbetalning hyresavi AVI-2026-10-0001 (José Müller & Co)'],
  ['inbetalning faktura', 'Inbetalning faktura F-2026-0042 (Anna Åberg)'],
  ['deposition', 'Deposition F-2026-0043'],
  ['depositionsbetalning', 'Inbetalning deposition (manuell)'],
  ['återbetalning deposition', 'Återbetalning deposition'],
  ['leverantörsfaktura (T1)', 'Leverantörsfaktura: Bygg & Co AB — Reparation, trapphus 2'],
  ['betald leverantörsfaktura (T2)', 'Betald leverantörsfaktura: Bygg & Co AB'],
  ['makulerad leverantörsfaktura', 'Makulerad leverantörsfaktura: Bygg & Co AB — Reparation'],
  ['faktura', 'Faktura F-2026-0042'],
  ['kreditnota', 'Kreditnota K-2026-0001'],
  ['förbrukning', 'Förbrukning El 2026-09'],
  ['övrig debitering', 'Övrig debitering ÖD-12'],
  ['kreditering avi', 'Kreditering av hyresavi AVI-2026-10-0001'],
  ['annullerad avi', 'Annullerad hyresavi: Hyresavi AVI-2026-10-0001'],
  ['hävd matchning', 'Hävd matchning: Inbetalning hyresavi AVI-2026-10-0001 (Lars Öberg)'],
]

describe('V-H4-4: produktens mallar genom transformer och provdubbel', () => {
  it.each(MALLAR)(
    '%s → READY, exporttext i klassen och godtagen av dubbeln',
    async (_namn, text) => {
      const { entry, config } = fixture()
      const med: LocalJournalEntrySnapshot = {
        ...entry,
        description: text,
        lines: entry.lines.map((l, i) => (i === 0 ? { ...l, description: text.slice(0, 100) } : l)),
      }
      const res = buildFortnoxVoucherDraft(med, config as FortnoxVoucherDraftConfig)
      expect(res.status).toBe('READY_DRY_RUN')
      if (res.status !== 'READY_DRY_RUN') throw new Error('READY förväntades')
      const v = res.payload.Voucher
      expect(v.Description).toBe(text.split('—').join('–'))
      expect(iKlassen(v.Description) && iKlassen(v.Comments)).toBe(true)
      expect(res.provenance.text.regelVersion).toBe(TEXT_REGEL_VERSION)
      expect(res.provenance.text.falt.map((f) => f.ra)).toEqual(
        text.includes('—') ? [text, text.slice(0, 100)] : [],
      )
      const api = new FakeFortnoxApi(new MockFortnoxLedgerReader())
      const svar = await api.fetch('https://api.fortnox.se/3/vouchers?financialyear=17', {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: JSON.stringify(res.payload),
      })
      expect(svar.status).toBe(201)
    },
  )

  it('dubbeln [K] avvisar exakt den observerade texten med 400/2000359 när mappningen inte görs', async () => {
    const { entry, config } = fixture()
    const res = buildFortnoxVoucherDraft(entry, config)
    if (res.status !== 'READY_DRY_RUN') throw new Error('READY förväntades')
    const ra = 'Leverantörsfaktura: EVENO TEST leverantör — EVENO TEST H3H4-013 RAW kostnad'
    const api = new FakeFortnoxApi(new MockFortnoxLedgerReader())
    const svar = await api.fetch('https://api.fortnox.se/3/vouchers?financialyear=17', {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: 'Bearer t' },
      body: JSON.stringify({ Voucher: { ...res.payload.Voucher, Description: ra } }),
    })
    expect(svar.status).toBe(400)
    expect(await svar.json()).toEqual({
      ErrorInformation: {
        error: 1,
        message: `Värdet innehåller ej tillåtna tecken. (${ra})`,
        code: 2000359,
      },
    })
  })

  it('T8: längd prövas efter mappningen, ingen avkortning; T6: utanför klassen ger TEXT_NOT_EXPORTABLE med fält och kodpunkt', () => {
    const { entry, config } = fixture()
    const lang = buildFortnoxVoucherDraft({ ...entry, description: 'x'.repeat(199) + '——' }, config)
    expect(lang.status === 'BLOCKED' && lang.reason.code).toBe('DESCRIPTION_UNREPRESENTABLE')
    const exakt = buildFortnoxVoucherDraft({ ...entry, description: 'x'.repeat(199) + '—' }, config)
    expect(exakt.status === 'READY_DRY_RUN' && exakt.payload.Voucher.Description).toBe(
      'x'.repeat(199) + '–',
    )
    const rad = buildFortnoxVoucherDraft(
      {
        ...entry,
        lines: entry.lines.map((l, i) => (i === 1 ? { ...l, description: 'A <B>' } : l)),
      },
      config,
    )
    expect(rad.status).toBe('BLOCKED')
    if (rad.status !== 'BLOCKED') throw new Error('BLOCKED förväntades')
    expect(rad.reason.code).toBe('TEXT_NOT_EXPORTABLE')
    expect(rad.reason.path).toBe('entry.lines[1]')
    expect(rad.reason.message).toContain('TransactionInformation på rad 2')
    expect(rad.reason.message).toContain('«<» (U+003C)')
    expect(rad.reason.message).toContain('«>» (U+003E)')
  })
})
