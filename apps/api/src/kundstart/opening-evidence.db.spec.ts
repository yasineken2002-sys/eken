import { ConflictException, ForbiddenException } from '@nestjs/common'
import { PrismaClient, Prisma } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { OcrService } from '../common/ocr/ocr.service'
import { OpeningPackageService } from './opening-package.service'
import { OpeningEvidenceService } from './opening-evidence.service'
import {
  createEvidenceFixture,
  prepareEvidencePackage,
  evidenceEffects,
  fixtureActor,
  SOURCE_191,
  IMPORT_191,
  SWAPPED_191,
  IMPORT_HEADER_207,
  type EvidenceFixture,
} from './opening-evidence.fixtures'
import { SOURCE_HEADER, MAPPING_HEADER } from './opening-evidence-format'

jest.setTimeout(120_000)
const db = new PrismaClient()
const fixtures: EvidenceFixture[] = []
const fixture = async (name: string, csv = IMPORT_191) => {
  const f = await createEvidenceFixture(db, name, csv)
  fixtures.push(f)
  await prepareEvidencePackage(db, f)
  return f
}
const approve = async (f: EvidenceFixture, evidenceSha256: string) => {
  const p = await db.openingPackage.findUniqueOrThrow({ where: { id: f.pkg.id } })
  return f.packages.approve(f.id, p.id, f.owner, {
    version: p.version,
    sourceSha256: p.sourceSha256,
    evidenceSha256,
  })
}
const create = (f: EvidenceFixture) => f.evidence.create(f.id, f.pkg.id, f.admin, f.input)
const review = async (f: EvidenceFixture) => {
  const e = await create(f)
  await f.evidence.review(f.id, f.pkg.id, e.id, f.accountant, { evidenceSha256: e.evidenceSha256 })
  return e
}
const noEffects = async (f: EvidenceFixture) => {
  const effects = await evidenceEffects(db, f)
  expect(effects).toMatchObject({
    opening: [],
    journals: 0,
    payments: 0,
    deposits: 0,
    bank: 0,
    exports: 0,
    activations: 0,
  })
  return effects
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function observeBlock(blocker: number, minimum = 1) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<
      { pid: number; blockers: number[] }[]
    >`SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`
    const connected = new Set([blocker])
    for (let i = 0; i < rows.length; i++)
      for (const row of rows)
        if (row.blockers.some((pid) => connected.has(pid))) connected.add(row.pid)
    const waiting = rows.filter((row) => connected.has(row.pid))
    if (waiting.length >= minimum) {
      console.log('207 OBSERVED_LOCK', JSON.stringify(waiting))
      return waiting
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('Förregistrerad pg_blocking_pids-barriär observerades inte')
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL || process.env.NODE_ENV !== 'test')
    throw new Error('207 kräver egen syntetisk DATABASE_URL och NODE_ENV=test; inga skips')
  await db.$connect()
})
afterAll(async () => {
  for (const f of fixtures) await db.organization.delete({ where: { id: f.id } })
  await db.$disconnect()
})

