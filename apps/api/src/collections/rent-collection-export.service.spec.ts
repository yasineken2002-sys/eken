/**
 * Inkasso PR 4b — steg 3. RentCollectionExportService (read-only inkassoexport).
 *
 * Täcker:
 *   • INV-C: exporten rör INGEN bokföring och INGEN status-/kravstegsövergång —
 *     bara dokument + append-only audit-notering,
 *   • vägrar export av avi som inte är INKASSO_READY (grinden måste ha godkänt),
 *   • tenant-isolation: org verifieras före avins logg läses (NotFound annars),
 *   • CSV: batch-import-format med kapital + avgift + ränta + total + segment,
 *   • ränta per halvår ur INTEREST_ACCRUED-segmenten, total = auktoritativ
 *     (interestAccruedAmount) — aldrig dagviktat snitt,
 *   • bulk: ZIP bifogar lagrad påminnelse-PDF (4b₀) + batch-CSV, notering per avi.
 */

// StorageService drar in @aws-sdk (ESM) som ts-jest inte transformerar — stubba.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import JSZip from 'jszip'
import { RentCollectionExportService } from './rent-collection-export.service'
import { Decimal } from '@prisma/client/runtime/library'

function completeNotice(over: Record<string, unknown> = {}) {
  return {
    id: 'rn-1',
    organizationId: 'org-1',
    noticeNumber: 'AVI-2026-07-0001',
    ocrNumber: '1234567890',
    status: 'OVERDUE',
    collectionStage: 'INKASSO_READY',
    dueDate: new Date('2026-06-01'),
    sentAt: new Date('2026-06-02'),
    remindedAt: new Date('2026-06-09'),
    collectionReadyAt: new Date('2026-06-22'),
    totalAmount: new Decimal(8000),
    consumptionAmount: new Decimal(500),
    reminderFeeAmount: new Decimal(60),
    interestAccruedAmount: new Decimal(123.45),
    interestAccruedThrough: new Date('2026-06-22'),
    reminderPdfStorageKey: 'reminders/org-1/rn-1.pdf',
    tenant: {
      type: 'INDIVIDUAL',
      firstName: 'Anna',
      lastName: 'Andersson',
      companyName: null,
      personalNumber: '900101-1234',
      orgNumber: null,
      email: 'g@x.se',
      phone: '070-1',
      street: 'Storgatan 1',
      postalCode: '111 22',
      city: 'Stockholm',
    },
    organization: {
      name: 'Värd AB',
      orgNumber: '556000-0001',
      street: 'Värdgatan 2',
      postalCode: '222 33',
      city: 'Stockholm',
      email: 'v@x.se',
      collectionAgencyName: 'Intrum',
    },
    lease: { unit: { unitNumber: '1001', name: 'Lgh 1001', property: { name: 'Storgatan 1' } } },
    events: [
      { type: 'SENT', createdAt: new Date('2026-06-02'), payload: {} },
      { type: 'EMAIL_DELIVERED', createdAt: new Date('2026-06-09'), payload: {} },
      {
        type: 'INTEREST_ACCRUED',
        createdAt: new Date('2026-06-22'),
        payload: {
          interestTotal: 123.45,
          segments: [
            {
              from: '2026-06-02',
              to: '2026-06-22',
              days: 21,
              referenceRatePercent: 2,
              effectiveRatePercent: 10,
              amount: 123.45,
            },
          ],
        },
      },
    ],
    ...over,
  }
}

