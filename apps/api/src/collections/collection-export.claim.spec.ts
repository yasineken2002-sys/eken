/**
 * #307 PR1 — claim FÖRE I/O i inkassoexporten.
 *
 * DEN HÄR FILEN FINNS FÖR ATT BEVISRIGGEN INTE ÖVERLEVER. Racet bevisades mot
 * riktig Postgres (`.proof-307`, S1–S7), men den riggen raderas före PR enligt
 * `docs/runbooks/bevisrigg-riktig-postgres.md`. Utan en mockad spec i den
 * ordinarie sviten fanns ingen bevakning alls mot att en framtida refaktorering
 * återinför den blinda skrivningen — påpekat av security-granskningen, och
 * samma sorts hål som FAR hittade i cancelNotice-sviten under #301.
 *
 * Vad som bevakas här är ORDNINGEN och GRINDARNA — det som går att se med
 * attrapper. Att fönstret faktiskt är stängt under samtidighet kan bara visas
 * mot en riktig databas och står i PR-beskrivningen.
 *
 * DISKRIMINERANDE ATTRAPPER: `prisma` och `tx` är SKILDA objekt (läxan från
 * #288), och anropsordningen fångas i en array så "claim före I/O" kan hävdas
 * som just en ordning — inte bara som "båda hände".
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException, ConflictException } from '@nestjs/common'
import { CollectionExportService } from './collection-export.service'

const ORG = 'org-1'

function makeService(
  opts: {
    /** Fakturor som loadInvoice ska returnera, i tur och ordning. */
    invoices?: Array<{ id: string; invoiceNumber: string; status: string }>
    /** count som claimens updateMany returnerar (0 = någon hann före). */
    claimCount?: number
  } = {},
) {
  const rows = opts.invoices ?? [{ id: 'inv-1', invoiceNumber: 'F-2026-0001', status: 'OVERDUE' }]
  const ordning: string[] = []

  const tx = {
    invoice: {
      updateMany: jest.fn((..._a: unknown[]) => {
        ordning.push('claim')
        return Promise.resolve({ count: opts.claimCount ?? 1 })
      }),
      update: jest.fn(() => Promise.resolve({})),
    },
    invoiceEvent: {
      create: jest.fn((..._a: unknown[]) => {
        ordning.push('skriv-händelse')
        return Promise.resolve({})
      }),
    },
  }

  const prisma = {
    invoice: {
      // loadInvoice — matar ut raderna i tur och ordning.
      findFirst: jest.fn(() =>
        Promise.resolve({
          ...rows.shift(),
          total: 11_000,
          dueDate: new Date('2026-01-31'),
          issueDate: new Date('2026-01-01'),
          // Organisationen bär bara varumärkesfält i PDF-bygget — inga belopp,
          // ingen status. Namnet räcker; resten defaultar i branding-hjälparen.
          organization: {
            name: 'Bevis AB',
            logoStorageKey: null,
            invoiceColor: null,
            brandSecondaryColor: null,
            brandFont: null,
          },
          lines: [],
          paymentReminders: [],
          payments: [],
          tenant: null,
          customer: null,
          lease: null,
        }),
      ),
      update: jest.fn((..._a: unknown[]) => {
        ordning.push('skriv-nyckel')
        return Promise.resolve({})
      }),
    },
    invoiceEvent: { create: jest.fn() },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }

  const pdf = {
    generateFromHtml: jest.fn(() => {
      ordning.push('generera-pdf')
      return Promise.resolve(Buffer.from('%PDF'))
    }),
  }
  const storage = {
    uploadFile: jest.fn((_b: Buffer, key: string) => {
      ordning.push('ladda-upp')
      return Promise.resolve(`https://r2.test/${key}`)
    }),
  }

  const service = new CollectionExportService(
    prisma as never,
    { reveal: jest.fn(() => null) } as never,
    pdf as never,
    storage as never,
    { enqueue: jest.fn() } as never,
  )
  return { service, prisma, tx, pdf, storage, ordning }
}

