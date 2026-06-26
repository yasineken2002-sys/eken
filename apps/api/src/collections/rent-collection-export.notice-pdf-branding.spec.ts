/**
 * Steg 3, PR 3e-ii — den hyres-/avi-baserade inkasso-PDF:en
 * (rent-collection-export.service.ts, RentCollectionExportService) renderas nu
 * genom den gemensamma brandade shellen (buildBrandedPdfHtml, hideFooter) i
 * stället för egen inline-HTML med hårdkodad grön #1a4a28 och ingen logga.
 *
 * Detta är seriens KÄNSLIGASTE dokument — alla tunga element samlade: den
 * juristkrävda disclaimern, den period-segmenterade dröjsmålsräntan, OCR och
 * hela skuldspecifikationen. Testet låser att migreringen är BYTE-FÖR-BYTE
 * neutral för allt bindande innehåll:
 *
 *   (a) Den HYRESJURIST-KRÄVDA DISCLAIMERN — inkassobolaget äger det formella
 *       kravet (inkassolagen 1974:182 5 §), Eveno saknar inkassolicens, samt
 *       lagrum för avgift (1981:739) och ränta (räntelagen 1975:635 6 §, 9 §) —
 *       ordagrant oförändrad, inklusive <strong>-markeringen.
 *   (b) Den PERIOD-SEGMENTERADE dröjsmålsräntan — varje halvårssegment (period,
 *       dagar, effektiv räntesats, belopp) PLUS den auktoritativa totalen
 *       (interestAccruedAmount). Totalen är ALLTID den bokförda — aldrig
 *       segmentsumman — även vid öresrest.
 *   (c) Alla övriga belopp (kapital, påminnelseavgift, total skuld) + OCR +
 *       förfallodatum + borgenär/gäldenär — oförändrade.
 *
 * Detta dokument visar — som #126 — INGET bankgiro (betalningsvägen ägs av
 * inkassobolaget). Testet låser att inget bankgiro smyger in via shellen.
 * Visuell ändring (avsiktlig, ej innehåll): egen grön #1a4a28 → DEFAULT_BRAND_COLOR.
 */

// StorageService drar in @aws-sdk (ESM) som ts-jest inte transformerar — stubba.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { RentCollectionExportService } from './rent-collection-export.service'
import { Decimal } from '@prisma/client/runtime/library'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'

function formatSek(amount: number): string {
  return `${amount.toLocaleString('sv-SE', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} kr`
}

// Två räntesegment som korsar ett halvårsskifte (räntelagen 9 §). Σ = 123.45.
const SEGMENTS = [
  {
    from: '2026-05-02',
    to: '2026-06-30',
    days: 60,
    referenceRatePercent: 2.0,
    effectiveRatePercent: 10.0,
    amount: 100.0,
  },
  {
    from: '2026-07-01',
    to: '2026-07-20',
    days: 20,
    referenceRatePercent: 2.5,
    effectiveRatePercent: 10.5,
    amount: 23.45,
  },
]

const ORG = {
  name: 'Värd & Co',
  orgNumber: '556000-0001',
  street: 'Storgatan 1',
  postalCode: '111 22',
  city: 'Stockholm',
  email: 'kontakt@vard.se',
  phone: '08-123 456',
  bankgiro: '1234-5678', // finns på org men FÅR INTE synas i inkassounderlaget
  vatNumber: 'SE556000000101',
  collectionAgencyName: 'Intrum',
  invoiceColor: null, // → DEFAULT_BRAND_COLOR
  brandSecondaryColor: null,
  brandFont: null,
  logoStorageKey: null, // → getLogoDataUrl returnerar null utan storage-anrop
}

