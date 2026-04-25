import { PrismaClient, Prisma } from '@prisma/client'

const prisma = new PrismaClient()

interface UnitInput {
  unitNumber: string
  name: string
  area: number
  monthlyRent: number
  status?: 'VACANT' | 'OCCUPIED' | 'UNDER_RENOVATION' | 'RESERVED'
}

interface PropertyInput {
  name: string
  propertyDesignation: string
  street: string
  city: string
  postalCode: string
  totalArea: number
  units: UnitInput[]
}

const PROPERTIES: PropertyInput[] = [
  {
    name: 'Stenmossevägen 10/12/14/16',
    propertyDesignation: 'Kungsbacka Skårby 12:2',
    street: 'Stenmossevägen 10/12/14/16',
    city: 'Kungsbacka',
    postalCode: '43995',
    totalArea: 507,
    units: [
      { unitNumber: '10-stuga', name: 'Stenmossevägen 10 stuga', area: 30, monthlyRent: 8000 },
      { unitNumber: '12-1001', name: 'Stenmossevägen 12 lgh 1001', area: 65, monthlyRent: 13200 },
      { unitNumber: '12-1002', name: 'Stenmossevägen 12 lgh 1002', area: 50, monthlyRent: 8750 },
      { unitNumber: '12-1201', name: 'Stenmossevägen 12 lgh 1201', area: 180, monthlyRent: 15000 },
      { unitNumber: '12-1301', name: 'Stenmossevägen 12 lgh 1301', area: 85, monthlyRent: 13750 },
      { unitNumber: '12-extra', name: 'Stenmossevägen 12', area: 25, monthlyRent: 6300 },
      { unitNumber: '12-stuga', name: 'Stenmossevägen 12 stuga', area: 22, monthlyRent: 9000 },
      {
        unitNumber: '14-attefall',
        name: 'Stenmossevägen 14 Attefallshus',
        area: 50,
        monthlyRent: 12600,
      },
    ],
  },
  {
    name: 'Säröleden 135',
    propertyDesignation: 'Kungsbacka Ysby 3:22',
    street: 'Säröleden 135',
    city: 'Kungsbacka',
    postalCode: '43973',
    totalArea: 259,
    units: [
      { unitNumber: 'underplan', name: 'Underplan', area: 75, monthlyRent: 20000 },
      { unitNumber: 'overplan', name: 'Överplan', area: 105, monthlyRent: 18900 },
      { unitNumber: 'attefallshus', name: 'Attefallshus', area: 57, monthlyRent: 15000 },
      { unitNumber: 'stuga', name: 'Stuga', area: 22, monthlyRent: 9000 },
    ],
  },
  {
    name: 'Hönsarydsliden 66',
    propertyDesignation: 'Kungsbacka Vallda 4:27',
    street: 'Hönsarydsliden 66',
    city: 'Kungsbacka',
    postalCode: '43492',
    totalArea: 635,
    units: [
      { unitNumber: '1', name: 'Lägenhet 1', area: 110, monthlyRent: 18020 },
      { unitNumber: '2', name: 'Lägenhet 2', area: 50, monthlyRent: 13000 },
      { unitNumber: '3', name: 'Lägenhet 3', area: 63, monthlyRent: 15000 },
      { unitNumber: '4', name: 'Lägenhet 4', area: 95, monthlyRent: 16000 },
      { unitNumber: '5', name: 'Lägenhet 5', area: 100, monthlyRent: 16000 },
      { unitNumber: '6', name: 'Lägenhet 6', area: 40, monthlyRent: 5000 },
      { unitNumber: '7', name: 'Lägenhet 7', area: 40, monthlyRent: 12000 },
      { unitNumber: '8', name: 'Lägenhet 8', area: 35, monthlyRent: 11000 },
      { unitNumber: 'gaststuga', name: 'Gäststuga', area: 35, monthlyRent: 9000 },
      { unitNumber: 'friggebod', name: 'Friggebod', area: 15, monthlyRent: 5500 },
      {
        unitNumber: 'kompl',
        name: 'Komplementbostadshus',
        area: 52,
        monthlyRent: 0,
        status: 'VACANT',
      },
    ],
  },
]

async function safeDeleteMany<T>(label: string, fn: () => Promise<T>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2021') {
      console.warn(`  (skipping ${label} — table missing in DB)`)
      return
    }
    throw err
  }
}

