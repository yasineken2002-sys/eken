/**
 * MIGRATIONENS KONTROLL — den ska FÄLLA på ett okänt betalsätt.
 *
 * ── VAD MIGRATIONEN GÖR, OCH INTE GÖR ───────────────────────────────────────
 *
 * Uppdraget var "mappa befintliga råtexter till enumvärden, okänd råtext → rött".
 * Mätningen visade att fakturavägen ALDRIG har lagrat råtext: `toPaymentMethod`
 * mappade i controllern och det som nådde databasen var redan enumvärdet, i
 * `InvoiceEvent.payload` (jsonb). Det finns alltså ingen kolumn att översätta,
 * och en mappande UPDATE hade haft en tom mängd.
 *
 * Det som ÄR meningsfullt att kräva är att varje redan lagrat värde ligger inom
 * enumen — annars finns en rad som ingen känd väg kan ha skrivit, och då ska
 * migrationen stanna i stället för att gissa. Den kontrollen är inte tom av
 * konstruktion, och det här provet är beviset: den matas med ett okänt värde och
 * MÅSTE kasta.
 *
 * ── RIGGEN SKAPAR SINA EGNA FÖRUTSÄTTNINGAR ─────────────────────────────────
 *
 * Egen organisation, eget avtal, egen faktura och egen händelse; städning i
 * FK-riktning. Ingenting lånas ur `eken_dev` (#612) — och kontrollsatsen körs
 * som ren SQL, samma text som i migrationen, mot den databas testet pekar på.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/**
 * SAMMA sats som i migrationen. Att den står här som en kopia är medvetet: ett
 * prov som importerade migrationsfilen hade prövat att filen går att läsa, inte
 * att SQL:en gör vad den ska. Skulle de glida isär fäller `KANARIEFÅGEL`-provet
 * nedan, som läser migrationsfilen och kräver att texten finns i den.
 */
const KONTROLLSATS = `
DO $$
DECLARE
  okanda TEXT;
BEGIN
  SELECT string_agg(DISTINCT v, ', ')
    INTO okanda
    FROM (
      SELECT payload->>'paymentMethod' AS v
        FROM "InvoiceEvent"
       WHERE payload ? 'paymentMethod'
         AND payload->>'paymentMethod' IS NOT NULL
    ) q
   WHERE v NOT IN ('BANK', 'CASH', 'SWISH', 'MANUAL');

  IF okanda IS NOT NULL THEN
    RAISE EXCEPTION 'okanda betalsatt: %', okanda;
  END IF;
END $$;
`

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('migrationens betalsättskontroll', () => {
  let prisma: PrismaClient
  let orgId: string
  let invoiceId: string
  let customerId: string

  beforeAll(async () => {
    prisma = new PrismaClient()
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `pm-${sfx}`,
        email: `pm-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgId = org.id
    // Invoice_tenant_xor_customer_chk: exakt EN motpart krävs. Riggen skapar
    // sin egen kund i stället för att låna en ur eken_dev.
    const kund = await prisma.customer.create({
      data: { organizationId: orgId, companyName: `kund-${sfx}`, type: 'COMPANY' },
    })
    customerId = kund.id
    const invoice = await prisma.invoice.create({
      data: {
        organizationId: orgId,
        customerId,
        invoiceNumber: `PM-${sfx}`,
        type: 'OTHER',
        status: 'SENT',
        issueDate: new Date('2026-09-01'),
        dueDate: new Date('2026-09-30'),
        subtotal: 1000,
        vatTotal: 0,
        total: 1000,
      },
    })
    invoiceId = invoice.id
  })

  afterAll(async () => {
    await prisma.invoiceEvent.deleteMany({ where: { invoiceId } })
    await prisma.invoicePayment.deleteMany({ where: { invoiceId } })
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
    await prisma.customer.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  afterEach(async () => {
    await prisma.invoiceEvent.deleteMany({ where: { invoiceId } })
  })

  const skrivHandelse = (paymentMethod: string) =>
    prisma.invoiceEvent.create({
      data: {
        invoiceId,
        type: 'PAYMENT_RECEIVED',
        actorType: 'USER',
        payload: { paymentMethod },
      },
    })

  it('DE FYRA ENUMVÄRDENA passerar kontrollen', async () => {
    for (const v of ['BANK', 'CASH', 'SWISH', 'MANUAL']) await skrivHandelse(v)
    await expect(prisma.$executeRawUnsafe(KONTROLLSATS)).resolves.toBeDefined()
  })

  it.each(['Bankgiro', 'Plusgiro', 'Autogiro', 'Kontant', 'bank', 'Bitcoin'])(
    'DEN AVGÖRANDE: råtexten %s FÄLLER kontrollen',
    async (raatext) => {
      // Exakt de etiketter gränssnittet erbjuder, plus den lowercase-form den
      // gamla mappningen godtog, plus ett rent skräpvärde. Skulle någon av dem
      // finnas lagrad i prod ska driftsättningen stanna — inte tyst bli MANUAL.
      await skrivHandelse(raatext)
      await expect(prisma.$executeRawUnsafe(KONTROLLSATS)).rejects.toThrow(/okanda betalsatt/)
    },
  )

  it('en händelse UTAN paymentMethod rör inte kontrollen', async () => {
    await prisma.invoiceEvent.create({
      data: { invoiceId, type: 'SENT', actorType: 'USER', payload: { note: 'inget betalsätt' } },
    })
    await expect(prisma.$executeRawUnsafe(KONTROLLSATS)).resolves.toBeDefined()
  })

  it('KANARIEFÅGEL: satsen ovan står FAKTISKT i migrationsfilen', async () => {
    // Utan den här kan provet vara grönt om en SQL som inte längre körs.
    const fs = await import('node:fs')
    const path = await import('node:path')
    const fil = path.join(
      __dirname,
      '../../prisma/migrations/20260905220000_invoice_payment_method/migration.sql',
    )
    const sql = fs.readFileSync(fil, 'utf8')
    expect(sql).toContain("v NOT IN ('BANK', 'CASH', 'SWISH', 'MANUAL')")
    expect(sql).toContain('RAISE EXCEPTION')
    expect(sql).toContain('ADD COLUMN "paymentMethodRaw"')
  })
})
