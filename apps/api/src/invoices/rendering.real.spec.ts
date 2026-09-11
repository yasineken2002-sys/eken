// Only the external storage DI class is synthetic. PDF, HTML and mail engines are real.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import puppeteer from 'puppeteer'
import type { Browser } from 'puppeteer'
import { CollectionExportService } from '../collections/collection-export.service'
import { RentReminderService } from '../avisering/rent-reminder.service'
import { MailRenderer } from '../mail/mail.renderer'
import { assertRendererContract } from '../consumption/delivery-execution.test-ports'
import { PdfService } from './pdf.service'
import {
  documentContext,
  pdfEnvironmentIdentity,
  renderingCodeIdentity,
  renderingCodeManifest,
  renderingDigest,
  renderingLogo,
  stampPdfDates,
} from './rendering-context'
import { generateInvoiceHtml } from './templates/invoice-pdf.template'
import {
  createRenderingFixtures,
  renderingFixtureAsOf,
  renderingFixtureLogo,
} from './rendering.test-fixtures'
import {
  assertPdfGolden,
  comparableEnvelope,
  comparablePdf,
  hash,
  loadCapture,
  readArtifact,
  type CaptureManifest,
} from './rendering.golden.test-helpers'
import { runRenderingCallerProof } from './rendering.routing.test-helpers'

jest.setTimeout(900_000)
const execute = promisify(execFile)
const api = resolve(__dirname, '../..')
const evidence = resolve(api, '../../docs/granskning/agent3-rendering-2-1')
// Each execution preserves its own raw evidence; authoritative before files are read-only.
const output =
  process.env.RENDERING_EVIDENCE_DIR ?? join(api, 'test-results/rendering', String(process.pid))
const after = [join(output, 'process-1/run-1'), join(output, 'process-2/run-1')]
const fontRoot = join(evidence, 'font-environment')
const logoA = `data:${renderingFixtureLogo.mediaType};base64,${renderingFixtureLogo.base64}`
const manifests: CaptureManifest[] = []
const fixtures = createRenderingFixtures()

function pdfService() {
  return new PdfService(
    {} as ConstructorParameters<typeof PdfService>[0],
    {} as ConstructorParameters<typeof PdfService>[1],
  )
}
function invoiceInput(): Parameters<typeof generateInvoiceHtml>[0] {
  const source = structuredClone(fixtures.invoiceCases[0]!.document)
  const party = source.customer!
  return {
    invoiceColor: source.organization.invoiceColor,
    invoiceTemplate: source.organization.invoiceTemplate,
    invoice: {
      ...source,
      tenant: {
        ...party,
        address: {
          street: party.street,
          city: party.city,
          postalCode: party.postalCode,
        },
      },
      organization: { ...source.organization, logoUrl: renderingFixtureLogo.storageKey },
    },
    logoBase64: renderingFixtureLogo.base64,
  }
}
function raw(id: string, kind: 'pdf' | 'html' | 'text' | 'envelope', processIndex = 0) {
  const artifact = manifests[processIndex]!.records.find((record) => record.id === id)?.[kind]
  if (!artifact) throw new Error(`Missing actual artifact ${id}:${kind}`)
  return readArtifact(after[processIndex]!, artifact)
}
async function pdfText(file: string) {
  return (await execute('pdftotext', ['-layout', file, '-'])).stdout
}
// Atomic replacement changes only this worktree's directory entry, never a pnpm-store hardlink.
async function withChangedFile(file: string, bytes: Buffer, check: () => Promise<void>) {
  const original = readFileSync(file)
  const mode = statSync(file).mode
  const replace = (value: Buffer) => {
    const temporary = file + `.r21-${process.pid}.tmp`
    writeFileSync(temporary, value, { mode })
    renameSync(temporary, file)
  }
  replace(bytes)
  try {
    await check()
  } finally {
    replace(original)
  }
  expect(readFileSync(file)).toEqual(original)
}

