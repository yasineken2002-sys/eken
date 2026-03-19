import { PrismaClient } from '@prisma/client'
import * as bcrypt from 'bcrypt'

const prisma = new PrismaClient()

async function main() {
  console.warn('Seeding database...')

  // Organization
  const org = await prisma.organization.upsert({
    where: { orgNumber: '556000-0001' },
    update: {},
    create: {
      name: 'Demo Fastigheter AB',
      orgNumber: '556000-0001',
      email: 'info@demofastigheter.se',
      phone: '08-123 456 78',
      street: 'Storgatan 1',
      city: 'Stockholm',
      postalCode: '111 22',
    },
  })

  // Owner user
  const passwordHash = await bcrypt.hash('Demo123!', 12)
  const user = await prisma.user.upsert({
    where: { email: 'admin@demo.se' },
    update: {},
    create: {
      organizationId: org.id,
      email: 'admin@demo.se',
      passwordHash,
      firstName: 'Anna',
      lastName: 'Andersson',
      role: 'OWNER',
    },
  })

  // Property
  const property = await prisma.property.create({
    data: {
      organizationId: org.id,
      name: 'Storgatan 10',
      propertyDesignation: 'Stockholm Centrum 1:1',
      type: 'RESIDENTIAL',
      street: 'Storgatan 10',
      city: 'Stockholm',
      postalCode: '111 23',
      totalArea: 1200,
      yearBuilt: 1985,
    },
  })

  // Units
  for (let i = 1; i <= 8; i++) {
    await prisma.unit.create({
      data: {
        propertyId: property.id,
        name: `Lägenhet ${i}${i <= 4 ? 'A' : 'B'}`,
        unitNumber: `${i}0${i}`,
        type: 'APARTMENT',
        status: i % 4 === 0 ? 'VACANT' : 'OCCUPIED',
        area: 65 + i * 5,
        floor: Math.ceil(i / 2),
        rooms: 2 + (i % 3),
        monthlyRent: 8500 + i * 250,
      },
    })
  }

  // BAS accounts
  const accounts = [
    { number: 1510, name: 'Kundfordringar', type: 'ASSET' as const },
    { number: 1930, name: 'Bankkonto', type: 'ASSET' as const },
    { number: 2350, name: 'Mottagna depositioner', type: 'LIABILITY' as const },
    { number: 2610, name: 'Utgående moms 25%', type: 'LIABILITY' as const },
    { number: 3010, name: 'Hyresintäkter bostäder', type: 'REVENUE' as const },
    { number: 5010, name: 'Reparationer och underhåll', type: 'EXPENSE' as const },
    { number: 5020, name: 'Fastighetsskötsel', type: 'EXPENSE' as const },
  ]

  for (const acc of accounts) {
    await prisma.account.upsert({
      where: { organizationId_number: { organizationId: org.id, number: acc.number } },
      update: {},
      create: { organizationId: org.id, ...acc },
    })
  }

  console.warn(`✓ Seed complete. Login: admin@demo.se / Demo123!`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
