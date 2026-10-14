/** Independent synthetic ledger and explicit mapping. Never reconstructed from package rows. */
import { randomUUID } from 'crypto'
import { PrismaClient, type UserRole, type Tenant, type Lease } from '@prisma/client'
import type { CreateOpeningEvidenceInput } from '@eken/shared'
import type { PrismaService } from '../common/prisma/prisma.service'
import { OcrService } from '../common/ocr/ocr.service'
import { OpeningPackageService } from './opening-package.service'
import { OpeningEvidenceService } from './opening-evidence.service'
import { SOURCE_HEADER, MAPPING_HEADER } from './opening-evidence-format'

export const SOURCE_191 =
  SOURCE_HEADER +
  '\n' +
  [
    'SYNTHETIC_191;A;K-1;DOC-1;RECEIVABLE;2026-10;2026-10-31;600000;0;0;600000;;',
    'SYNTHETIC_191;B;K-2;DOC-2;RECEIVABLE;2026-10;2026-10-31;400000;0;0;400000;;',
  ].join('\n')
export const IMPORT_HEADER_207 =
  'radId;typ;hyresgast;avtal;fastighet;enhet;periodAr;periodManad;forfallodag;ursprungligtBelopp;oppetBelopp;mottagetDatum;betaltBelopp;krediteratBelopp'
export const IMPORT_191 =
  IMPORT_HEADER_207 +
  '\n' +
  [
    'DOC-1;FORDRAN;7771000011;K-1;;;2026;10;2026-10-31;6000;6000;;0;0',
    'DOC-2;FORDRAN;7771000022;K-2;;;2026;10;2026-10-31;4000;4000;;0;0',
  ].join('\n')
export const SWAPPED_191 =
  IMPORT_HEADER_207 +
  '\n' +
  [
    'DOC-1;FORDRAN;7771000022;K-2;;;2026;10;2026-10-31;6000;6000;;0;0',
    'DOC-2;FORDRAN;7771000011;K-1;;;2026;10;2026-10-31;4000;4000;;0;0',
  ].join('\n')

export async function fixtureActor(db: PrismaClient, org: string, role: UserRole) {
  const u = await db.user.create({
    data: {
      organizationId: org,
      role,
      email: `evidence207-${randomUUID()}@example.invalid`,
      passwordHash: 'synthetic-not-login',
      firstName: 'Syntetisk',
      lastName: role,
    },
  })
  return { sub: u.id, role }
}

export function fixtureEvidenceInput(
  orgNumber: string,
  cutover: Date,
  sourceContent: string,
  mappingContent: string,
  company = 'SYNTHETIC_191',
): CreateOpeningEvidenceInput {
  const digits = orgNumber.replace(/-/gu, '')
  return {
    sourceSystemProduct: 'Syntetiskt fristående källsystem',
    sourceCompanyKey: company,
    sourceOrgNumber: digits.slice(0, 6) + '-' + digits.slice(6),
    sourceAsOfDate: new Date(cutover.getTime() - 86_400_000).toISOString().slice(0, 10),
    sourceExportedAt: '2026-11-01T00:00:00.000Z',
    scopeResponsible: 'Syntetisk fullständighetsansvarig',
    scopeDeclaration:
      'Samtliga öppna fordringar och hållna depositioner i den uttryckligt syntetiska källreskontran per avstämningsdagen.',
    sourceName: 'oberoende-kalla.csv',
    sourceContent,
    mappingName: 'explicit-mappning.csv',
    mappingContent,
  }
}

/** Existing regression fixtures supply their own explicit ledger; this helper only reviews it. */
export async function reviewedFixtureEvidence(
  db: PrismaClient,
  organizationId: string,
  packageId: string,
  owner: { sub: string; role: UserRole },
  input: CreateOpeningEvidenceInput,
) {
  const service = new OpeningEvidenceService(db as unknown as PrismaService)
  const accountant = await fixtureActor(db, organizationId, 'ACCOUNTANT')
  const evidence = await service.create(organizationId, packageId, owner, input)
  if (evidence.comparisonStatus !== 'OK')
    throw new Error('Syntetisk regressionsevidens: ' + JSON.stringify(evidence))
  await service.review(organizationId, packageId, evidence.id, accountant, {
    evidenceSha256: evidence.evidenceSha256,
  })
  return evidence.evidenceSha256
}

// One worker, monotonic local candidates plus an existence check for preserved prior runs.
// The previous four-digit random suffix collided during V4 (C1 log45).
let fixtureOrgSerial = BigInt(Date.now()) % 100_000_000n
async function nextFixtureOrgNumber(db: PrismaClient) {
  for (;;) {
    fixtureOrgSerial = (fixtureOrgSerial + 1n) % 100_000_000n
    const digits = '90' + fixtureOrgSerial.toString().padStart(8, '0')
    const orgNumber = digits.slice(0, 6) + '-' + digits.slice(6)
    if (!(await db.organization.findUnique({ where: { orgNumber }, select: { id: true } })))
      return orgNumber
  }
}

