// Endast syntetisk isolationsrigg; laddar den gamla main-koden och dess Prisma-klient.
const assert = require('node:assert/strict')
const { PrismaClient } = require('@prisma/client')
const url = new URL(process.env.DATABASE_URL)
assert.equal(url.hostname, '127.0.0.1')
assert.equal(url.port, '55483')
assert.ok(url.pathname.startsWith('/api_release_'))
const prisma = new PrismaClient()
const mode = process.argv[2]
async function seed() {
  for (const id of ['org-a', 'org-b'])
    await prisma.organization.create({
      data: {
        id,
        name: 'Syntetiskt isolationsprov',
        email: `${id}@example.invalid`,
        street: 'Provvägen 1',
        city: 'Provstad',
        postalCode: '00000',
      },
    })
  await prisma.property.create({
    data: {
      id: 'property',
      organizationId: 'org-a',
      name: 'Prov',
      propertyDesignation: 'PROV 1:1',
      type: 'RESIDENTIAL',
      street: 'Provvägen 1',
      city: 'Provstad',
      postalCode: '00000',
      totalArea: 50,
    },
  })
  await prisma.unit.create({
    data: {
      id: 'unit',
      propertyId: 'property',
      name: 'Prov',
      unitNumber: '1',
      type: 'APARTMENT',
      area: 50,
      monthlyRent: 1000,
    },
  })
  await prisma.tenant.create({
    data: {
      id: 'tenant',
      organizationId: 'org-a',
      type: 'INDIVIDUAL',
      firstName: 'Syntetisk',
      lastName: 'Person',
      email: 'tenant@example.invalid',
    },
  })
  await prisma.lease.create({
    data: {
      id: 'lease',
      organizationId: 'org-a',
      unitId: 'unit',
      tenantId: 'tenant',
      status: 'ACTIVE',
      startDate: new Date('2026-01-01'),
      tenancyStartDate: new Date('2026-01-01'),
      monthlyRent: 1000,
      depositAmount: 0,
    },
  })
  await prisma.meter.create({
    data: {
      id: 'meter',
      organizationId: 'org-a',
      unitId: 'unit',
      type: 'WATER_COLD',
      unitOfMeasure: 'm³',
    },
  })
  for (const month of [8, 9])
    await prisma.rentNotice.create({
      data: {
        id: `notice-${month}`,
        organizationId: 'org-a',
        leaseId: 'lease',
        tenantId: 'tenant',
        noticeNumber: `PROV-${month}`,
        ocrNumber: `${month}`,
        month,
        year: 2026,
        amount: 1000,
        totalAmount: 1000,
        dueDate: new Date('2026-10-01'),
      },
    })
}
async function probe() {
  require('ts-node').register({
    transpileOnly: true,
    project: require('node:path').resolve(__dirname, '../../tsconfig.json'),
  })
  const { ConsumptionService } = require('../../src/consumption/consumption.service.ts')
  // De två tjänsterna används inte av dessa verkliga läs-/avläsningsmetoder.
  const observedPrisma = mode === 'deadlock' ? prisma.$extends({ query: { meterReading: {
    async create({ args, query }) {
      const result = await query(args)
      process.stdout.write('READING_WRITTEN\n')
      await new Promise(resolveInput => process.stdin.once('data', resolveInput))
      return result
    },
  } } }) : prisma
  const service = new ConsumptionService(observedPrisma, undefined, undefined)
  await prisma.consumptionTariff.upsert({
    where: { id: 'tariff' },
    update: {},
    create: {
      id: 'tariff',
      organizationId: 'org-a',
      meterType: 'WATER_COLD',
      pricePerUnit: 2,
      validFrom: new Date('2026-01-01'),
    },
  })
  if (mode === 'concurrent') {
    process.stdout.write('READY\n')
    await new Promise((resolveInput) => process.stdin.once('data', resolveInput))
  }
  const input = {
    meterId: 'meter',
    leaseId: 'lease',
    readingType: 'PERIOD_VOLUME',
    value: 3,
    readingDate: '2026-09-12',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    source: 'MANUAL',
    externalId: 'old-api-probe',
  }
  const start = performance.now()
  const result = await service.recordReading(input, 'org-a', 'synthetic-user')
  assert.equal(Number(result.charge.totalAmount), 6)
  const repeated = await service.recordReading(input, 'org-a', 'synthetic-user')
  assert.equal(repeated.idempotent, true)
  assert.equal(repeated.reading.id, result.reading.id)
  assert.equal((await service.findMeter('meter', 'org-a')).id, 'meter')
  assert.equal((await service.findCharge(result.charge.id, 'org-a')).id, result.charge.id)
  assert.equal((await prisma.rentNotice.findMany()).length, 2)
  await prisma.rentNotice.update({
    where: { id: 'notice-8' },
    data: { sendError: 'syntetisk skrivsond' },
  })
  const invoice = await prisma.invoice.create({
    data: {
      organizationId: 'org-a',
      tenantId: 'tenant',
      invoiceNumber: 'PROBE-1',
      type: 'OTHER',
      subtotal: 10,
      vatTotal: 0,
      total: 10,
      dueDate: new Date('2026-10-01'),
      issueDate: new Date('2026-09-12'),
    },
  })
  assert.equal(
    Number((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).total),
    10,
  )
  process.stdout.write(
    `${JSON.stringify({ oldApi: 'recordReading/findMeter/findCharge', assertions: 7, elapsedMs: performance.now() - start, readingCount: await prisma.meterReading.count(), chargeCount: await prisma.consumptionCharge.count(), ordinaryNoticeCount: await prisma.rentNotice.count(), ordinaryInvoiceCount: await prisma.invoice.count() })}\n`,
  )
}
;(mode === 'seed' ? seed() : probe())
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    process.stderr.write(`${error}\n`)
    process.exitCode = 1
  })