beforeAll(async () => {
  global.gc?.() // Optional local --expose-gc releases compiler garbage before real rendering.
  // On the shared two-core Codespace, fresh capture may run immediately before Jest
  // so the compiler heap cannot evict the engine-file cache. CI always launches here.
  if (process.env.CI && process.env.RENDERING_CAPTURED_BEFORE_JEST)
    throw new Error('CI must launch the real renderer in this suite')
  process.env.FONTCONFIG_FILE = join(fontRoot, 'fonts.conf')
  process.env.FONTCONFIG_PATH = fontRoot
  mkdirSync(output, { recursive: true })
  for (let index = 0; index < 2; index++) {
    if (!process.env.RENDERING_CAPTURED_BEFORE_JEST) {
      const result = await execute(
        process.execPath,
        [
          '-r',
          'ts-node/register/transpile-only',
          join(evidence, 'capture-after.cjs'),
          join(output, `process-${index + 1}`),
          '1',
        ],
        {
          cwd: api,
          env: { ...process.env, TZ: 'UTC' },
          timeout: 600_000,
          maxBuffer: 32 * 1024 * 1024,
        },
      )
      writeFileSync(join(output, `capture-${index + 1}.log`), result.stdout + result.stderr)
    }
    manifests.push(loadCapture(after[index]!))
    assert.equal(manifests[index]!.renderingCodeIdentity, renderingCodeIdentity())
    assert.equal(manifests[index]!.fixtureSha256, hash(JSON.stringify(createRenderingFixtures())))
    console.warn(
      'r21 real capture',
      JSON.stringify({
        pid: manifests[index]!.pid,
        chromiumPid: manifests[index]!.chromiumPid,
        identity: manifests[index]!.renderingCodeIdentity,
        environment: manifests[index]!.environment,
        records: manifests[index]!.records,
      }),
    )
  }
})