function makeNotice(over: Record<string, unknown> = {}) {
  return {
    id: 'rn-1',
    organizationId: 'org-1',
    noticeNumber: 'AVI-2026-07-0001',
    ocrNumber: '12345678901234',
    status: 'OVERDUE',
    collectionStage: 'INKASSO_READY',
    dueDate: new Date('2026-06-01T00:00:00Z'),
    sentAt: new Date('2026-05-25T00:00:00Z'),
    remindedAt: new Date('2026-06-09T00:00:00Z'),
    collectionReadyAt: new Date('2026-07-21T00:00:00Z'),
    totalAmount: new Decimal(8000),
    consumptionAmount: new Decimal(500),
    miscChargeAmount: new Decimal(0),
    reminderFeeAmount: new Decimal(60),
    interestAccruedAmount: new Decimal(123.45),
    interestAccruedThrough: new Date('2026-07-20T00:00:00Z'),
    reminderPdfStorageKey: 'reminders/org-1/rn-1.pdf',
    tenant: {
      type: 'INDIVIDUAL',
      firstName: 'Anna',
      lastName: "O'Brien & <x>", // apostrof + &/<> → escapas (aldrig rått)
      companyName: null,
      personalNumber: '900101-1234',
      orgNumber: null,
      email: 'anna@example.se',
      phone: '070-111 22 33',
      street: "Karl's väg <b>5</b>", // injektionsförsök i adress → escapas
      postalCode: '222 33',
      city: 'Göteborg',
    },
    organization: ORG,
    lease: {
      unit: { name: 'Lgh 1001', unitNumber: '1001', property: { name: 'Storgatan 1' } },
    },
    events: [
      {
        type: 'INTEREST_ACCRUED',
        createdAt: new Date('2026-07-21T00:00:00Z'),
        payload: { segments: SEGMENTS },
      },
      { type: 'EMAIL_DELIVERED', createdAt: new Date('2026-06-10T00:00:00Z'), payload: {} },
    ],
    ...over,
  }
}

function makeService(): RentCollectionExportService {
  const noop = {}
  return new RentCollectionExportService(
    noop as never, // prisma
    noop as never, // pdf
    noop as never, // storage
    noop as never, // pdfQueue
    noop as never, // rentDebt
  )
}

async function render(notice: Record<string, unknown> = makeNotice()): Promise<string> {
  return (makeService() as unknown as { buildPdfHtml(n: unknown): Promise<string> }).buildPdfHtml(
    notice,
  )
}