describe('207 kundavstämning med riktiga transaktioner och effekter', () => {
  it('E1/E13: två autentiserade aktörer, korrekt import, replay utan dubbla effekter', async () => {
    const f = await fixture('E1'),
      e = await review(f)
    expect(e.comparisonStatus).toBe('OK')
    const replay = await f.evidence.review(f.id, f.pkg.id, e.id, f.accountant, {
      evidenceSha256: e.evidenceSha256,
    })
    expect(replay.granskning?.reviewerUserId).toBe(f.accountant.sub)
    expect(await db.openingEvidenceReview.count({ where: { evidenceId: e.id } })).toBe(1)
    await approve(f, e.evidenceSha256)
    await expect(approve(f, e.evidenceSha256)).rejects.toBeInstanceOf(ConflictException)
    await f.packages.execute(f.id, f.pkg.id, f.owner)
    expect(await f.packages.execute(f.id, f.pkg.id, f.owner)).toMatchObject({
      redanVerkstallt: true,
    })
    const effects = await evidenceEffects(db, f)
    console.log('207 E1', JSON.stringify(effects))
    expect(effects).toMatchObject({
      package: 'EXECUTED',
      opening: [
        { customer: 'A', ore: 600000, status: 'OPENING', origin: 'OPENING_PACKAGE' },
        { customer: 'B', ore: 400000, status: 'OPENING', origin: 'OPENING_PACKAGE' },
      ],
      journals: 0,
      payments: 0,
      deposits: 0,
      bank: 0,
      exports: 0,
      activations: 0,
    })
  })

  it('E2: omkastad191-import stoppas med två dokumentfel trots total0', async () => {
    const f = await fixture('E2', SWAPPED_191),
      e = await create(f)
    expect(e.counts.avvikelser).toBe(2)
    expect(
      e.avvikelser
        .filter((d) => d.niva === 'KUND_AVTAL')
        .map((d) => [d.kund, Number(d.import) - Number(d.kalla)])
        .sort(),
    ).toEqual([
      ['A', -200000],
      ['B', 200000],
    ])
    await expect(
      f.evidence.review(f.id, f.pkg.id, e.id, f.accountant, { evidenceSha256: e.evidenceSha256 }),
    ).rejects.toThrow(/dokumentavvikelser/u)
    await expect(approve(f, e.evidenceSha256)).rejects.toThrow(/dokumentavvikelser/u)
    await expect(f.packages.execute(f.id, f.pkg.id, f.owner)).rejects.toThrow(/APPROVED/u)
    expect((await noEffects(f)).package).toBe('VALIDATED')
    console.log(
      '207 E2',
      JSON.stringify({
        counts: e.counts,
        differences: e.avvikelser,
        effects: await evidenceEffects(db, f),
      }),
    )
  })

  it('E21: negativkontrollens effektfacit stoppar verklig fel kundeffekt', async () => {
    const f = await fixture('E21', SWAPPED_191),
      e = await create(f)
    let reason: string | null = null
    try {
      await f.evidence.review(f.id, f.pkg.id, e.id, f.accountant, {
        evidenceSha256: e.evidenceSha256,
      })
      await approve(f, e.evidenceSha256)
      await f.packages.execute(f.id, f.pkg.id, f.owner)
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error
      reason = error.message
    }
    const effects = await evidenceEffects(db, f)
    // Logged before the assertion: mutation must produce A400000/B600000, not an early error.
    console.log('207 E21 EFFECT_ORACLE', JSON.stringify({ reason, effects }))
    expect(effects.opening).toEqual([])
    expect(reason).toMatch(/dokumentavvikelser/u)
    await noEffects(f)
  })

  it.each([
    'duplicate',
    'missing',
    'extra',
    'missingAmount',
    'unknownMapping',
    'duplicateMapping',
    'wrongLease',
    'missingChain',
  ] as const)('E3–E7/E16: %s stoppar före effekt', async (kind) => {
    const f = await fixture(
      kind,
      kind === 'missingChain'
        ? IMPORT_191.split('\n')
            .map((l, i) =>
              i === 0 ? l.split(';').slice(0, 12).join(';') : l.split(';').slice(0, 12).join(';'),
            )
            .join('\n')
        : IMPORT_191,
    )
    if (kind === 'duplicate') f.input.sourceContent += '\n' + SOURCE_191.split('\n')[1]!
    if (kind === 'missing') f.input.sourceContent = SOURCE_191.split('\n').slice(0, 2).join('\n')
    if (kind === 'extra')
      f.input.sourceContent += '\n' + SOURCE_191.split('\n')[1]!.replace('DOC-1', 'DOC-EXTRA')
    if (kind === 'missingAmount')
      f.input.sourceContent = SOURCE_191.replace(';600000;0;0;600000;', ';600000;;0;600000;')
    if (kind === 'unknownMapping')
      f.input.mappingContent = f.input.mappingContent.replace(';A;K-1;', ';UNKNOWN;K-1;')
    if (kind === 'duplicateMapping')
      f.input.mappingContent += '\n' + f.input.mappingContent.split('\n')[1]!
    if (kind === 'wrongLease')
      f.input.mappingContent = f.input.mappingContent.replace(f.leases[0]!.id, f.leases[1]!.id)
    const e = await create(f)
    expect(e.comparisonStatus).toBe('STOPP')
    await expect(
      f.evidence.review(f.id, f.pkg.id, e.id, f.accountant, { evidenceSha256: e.evidenceSha256 }),
    ).rejects.toThrow()
    await expect(approve(f, e.evidenceSha256)).rejects.toThrow()
    await noEffects(f)
  })

  it('E5b/V6: importens betalning och kredit jämförs separat; bara öppet belopp verkställs', async () => {
    const csv = IMPORT_191.replace(';6000;6000;;0;0', ';10000;6000;;2500;1500')
    const f = await fixture('E5b', csv)
    f.input.sourceContent = SOURCE_191.replace(
      ';600000;0;0;600000;',
      ';1000000;150000;250000;600000;',
    )
    const bad = await create(f)
    expect(bad.counts.avvikelser).toBe(1)
    await expect(approve(f, bad.evidenceSha256)).rejects.toThrow(/dokumentavvikelser/u)
    await noEffects(f)
    f.input.sourceContent = SOURCE_191.replace(
      ';600000;0;0;600000;',
      ';1000000;250000;150000;600000;',
    )
    const good = await review(f)
    await approve(f, good.evidenceSha256)
    await f.packages.execute(f.id, f.pkg.id, f.owner)
    expect(await evidenceEffects(db, f)).toMatchObject({
      opening: [
        { customer: 'A', ore: 600000 },
        { customer: 'B', ore: 400000 },
      ],
      journals: 0,
      payments: 0,
      bank: 0,
    })
  })

  it.each(['source', 'mapping', 'version', 'cutover', 'orgNumber', 'identity'] as const)(
    'E8: %s efter granskning får ingen ärvd attest',
    async (change) => {
      const f = await fixture('E8-' + change),
        e = await review(f)
      if (change === 'source' || change === 'mapping') {
        f.input[change === 'source' ? 'sourceContent' : 'mappingContent'] += '\n'
        const next = await create(f)
        expect(next.granskning).toBeNull()
        expect(next.evidenceSha256).not.toBe(e.evidenceSha256)
        await expect(
          f.evidence.review(f.id, f.pkg.id, e.id, f.accountant, {
            evidenceSha256: e.evidenceSha256,
          }),
        ).rejects.toThrow(/version/u)
      } else if (change === 'version')
        await f.packages.replaceSource(f.id, f.pkg.id, f.admin, {
          sourceName: 'ny.csv',
          innehall: IMPORT_191 + '\n',
        })
      else if (change === 'cutover')
        await db.organization.update({
          where: { id: f.id },
          data: { billingCutoverDate: new Date('2026-12-01') },
        })
      else if (change === 'orgNumber')
        await db.organization.update({ where: { id: f.id }, data: { orgNumber: '559998-0001' } })
      else
        await db.tenant.update({
          where: { id: f.tenants[0]!.id },
          data: { ocrNumber: '7779000011' },
        })
      await expect(approve(f, e.evidenceSha256)).rejects.toThrow()
      await noEffects(f)
    },
  )

  it.each(['version', 'cutover', 'identity', 'reviewerRole', 'approverRole'] as const)(
    'E9/E14: %s efter approve stoppas före OPENING',
    async (change) => {
      const f = await fixture('E9-' + change),
        e = await review(f)
      await approve(f, e.evidenceSha256)
      if (change === 'version')
        await f.packages.replaceSource(f.id, f.pkg.id, f.admin, {
          sourceName: 'ny.csv',
          innehall: IMPORT_191 + '\n',
        })
      else if (change === 'cutover')
        await db.organization.update({
          where: { id: f.id },
          data: { billingCutoverDate: new Date('2026-12-01') },
        })
      else if (change === 'identity')
        await db.tenant.update({
          where: { id: f.tenants[0]!.id },
          data: { ocrNumber: '7779000011' },
        })
      else
        await db.user.update({
          where: { id: change === 'reviewerRole' ? f.accountant.sub : f.owner.sub },
          data: { role: 'VIEWER' },
        })
      await expect(f.packages.execute(f.id, f.pkg.id, f.owner)).rejects.toThrow()
      await noEffects(f)
    },
  )

  it('E10: rollbyte ger aldrig rätt att godkänna egen granskning; reviewerId avvisas', async () => {
    const f = await fixture('E10'),
      e = await create(f)
    await expect(
      f.evidence.review(f.id, f.pkg.id, e.id, f.accountant, {
        evidenceSha256: e.evidenceSha256,
        reviewerId: f.owner.sub,
      } as never),
    ).rejects.toThrow()
    await f.evidence.review(f.id, f.pkg.id, e.id, f.accountant, {
      evidenceSha256: e.evidenceSha256,
    })
    await db.user.update({ where: { id: f.accountant.sub }, data: { role: 'OWNER' } })
    await expect(
      f.packages.approve(
        f.id,
        f.pkg.id,
        { sub: f.accountant.sub, role: 'OWNER' },
        {
          version: f.pkg.version,
          sourceSha256: f.pkg.sourceSha256,
          evidenceSha256: e.evidenceSha256,
        },
      ),
    ).rejects.toThrow(/skilda/u)
    await noEffects(f)
  })

  it('E11/E14: ACCOUNTANT och föråldrade rollclaims saknar alla gamla skrivrättigheter', async () => {
    const f = await fixture('E11'),
      e = await create(f)
    const actions = (user: typeof f.accountant) => [
      () => f.packages.create(f.id, user, { sourceName: 'x.csv', innehall: IMPORT_191 }),
      () =>
        f.packages.replaceSource(f.id, f.pkg.id, user, {
          sourceName: 'x.csv',
          innehall: IMPORT_191,
        }),
      () => f.packages.validate(f.id, f.pkg.id, user),
      () => f.packages.bindFortnoxRead(f.id, f.pkg.id, user, 'unused'),
      () =>
        f.packages.setSeparateLedger(f.id, f.pkg.id, user, {
          konto: '1510',
          beskrivning: '',
          filnamn: '',
          innehall: null,
        }),
      () => f.packages.setFirstPeriodRegister(f.id, f.pkg.id, user, {} as never),
      () => f.packages.discard(f.id, f.pkg.id, user),
      () =>
        f.packages.approve(f.id, f.pkg.id, user, {
          version: f.pkg.version,
          sourceSha256: f.pkg.sourceSha256,
          evidenceSha256: e.evidenceSha256,
        }),
      () => f.packages.execute(f.id, f.pkg.id, user),
      () => f.evidence.create(f.id, f.pkg.id, user, f.input),
    ]
    for (const action of actions(f.accountant))
      await expect(action()).rejects.toBeInstanceOf(ForbiddenException)
    for (const action of actions({ sub: f.accountant.sub, role: 'OWNER' }))
      await expect(action()).rejects.toBeInstanceOf(ForbiddenException)
    await db.user.update({ where: { id: f.accountant.sub }, data: { role: 'VIEWER' } })
    await expect(
      f.evidence.review(f.id, f.pkg.id, e.id, f.accountant, { evidenceSha256: e.evidenceSha256 }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    await noEffects(f)
  })

  it('E6/E12: korsorganisation, inaktiv användare och saknad identitet stoppas', async () => {
    const f = await fixture('E12'),
      foreign = await fixture('E12-foreign'),
      e = await create(f)
    await expect(f.evidence.list(foreign.id, f.pkg.id)).rejects.toThrow(/hittades inte/u)
    await expect(
      f.evidence.review(f.id, f.pkg.id, e.id, foreign.accountant, {
        evidenceSha256: e.evidenceSha256,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    await expect(
      f.packages.approve(f.id, f.pkg.id, foreign.owner, {
        version: 1,
        sourceSha256: f.pkg.sourceSha256,
        evidenceSha256: e.evidenceSha256,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    f.input.mappingContent = f.input.mappingContent
      .replace(f.tenants[0]!.id, foreign.tenants[0]!.id)
      .replace(f.leases[0]!.id, foreign.leases[0]!.id)
    const bad = await create(f)
    expect(bad.comparisonStatus).toBe('STOPP')
    expect(JSON.stringify(bad.stopp)).not.toContain(foreign.tenants[0]!.id)
    await db.user.update({ where: { id: f.accountant.sub }, data: { isActive: false } })
    await expect(
      f.evidence.review(f.id, f.pkg.id, bad.id, f.accountant, {
        evidenceSha256: bad.evidenceSha256,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    await expect(
      f.evidence.review(
        f.id,
        f.pkg.id,
        bad.id,
        { sub: 'missing', role: 'ACCOUNTANT' },
        { evidenceSha256: bad.evidenceSha256 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
    await noEffects(f)
    await noEffects(foreign)
  })

  it('E13: annan granskare kan inte skriva över unik review', async () => {
    const f = await fixture('E13'),
      e = await review(f),
      other = await fixtureActor(db, f.id, 'ACCOUNTANT')
    await expect(
      f.evidence.review(f.id, f.pkg.id, e.id, other, { evidenceSha256: e.evidenceSha256 }),
    ).rejects.toThrow(/annan granskning/u)
    expect(await db.openingEvidenceReview.count({ where: { evidenceId: e.id } })).toBe(1)
  })

  it('E16/E17: legacy utan evidens stoppas; historiskt EXECUTED läses och återspelas oförändrat', async () => {
    const f = await fixture('legacy'),
      e = await review(f)
    await approve(f, e.evidenceSha256)
    await db.openingPackage.update({
      where: { id: f.pkg.id },
      data: { approvedEvidenceId: null, approvedEvidenceSha256: null },
    })
    await expect(f.packages.execute(f.id, f.pkg.id, f.owner)).rejects.toThrow(
      /kundavstämning saknas/u,
    )
    await noEffects(f)
    const history = await fixture('history'),
      h = await review(history)
    await approve(history, h.evidenceSha256)
    await history.packages.execute(history.id, history.pkg.id, history.owner)
    await db.openingPackage.update({
      where: { id: history.pkg.id },
      data: { approvedEvidenceId: null, approvedEvidenceSha256: null },
    })
    const before = await evidenceEffects(db, history)
    expect((await history.packages.get(history.id, history.pkg.id)).status).toBe('EXECUTED')
    await history.evidence.list(history.id, history.pkg.id)
    await history.packages.execute(history.id, history.pkg.id, history.owner)
    await expect(create(history)).rejects.toThrow(/Validera/u)
    await expect(
      history.packages.replaceSource(history.id, history.pkg.id, history.admin, {
        sourceName: 'x',
        innehall: IMPORT_191,
      }),
    ).rejects.toThrow(/EXECUTED/u)
    expect(await evidenceEffects(db, history)).toEqual(before)
  })

  it('E18: deposition separat med deklarerad mottagningsreferens, inga bank-/hyresbetalningar', async () => {
    const f = await createEvidenceFixture(
      db,
      'deposit',
      IMPORT_191 + '\nDEP-1;DEPOSITION;7771000011;K-1;;;;;;1200;1200;2026-02-01;;',
    )
    fixtures.push(f)
    await prepareEvidencePackage(db, f, 1000000, 120000)
    f.input.sourceContent += '\nSYNTHETIC_191;A;K-1;DEP-1;DEPOSIT;;;120000;0;0;120000;2026-02-01;'
    expect((await create(f)).comparisonStatus).toBe('STOPP')
    await noEffects(f)
    f.input.sourceContent += 'deklarerat syntetiskt kvitto DEP-1'
    const e = await review(f)
    await approve(f, e.evidenceSha256)
    await f.packages.execute(f.id, f.pkg.id, f.owner)
    expect(await evidenceEffects(db, f)).toMatchObject({
      deposits: 1,
      journals: 0,
      payments: 0,
      bank: 0,
    })
    expect(
      (await db.deposit.findFirstOrThrow({ where: { organizationId: f.id } })).amount.toFixed(2),
    ).toBe('1200.00')
  })

  it.each([
    'sourceOrgNumber',
    'sourceAsOfDate',
    'scopeDeclaration',
    'scopeResponsible',
    'sourceExportedAt',
  ] as const)('E20: felaktig eller saknad %s stoppas', async (field) => {
    const f = await fixture('E20-' + field)
    f.input[field] =
      field === 'sourceOrgNumber' ? '559998-0001' : field === 'sourceAsOfDate' ? '2026-10-30' : ''
    await expect(create(f)).rejects.toThrow()
    await noEffects(f)
  })

  it('V5: uttrycklig komplett nollöppning kräver två aktörer och inga effekter', async () => {
    const f = await createEvidenceFixture(db, 'zero', IMPORT_HEADER_207)
    fixtures.push(f)
    await prepareEvidencePackage(db, f, 0, 0)
    f.input.sourceContent = SOURCE_HEADER
    f.input.mappingContent = MAPPING_HEADER
    await expect(approve(f, '0'.repeat(64))).rejects.toThrow(/kundavstämning saknas/u)
    const e = await review(f)
    await approve(f, e.evidenceSha256)
    await f.packages.execute(f.id, f.pkg.id, f.owner)
    expect((await noEffects(f)).package).toBe('EXECUTED')
  })

  it('V4: oföränderlig rålagring avvisar byte- och resultatändring', async () => {
    const f = await fixture('V4'),
      e = await review(f)
    await expect(
      db.openingEvidence.update({
        where: { id: e.id },
        data: { sourceRaw: Buffer.from('forged') },
      }),
    ).rejects.toThrow()
    await expect(
      db.openingEvidence.update({
        where: { id: e.id },
        data: { comparisonStatus: 'OK', comparisonResult: {} },
      }),
    ).rejects.toThrow()
    await expect(
      db.openingEvidenceReview.updateMany({
        where: { evidenceId: e.id },
        data: { reviewerUserId: f.owner.sub },
      }),
    ).rejects.toThrow()
    // Recompute distrusts returned cached fields too, without disabling production triggers.
    await expect(
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${f.id} FOR UPDATE`
        await tx.$queryRaw`SELECT id FROM "OpeningPackage" WHERE id = ${f.pkg.id} FOR UPDATE`
        const p = await tx.openingPackage.findUniqueOrThrow({
          where: { id: f.pkg.id },
          include: { rows: true },
        })
        const delegate = new Proxy(tx.openingEvidence, {
          get(target, name) {
            if (name === 'findFirst')
              return async (args: Prisma.OpeningEvidenceFindFirstArgs) => {
                const value = await target.findFirst(args)
                return value ? { ...value, sourceRaw: Buffer.from('forged') } : value
              }
            const value = Reflect.get(target, name)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        const poisoned = new Proxy(tx, {
          get(target, name) {
            return name === 'openingEvidence' ? delegate : Reflect.get(target, name)
          },
        })
        await f.evidence.kravForGodkannande(poisoned, f.id, p, f.owner, e.evidenceSha256)
      }),
    ).rejects.toThrow(/källbytes/u)
    await noEffects(f)
  })

  it('E15: review väntar på riktigt orglås; två executes skapar aldrig dubbla effekter', async () => {
    const f = await fixture('E15'),
      e = await create(f),
      held = deferred<number>(),
      release = deferred<void>()
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${f.id} FOR UPDATE`
        const [pid] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        held.resolve(pid!.pid)
        await release.promise
      },
      { timeout: 20_000 },
    )
    const pid = await held.promise
    const reviewing = f.evidence.review(f.id, f.pkg.id, e.id, f.accountant, {
      evidenceSha256: e.evidenceSha256,
    })
    try {
      expect((await observeBlock(pid)).length).toBeGreaterThan(0)
    } finally {
      release.resolve()
    }
    await holder
    await reviewing
    await approve(f, e.evidenceSha256)
    const attempts = await Promise.allSettled([
      f.packages.execute(f.id, f.pkg.id, f.owner),
      f.packages.execute(f.id, f.pkg.id, f.owner),
    ])
    expect(attempts.some((a) => a.status === 'fulfilled')).toBe(true)
    const effects = await evidenceEffects(db, f)
    expect(effects.opening).toHaveLength(2)
    expect(effects.journals).toBe(0)
  })

  it.each(['review', 'execute'] as const)(
    'E15: ny källversion före väntande %s serialiseras utan gammal attest',
    async (action) => {
      const f = await fixture('E15-source-' + action),
        e = action === 'execute' ? await review(f) : await create(f)
      if (action === 'execute') await approve(f, e.evidenceSha256)
      const held = deferred<number>(),
        release = deferred<void>()
      const holder = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${f.id} FOR UPDATE`
          const [pid] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
          held.resolve(pid!.pid)
          await release.promise
        },
        { timeout: 30_000 },
      )
      const pid = await held.promise
      const replacing = f.packages
        .replaceSource(f.id, f.pkg.id, f.admin, {
          sourceName: 'ny-version.csv',
          innehall: IMPORT_191 + '\n',
        })
        .then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        )
      let following: Promise<unknown> | undefined
      try {
        await observeBlock(pid)
        following = (
          action === 'execute'
            ? f.packages.execute(f.id, f.pkg.id, f.owner)
            : f.evidence.review(f.id, f.pkg.id, e.id, f.accountant, {
                evidenceSha256: e.evidenceSha256,
              })
        ).then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error: error.message }),
        )
        await observeBlock(pid, 2)
      } finally {
        release.resolve()
      }
      await holder
      expect(await replacing).toMatchObject({ ok: true })
      expect(await following).toMatchObject({ ok: false })
      const current = await db.openingPackage.findUniqueOrThrow({ where: { id: f.pkg.id } })
      expect(current).toMatchObject({
        version: 2,
        status: 'DRAFT',
        approvedEvidenceId: null,
        approvedEvidenceSha256: null,
      })
      if (action === 'review')
        expect(await db.openingEvidenceReview.count({ where: { evidenceId: e.id } })).toBe(0)
      await noEffects(f)
    },
  )

  it.each(['sourceContent', 'mappingContent'] as const)(
    'E9: %s kan inte ersättas under APPROVED',
    async (field) => {
      const f = await fixture('E9-' + field),
        e = await review(f)
      await approve(f, e.evidenceSha256)
      f.input[field] += '\n'
      await expect(create(f)).rejects.toThrow(/Validera/u)
      expect(await db.openingEvidence.count({ where: { packageId: f.pkg.id } })).toBe(1)
      await noEffects(f)
      await f.packages.execute(f.id, f.pkg.id, f.owner)
      expect((await evidenceEffects(db, f)).opening).toMatchObject([
        { customer: 'A', ore: 600000 },
        { customer: 'B', ore: 400000 },
      ])
    },
  )

  it.each(['approve', 'execute'] as const)(
    'E15b: gammal validate får inte skriva över senare %s',
    async (action) => {
      const f = await fixture('E15b-' + action),
        e = await review(f),
        entered = deferred<void>(),
        release = deferred<void>()
      const proxy = new Proxy(db, {
        get(target, name) {
          if (name === '$transaction')
            return async (
              fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
              options: unknown,
            ) => {
              entered.resolve()
              await release.promise
              return target.$transaction(fn, options as never)
            }
          const v = Reflect.get(target, name)
          return typeof v === 'function' ? v.bind(target) : v
        },
      }) as unknown as PrismaService
      const stale = new OpeningPackageService(
        proxy,
        new OcrService(proxy),
        new OpeningEvidenceService(proxy),
      )
      const validating = stale.validate(f.id, f.pkg.id, f.admin)
      await entered.promise
      try {
        await approve(f, e.evidenceSha256)
        if (action === 'execute') await f.packages.execute(f.id, f.pkg.id, f.owner)
      } finally {
        release.resolve()
      }
      await expect(validating).rejects.toThrow(/ändrats under valideringen/u)
      const effects = await evidenceEffects(db, f)
      console.log('207 E15b', action, JSON.stringify(effects))
      expect(effects.package).toBe(action === 'execute' ? 'EXECUTED' : 'APPROVED')
      expect(effects.opening).toHaveLength(action === 'execute' ? 2 : 0)
    },
  )
})