export async function createEvidenceFixture(db: PrismaClient, label: string, csv = IMPORT_191) {
  const id = `evidence207-${label}-${randomUUID()}`
  const orgNumber = await nextFixtureOrgNumber(db)
  const cutover = new Date('2026-11-01')
  await db.organization.create({
    data: {
      id,
      name: 'Syntetisk207 ' + label,
      orgNumber,
      email: id + '@example.invalid',
      street: 'Syntetgatan1',
      city: 'Teststad',
      postalCode: '12345',
      billingCutoverDate: cutover,
    },
  })
  const owner = await fixtureActor(db, id, 'OWNER'),
    admin = await fixtureActor(db, id, 'ADMIN'),
    accountant = await fixtureActor(db, id, 'ACCOUNTANT')
  const property = await db.property.create({
    data: {
      organizationId: id,
      name: 'Syntetisk207',
      propertyDesignation: id,
      type: 'RESIDENTIAL',
      street: 'Syntetgatan1',
      city: 'Teststad',
      postalCode: '12345',
      totalArea: 100,
    },
  })
  const tenants: Tenant[] = [],
    leases: Lease[] = []
  for (const [name, ocr, contract] of [
    ['A', '7771000011', 'K-1'],
    ['B', '7771000022', 'K-2'],
  ] as const) {
    const t = await db.tenant.create({
      data: {
        organizationId: id,
        type: 'INDIVIDUAL',
        firstName: 'Syntetisk',
        lastName: name,
        email: id + name + '@example.invalid',
        ocrNumber: ocr,
      },
    })
    const u = await db.unit.create({
      data: {
        propertyId: property.id,
        name,
        unitNumber: name,
        type: 'APARTMENT',
        area: 50,
        monthlyRent: 6000,
      },
    })
    const l = await db.lease.create({
      data: {
        organizationId: id,
        tenantId: t.id,
        unitId: u.id,
        contractNumber: contract,
        status: 'ACTIVE',
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        monthlyRent: 6000,
        depositAmount: 0,
      },
    })
    tenants.push(t)
    leases.push(l)
  }
  const p = db as unknown as PrismaService
  const evidence = new OpeningEvidenceService(p),
    packages = new OpeningPackageService(p, new OcrService(p), evidence)
  const pkg = await packages.create(id, admin, {
    sourceName: 'syntetisk-import.csv',
    innehall: csv,
    nollOppning: csv === IMPORT_HEADER_207,
  })
  const mapping =
    MAPPING_HEADER +
    '\n' +
    [0, 1]
      .map(
        (i) =>
          `SYNTHETIC_191;${i === 0 ? 'A' : 'B'};K-${i + 1};${tenants[i]!.id};${leases[i]!.id};syntetisk kontraktskontroll`,
      )
      .join('\n')
  return {
    id,
    orgNumber,
    cutover,
    owner,
    admin,
    accountant,
    tenants,
    leases,
    pkg,
    packages,
    evidence,
    input: fixtureEvidenceInput(orgNumber, cutover, SOURCE_191, mapping),
  }
}
export type EvidenceFixture = Awaited<ReturnType<typeof createEvidenceFixture>>

export async function prepareEvidencePackage(
  db: PrismaClient,
  f: EvidenceFixture,
  receivables = 1_000_000,
  deposits = 0,
) {
  const conn = await db.fortnoxConnection.create({
    data: {
      organizationId: f.id,
      status: 'ACTIVE',
      fortnoxDatabaseNumber: 990207,
      fortnoxOrgNumber: f.orgNumber,
      connectedAt: new Date(Date.now() - 3_600_000),
      exportVoucherSeries: 'A',
    },
  })
  const v = await f.packages.validate(f.id, f.pkg.id, f.admin)
  if (v.status !== 'VALIDATED')
    throw new Error(
      'Syntetisk import kunde inte valideras: ' + JSON.stringify(v.rows.map((r) => r.errors)),
    )
  const run = await db.fortnoxReadRun.create({
    data: {
      organizationId: f.id,
      connectionId: conn.id,
      fortnoxDatabaseNumber: 990207,
      status: 'COMPLETE',
      financialYearId: 1,
      financialYearStart: new Date('2026-01-01'),
      financialYearEnd: new Date('2026-12-31'),
      periodFrom: new Date('2026-01-01'),
      periodTo: new Date('2026-10-31'),
      costAccounts: [1510, 2890],
      startedAt: new Date(),
      completedAt: new Date(),
      summary: { balanceBroughtForwardOre: { '1510': receivables, '2890': -deposits } },
      rows: { rows: [], references: [] },
    },
  })
  await f.packages.bindFortnoxRead(f.id, f.pkg.id, f.admin, run.id)
  await f.packages.setFirstPeriodRegister(f.id, f.pkg.id, f.admin, {
    filnamn: 'syntetiskt-register.csv',
    innehall: 'radId;hyresgast;avtal;periodAr;periodManad;dokument;fakturerat;betalt',
    system: 'Syntetiskt tidigare system',
    ansvarig: 'Syntetisk ansvarig',
    tackningFran: '2026-11-01',
    tackningTill: '2026-12-31',
    intaktskonton: [3911],
    forskottskonton: [2420],
  })
}

export async function evidenceEffects(db: PrismaClient, f: EvidenceFixture) {
  const notices = await db.rentNotice.findMany({
    where: { organizationId: f.id },
    orderBy: { tenantId: 'asc' },
  })
  return {
    package: (await db.openingPackage.findUniqueOrThrow({ where: { id: f.pkg.id } })).status,
    opening: notices
      .map((n) => ({
        customer: n.tenantId === f.tenants[0]!.id ? 'A' : 'B',
        ore: Math.round(Number(n.totalAmount) * 100),
        status: n.status,
        origin: n.origin,
      }))
      .sort((a, b) => a.customer.localeCompare(b.customer)),
    journals: await db.journalEntry.count({ where: { organizationId: f.id } }),
    payments: await db.rentNoticePayment.count({ where: { rentNotice: { organizationId: f.id } } }),
    deposits: await db.deposit.count({ where: { organizationId: f.id } }),
    bank: await db.bankTransaction.count({ where: { organizationId: f.id } }),
    exports: await db.fortnoxVoucherExport.count({ where: { organizationId: f.id } }),
    activations: await db.fortnoxCustomerActivation.count({ where: { organizationId: f.id } }),
  }
}
