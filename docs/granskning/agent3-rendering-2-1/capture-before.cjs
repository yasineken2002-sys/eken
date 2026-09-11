/* Independent test capture. Run from apps/api with ts-node/transpile-only and TZ=UTC.
 * Only synthetic DB/storage/queue ports; PdfService, templates and React Email are real.
 * This driver is for the unmodified 5ae9906 base and must not regenerate its own golden later.
 */
const { createRequire } = require('node:module')
const { resolve, join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const api = createRequire(resolve('package.json'))
const { PdfService } = api('./src/invoices/pdf.service')
const { AviseringService } = api('./src/avisering/avisering.service')
const { RentReminderService } = api('./src/avisering/rent-reminder.service')
const { CollectionExportService } = api('./src/collections/collection-export.service')
const { RentCollectionExportService } = api('./src/collections/rent-collection-export.service')
const { MailService } = api('./src/mail/mail.service')
const { MailRenderer } = api('./src/mail/mail.renderer')
const { createRenderingFixtures, renderingFixtureAsOf, renderingFixtureBaseSha, renderingFixtureLogo } = api('./src/invoices/rendering.test-fixtures')
const puppeteer = api('puppeteer').default
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const output = resolve(process.argv[2])
const fixtures = createRenderingFixtures()
const logo = Buffer.from(renderingFixtureLogo.base64, 'base64')
const storage = { getFileBuffer: async key => {
  if (key !== renderingFixtureLogo.storageKey) throw new Error('Unexpected synthetic storage key')
  return Buffer.from(logo)
} }
const originalDate = Date
class FixtureDate extends Date {
  constructor(...args) { super(...(args.length ? args : [renderingFixtureAsOf])) }
  static now() { return new originalDate(renderingFixtureAsOf).getTime() }
}
async function withDocumentClock(fn) {
  global.Date = FixtureDate
  try { return await fn() } finally { global.Date = originalDate }
}
const service = type => Object.assign(Object.create(type.prototype), { storage, pn: { reveal: () => null } })
const records = []
const pdfs = new Map()
let invoice
const pdf = new PdfService({ invoice: { findFirst: async () => invoice } }, storage)
let capturedHtml
const withPage = pdf.withPage.bind(pdf)
pdf.withPage = fn => withPage(page => {
  const setContent = page.setContent.bind(page)
  page.setContent = (html, options) => { capturedHtml = html; return setContent(html, options) }
  return fn(page)
})
function save(name, bytes) {
  writeFileSync(join(output, name), bytes)
  return { file: name, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) }
}
async function captureCase(fixture, build) {
  const bytes = await build()
  pdfs.set(fixture.id, bytes)
  records.push({ id: fixture.id, hasConsumption: fixture.hasConsumption,
    input: save(fixture.id + '.input.json', JSON.stringify(fixture.document, null, 2) + '\n'),
    html: save(fixture.id + '.html', capturedHtml), pdf: save(fixture.id + '.pdf', bytes) })
}
async function main() {
  mkdirSync(output, { recursive: true })
  save('logo.png', logo)
  for (const fixture of fixtures.invoiceCases) {
    invoice = fixture.document
    await captureCase(fixture, () => pdf.generateInvoicePdf(invoice.id, fixtures.organization.id))
  }
  const groups = [
    [fixtures.noticeCases, service(AviseringService), 'buildNoticePdfHtml'],
    [fixtures.reminderCases, service(RentReminderService), 'buildReminderPdfHtml'],
    [fixtures.invoiceCollectionCases, service(CollectionExportService), 'buildPdfHtml'],
    [fixtures.rentCollectionCases, service(RentCollectionExportService), 'buildPdfHtml'],
  ]
  for (const [cases, builder, method] of groups) {
    for (const fixture of cases) {
      const html = await withDocumentClock(() => builder[method](fixture.document, fixtures.organization))
      await captureCase(fixture, () => pdf.generateFromHtml(html))
    }
  }
  const renderer = new MailRenderer()
  const queue = { enqueue: async options => {
    const id = mailId
    const rendered = await renderer.render(options.template, options.props)
    const envelope = { ...options, attachments: options.attachments?.map(a => ({
      filename: a.filename, content: a.content.toString('base64'),
    })) }
    records.push({ id, envelope: save(id + '.json', JSON.stringify(envelope, null, 2) + '\n'),
      html: save(id + '.html', rendered.html), text: save(id + '.txt', rendered.text) })
    return 'synthetic-job'
  } }
  const mail = new MailService(queue)
  const common = { to: 'testa.aberg@example.test', organizationId: fixtures.organization.id,
    tenantName: 'Testa Åberg', organizationName: fixtures.organization.name,
    invoiceNumber: 'F-SYN-2026-001', total: 1100, dueDate: '2026-08-31T00:00:00Z',
    daysOverdue: 11, ocrNumber: '1234567897', bankgiro: '5050-1055',
    rentNoticeId: 'synthetic-notice-rent', noticeNumber: 'AVI-SYN-2026-0901' }
  const mailCases = [
    ['mail-invoice', 'sendInvoice', { tenantName: fixtures.invoiceCases[0].document.customer.companyName, to: fixtures.invoiceCases[0].document.customer.email, invoiceNumber: fixtures.invoiceCases[0].document.invoiceNumber, dueDate: fixtures.invoiceCases[0].document.dueDate, total: fixtures.invoiceCases[0].document.total, pdfBuffer: pdfs.get('invoice-customer-classic') }],
    ['mail-overdue', 'sendOverdueReminder', {}],
    ['mail-friendly', 'sendReminderFriendly', {}],
    ['mail-formal', 'sendReminderFormal', { outstandingBeforeFee: 900, feeAmount: 60, newTotal: 960, collectionDay: 30 }],
    ['mail-notice', 'sendRentNotice', { dueDate: fixtures.noticeCases[0].document.dueDate, amount: 9000, pdfBuffer: pdfs.get('notice-rent') }],
    ['mail-notice-reminder', 'sendRentNoticeReminder', { noticeAmount: 9000, paidSoFar: 4000, overpaidAmount: 0, feeAmount: 60, payableTotal: 5060, pdfBuffer: pdfs.get('reminder-rent-partpaid') }],
  ]
  for (const [id, method, extra] of mailCases) {
    mailId = id
    await withDocumentClock(() => mail[method]({ ...common, ...extra }))
  }
  const browser = await pdf.getBrowser()
  const fonts = execFileSync('fc-list', ['--format', '%{file}\n'], { encoding: 'utf8' }).trim().split('\n')
  const fontFiles = [...new Set(fonts)].sort().map(file => ({ file, sha256: sha(readFileSync(file)) }))
  const manifest = { captureSourceSha256: sha(readFileSync(__filename)), baseSha: renderingFixtureBaseSha, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    fixtureSha256: sha(JSON.stringify(fixtures)), fixtureSourceSha256: sha(readFileSync(resolve('src/invoices/rendering.test-fixtures.ts'))),
    documentClock: renderingFixtureAsOf, chromiumClock: 'real, not frozen',
    resources: { ...renderingFixtureLogo, sha256: sha(logo), width: 96, height: 32 },
    environment: { node: process.version, versions: process.versions, platform: process.platform, arch: process.arch,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      osRelease: readFileSync('/etc/os-release', 'utf8'),
      puppeteer: api('puppeteer/package.json').version, chromium: await browser.version(),
      chromeExecutable: puppeteer.executablePath(), chromeSha256: sha(readFileSync(puppeteer.executablePath())),
      react: api('react/package.json').version, reactEmail: JSON.parse(readFileSync(resolve(api.resolve('@react-email/render'), '../../../package.json'), 'utf8')).version,
      fontFiles, fontconfig: execFileSync('fc-match', ['-v'], { encoding: 'utf8' }) }, records }
  save('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ output, cases: records.length, pdfs: pdfs.size, fixtureSha256: manifest.fixtureSha256 }))
}
let mailId
main().finally(() => pdf.onModuleDestroy()).catch(error => { console.error(error); process.exitCode = 1 })
