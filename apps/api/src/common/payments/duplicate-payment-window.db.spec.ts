/**
 * DUBBLETTFÖNSTRET FÖR MANUELLA BETALNINGAR — mekaniken, mot riktig Postgres.
 *
 * ── VAD DEN HÄR FILEN ÄGER ──────────────────────────────────────────────────
 *
 * Att fönstret SVARAR RÄTT: vad som räknas som en dubblett och vad som inte
 * gör det. Att `markAsPaidManually` faktiskt frågar — och frågar innanför
 * transaktionen — ägs av `manual-payment-duplicate-window.spec.ts`. Vakten äger
 * påkopplingen, specen äger mekaniken.
 *
 * ── VARFÖR MOT RIKTIG POSTGRES OCH INTE MOT EN ATTRAPP ──────────────────────
 *
 * Frågan är ett `where` med tre villkor samtidigt — belopp, källa och ett
 * tidsfönster på `createdAt`. En attrapp som returnerar det jag matat in
 * bekräftar bara att jag skrev regeln två gånger. Särskilt beloppet: `amount`
 * är `Decimal(10,2)`, och likhet mellan `Prisma.Decimal` och en kolumn är
 * databasens sak att avgöra, inte JavaScripts.
 *
 * ── MOTPROVEN ÄR POÄNGEN ────────────────────────────────────────────────────
 *
 * Ett fönster som fäller allt vore lika trasigt som inget fönster. Tre av fem
 * prov nedan kräver att det INTE slår till: olika belopp, utanför tiden, och
 * en bankmatchad rad (som har en riktig nyckel i `bankTransactionId` och inte
 * ska blockera en manuell registrering).
 */
import { randomUUID } from 'node:crypto'

import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'

import {
  DUPLICATE_MANUAL_PAYMENT_WINDOW_MS,
  assertNoRecentIdenticalManualPayment,
} from './duplicate-payment-window'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const BELOPP = 5_000
const TOTAL = 20_000

medDb('dubblettfönstret för manuella betalningar', () => {
  let prisma: PrismaClient
  let orgId: string
  let tenantId: string

  beforeAll(async () => {
    prisma = new PrismaClient()
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `dubb-${sfx}`,
        email: `dubb-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    // CHECK Invoice_tenant_xor_customer_chk kräver exakt en motpart.
    const t = await prisma.tenant.create({
      data: { organizationId: orgId, type: 'INDIVIDUAL', email: `dubb-${sfx}@example.se` },
      select: { id: true },
    })
    tenantId = t.id
  }, 30_000)

  afterAll(async () => {
    // Org-radering kaskaderar INTE — städa i beroendeordning.
    await prisma.invoicePayment.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  const nyFaktura = () =>
    prisma.invoice.create({
      data: {
        organizationId: orgId,
        tenantId,
        invoiceNumber: `F-${randomUUID().slice(0, 8)}`,
        type: 'RENT',
        issueDate: new Date(),
        dueDate: new Date(),
        subtotal: TOTAL,
        vatTotal: 0,
        total: TOTAL,
        status: 'SENT',
      },
      select: { id: true },
    })

  /** `createdAt` sätts explicit där provet behöver styra tiden. */
  const betalning = (
    invoiceId: string,
    belopp: number,
    over: { source?: 'MANUAL' | 'BANK_RECONCILIATION'; createdAt?: Date } = {},
  ) =>
    prisma.invoicePayment.create({
      data: {
        invoiceId,
        amount: belopp,
        paidAt: new Date(),
        source: over.source ?? 'MANUAL',
        ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      },
      select: { id: true },
    })

  const pröva = (invoiceId: string, belopp: number) =>
    assertNoRecentIdenticalManualPayment(prisma, {
      invoiceId,
      amount: new Prisma.Decimal(belopp),
    })

  it('SOND-STYRKA: fönstret är känt och sonderna ligger på rätt sida om det', () => {
    // Utan det här talet går det inte att skilja "fönstret fungerade" från
    // "sonden låg utanför av misstag". Provet nedan backdaterar med fönstret
    // plus en minut; provet ovanför skriver i nuet.
    expect(DUPLICATE_MANUAL_PAYMENT_WINDOW_MS).toBe(120_000)
    expect(DUPLICATE_MANUAL_PAYMENT_WINDOW_MS).toBeLessThan(10 * 60_000)
  })

  it('IDENTISK manuell betalning inom fönstret → kastar', async () => {
    const { id } = await nyFaktura()
    await betalning(id, BELOPP)
    await expect(pröva(id, BELOPP)).rejects.toBeInstanceOf(ConflictException)
  })

  it('MOTPROV: ANNAT belopp inom fönstret → släpps igenom', async () => {
    const { id } = await nyFaktura()
    await betalning(id, BELOPP)
    await expect(pröva(id, BELOPP + 1)).resolves.toBeUndefined()
  })

  it('MOTPROV: samma belopp UTANFÖR fönstret → släpps igenom', async () => {
    const { id } = await nyFaktura()
    await betalning(id, BELOPP, {
      createdAt: new Date(Date.now() - DUPLICATE_MANUAL_PAYMENT_WINDOW_MS - 60_000),
    })
    await expect(pröva(id, BELOPP)).resolves.toBeUndefined()
  })

  it('MOTPROV: en BANKMATCHAD rad blockerar inte en manuell registrering', async () => {
    // Bankraden bär `bankTransactionId` med ett eget unikt index — den har en
    // riktig nyckel och behöver inget fönster. Att låta den blockera hade
    // stoppat en legitim manuell registrering av en annan betalning.
    const { id } = await nyFaktura()
    await betalning(id, BELOPP, { source: 'BANK_RECONCILIATION' })
    await expect(pröva(id, BELOPP)).resolves.toBeUndefined()
  })

  it('MOTPROV: en annan FAKTURA med samma belopp blockerar inte', async () => {
    const a = await nyFaktura()
    const b = await nyFaktura()
    await betalning(a.id, BELOPP)
    await expect(pröva(b.id, BELOPP)).resolves.toBeUndefined()
  })

  it('felmeddelandet bär beloppet och åldern — annars vet operatören inte vad som hände', async () => {
    const { id } = await nyFaktura()
    await betalning(id, BELOPP)
    await expect(pröva(id, BELOPP)).rejects.toThrow(/5000/)
    await expect(pröva(id, BELOPP)).rejects.toThrow(/sekunder sedan/)
  })
})