describe('RentCollectionExportService.buildPdfHtml — brandad shell + juridisk/ekonomisk integritet (PR 3e-ii)', () => {
  it('(a) den juristkrävda disclaimern är byte-för-byte oförändrad', async () => {
    const text = (await render()).replace(/\s+/g, ' ')
    expect(text).toContain(
      'Detta dokument är ett underlag för inkassoärende. Borgenären ansvarar för att ' +
        'skicka det vidare till sitt valda inkassobolag (t.ex. Visma Collectors, Intrum ' +
        'eller Lindorff). Påminnelseavgift (60 kr) utgår enligt lag (1981:739) om ' +
        'ersättning för inkassokostnader. Dröjsmålsränta beräknas enligt räntelagen ' +
        '(1975:635) 6 § (referensränta + 8 procentenheter) och redovisas per period ' +
        'enligt 9 §. <strong>Inkassobolaget ansvarar för att utfärda formellt ' +
        'inkassokrav enligt inkassolagen (1974:182) 5 § med skälig betalningstid innan ' +
        'betalningsföreläggande eller talan väcks.</strong> Eveno är ett ' +
        'fastighetssystem, bedriver INTE inkassoverksamhet och har inte tillstånd enligt ' +
        'inkassolagen.',
    )
    // De laddade fraserna explicit (icke förhandlingsbart).
    expect(text).toContain('Inkassobolaget ansvarar för att utfärda formellt inkassokrav')
    expect(text).toContain('inkassolagen (1974:182) 5 §')
    expect(text).toContain('bedriver INTE inkassoverksamhet och har inte tillstånd enligt')
    expect(text).toContain('lag (1981:739)')
    expect(text).toContain('räntelagen (1975:635) 6 §')
  })

  it('(b) period-segmenterad ränta: varje segment (period/dagar/sats/belopp) bevaras', async () => {
    const html = await render()
    // Segment 1
    expect(html).toContain('2026-05-02 – 2026-06-30')
    expect(html).toContain('>60<') // dagar
    expect(html).toContain('10.00 %')
    expect(html).toContain(formatSek(100)) // 100,00 kr
    // Segment 2 (efter halvårsskiftet, högre referensränta)
    expect(html).toContain('2026-07-01 – 2026-07-20')
    expect(html).toContain('>20<') // dagar
    expect(html).toContain('10.50 %')
    expect(html).toContain(formatSek(23.45)) // 23,45 kr
    // Räntan som egen specificerad sektion (räntelagen 9 §).
    expect(html).toContain('Dröjsmålsränta per period (räntelagen 6 §, 9 §)')
  })

  it('(b) totalen använder den AUKTORITATIVA bokförda räntan, aldrig segmentsumman (öresrest)', async () => {
    // Σ segment = 123.40 men bokförd interestAccruedAmount = 123.45 → öresrest 0.05.
    // Dröjsmålsränteraden och totalen MÅSTE följa den bokförda totalen.
    const oresrest = makeNotice({
      interestAccruedAmount: new Decimal(123.45),
      events: [
        {
          type: 'INTEREST_ACCRUED',
          createdAt: new Date('2026-07-21T00:00:00Z'),
          payload: {
            segments: [
              { ...SEGMENTS[0], amount: 100.0 },
              { ...SEGMENTS[1], amount: 23.4 }, // Σ = 123.40
            ],
          },
        },
      ],
    })
    const html = await render(oresrest)
    expect(html).toContain(formatSek(123.45)) // Dröjsmålsränta-raden = auktoritativ total
    expect(html).toContain(formatSek(8683.45)) // total = 8500 + 60 + 123.45 (ej 123.40)
  })

  it('(c) övriga belopp, OCR, förfallodatum och parter bevaras', async () => {
    const html = await render()
    expect(html).toContain(formatSek(8500)) // kapital = 8000 + 500
    expect(html).toContain(formatSek(60)) // påminnelseavgift
    expect(html).toContain(formatSek(123.45)) // dröjsmålsränta (auktoritativ)
    expect(html).toContain(formatSek(8683.45)) // total skuld att driva in
    expect(html).toContain('Dröjsmålsränta (t.o.m. 2026-07-20)') // interestThrough
    expect(html).toContain('OCR 12345678901234') // OCR som text (digits → escaping = identitet)
    expect(html).toContain('2026-06-01') // förfallodatum (sv-SE)
    expect(html).toContain('Org.nr: 556000-0001') // borgenär
    expect(html).toContain('Personnr: 900101-1234') // gäldenär
    expect(html).toContain('Storgatan 1 – Lgh 1001 (1001)') // kontraktsreferens
  })

  it('renderas genom shellen (header + titel) UTAN footer (disclaimern är sista ordet)', async () => {
    const html = await render()
    expect(html).toContain('class="bp-header"')
    expect(html).toContain('Inkassounderlag – hyresfordran') // dokumenttitel via shellen
    expect(html).not.toContain('class="bp-footer"') // hideFooter
  })

  it('INGET bankgiro i dokumentet (betalningsvägen ägs av inkassobolaget)', async () => {
    const html = await render()
    expect(html).not.toContain('1234-5678') // org-bankgiro får ALDRIG synas här
    expect(html).not.toContain('Bankgiro')
  })

  it('färg: egen grön #1a4a28 → DEFAULT_BRAND_COLOR (avsiktlig enhetlig brandfärg)', async () => {
    const html = await render()
    expect(html).toContain(DEFAULT_BRAND_COLOR)
    expect(html).not.toContain('#1a4a28')
  })

  it('escapar fri text (gäldenärnamn + adress, org-namn) men ALDRIG belopp/OCR/disclaimer', async () => {
    const html = await render()
    expect(html).toContain('O&#x27;Brien &amp; &lt;x&gt;') // namn (apostrof via shell-escape)
    expect(html).toContain('Karl&#x27;s väg &lt;b&gt;5&lt;/b&gt;') // adress-injektion neutraliserad
    expect(html).toContain('Värd &amp; Co') // org-namn escapat
    expect(html).not.toContain('<x>')
    expect(html).not.toContain('<b>5</b>')
  })
})
