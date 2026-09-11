// External storage DI is unavailable; Chromium, PDF and mail renderers are real.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
import { execFile } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Prisma } from '@prisma/client'
import type { DeliveryDispatch } from '@prisma/client'
import { PdfService } from '../invoices/pdf.service'
import { MailRenderer } from '../mail/mail.renderer'
import { renderingCodeManifest } from '../invoices/rendering-context'
import { renderingFixtureLogo } from '../invoices/rendering.test-fixtures'
import { DeliveryRenderer } from './delivery-renderer'
import { DeliveryExecution, deliveryDigest } from './delivery-execution'
import type { DeliveryDecisionCommand } from './delivery-decisions'
import {
  assertRendererContract,
  fixtureResourceDigests,
  latch,
  SimulatedDeliveryProvider,
} from './delivery-execution.test-ports'
import { deliveryRenderingRig } from './delivery-renderer.test-helpers'

jest.setTimeout(900_000)
const api = resolve(__dirname, '../..')
const unavailable = new Proxy(
  {},
  {
    get() {
      throw new Error('CURRENT_DATA_FORBIDDEN')
    },
  },
)
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const initialTime = Date.UTC(2026, 8, 11)
async function pdfText(bytes: Buffer): Promise<string> {
  return new Promise((resolveText, reject) => {
    const process = execFile('pdftotext', ['-layout', '-', '-'], (error, stdout) => {
      if (error) reject(error)
      else resolveText(stdout.replace(/\s+/g, ' '))
    })
    process.stdin!.end(bytes)
  })
}
const pdfs: PdfService[] = []
function renderer() {
  const pdf = new PdfService(
    unavailable as ConstructorParameters<typeof PdfService>[0],
    unavailable as ConstructorParameters<typeof PdfService>[1],
  )
  pdfs.push(pdf)
  return new DeliveryRenderer(pdf, new MailRenderer())
}
async function child(input: object, databaseUrl?: string) {
  return new Promise<{
    pid: number
    chromiumPid: number
    bodies: string[]
    dispatch: DeliveryDispatch
    run: { called: boolean }
  }>((resolveResult, reject) => {
    const process = execFile(
      global.process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        resolve(__dirname, 'delivery-renderer-process.test-helpers.cjs'),
      ],
      {
        cwd: api,
        env: { ...global.process.env, ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}) },
        timeout: 600_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(String(error) + stderr))
        const line = stdout.split('\n').find((value) => value.startsWith('R22_RESULT='))
        if (!line) return reject(new Error('Child did not report real result: ' + stdout))
        resolveResult(JSON.parse(line.slice('R22_RESULT='.length)))
      },
    )
    process.stdin!.end(JSON.stringify(input))
  })
}
async function changedResource(work: () => Promise<void>) {
  // A real, declared file in this worktree; no mutation of shared dependency installations.
  const file = resolve(__dirname, '../invoices/pdf-wait-until.ts')
  const original = readFileSync(file)
  const replace = (bytes: Buffer) => {
    writeFileSync(file + '.r22-tmp', bytes)
    renameSync(file + '.r22-tmp', file)
  }
  replace(Buffer.concat([original, Buffer.from('\n// r22 actual identity B\n')]))
  try {
    await work()
  } finally {
    replace(original)
  }
}