async function main() {
  const orgId = process.env['SEED_ORG_ID']
  if (!orgId) throw new Error('SEED_ORG_ID saknas i miljön')

  const org = await prisma.organization.findUnique({ where: { id: orgId } })
  if (!org) throw new Error(`Organization ${orgId} hittades inte`)

  console.warn(`\n→ Seedar fastigheter till org "${org.name}" (${orgId})\n`)

  // Fas 1: städa befintlig data. Inte i transaktion eftersom vissa modeller
  // (rentNotice/inspection/maintenancePlan) saknas i prod-DB och deras
  // P2021-fel skulle annars rolla tillbaka även de delete:s som lyckats.
  const existingProps = await prisma.property.findMany({
    where: { organizationId: orgId },
    select: { id: true, units: { select: { id: true } } },
  })
  const propIds = existingProps.map((p) => p.id)
  const unitIds = existingProps.flatMap((p) => p.units.map((u) => u.id))

  console.warn(
    `Hittade ${propIds.length} existerande properties (${unitIds.length} units) — raderar.`,
  )

  if (unitIds.length > 0) {
    const leaseIds = (
      await prisma.lease.findMany({
        where: { unitId: { in: unitIds } },
        select: { id: true },
      })
    ).map((l) => l.id)

    if (leaseIds.length > 0) {
      await prisma.invoice.deleteMany({ where: { leaseId: { in: leaseIds } } })
      await prisma.document.deleteMany({ where: { leaseId: { in: leaseIds } } })
      await safeDeleteMany('rentNotice (lease)', () =>
        prisma.rentNotice.deleteMany({ where: { leaseId: { in: leaseIds } } }),
      )
      await safeDeleteMany('inspection (lease)', () =>
        prisma.inspection.deleteMany({ where: { leaseId: { in: leaseIds } } }),
      )
      await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
    }

    await prisma.document.deleteMany({ where: { unitId: { in: unitIds } } })
    await prisma.maintenanceTicket.deleteMany({ where: { unitId: { in: unitIds } } })
    await safeDeleteMany('inspection (unit)', () =>
      prisma.inspection.deleteMany({ where: { unitId: { in: unitIds } } }),
    )
  }

  if (propIds.length > 0) {
    await prisma.document.deleteMany({ where: { propertyId: { in: propIds } } })
    await prisma.maintenanceTicket.deleteMany({ where: { propertyId: { in: propIds } } })
    await prisma.newsPost.deleteMany({ where: { propertyId: { in: propIds } } })
    await safeDeleteMany('inspection (property)', () =>
      prisma.inspection.deleteMany({ where: { propertyId: { in: propIds } } }),
    )
    await safeDeleteMany('maintenancePlan', () =>
      prisma.maintenancePlan.deleteMany({ where: { propertyId: { in: propIds } } }),
    )
    await prisma.property.deleteMany({ where: { id: { in: propIds } } })
  }

  // Fas 2: skapa nya properties + units atomiskt
  console.warn(`\nSkapar ${PROPERTIES.length} nya properties...`)

  await prisma.$transaction(async (tx) => {
    for (const prop of PROPERTIES) {
      const created = await tx.property.create({
        data: {
          organizationId: orgId,
          name: prop.name,
          propertyDesignation: prop.propertyDesignation,
          type: 'RESIDENTIAL',
          street: prop.street,
          city: prop.city,
          postalCode: prop.postalCode,
          totalArea: new Prisma.Decimal(prop.totalArea),
          units: {
            create: prop.units.map((u) => ({
              unitNumber: u.unitNumber,
              name: u.name,
              type: 'APARTMENT',
              status: u.status ?? 'VACANT',
              area: new Prisma.Decimal(u.area),
              monthlyRent: new Prisma.Decimal(u.monthlyRent),
            })),
          },
        },
        include: { _count: { select: { units: true } } },
      })

      console.warn(
        `  ✓ ${created.propertyDesignation} — ${created.name} (${created._count.units} units)`,
      )
    }
  })

  const totals = await prisma.property.aggregate({
    where: { organizationId: orgId },
    _count: { id: true },
    _sum: { totalArea: true },
  })

  const unitCount = await prisma.unit.count({
    where: { property: { organizationId: orgId } },
  })

  console.warn('\n╔══════════════════════════════════════════════╗')
  console.warn('║          Seed slutförd                       ║')
  console.warn('╠══════════════════════════════════════════════╣')
  console.warn(`║ Properties:   ${String(totals._count.id).padEnd(31)}║`)
  console.warn(`║ Units:        ${String(unitCount).padEnd(31)}║`)
  console.warn(`║ Total area:   ${(totals._sum.totalArea?.toString() ?? '0').padEnd(27)} kvm ║`)
  console.warn('╚══════════════════════════════════════════════╝')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => {
    void prisma.$disconnect()
  })