describe('#307 — claimForExport: claim före I/O', () => {
  it('ORDNINGEN: claim och händelse skrivs FÖRE PDF och uppladdning', async () => {
    const { service, ordning } = makeService()

    await service.exportForInvoice('inv-1', ORG)

    // Kärnan i #307. Fanns claimen efter I/O:t låg det sekunder emellan.
    expect(ordning.indexOf('claim')).toBeLessThan(ordning.indexOf('generera-pdf'))
    expect(ordning.indexOf('claim')).toBeLessThan(ordning.indexOf('ladda-upp'))
    expect(ordning.indexOf('skriv-händelse')).toBeLessThan(ordning.indexOf('generera-pdf'))
    // Nyckeln kan först skrivas när uppladdningen är klar.
    expect(ordning.indexOf('ladda-upp')).toBeLessThan(ordning.indexOf('skriv-nyckel'))
  })

  it('claimen är STATUS-GUARDAD och org-scopad — inte en blind update', async () => {
    const { service, tx } = makeService()

    await service.exportForInvoice('inv-1', ORG)

    const where = (tx.invoice.updateMany.mock.calls[0] as unknown[])[0] as {
      where: Record<string, unknown>
    }
    expect(where.where['id']).toBe('inv-1')
    expect(where.where['organizationId']).toBe(ORG)
    // Guarden är det som gör claimen atomisk: hann fakturan bli reglerad
    // matchar updateMany noll rader.
    expect(where.where['status']).toEqual({ notIn: ['PAID', 'VOID', 'SENT_TO_COLLECTION'] })
  })

  it('count === 0 → ConflictException, INGEN händelse, INGET dyrt arbete', async () => {
    // Någon hann före mellan läsningen och claimen. DEBT_COLLECTION är
    // append-only och får aldrig skrivas för ett krav som inte gäller.
    const { service, tx, pdf, storage } = makeService({ claimCount: 0 })

    await expect(service.exportForInvoice('inv-1', ORG)).rejects.toBeInstanceOf(ConflictException)

    expect(tx.invoiceEvent.create).not.toHaveBeenCalled()
    expect(pdf.generateFromHtml).not.toHaveBeenCalled()
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it('claim och händelse ligger i SAMMA transaktion — kan inte skiljas åt', async () => {
    const { service, prisma, tx } = makeService()

    await service.exportForInvoice('inv-1', ORG)

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    // Båda skrevs på transaktionsklienten, inte på prisma bredvid den (#288).
    expect(tx.invoice.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.invoiceEvent.create).toHaveBeenCalledTimes(1)
  })

  it.each([['PAID'], ['VOID']])(
    'redan %s → BadRequestException före transaktionen ens öppnas',
    async (status) => {
      const { service, prisma, pdf } = makeService({
        invoices: [{ id: 'inv-1', invoiceNumber: 'F-2026-0001', status }],
      })

      await expect(service.exportForInvoice('inv-1', ORG)).rejects.toBeInstanceOf(
        BadRequestException,
      )

      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(pdf.generateFromHtml).not.toHaveBeenCalled()
    },
  )

  it('IDEMPOTENS: redan SENT_TO_COLLECTION → ingen ANDRA händelse, men nyckeln fylls i', async () => {
    // Omkörning efter ett R2-fel. Claimen är redan gjord; bara underlaget saknas.
    const { service, prisma, tx } = makeService({
      invoices: [{ id: 'inv-1', invoiceNumber: 'F-2026-0001', status: 'SENT_TO_COLLECTION' }],
    })

    await service.exportForInvoice('inv-1', ORG)

    expect(tx.invoice.updateMany).not.toHaveBeenCalled()
    expect(tx.invoiceEvent.create).not.toHaveBeenCalled()
    // …men nyckeln skrivs, så det hängande tillståndet läks.
    expect(prisma.invoice.update).toHaveBeenCalledTimes(1)
  })
})

describe('#307 — exportBulk: bara claimade fakturor kommer med', () => {
  it('betald/makulerad faktura får INGEN PDF i ZIP:en och rapporteras som skippad', async () => {
    // Zip-loopen filtrerade tidigare inte alls: varje begärd faktura fick ett
    // fullständigt inkassokrav i batchen till inkassobolaget, oavsett status
    // och helt utan samtidighet inblandad.
    const { service, pdf } = makeService({
      invoices: [
        { id: 'a', invoiceNumber: 'F-1', status: 'OVERDUE' },
        { id: 'b', invoiceNumber: 'F-2', status: 'PAID' },
        { id: 'c', invoiceNumber: 'F-3', status: 'OVERDUE' },
      ],
    })

    const res = await service.exportBulk(['a', 'b', 'c'], ORG)

    expect(res.count).toBe(2)
    expect(res.skipped.map((s) => s.invoiceNumber)).toEqual(['F-2'])
    // TVÅ renderingar, inte tre. Den betalda fakturan når aldrig inkassobolaget.
    expect(pdf.generateFromHtml).toHaveBeenCalledTimes(2)
  })

  it('samtliga oexporterbara → kastar hellre än att ladda upp en tom batch', async () => {
    const { service, storage } = makeService({
      invoices: [
        { id: 'a', invoiceNumber: 'F-1', status: 'PAID' },
        { id: 'b', invoiceNumber: 'F-2', status: 'VOID' },
      ],
    })

    await expect(service.exportBulk(['a', 'b'], ORG)).rejects.toBeInstanceOf(BadRequestException)
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })
})
