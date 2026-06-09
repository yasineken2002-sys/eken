/**
 * Steg 3, PR 3d — påminnelse-PDF:en renderas genom den gemensamma brandade
 * shellen (buildBrandedPdfHtml, hideFooter). Påminnelsen är ett betalnings- OCH
 * juridiskt laddat dokument (lag 1981:739), så detta test låser att de
 * BETALNINGSBÄRANDE fälten är BYTE-FÖR-BYTE oförändrade efter migreringen:
 *   • OCR-nummer
 *   • ursprungligt belopp (hyra + förbrukning)
 *   • påminnelseavgift (60 kr)
 *   • total ("Att betala nu" = hyra + förbrukning + avgift)
 *   • bankgiro
 *   • förfallodatum
 *   • betalningsmottagare (fordringsägarens namn, RÅTT — byte-för-byte)
 * Samt att den går genom shellen (header, ingen footer) och att fri text
 * (hyresgästnamn) escapas — men ALDRIG betalningsfälten.
 *
 * OBS: påminnelse-PDF:en har — till skillnad från hyresavin — INGEN maskinläsbar
 * OCR-giro-rad och INGEN dröjsmålsränta i totalen (räntan löper separat och
 * redovisas inte på påminnelsen). Detta test låser att inget sådant smyger in.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { RentReminderService } from './rent-reminder.service'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'

function fmt(n: number): string {
  return n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const NOTICE = {
  noticeNumber: 'AVI-2026-07-0001',
  ocrNumber: '1234567890',
  dueDate: new Date('2026-06-01T00:00:00Z'),
  totalAmount: 8000,
  consumptionAmount: 0,
  reminderFeeAmount: 60,
  tenant: { type: 'INDIVIDUAL', firstName: 'Anna', lastName: '& Co <x>', companyName: null },
}

const ORG = {
  name: 'Värd & Co', // '&' → escapas i shell-headern men RÅTT i fordringsägar-/mottagarblocket
  street: 'Storgatan 1',
  postalCode: '111 22',
  city: 'Stockholm',
  bankgiro: '5050-1055',
  invoiceColor: null, // → DEFAULT_BRAND_COLOR
  brandSecondaryColor: null,
  brandFont: null,
  logoStorageKey: null,
}

function makeService(): RentReminderService {
  const noop = {}
  return new RentReminderService(
    noop as never, // prisma
    noop as never, // accounting
    noop as never, // rentNoticeEvents
    noop as never, // rentInterest
    noop as never, // pdfQueue
    noop as never, // mailService
    noop as never, // pdfService
    noop as never, // storage
    noop as never, // rentDebt
    noop as never, // freshness
  )
}

async function render(): Promise<string> {
  return makeService().buildReminderPdfHtml(NOTICE as never, ORG)
}

describe('RentReminderService.buildReminderPdfHtml — brandad shell + betalningsintegritet (PR 3d)', () => {
  it('BETALNINGSBÄRANDE fält är byte-för-byte oförändrade', async () => {
    const html = await render()

    expect(html).toContain('1234567890') // OCR-nummer
    expect(html).toContain(`${fmt(8000)} kr`) // ursprungligt belopp
    expect(html).toContain(`${fmt(60)} kr`) // påminnelseavgift
    expect(html).toContain(`${fmt(8060)} kr`) // att betala nu = 8000 + 0 + 60
    expect(html).toContain('5050-1055') // bankgiro
    expect(html).toContain('2026-06-01') // förfallodatum
    expect(html).toContain('Värd & Co') // mottagare/fordringsägare RÅTT, trots '&'
  })

  it('har INGEN maskinläsbar OCR-giro-rad och INGEN dröjsmålsränta i totalen', async () => {
    const html = await render()
    expect(html).not.toContain('#41#') // ingen bankgiro-maskinrad (till skillnad från hyresavin)
    expect(html).not.toContain('Dröjsmålsränta')
    expect(html).not.toContain('ränta')
  })

  it('renderas genom shellen (header) UTAN footer', async () => {
    const html = await render()
    expect(html).toContain('class="bp-header"')
    expect(html).not.toContain('class="bp-footer"')
    expect(html).toContain('Betalningspåminnelse') // dokumenttitel via shellen
  })

  it('saknad invoiceColor → DEFAULT_BRAND_COLOR (pixel-identiskt med tidigare #1a6b3c)', async () => {
    const html = await render()
    expect(html).toContain(DEFAULT_BRAND_COLOR)
    expect(DEFAULT_BRAND_COLOR).toBe('#1a6b3c')
  })

  it('escapar fri text (hyresgästnamn) men ALDRIG betalningsfält/mottagare', async () => {
    const html = await render()
    expect(html).toContain('Anna &amp; Co &lt;x&gt;') // hyresgästnamn escapat
    expect(html).not.toContain('<x>')
    // mottagaren 'Värd & Co' är fortfarande rått (verifierat i test ovan).
  })

  it('bevarar det lagstadgade innehållet (fordringsägare + adress + lagrum 1981:739)', async () => {
    const html = await render()
    expect(html).toContain('Storgatan 1')
    expect(html).toContain('Stockholm')
    expect(html).toContain('1981:739')
  })
})