function makeService(
  opts: {
    notice?: Record<string, unknown> | null
    // PR 2 — export-grindens skuldkontroll. Default: skuld kvar, ingen ny betalning.
    outstanding?: number
    newerPayment?: { id: string } | null
  } = {},
) {
  const notice = opts.notice === undefined ? completeNotice() : opts.notice
  const txEventCreate = jest.fn().mockResolvedValue({})
  const tx = { rentNoticeEvent: { create: txEventCreate } }
  const update = jest.fn().mockResolvedValue({})
  const eventCreate = jest.fn().mockResolvedValue({})
  const paymentFindFirst = jest.fn().mockResolvedValue(opts.newerPayment ?? null)
  const prisma = {
    rentNotice: { findFirst: jest.fn().mockResolvedValue(notice), update },
    rentNoticeEvent: { create: eventCreate },
    rentNoticePayment: { findFirst: paymentFindFirst },
    $transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
  }
  const pdf = { generateFromHtml: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 underlag')) }
  const uploadFile = jest.fn().mockResolvedValue('https://signed.example/r2')
  const getFileBuffer = jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 paminnelse'))
  const storage = { uploadFile, getFileBuffer }
  const pdfQueue = { enqueue: jest.fn().mockResolvedValue('job-1') }
  // PR 2 — RentDebtService: default returnerar en utestående total-residual > 0
  // så grindens skuldkontroll släpper igenom om inget annat anges.
  const outstanding = jest.fn().mockResolvedValue({
    capital: 8500,
    consumption: 0,
    reminderFee: 60,
    interest: 123.45,
    claim: 8683.45,
    paid: 0,
    outstanding: opts.outstanding ?? 8683.45,
  })
  const rentDebt = { outstanding }
  const service = new RentCollectionExportService(
    prisma as never,
    pdf as never,
    storage as never,
    pdfQueue as never,
    rentDebt as never,
  )
  return {
    service,
    prisma,
    update,
    eventCreate,
    txEventCreate,
    pdf,
    uploadFile,
    getFileBuffer,
    outstanding,
    paymentFindFirst,
  }
}

// Plockar ut CSV-texten ur uploadFile-anropet (mime text/csv).
function csvFrom(uploadFile: jest.Mock): string {
  const call = uploadFile.mock.calls.find((c) => c[2] === 'text/csv')!
  return (call[0] as Buffer).toString('utf8')
}

describe('exportForNotice', () => {
  it('INV-C: ingen status-/kravstegsändring, ingen bokföring — bara dokument + audit-notering', async () => {
    const { service, update, eventCreate, uploadFile } = makeService()
    const res = await service.exportForNotice('rn-1', 'org-1')

    // Inga muteringar av avin (read-only).
    expect(update).not.toHaveBeenCalled()
    // PDF + CSV laddas upp org-scopat.
    expect(uploadFile).toHaveBeenCalledTimes(2)
    expect(res.pdfKey).toMatch(
      /^rent-collections\/org-1\/\d{4}-\d{2}-\d{2}\/inkasso-AVI-2026-07-0001\.pdf$/,
    )
    expect(res.csvKey).toMatch(/\.csv$/)
    // Append-only audit-notering (NOTE_ADDED), ingen pengahändelse.
    const ev = eventCreate.mock.calls[0]![0].data
    expect(ev.type).toBe('NOTE_ADDED')
    expect(ev.payload).toMatchObject({ action: 'inkasso-export' })
  })

  it('vägrar export av avi som inte är inkasso-redo (grinden måste ha godkänt)', async () => {
    const { service } = makeService({ notice: completeNotice({ collectionStage: 'REMINDED' }) })
    await expect(service.exportForNotice('rn-1', 'org-1')).rejects.toThrow(/inte inkasso-redo/)
  })

  it('tenant-isolation: avi i annan org (findFirst null) → NotFound', async () => {
    const { service, prisma } = makeService({ notice: null })
    await expect(service.exportForNotice('rn-1', 'org-1')).rejects.toThrow(/hittades inte/)
    // org verifieras i WHERE.
    expect(prisma.rentNotice.findFirst.mock.calls[0]![0].where).toMatchObject({
      id: 'rn-1',
      organizationId: 'org-1',
    })
  })

  it('CSV: batch-import-format med kapital, avgift, ränta, total och segment', async () => {
    const { service, uploadFile } = makeService()
    await service.exportForNotice('rn-1', 'org-1')
    const csv = csvFrom(uploadFile)
    const [header, row] = csv.split('\n')
    expect(header).toContain('avinummer')
    expect(header).toContain('drojsmalsranta')
    expect(header).toContain('rantesegment')
    expect(header).toContain('total_skuld')
    // Kapital = hyra 8000 + förbrukning 500; total = 8500 + 60 + 123.45.
    expect(row).toContain('8500.00')
    expect(row).toContain('60.00')
    expect(row).toContain('123.45')
    expect(row).toContain('8683.45')
    // Segment kodat per halvår (ej dagviktat snitt).
    expect(row).toContain('2026-06-02..2026-06-22:21d:10.00%:123.45')
    // Gäldenär + borgenär identifierade.
    expect(row).toContain('900101-1234')
    expect(row).toContain('556000-0001')
    expect(row).toContain('Intrum')
  })

  it('CSV formula-injection: namn som börjar på = neutraliseras med apostrof', async () => {
    const { service, uploadFile } = makeService({
      notice: completeNotice({
        tenant: {
          type: 'COMPANY',
          companyName: '=HYPERLINK("http://evil","x")',
          firstName: null,
          lastName: null,
          personalNumber: null,
          orgNumber: '556000-9999',
          email: null,
          phone: null,
          street: 'Storgatan 1',
          postalCode: '111 22',
          city: 'Stockholm',
        },
      }),
    })
    await service.exportForNotice('rn-1', 'org-1')
    const row = csvFrom(uploadFile).split('\n')[1]!
    // Apostrof-prefix + (eftersom värdet citeras pga komma) — formeln körs inte.
    expect(row).toContain(`"'=HYPERLINK`)
    expect(row).not.toMatch(/(^|,)=HYPERLINK/)
  })

  it('PDF: HTML-escapar gäldenäradress och innehåller inkassolagen-disclaimer', async () => {
    const { service, pdf } = makeService({
      notice: completeNotice({
        tenant: {
          type: 'INDIVIDUAL',
          firstName: 'Anna',
          lastName: 'A',
          companyName: null,
          personalNumber: '900101-1234',
          orgNumber: null,
          email: null,
          phone: null,
          street: '<script>alert(1)</script>',
          postalCode: '111 22',
          city: 'Stockholm',
        },
      }),
    })
    await service.exportForNotice('rn-1', 'org-1')
    const html = pdf.generateFromHtml.mock.calls[0]![0] as string
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    // Juridisk anmärkning: inkassobolaget ansvarar för formellt inkassokrav.
    expect(html).toContain('1974:182')
  })

  it('total = auktoritativ (interestAccruedAmount), även om Σ segment skulle skilja', async () => {
    // Segment summerar till 100, men bokförd ränta är 123.45 → totalen följer det bokförda.
    const { service, uploadFile, pdf } = makeService({
      notice: completeNotice({
        events: [
          { type: 'EMAIL_DELIVERED', createdAt: new Date('2026-06-09'), payload: {} },
          {
            type: 'INTEREST_ACCRUED',
            createdAt: new Date('2026-06-22'),
            payload: {
              segments: [
                {
                  from: '2026-06-02',
                  to: '2026-06-22',
                  days: 21,
                  referenceRatePercent: 2,
                  effectiveRatePercent: 10,
                  amount: 100,
                },
              ],
            },
          },
        ],
      }),
    })
    await service.exportForNotice('rn-1', 'org-1')
    const csv = csvFrom(uploadFile)
    const row = csv.split('\n')[1]!
    expect(row).toContain('123.45') // drojsmalsranta = auktoritativ bokförd total
    expect(row).toContain('8683.45') // total använder den, inte segmentsumman 100
    // PDF visar segmentet som egen rad.
    const html = pdf.generateFromHtml.mock.calls[0]![0] as string
    expect(html).toContain('Dröjsmålsränta per period')
    expect(html).toContain('10.00 %')
  })
})

describe('exportBulk', () => {
  it('bygger ZIP med underlag-PDF + lagrad påminnelse-PDF + batch-CSV och loggar per avi', async () => {
    const { service, uploadFile, getFileBuffer, txEventCreate } = makeService()
    const res = await service.exportBulk(['rn-1'], 'org-1')
    expect(res.count).toBe(1)
    expect(res.zipKey).toMatch(/^rent-collections\/org-1\/.*\.zip$/)

    // Dokumentkopian (4b₀) hämtas och bifogas.
    expect(getFileBuffer).toHaveBeenCalledWith('reminders/org-1/rn-1.pdf')

    // Verifiera ZIP-innehållet.
    const zipCall = uploadFile.mock.calls.find((c) => c[2] === 'application/zip')!
    const zip = await JSZip.loadAsync(zipCall[0] as Buffer)
    const names = Object.keys(zip.files)
    expect(names).toContain('AVI-2026-07-0001/inkasso-underlag-AVI-2026-07-0001.pdf')
    expect(names).toContain('AVI-2026-07-0001/paminnelse-AVI-2026-07-0001.pdf')
    expect(names).toContain('inkasso-rent-batch.csv')

    // INV-C: append-only notering per avi, ingen statusändring.
    expect(txEventCreate.mock.calls[0]![0].data.type).toBe('NOTE_ADDED')
  })

  it('vägrar bulk om någon avi inte är inkasso-redo', async () => {
    const { service, prisma } = makeService()
    prisma.rentNotice.findFirst.mockResolvedValueOnce(
      completeNotice({ collectionStage: 'REMINDED', noticeNumber: 'AVI-X' }),
    )
    await expect(service.exportBulk(['rn-x'], 'org-1')).rejects.toThrow(/inte inkasso-redo/)
  })
})

// ── Bankavstämnings-härdning PR 2 · INV-D — exportgrinden på FAKTISK skuld ──────
describe('PR2 · export-grind (INV-D): faktisk skuld, inte collectionStage', () => {
  it('ZOMBIE: betald avi som ligger kvar INKASSO_READY kan ALDRIG exporteras', async () => {
    const { service, uploadFile, outstanding } = makeService({
      notice: completeNotice({ status: 'PAID', collectionStage: 'INKASSO_READY' }),
    })
    await expect(service.exportForNotice('rn-1', 'org-1')).rejects.toThrow(/betald/i)
    // Inget inkasso-artefakt producerat (ingen PDF/CSV uppladdad).
    expect(uploadFile).not.toHaveBeenCalled()
    // Status-grinden fäller före ens skuldfrågan ställs.
    expect(outstanding).not.toHaveBeenCalled()
  })

  it('REGLERAD: outstanding = 0 → export vägras (ingen utestående skuld)', async () => {
    const { service, uploadFile } = makeService({ outstanding: 0 })
    await expect(service.exportForNotice('rn-1', 'org-1')).rejects.toThrow(/ingen utestående skuld/)
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it('NY BETALNING efter inkasso-redo → export vägras (måste granskas på nytt)', async () => {
    const { service, uploadFile, paymentFindFirst } = makeService({
      outstanding: 4000, // delbetalning: skuld kvar MEN en ny betalning har inkommit
      newerPayment: { id: 'rnp-late' },
    })
    await expect(service.exportForNotice('rn-1', 'org-1')).rejects.toThrow(
      /betalning registrerad efter/,
    )
    expect(uploadFile).not.toHaveBeenCalled()
    // Payment-frågan filtrerar på avin + createdAt > collectionReadyAt.
    const where = paymentFindFirst.mock.calls[0]![0].where
    expect(where.rentNoticeId).toBe('rn-1')
    expect(where.createdAt.gt).toEqual(new Date('2026-06-22'))
  })

  it('TOTAL-RESIDUAL inkl. ränta: bara ränta kvar (outstanding > 0) → export TILLÅTS', async () => {
    const { service, uploadFile, outstanding } = makeService({ outstanding: 123.45 })
    const res = await service.exportForNotice('rn-1', 'org-1')
    expect(res.noticeId).toBe('rn-1')
    expect(uploadFile).toHaveBeenCalledTimes(2) // PDF + CSV producerade
    // Skuldfrågan org-scopas på avins organizationId.
    expect(outstanding).toHaveBeenCalledWith('rn-1', 'org-1')
  })

  it('bulk: en enda reglerad avi fäller hela bulken med konkret skäl', async () => {
    const { service, uploadFile } = makeService({ outstanding: 0 })
    await expect(service.exportBulk(['rn-1'], 'org-1')).rejects.toThrow(/Kan inte exportera/)
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it('listReady filtrerar bort reglerade/zombie — listar bara faktiskt exporterbara', async () => {
    const txEventCreate = jest.fn()
    const tx = { rentNoticeEvent: { create: txEventCreate } }
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'rn-skuld',
        noticeNumber: 'AVI-1',
        status: 'OVERDUE',
        collectionReadyAt: new Date('2026-06-22'),
      },
      {
        id: 'rn-reglerad',
        noticeNumber: 'AVI-2',
        status: 'OVERDUE',
        collectionReadyAt: new Date('2026-06-22'),
      },
    ])
    const paymentFindFirst = jest.fn().mockResolvedValue(null)
    const prisma = {
      rentNotice: { findMany },
      rentNoticePayment: { findFirst: paymentFindFirst },
      $transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
    }
    // rn-skuld har skuld kvar, rn-reglerad är betald (outstanding 0).
    const outstanding = jest
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve({ outstanding: id === 'rn-skuld' ? 5000 : 0 }),
      )
    const service = new RentCollectionExportService(
      prisma as never,
      { generateFromHtml: jest.fn() } as never,
      { uploadFile: jest.fn(), getFileBuffer: jest.fn() } as never,
      { enqueue: jest.fn() } as never,
      { outstanding } as never,
    )

    const list = (await service.listReady('org-1')) as Array<{ id: string }>
    expect(list.map((n) => n.id)).toEqual(['rn-skuld'])
    // DB-förfiltret exkluderar PAID/CANCELLED redan i WHERE.
    expect(findMany.mock.calls[0]![0].where.status).toEqual({ notIn: ['PAID', 'CANCELLED'] })
  })
})