describe('r22: verklig rendering från beslutets frysta PostgreSQL-underlag', () => {
  const rig = deliveryRenderingRig()
  type Harness = Awaited<ReturnType<typeof harness>>
  const saved: Array<{
    snapshot: Prisma.JsonValue
    command: DeliveryDecisionCommand
    sealed: DeliveryDispatch
  }> = []
  let invoice: Harness, notice: Harness
  async function harness(kind: 'INVOICE' | 'NOTICE' = 'INVOICE') {
    const f = await rig.fixture(kind)
    const lines =
      kind === 'INVOICE'
        ? await rig.db.invoiceLine.findMany({
            where: { invoiceId: f.documentId },
            orderBy: { id: 'asc' },
          })
        : await rig.db.rentNoticeLine.findMany({
            where: { rentNoticeId: f.documentId },
            orderBy: { id: 'asc' },
          })
    for (const [index, line] of lines.entries()) {
      const data = { description: `Fryst elrad ${index + 1}` }
      if (kind === 'INVOICE') await rig.db.invoiceLine.update({ where: { id: line.id }, data })
      else await rig.db.rentNoticeLine.update({ where: { id: line.id }, data })
    }
    await rig.db.organization.update({
      where: { id: f.organizationId },
      data: { logoStorageKey: renderingFixtureLogo.storageKey, name: 'Fryst Avsändare AB' },
    })
    const principal = await rig.db.deliveryPrincipal.create({
      data: { organizationId: f.organizationId, name: 'r22 syntetisk transportprincipal' },
    })
    const identity = {
      organizationId: f.organizationId,
      principalId: principal.id,
      team: 'r22-' + f.organizationId,
    }
    const actual = renderer()
    const rendering = await actual.freeze(
      '2026-09-11T00:00:00.000Z',
      'Fryst avsändare <frozen@example.test>',
      {
        key: renderingFixtureLogo.storageKey,
        mime: renderingFixtureLogo.mediaType,
        base64: renderingFixtureLogo.base64,
      },
    )
    const provider = new SimulatedDeliveryProvider()
    const ports = {
      resources: jest.fn(actual.resources.bind(actual)),
      render: jest.fn(actual.render.bind(actual)),
      publish: jest.fn(async () => {}),
      send: jest.fn(provider.send.bind(provider)),
    }
    const command = {
      ...(await rig.command(f)),
      team: identity.team,
      rendering,
      resources: fixtureResourceDigests(await actual.resources(rendering)),
    }
    const execution = new DeliveryExecution(rig.db, identity, ports)
    return { f, actual, provider, ports, command, execution, identity }
  }
  async function seal(h: Harness) {
    const sealed = await h.execution.enqueue(h.command)
    const decision = await rig.db.deliveryDecision.findUniqueOrThrow({
      where: { id: sealed.decisionId },
      include: { events: { where: { revision: 1 } } },
    })
    return {
      snapshot: decision.snapshot,
      command: decision.events[0]!.request as DeliveryDecisionCommand,
      sealed,
    }
  }
  async function empty(h: Harness) {
    const where = { organizationId: h.f.organizationId }
    expect(await rig.db.deliveryDecision.count({ where })).toBe(0)
    expect(await rig.db.deliveryDispatch.count({ where })).toBe(0)
    expect(await rig.db.deliveryMember.count({ where })).toBe(0)
    expect(await rig.db.deliveryEvent.count({ where })).toBe(0)
  }
  beforeAll(async () => {
    invoice = await harness()
    notice = await harness('NOTICE')
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await Promise.all(pdfs.map((pdf) => pdf.onModuleDestroy()))
  })

  it('r22-01 verklig faktura och mejl binds till samma frysta beslut', async () => {
    const result = await seal(invoice)
    saved.push(result)
    const body = JSON.parse(result.sealed.body)
    expect(body.from).toBe('Fryst avsändare <frozen@example.test>')
    expect(body.to).toEqual([invoice.f.tenant.email])
    expect(body.subject).toBe(
      `Faktura ${invoice.f.invoiceData.invoiceNumber} från Fryst Avsändare AB`,
    )
    expect(body.html).toContain('Fryst Avsändare AB')
    expect(body.text).toContain(invoice.f.invoiceData.invoiceNumber)
    expect(body.text).toContain('40')
    expect(body.attachments[0].filename).toBe(`faktura-${invoice.f.invoiceData.invoiceNumber}.pdf`)
    const pdf = Buffer.from(body.attachments[0].content, 'base64')
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.4')
    expect(pdf.toString('latin1')).toContain('/CreationDate (D:20260911000000')
    const text = await pdfText(pdf)
    expect(text).toContain('Fryst Avsändare AB')
    expect(text).toContain('40,00')
    expect(text).toContain('Fryst elrad 1')
    expect(text.indexOf('Fryst elrad 1')).toBeLessThan(text.indexOf('Fryst elrad 2'))
    expect(pdf.toString('latin1')).toContain('/Subtype /Image')
    expect(result.sealed.digest).toBe(deliveryDigest(result.sealed.body))
    expect(result.command).toEqual(invoice.command)
    expect(result.sealed.resources).toEqual(invoice.command.resources)
  })

  it('r22-02 verklig hyresavi använder fryst period, rader, logotyp och belopp', async () => {
    const result = await seal(notice)
    saved.push(result)
    const body = JSON.parse(result.sealed.body)
    expect(body.to).toEqual([notice.f.tenant.email])
    expect(body.text).toMatch(/1\s040/)
    expect(body.text).toContain('31 mars 2026')
    expect(body.attachments[0].filename).toContain('hyresavi-')
    const text = await pdfText(Buffer.from(body.attachments[0].content, 'base64'))
    expect(text).toContain('april 2026')
    expect(text).toContain('1 040,00')
    expect(text).toContain('Fryst elrad 1')
    expect(text.indexOf('Fryst elrad 1')).toBeLessThan(text.indexOf('Fryst elrad 2'))
    expect(Buffer.from(body.attachments[0].content, 'base64').length).toBeGreaterThan(10_000)
    const snapshot = result.snapshot as Prisma.JsonObject
    expect((snapshot.document as Prisma.JsonObject).month).toBe('4')
    expect(
      (snapshot.lines as Prisma.JsonArray).map((line) => (line as Prisma.JsonObject).description),
    ).toEqual(['Fryst elrad 1', 'Fryst elrad 2'])
    expect(result.command.rendering).toEqual(notice.command.rendering)
  })

  it('r22-03 feltypade tal och ogiltiga datum avvisas före bindning', async () => {
    for (const kind of ['INVOICE', 'NOTICE'] as const) {
      const h = await harness(kind)
      const numeric = kind === 'INVOICE' ? 'total' : 'totalAmount'
      const attacks: Array<[string, Prisma.JsonValue]> = [
        [numeric, 40],
        [numeric, 'NaN'],
        [numeric, 'Infinity'],
        ['dueDate', '2026-02-30T00:00:00'],
        ['dueDate', 123],
      ]
      if (kind === 'NOTICE') attacks.push(['month', '13'])
      for (const [field, value] of attacks) {
        h.ports.render.mockImplementationOnce((snapshot, resources, context) => {
          const changed = json(snapshot) as Prisma.JsonObject
          ;(changed.document as Prisma.JsonObject)[field] = value
          return h.actual.render(changed, resources, context)
        })
        await expect(h.execution.enqueue(h.command)).rejects.toThrow(
          'DELIVERY_RENDER_INPUT_INVALID',
        )
        await empty(h)
      }
    }
  })

  it('r22-04 hela nya kommandot jämförs utan retroaktiva krav eller nyckelordningsberoende', async () => {
    for (const rendering of [
      { ...invoice.command.rendering, asOf: '2026-09-12T00:00:00.000Z' },
      { ...invoice.command.rendering, from: 'changed@example.test' },
      {
        ...invoice.command.rendering,
        logo: { ...invoice.command.rendering.logo!, mime: 'image/jpeg' },
      },
      {
        ...invoice.command.rendering,
        logo: { ...invoice.command.rendering.logo!, base64: 'Yg==' },
      },
    ])
      await expect(invoice.execution.enqueue({ ...invoice.command, rendering })).rejects.toThrow(
        'KEY_CONFLICT',
      )
    await expect(
      invoice.execution.enqueue({
        ...invoice.command,
        resources: { ...invoice.command.resources, changed: '0'.repeat(64) },
      }),
    ).rejects.toThrow('KEY_CONFLICT')
    const reordered = Object.fromEntries(
      Object.entries(invoice.command).reverse(),
    ) as typeof invoice.command
    const existing = await invoice.execution.enqueue(reordered)
    expect(existing).toEqual(saved[0]!.sealed)
    expect(invoice.ports.render).toHaveBeenCalledTimes(1)
  })

  it('r22-05 konkurrerande dokument- och medlemscommit under rendering ger atomisk konflikt', async () => {
    for (const change of ['document', 'members']) {
      const h = await harness()
      h.ports.render.mockImplementationOnce(async (...args) => {
        const body = await h.actual.render(...args)
        const concurrent = rig.client()
        try {
          const first = await rig.db.$queryRaw`SELECT pg_backend_pid()`
          expect(await concurrent.$queryRaw`SELECT pg_backend_pid()`).not.toEqual(first)
          if (change === 'document') {
            await concurrent.invoiceLine.updateMany({
              where: { invoiceId: h.f.documentId },
              data: { description: 'Konkurrerande ändring' },
            })
          } else {
            const charge = await h.f.addCharge()
            await concurrent.consumptionCharge.update({
              where: { id: charge.id },
              data: { status: 'ATTACHED', invoiceId: h.f.documentId },
            })
          }
          expect(
            await concurrent.deliveryDecision.count({
              where: { organizationId: h.f.organizationId },
            }),
          ).toBe(0)
        } finally {
          await concurrent.$disconnect()
        }
        return body
      })
      await expect(h.execution.enqueue(h.command)).rejects.toThrow('DELIVERY_SNAPSHOT_CONFLICT')
      await empty(h)
    }
  })

  it('r22-06 replay i ny process kräver varken dagens DB-underlag eller renderer', async () => {
    await rig.db.tenant.update({
      where: { id: invoice.f.tenant.id },
      data: { email: 'changed@example.test' },
    })
    const [location] = await rig.db.$queryRaw<
      Array<{ database: string; schema: string }>
    >`SELECT current_database() AS database, current_schema() AS schema`
    const url = new URL(process.env.DATABASE_URL!)
    url.pathname = '/' + location!.database
    url.searchParams.set('schema', location!.schema)
    await changedResource(async () => {
      const result = await child(
        { replay: true, identity: invoice.identity, command: invoice.command },
        url.toString(),
      )
      expect(result.pid).not.toBe(process.pid)
      expect(result.dispatch).toEqual(saved[0]!.sealed)
    })
    expect(
      await rig.db.deliveryDecision.count({ where: { organizationId: invoice.f.organizationId } }),
    ).toBe(1)
  })

  it('r22-07 samma logotypnyckel med nya byte avvisas av verklig renderer', async () => {
    const source = saved[1]!
    const resources = await notice.actual.resources(source.command.rendering)
    resources['logo/' + renderingFixtureLogo.storageKey] =
      Buffer.from('changed logo').toString('base64')
    await expect(
      notice.actual.render(source.snapshot, resources, source.command.rendering),
    ).rejects.toThrow('RENDER_IDENTITY_CONFLICT')
    const changed = json(source.command)
    ;(changed.rendering!.logo as Prisma.JsonObject).base64 = 'Yg=='
    await expect(notice.actual.reproduce(source.snapshot, changed, source.sealed)).rejects.toThrow(
      'RENDER_IDENTITY_CONFLICT',
    )
    expect(
      await rig.db.deliveryDispatch.findUnique({ where: { decisionId: source.sealed.decisionId } }),
    ).toEqual(source.sealed)
  })

  it('r22-08 verkliga portkontraktet tål klocka/slump och upptäcker fyra byteangrepp', async () => {
    const source = saved[1]!
    const resources = await notice.actual.resources(source.command.rendering)
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2039, 2, 7))
    jest.spyOn(Math, 'random').mockReturnValue(0.012345)
    const body = await assertRendererContract(
      () => {
        const actual = renderer()
        return {
          render: (snapshot, bytes) => actual.render(snapshot, bytes, source.command.rendering),
        }
      },
      source.snapshot,
      resources,
    )
    expect(body).toBe(source.sealed.body)
    for (const mutation of ['timestamp', 'random', 'filename', 'attachment']) {
      let n = 0
      await expect(
        assertRendererContract(
          () => ({
            render: async (snapshot, bytes) => {
              const packet = JSON.parse(
                await notice.actual.render(snapshot, bytes, source.command.rendering),
              )
              if (n++ > 0) {
                if (mutation === 'timestamp') packet.text += '\n2039-03-07'
                if (mutation === 'random') packet.html += '<!-- 0.012345 -->'
                if (mutation === 'filename') packet.attachments[0].filename += '.changed'
                if (mutation === 'attachment') {
                  const bytes = Buffer.from(packet.attachments[0].content, 'base64')
                  bytes[100] = bytes[100]! ^ 1
                  packet.attachments[0].content = bytes.toString('base64')
                }
              }
              return JSON.stringify(packet)
            },
          }),
          source.snapshot,
          resources,
        ),
      ).rejects.toThrow('RENDERER_NONDETERMINISTIC_BYTES')
    }
  })

  it('r22-09 två nya Node- och Chromium-processer reproducerar båda sparade besluts body exakt', async () => {
    const first = await child({ saved })
    const second = await child({ saved })
    expect(first.pid).not.toBe(second.pid)
    expect(first.pid).not.toBe(process.pid)
    expect(first.chromiumPid).toBeGreaterThan(0)
    expect(first.chromiumPid).not.toBe(second.chromiumPid)
    expect(first.bodies).toEqual(saved.map((value) => value.sealed.body))
    expect(second.bodies).toEqual(first.bodies)
    console.warn(
      'r22 processbevis',
      JSON.stringify({
        pids: [process.pid, first.pid, second.pid],
        chromiumPids: [first.chromiumPid, second.chromiumPid],
        digests: first.bodies.map(deliveryDigest),
      }),
    )
  })

  it('r22-10 reproduktion använder enbart sparat underlag med förbjuden DB och lagring', async () => {
    const source = saved[1]!
    process.env.MAIL_FROM = 'unrelated@example.test'
    const actual = renderer()
    expect(await actual.reproduce(json(source.snapshot), json(source.command), source.sealed)).toBe(
      source.sealed.body,
    )
    expect(
      renderingCodeManifest().some(([file]) => file.endsWith('/consumption/delivery-renderer.ts')),
    ).toBe(true)
    delete process.env.MAIL_FROM
  })

  it('r22-11 verklig identitet A→B ger beständigt konfliktspår och blockerar senare A', async () => {
    const h = await harness()
    const source = await seal(h)
    await changedResource(async () => {
      await expect(
        h.actual.reproduce(source.snapshot, source.command, source.sealed),
      ).rejects.toThrow('RENDER_IDENTITY_CONFLICT')
      expect(await h.execution.run(source.sealed.decisionId)).toEqual({ called: false })
    })
    const conflicts = await rig.db.deliveryObservation.findMany({
      where: { decisionId: source.sealed.decisionId },
    })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.kind).toBe('CONFLICT')
    expect((conflicts[0]!.evidence as Prisma.JsonObject).reason).toBe('RENDER_IDENTITY_CONFLICT')
    const restarted = new DeliveryExecution(rig.client(), h.identity, h.ports)
    expect(await restarted.run(source.sealed.decisionId)).toEqual({ called: false })
    const [location] = await rig.db.$queryRaw<
      Array<{ schema: string }>
    >`SELECT current_schema() AS schema`
    const url = new URL(process.env.DATABASE_URL!)
    url.searchParams.set('schema', location!.schema)
    const fresh = await child(
      { blocked: true, identity: h.identity, decisionId: source.sealed.decisionId },
      url.toString(),
    )
    expect(fresh.pid).not.toBe(process.pid)
    expect(fresh.run).toEqual({ called: false })
    expect(
      (await rig.db.deliveryDecision.findUniqueOrThrow({ where: { id: source.sealed.decisionId } }))
        .snapshot,
    ).toEqual(source.snapshot)
    expect(h.ports.send).not.toHaveBeenCalled()
    expect(
      await rig.db.deliveryDispatch.findUnique({ where: { decisionId: source.sealed.decisionId } }),
    ).toEqual(source.sealed)
    expect(
      await rig.db.deliveryEvent.count({ where: { decisionId: source.sealed.decisionId } }),
    ).toBe(1)
  })

  it('r22-12 SQL kan inte ändra verklig body, digest eller manifest', async () => {
    const source = saved[1]!
    const changed = JSON.parse(source.sealed.body)
    changed.html += '<!-- changed -->'
    const body = JSON.stringify(changed)
    await expect(
      rig.db
        .$executeRaw`UPDATE "DeliveryDispatch" SET "body" = ${body}, "digest" = ${deliveryDigest(body)} WHERE "decisionId" = ${source.sealed.decisionId}`,
    ).rejects.toThrow('append-only: DeliveryDispatch')
    for (const column of ['body', 'digest', 'resources']) {
      const value = column === 'resources' ? '{}' : column === 'digest' ? '0'.repeat(64) : '{}'
      await expect(
        rig.db.$executeRawUnsafe(
          `UPDATE "DeliveryDispatch" SET "${column}" = $1${column === 'resources' ? '::jsonb' : ''} WHERE "decisionId" = $2`,
          value,
          source.sealed.decisionId,
        ),
      ).rejects.toThrow('append-only: DeliveryDispatch')
    }
    expect(
      await rig.db.deliveryDispatch.findUnique({ where: { decisionId: source.sealed.decisionId } }),
    ).toEqual(source.sealed)
  })

  it('r22-13 samtidiga kommandon renderar utanför låset men får ett beslut och en dispatch', async () => {
    const h = await harness()
    const both = latch()
    let entered = 0,
      rendering = Promise.resolve('')
    h.ports.render.mockImplementation((...args) => {
      if (++entered === 2) both.release()
      const current = rendering.then(async () => {
        await both.promise
        return h.actual.render(...args)
      })
      rendering = current
      return current
    })
    const [a, b] = await Promise.all([
      h.execution.enqueue(h.command),
      h.execution.enqueue(h.command),
    ])
    expect(a).toEqual(b)
    expect(entered).toBe(2)
    expect(
      await rig.db.deliveryDecision.count({ where: { organizationId: h.f.organizationId } }),
    ).toBe(1)
    expect(
      await rig.db.deliveryDispatch.count({ where: { organizationId: h.f.organizationId } }),
    ).toBe(1)
  })

  it('r22-14 resursbyte före sista bindningen lämnar ingen halv commit', async () => {
    const h = await harness()
    const file = resolve(__dirname, '../invoices/pdf-wait-until.ts')
    const original = readFileSync(file)
    h.ports.render.mockImplementationOnce(async (...args) => {
      const body = await h.actual.render(...args)
      writeFileSync(
        file + '.r22-tmp',
        Buffer.concat([original, Buffer.from('\n// r22 before binding\n')]),
      )
      renameSync(file + '.r22-tmp', file)
      return body
    })
    try {
      await expect(h.execution.enqueue(h.command)).rejects.toThrow('RENDER_IDENTITY_CONFLICT')
    } finally {
      writeFileSync(file + '.r22-tmp', original)
      renameSync(file + '.r22-tmp', file)
    }
    await empty(h)
  })

  it('r22-15 tillåtet retry använder sparad body och attemptId utan ny rendering', async () => {
    const h = await harness()
    const source = await seal(h)
    await rig.setTime(initialTime)
    h.provider.modes.push('drop-after')
    expect((await h.execution.run(source.sealed.decisionId)).called).toBe(true)
    const frozenOnly = {
      ...h.ports,
      resources: jest.fn(async () => {
        throw new Error('NO_RESOURCE_READ_ON_RETRY')
      }),
      render: jest.fn(async () => {
        throw new Error('NO_RENDER_ON_RETRY')
      }),
    }
    const restarted = new DeliveryExecution(rig.client(), h.identity, frozenOnly)
    await expect(restarted.run(source.sealed.decisionId)).rejects.toThrow('DELIVERY_RETRY_LATER')
    await rig.db.tenant.update({
      where: { id: h.f.tenant.id },
      data: { email: 'now@example.test' },
    })
    await rig.setTime(initialTime + 1000)
    await changedResource(async () => {
      expect((await restarted.run(source.sealed.decisionId)).called).toBe(true)
    })
    expect(h.provider.accepted).toHaveLength(1)
    expect(h.provider.calls).toHaveLength(2)
    expect(h.provider.calls[0]).toEqual(h.provider.calls[1])
    expect(h.provider.calls[1]!.body).toBe(source.sealed.body)
    expect(h.provider.calls[1]!.attemptId).toBe(source.sealed.attemptId)
    expect(frozenOnly.render).not.toHaveBeenCalled()
    expect(frozenOnly.resources).not.toHaveBeenCalled()
    await rig.setTime(initialTime + 24 * 3600_000)
    expect(await restarted.run(source.sealed.decisionId)).toEqual({ called: false })
    expect(h.provider.calls).toHaveLength(2)
    const expired = await harness()
    const late = await seal(expired)
    await rig.setTime(initialTime)
    expired.provider.modes.push('drop-before')
    expect((await expired.execution.run(late.sealed.decisionId)).called).toBe(true)
    await rig.setTime(initialTime + 23 * 3600_000)
    expect(await expired.execution.run(late.sealed.decisionId)).toEqual({ called: false })
    expect(expired.provider.calls).toHaveLength(1)
    expect(
      await rig.db.deliveryObservation.findFirst({
        where: {
          decisionId: late.sealed.decisionId,
          kind: 'CLOSED',
          evidence: { path: ['reason'], equals: 'EXPIRED' },
        },
      }),
    ).not.toBeNull()
  })
})
