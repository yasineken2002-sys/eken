import { PrismaClient } from '@prisma/client'
import * as bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'

const prisma = new PrismaClient()

function generateTempPassword(): string {
  return randomBytes(9).toString('base64').replace(/[+/=]/g, 'A').slice(0, 12) + '!1'
}

async function main() {
  const email = process.env['PLATFORM_SEED_EMAIL']
  if (!email) {
    throw new Error('PLATFORM_SEED_EMAIL saknas i miljön')
  }

  const existing = await prisma.platformUser.findUnique({ where: { email } })
  if (existing) {
    console.warn(`PlatformUser ${email} finns redan — ingenting gjort.`)
    return
  }

  const tempPassword = process.env['PLATFORM_SEED_PASSWORD'] ?? generateTempPassword()
  const passwordHash = await bcrypt.hash(tempPassword, 12)

  const firstName = process.env['PLATFORM_SEED_FIRST_NAME'] ?? 'Super'
  const lastName = process.env['PLATFORM_SEED_LAST_NAME'] ?? 'Admin'

  await prisma.platformUser.create({
    data: {
      email,
      passwordHash,
      firstName,
      lastName,
    },
  })

  console.warn('╔════════════════════════════════════════════════════════════════╗')
  console.warn('║            Super-admin skapad                                  ║')
  console.warn('╠════════════════════════════════════════════════════════════════╣')
  console.warn(`║ Email:        ${email.padEnd(50)}║`)
  console.warn(`║ Lösenord:     ${tempPassword.padEnd(50)}║`)
  console.warn('║                                                                ║')
  console.warn('║ Byt lösenord omgående efter första inloggning!                 ║')
  console.warn('╚════════════════════════════════════════════════════════════════╝')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => {
    void prisma.$disconnect()
  })