describe('real deterministic rendering, independent before-final golden', () => {
  it('r21-01 identical input, content resources and context reproduce all raw bytes', () => {
    let pdfs = 0
    for (const [index, record] of manifests[0]!.records.entries()) {
      for (const kind of ['input', 'pdf', 'html', 'text', 'envelope'] as const) {
        const first = record[kind],
          second = manifests[1]!.records[index]![kind]
        expect(Boolean(first)).toBe(Boolean(second))
        if (first && second)
          expect(readArtifact(after[0]!, first)).toEqual(readArtifact(after[1]!, second))
      }
      if (record.pdf) pdfs++
    }
    expect(pdfs).toBe(16)
  })

  it('r21-02 independent Node and Chrome instances cannot explain reproduction by cache', () => {
    expect(manifests[0]!.pid).not.toBe(manifests[1]!.pid)
    expect(manifests[0]!.chromiumPid).not.toBe(manifests[1]!.chromiumPid)
    expect(manifests.every((manifest) => manifest.chromiumPid > 0)).toBe(true)
    expect(manifests.every((manifest) => manifest.pid > 0 && manifest.pid !== process.pid)).toBe(
      true,
    )
    expect(manifests[0]!.fixtureSha256).toBe(manifests[1]!.fixtureSha256)
    expect(manifests[0]!.renderingCodeIdentity).toBe(manifests[1]!.renderingCodeIdentity)
    expect(manifests[0]!.environment).toEqual(manifests[1]!.environment)
    expect(manifests[0]!.records).toEqual(manifests[1]!.records)
  })

  it('r21-04 undeclared text or any non-exempt byte fails the same golden comparator', () => {
    const pdf = raw('invoice-customer-classic', 'pdf')
    const mutation = Buffer.from(pdf)
    const offset = mutation.indexOf('/Creator') + '/Creator ('.length
    expect(offset).toBeGreaterThan(10)
    mutation[offset] = mutation[offset]! ^ 1
    expect(() => assertPdfGolden(pdf, mutation)).toThrow('Undeclared PDF byte difference')
    expect(() => assertPdfGolden(pdf, Buffer.concat([pdf, Buffer.from('\n')]))).toThrow()
    const envelope = raw('mail-invoice', 'envelope')
    const changedRecipient = Buffer.from(
      envelope.toString().replace('kund@example.test', 'annan@example.test'),
    )
    expect(comparableEnvelope(envelope)).not.toEqual(comparableEnvelope(changedRecipient))
    const nonCanonical = JSON.parse(envelope.toString())
    nonCanonical.attachments[0].content += '\n'
    expect(() => comparableEnvelope(Buffer.from(JSON.stringify(nonCanonical)))).toThrow(
      'Canonical attachment base64',
    )
  })

  it('r21-05 all five existing public callers execute their shared real rendering cores', async () => {
    const observations = await runRenderingCallerProof()
    expect(observations).toHaveLength(5)
    for (const observation of observations) {
      expect(observation.pdf).toEqual(raw(observation.fixtureId, 'pdf'))
      writeFileSync(join(output, `caller-${observation.fixtureId}.pdf`), observation.pdf)
    }
  })

  it('r21-06 same storage key with changed bytes changes identity and old resource A rejects B', async () => {
    const changed = Buffer.concat([
      Buffer.from(renderingFixtureLogo.base64, 'base64'),
      Buffer.from('\n'),
    ])
    const logoB = `data:${renderingFixtureLogo.mediaType};base64,${changed.toString('base64')}`
    const a = documentContext(new Date(renderingFixtureAsOf), logoA)
    const b = documentContext(new Date(renderingFixtureAsOf), logoB)
    // This is the same actual A/B resource construction used by r21-17/18/19's inactive DB boundary.
    const identity = (context: typeof a) =>
      renderingDigest(JSON.stringify({ code: renderingCodeIdentity(), context }))
    expect(identity(a)).not.toBe(identity(b))
    expect(renderingFixtureLogo.storageKey).toBe('synthetic/rendering/org-logo.png')
    expect(() => renderingLogo({ ...a, logo: { dataUrl: logoB, digest: a.logo!.digest } })).toThrow(
      'digest mismatch',
    )
    const pdf = pdfService()
    try {
      const context = await pdf.createRenderingContext(new Date(renderingFixtureAsOf), logoA)
      await expect(
        pdf.renderInvoice({ ...invoiceInput(), logoBase64: changed.toString('base64') }, context),
      ).rejects.toThrow('RENDER_IDENTITY_CONFLICT')
    } finally {
      await pdf.onModuleDestroy()
    }
  })

  it('r21-07 actual font, fontconfig and engine bytes are bound; old context cannot use a new environment', async () => {
    const pdf = pdfService()
    const context = await pdf.createRenderingContext(new Date(renderingFixtureAsOf), null)
    const current = await pdfEnvironmentIdentity()
    const copy = join(output, 'own-font-environment')
    cpSync(fontRoot, copy, { recursive: true })
    try {
      process.env.FONTCONFIG_FILE = join(copy, 'fonts.conf')
      process.env.FONTCONFIG_PATH = copy
      const copied = await pdfEnvironmentIdentity()
      expect(copied).not.toBe(current)
      await expect(pdf.generateFromHtml('<p>Same input</p>', context)).rejects.toThrow(
        'RENDER_IDENTITY_CONFLICT',
      )
      const font = (
        await execute('fc-list', ['--format', '%{file}\n'], { env: { ...process.env } })
      ).stdout
        .trim()
        .split('\n')[0]!
      expect(font.startsWith(copy + '/')).toBe(true)
      await withChangedFile(
        font,
        Buffer.concat([readFileSync(font), Buffer.from('\n')]),
        async () => {
          expect(await pdfEnvironmentIdentity()).not.toBe(copied)
        },
      )
      const config = join(copy, 'fonts.conf')
      await withChangedFile(
        config,
        Buffer.concat([readFileSync(config), Buffer.from('\n<!-- r21 -->\n')]),
        async () => {
          expect(await pdfEnvironmentIdentity()).not.toBe(copied)
        },
      )
      expect(readFileSync(puppeteer.executablePath()).length).toBeGreaterThan(1_000_000)
    } finally {
      process.env.FONTCONFIG_FILE = join(fontRoot, 'fonts.conf')
      process.env.FONTCONFIG_PATH = fontRoot
      await pdf.onModuleDestroy()
    }
  })

  it('r21-08 visible dates and overdue days follow explicit asOf, including the declared midnight change', () => {
    const context = documentContext(new Date(renderingFixtureAsOf), logoA)
    const next = documentContext(new Date('2026-09-12T00:00:01Z'), logoA)
    const reminder = fixtures.reminderCases[0]!.document as unknown as Parameters<
      typeof RentReminderService.buildReminderPdfHtml
    >[0]
    const organization = fixtures.organization as unknown as Parameters<
      typeof RentReminderService.buildReminderPdfHtml
    >[1]
    const first = RentReminderService.buildReminderPdfHtml(reminder, organization, context)
    expect(first).toContain('11 dagar')
    expect(RentReminderService.buildReminderPdfHtml(reminder, organization, next)).toContain(
      '12 dagar',
    )
    const collection = fixtures.invoiceCollectionCases[0]!.document as unknown as Parameters<
      typeof CollectionExportService.buildPdfHtml
    >[0]
    expect(CollectionExportService.buildPdfHtml(collection, context, null)).toContain('2026-09-11')
    expect(CollectionExportService.buildPdfHtml(collection, next, null)).toContain('2026-09-12')
    expect(RentReminderService.buildReminderPdfHtml(reminder, organization, context)).toBe(first)
  })

  it('r21-09 six real mail renderings retain HTML, text, recipients, names and correlated attachments', () => {
    const mails = manifests[0]!.records.filter((record) => record.id.startsWith('mail-'))
    expect(mails).toHaveLength(6)
    for (const mail of mails) {
      expect(raw(mail.id, 'html').toString()).toContain('Syntetiska Fastigheter AB')
      expect(raw(mail.id, 'text').length).toBeGreaterThan(100)
      const envelope = JSON.parse(raw(mail.id, 'envelope').toString())
      expect(envelope.to).toMatch(/@example\.test$/)
      for (const attachment of envelope.attachments ?? []) {
        expect(attachment.filename).toMatch(/\.pdf$/)
        expect(Buffer.from(attachment.content, 'base64').subarray(0, 8).toString()).toBe('%PDF-1.4')
      }
    }
    expect(JSON.parse(raw('mail-notice', 'envelope').toString()).correlation).toEqual({
      kind: 'rent-notice',
      rentNoticeId: 'synthetic-notice-rent',
    })
  })

  it('r21-10 clean and consumption documents retain dates, amounts, OCR, recipients, order and pages', async () => {
    const texts: Record<string, string> = {}
    for (const record of manifests[0]!.records.filter((item) => item.pdf)) {
      const file = join(after[0]!, record.pdf!.file)
      const text = await pdfText(file)
      texts[record.id] = text
      writeFileSync(join(output, record.id + '.extracted.txt'), text)
      expect(text).toContain('Syntetiska Fastigheter AB')
      const pages = (await execute('pdfinfo', [file])).stdout.match(/^Pages:\s+(\d+)/m)
      const expectedPages =
        record.id === 'invoice-customer-multipage'
          ? 4
          : record.id.startsWith('collection-notice-')
            ? 2
            : 1
      expect(Number(pages?.[1])).toBe(expectedPages)
    }
    const cleanInvoice = texts['invoice-customer-classic']!
    for (const value of ['Syntetisk Kund AB', '2026-09-30', '1 100,00', '1234567897', '5050-1055'])
      expect(cleanInvoice.replace(/\u00a0/g, ' ')).toContain(value)
    const cleanNotice = texts['notice-rent']!.replace(/\u00a0/g, ' ')
    for (const value of ['Testa Åberg', '9 000,00', '1234567897', '5050-1055'])
      expect(cleanNotice).toContain(value)
    expect(texts['invoice-utility-classic']).toContain('100 kWh')
    expect(texts['notice-utility-credit']).toContain('100 kWh')
    expect(texts['reminder-rent-partpaid']!.replace(/\u00a0/g, ' ')).toContain('5 060,00')
    const pages = texts['invoice-customer-multipage']!.split('\f').filter((page) => page.trim())
    expect(
      pages.map((page) =>
        [...page.matchAll(/Planerat servicearbete (\d\d)/g)].map((match) => match[1]),
      ),
    ).toEqual([
      Array.from({ length: 13 }, (_, i) => String(i + 1).padStart(2, '0')),
      Array.from({ length: 20 }, (_, i) => String(i + 14).padStart(2, '0')),
      Array.from({ length: 20 }, (_, i) => String(i + 34).padStart(2, '0')),
      ['54', '55'],
    ])
  })

  it('r21-11 controlled real Chromium blocks external loading and disables scripts', async () => {
    const pdf = pdfService()
    try {
      const context = await pdf.createRenderingContext(new Date(renderingFixtureAsOf), null)
      await expect(
        pdf.generateFromHtml('<img src="https://invalid.example.test/r21.png">', context),
      ).rejects.toThrow('External rendering resource rejected')
      const bytes = await pdf.generateFromHtml(
        '<p>ORIGINAL</p><script>document.body.innerHTML="EXECUTED"</script>',
        context,
      )
      const file = join(output, 'javascript-disabled.pdf')
      writeFileSync(file, bytes)
      expect(await pdfText(file)).toContain('ORIGINAL')
      expect(await pdfText(file)).not.toContain('EXECUTED')
    } finally {
      await pdf.onModuleDestroy()
    }
  })

  it('r21-12 reusable port contract rejects timestamp, randomness, filename and single attachment byte drift', async () => {
    const captured = raw('invoice-customer-classic', 'pdf')
    const stable = {
      createdAt: renderingFixtureAsOf,
      random: 0.25,
      filename: 'faktura.pdf',
      content: captured.toString('base64'),
    }
    const mutations = [
      { ...stable, createdAt: '2026-09-12T12:00:00Z' },
      { ...stable, random: 0.5 },
      { ...stable, filename: 'annan.pdf' },
      {
        ...stable,
        content: Buffer.concat([captured.subarray(0, -1), Buffer.from('!')]).toString('base64'),
      },
    ]
    await expect(
      assertRendererContract(() => ({ render: () => JSON.stringify(stable) }), {}, {}),
    ).resolves.toBe(JSON.stringify(stable))
    for (const changed of mutations) {
      let count = 0
      await expect(
        assertRendererContract(
          () => ({ render: () => JSON.stringify(++count === 1 ? stable : changed) }),
          {},
          {},
        ),
      ).rejects.toThrow('RENDERER_NONDETERMINISTIC_BYTES')
    }
  })

  it('r21-13 actual rendering preserves inputs and the explicitly supplied row order', async () => {
    expect(manifests[0]!.fixtureSha256).toBe(hash(JSON.stringify(createRenderingFixtures())))
    const input = invoiceInput()
    const frozen = JSON.stringify(input)
    const first = generateInvoiceHtml(input)
    expect(JSON.stringify(input)).toBe(frozen)
    expect(first.indexOf('Lokalservice september')).toBeLessThan(
      first.indexOf('Material för lokalservice'),
    )
    const reversed = structuredClone(input)
    reversed.invoice.lines.reverse()
    const second = generateInvoiceHtml(reversed)
    expect(second.indexOf('Material för lokalservice')).toBeLessThan(
      second.indexOf('Lokalservice september'),
    )
    const pdf = pdfService()
    try {
      const context = await pdf.createRenderingContext(new Date(renderingFixtureAsOf), logoA)
      const reversedBefore = JSON.stringify(reversed)
      const bytes = await pdf.renderInvoice(reversed, context)
      expect(JSON.stringify(reversed)).toBe(reversedBefore)
      expect(() => assertPdfGolden(raw('invoice-customer-classic', 'pdf'), bytes)).toThrow()
      expect(JSON.stringify(input)).toBe(frozen)
    } finally {
      await pdf.onModuleDestroy()
    }
  })

  it('r21-14 malformed, duplicate, missing or displaced PDF Info dates cannot be silently normalized', () => {
    const pdf = raw('invoice-customer-classic', 'pdf')
    const context = documentContext(new Date(renderingFixtureAsOf), null)
    const original = pdf.toString('latin1')
    const mutations = [
      original.replace('/CreationDate', '/UnknownDateX'),
      original.replace('/CreationDate', '/CreationDate (bogus)\n/CreationDate'),
      original.replace('/ModDate', '/ModDate (D:2026)\n/ModDate'),
      original.replace('D:20260911120000', 'D:2026091112000'),
      original.replace("+00'00'", "+01'00'"),
      original.replace('/Info 1 0 R', '/Info 2 0 R'),
      original.replace('/Info 1 0 R', '/Info 1 0 R /Info 2 0 R'),
      original.replaceAll('\nendobj', '\nmissing'),
      original.replace('\n1 0 obj\n', '\n2 0 obj\n'),
    ]
    for (const mutation of mutations) {
      const bytes = Buffer.from(mutation, 'latin1')
      expect(() => stampPdfDates(bytes, context)).toThrow()
      expect(() => comparablePdf(bytes)).toThrow()
    }
    expect(stampPdfDates(pdf, context)).toEqual(pdf)
    const outsideA = Buffer.concat([pdf, Buffer.from('\n% outside Info: 2026-09-11\n')])
    const outsideB = Buffer.concat([pdf, Buffer.from('\n% outside Info: 2026-09-12\n')])
    expect(stampPdfDates(outsideA, context)).toEqual(outsideA)
    expect(stampPdfDates(outsideB, context)).toEqual(outsideB)
    expect(() => assertPdfGolden(outsideA, outsideB)).toThrow('Undeclared PDF byte difference')
    expect(comparablePdf(pdf).fields.map((field) => [field.name, field.length])).toEqual([
      ['CreationDate', 14],
      ['ModDate', 14],
    ])
  })

  it('r21-15 declared identity is stable and an unrelated utility outside its boundary has no effect', async () => {
    const identity = renderingCodeIdentity()
    expect(renderingCodeIdentity()).toBe(identity)
    const outside = join(api, 'src/common/csv/csv-cell.ts')
    expect(renderingCodeManifest().some(([file]) => file === outside)).toBe(false)
    await withChangedFile(
      outside,
      Buffer.concat([readFileSync(outside), Buffer.from('\n// r21 outside boundary\n')]),
      async () => {
        expect(renderingCodeIdentity()).toBe(identity)
      },
    )
    expect(renderingCodeIdentity()).toBe(identity)
  })

  it('r21-16 declared templates, engine implementation and dynamically loaded React SSR changes reject identity A', async () => {
    const identity = renderingCodeIdentity()
    const manifest = renderingCodeManifest()
    const dynamic = manifest.find(([file]) =>
      file.endsWith('/react-dom/cjs/react-dom-server-legacy.node.development.js'),
    )?.[0]
    const engine = require.resolve('@react-email/render')
    expect(dynamic).toBeDefined()
    const files = [
      require.resolve('puppeteer'),
      join(__dirname, 'templates/invoice-pdf.template.ts'),
      join(api, 'src/mail/templates/invoices/InvoiceCreated.tsx'),
      engine,
      dynamic!,
    ]
    const pdf = pdfService()
    const mail = new MailRenderer()
    const context = await pdf.createRenderingContext(new Date(renderingFixtureAsOf), null)
    try {
      for (const file of files) {
        expect(file.startsWith(resolve(api, '../..') + '/')).toBe(true)
        expect(manifest.some(([path]) => path === file)).toBe(true)
        await withChangedFile(
          file,
          Buffer.concat([
            readFileSync(file),
            Buffer.from('\n// r21 declared implementation change\n'),
          ]),
          async () => {
            expect(renderingCodeIdentity()).not.toBe(identity)
            await expect(pdf.generateFromHtml('<p>Same input</p>', context)).rejects.toThrow(
              'RENDER_IDENTITY_CONFLICT',
            )
            await expect(
              mail.render(
                'custom',
                {
                  bodyHtml: '<p>Same input</p>',
                  preview: 'Test',
                  tenantName: 'Testa',
                  organizationName: 'Syntetisk',
                },
                { environment: identity },
              ),
            ).rejects.toThrow('RENDER_IDENTITY_CONFLICT')
          },
        )
      }
      expect(renderingCodeIdentity()).toBe(identity)
    } finally {
      await pdf.onModuleDestroy()
    }
  })
  it('r21-23 the additional clean InvoiceReminder retains UTC bytes and declares only the Stockholm due date', async () => {
    const driver = join(evidence, 'capture-extra-mail.cjs')
    const directories = ['extra-after-utc', 'extra-after-stockholm'].map((name) =>
      join(output, `${name}-${process.pid}`),
    )
    for (const [index, timezone] of ['UTC', 'Europe/Stockholm'].entries()) {
      const result = await execute(process.execPath, [driver, 'after', directories[index]!], {
        cwd: api,
        env: { ...process.env, TZ: timezone },
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      writeFileSync(
        join(output, `extra-after-${index}-${process.pid}.log`),
        result.stdout + result.stderr,
      )
    }
    const { assertExtraMailComparison } = createRequire(__filename)(driver) as {
      assertExtraMailComparison: (directories: Record<string, string>) => Array<{
        kind: string
        beforeUtc: string
        afterUtc: string
        afterStockholm: string
        declaredField: string
        before: string
        after: string
      }>
    }
    const comparisons = assertExtraMailComparison({
      beforeUtc: join(evidence, 'extra-mail-before-utc'),
      beforeStockholm: join(evidence, 'extra-mail-before-stockholm'),
      afterUtc: directories[0]!,
      afterStockholm: directories[1]!,
    })
    expect(comparisons.map((comparison) => comparison.kind)).toEqual(['html', 'text'])
    for (const comparison of comparisons) {
      expect(comparison.afterUtc).toBe(comparison.beforeUtc)
      expect(comparison.afterStockholm).toBe(comparison.afterUtc)
      expect(comparison.declaredField).toBe('body.dueDate')
      expect([comparison.before, comparison.after]).toEqual([
        '12 september 2026',
        '11 september 2026',
      ])
    }
    writeFileSync(
      join(output, `extra-comparisons-${process.pid}.json`),
      JSON.stringify(comparisons, null, 2) + '\n',
    )
    console.warn('r21 additional real mail comparison', JSON.stringify(comparisons))
  })

  it('r21-22 legacy and controlled PDFs share the kernel, own distinct browsers and close both', async () => {
    const pdf = pdfService()
    const pool = pdf as unknown as { browser: Browser; controlled: { browser: Browser } }
    const kernel = jest.spyOn(
      pdf as unknown as { withPage: (...args: unknown[]) => Promise<unknown> },
      'withPage',
    )
    let legacy: Browser | undefined, controlled: Browser | undefined
    const config = process.env.FONTCONFIG_FILE
    const configPath = process.env.FONTCONFIG_PATH
    try {
      expect((await pdf.generateFromHtml('<p>Legacy PDF</p>')).length).toBeGreaterThan(1000)
      legacy = pool.browser
      expect(legacy.connected).toBe(true)
      const context = await pdf.createRenderingContext(new Date(renderingFixtureAsOf), null)
      expect((await pdf.generateFromHtml('<p>Controlled PDF</p>', context)).length).toBeGreaterThan(
        1000,
      )
      controlled = pool.controlled.browser
      expect(controlled).not.toBe(legacy)
      expect(controlled.connected).toBe(true)
      await expect(
        pdf.generateFromHtml('<p>Wrong identity</p>', { ...context, environment: '0'.repeat(64) }),
      ).rejects.toThrow('RENDER_IDENTITY_CONFLICT')
      const changedFonts = join(output, `warm-browser-fonts-${process.pid}`)
      cpSync(fontRoot, changedFonts, { recursive: true })
      process.env.FONTCONFIG_FILE = join(changedFonts, 'fonts.conf')
      process.env.FONTCONFIG_PATH = changedFonts
      const changedContext = await pdf.createRenderingContext(new Date(renderingFixtureAsOf), null)
      expect(changedContext.environment).not.toBe(context.environment)
      await expect(
        pdf.generateFromHtml('<p>Honest new font identity</p>', changedContext),
      ).rejects.toThrow('RENDER_IDENTITY_CONFLICT')
      process.env.FONTCONFIG_FILE = join(output, 'nonexistent-fontconfig.xml')
      expect((await pdf.generateFromHtml('<p>Legacy still works</p>')).length).toBeGreaterThan(1000)
      expect(pool.browser).toBe(legacy)
      expect(pool.controlled.browser).toBe(controlled)
      expect(kernel.mock.calls.map((call) => Boolean(call[1]))).toEqual([
        false,
        true,
        true,
        true,
        false,
      ])
    } finally {
      if (config === undefined) delete process.env.FONTCONFIG_FILE
      else process.env.FONTCONFIG_FILE = config
      if (configPath === undefined) delete process.env.FONTCONFIG_PATH
      else process.env.FONTCONFIG_PATH = configPath
      kernel.mockRestore()
      await pdf.onModuleDestroy()
    }
    expect(legacy?.connected).toBe(false)
    expect(controlled?.connected).toBe(false)
  })
})
