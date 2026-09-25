/**
 * RÄTTNING-A1 (#922) — AI-VERKTYGET `send_overdue_reminders` OCH BETALNINGSMÅLET.
 *
 * ── VARFÖR DEN FINNS ────────────────────────────────────────────────────────
 *
 * Granskningen av #922 (T3, A1) visade att F8-grinden i verktygets gren inte
 * hade något prov som kunde falla: grindtexten förekom bara i produktfilen,
 * `overdue-reminder-effect-unit.db.spec.ts` fick bara ett giltigt bankgiro, och
 * varken DB-riggen eller HTTP-provet anropade verktyget.
 *
 * ── VAD DEN MÄTER ──────────────────────────────────────────────────────────
 *
 * Genom produktionens `executeTool` (samma metodkropp; `Object.create` av samma
 * skäl som systerspecen), mot riktig Postgres, med behörig principal och
 * organisationen ur anropet:
 *
 *   bankgiro null / blankt  → sant avslag (`success:false`, skälet och var det
 *                             rättas), 0 `PaymentReminder`, 0 köade mejl, och
 *                             fakturornas status/total/uppdateringstid,
 *                             händelser, rader och verifikat oförändrade.
 *   VIEWER                  → nekas av rollbeslutet, skriver ingenting.
 *   annan organisation      → når inte den här organisationens fakturor ens med
 *                             explicita id:n och ett eget giltigt bankgiro.
 *   giltigt bankgiro, OWNER → POSITIV KONTROLL i samma körning: brev och
 *                             `PaymentReminder` för exakt de förfallna fakturorna.
 *
 * Den positiva kontrollen är det som gör att "allt nekas" inte kan bli grönt.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * `MailService` är en lokal fångare: "0 köade mejl" betyder att verktyget aldrig
 * anropade köandet — leverans ägs av mail-kön och Resend-webhooken. Grindens
 * EFFEKTSKYDD i den här vägen bärs av grinden själv: verktyget går inte genom
 * `PaymentReminderService` eller någon annan betalningsmålskontroll, så tas den
 * bort skickas breven (negativkontrollen i RATTNING-A1 visar det).
 */
import { randomUUID } from 'node:crypto'

// Samma ESM-stubbar som systerspecen: de rör inte vägen som mäts.
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ForbiddenException, Logger } from '@nestjs/common'
import { PrismaService } from '../../common/prisma/prisma.service'
import { AiAuditService } from '../audit/ai-audit.service'
import { ToolExecutorService } from './tool-executor.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

const GILTIGT = '5050-1055'
const VERKTYG = 'send_overdue_reminders'
const SPAR_DEADLINE_MS = 8_000

medDb('RÄTTNING-A1 · AI send_overdue_reminders prövar betalningsmålet', () => {
  let prisma: PrismaService
  let audit: AiAuditService

  interface Org {
    id: string
    agare: string
    betraktare: string
    hyresgastEpost: string
    fakturor: string[]
  }
  let a: Org
  let b: Org

  /** Lokal fångare: varje anrop till köandet hamnar här och ingen annanstans. */
  const mejl: Array<{ to: string; invoiceNumber: string }> = []
  const executor = (): ToolExecutorService => {
    const ex = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(ex, {
      prisma,
      audit,
      mailService: {
        sendOverdueReminder: async (o: { to: string; invoiceNumber: string }) => {
          mejl.push({ to: o.to, invoiceNumber: o.invoiceNumber })
          return `lokalt-${randomUUID().slice(0, 8)}`
        },
      },
      logger: new Logger('t2-a1'),
    })
    return ex
  }

  const satMal = (org: string, bankgiro: string | null) =>
    prisma.organization.update({ where: { id: org }, data: { bankgiro } })

  /** Allt en påminnelse kan röra, per organisation. */
  const avtryck = async (org: string) => ({
    paminnelser: await prisma.paymentReminder.count({
      where: { invoice: { organizationId: org } },
    }),
    handelser: await prisma.invoiceEvent.count({ where: { invoice: { organizationId: org } } }),
    rader: await prisma.invoiceLine.count({ where: { invoice: { organizationId: org } } }),
    verifikat: await prisma.journalEntry.count({ where: { organizationId: org } }),
    fakturor: (
      await prisma.invoice.findMany({
        where: { organizationId: org },
        select: { id: true, status: true, total: true, updatedAt: true },
        orderBy: { id: 'asc' },
      })
    ).map((f) => `${f.id}|${f.status}|${f.total.toString()}|${f.updatedAt.toISOString()}`),
  })

  /** Varje körning dräneras innan nästa: spåret skrivs asynkront. */
  const spar = (org: string) =>
    prisma.aiToolExecution
      .findMany({ where: { organizationId: org, toolName: VERKTYG }, select: { id: true } })
      .then((r) => new Set(r.map((x) => x.id)))
  const vantaPaSpar = async (org: string, kanda: Set<string>) => {
    const slut = Date.now() + SPAR_DEADLINE_MS
    for (;;) {
      const r = await prisma.aiToolExecution.findMany({
        where: { organizationId: org, toolName: VERKTYG },
        select: { id: true, success: true, effects: { select: { entityType: true } } },
      })
      const ny = r.find((x) => !kanda.has(x.id))
      if (ny || Date.now() > slut) return ny ?? null
      await new Promise((res) => setTimeout(res, 100))
    }
  }

  const kor = async (
    org: Org,
    roll: string,
    anvandare: string,
    input: Record<string, unknown> = {},
  ) => {
    const kanda = await spar(org.id)
    let resultat: { success: boolean; message?: string } | null = null
    let kast: unknown = null
    try {
      resultat = (await executor().executeTool(
        VERKTYG,
        input,
        org.id,
        { kind: 'USER', id: anvandare },
        roll,
        { actionProof: { claimed: true } },
      )) as { success: boolean; message?: string }
    } catch (e) {
      kast = e
    }
    const sparRad = await vantaPaSpar(org.id, kanda)
    return { resultat, kast, sparRad }
  }

  async function byggOrg(
    tag: string,
    bankgiro: string | null,
    antalForfallna: number,
  ): Promise<Org> {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `t2a1-${tag}-${sfx}`,
        email: `t2a1-${tag}-${sfx}@example.invalid`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
        bankgiro,
      },
      select: { id: true },
    })
    const agare = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `t2a1-${tag}-agare-${sfx}@example.invalid`,
        passwordHash: 'x',
        firstName: 'A',
        lastName: tag,
        role: 'OWNER',
      },
      select: { id: true },
    })
    const betraktare = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `t2a1-${tag}-viewer-${sfx}@example.invalid`,
        passwordHash: 'x',
        firstName: 'V',
        lastName: tag,
        role: 'VIEWER',
      },
      select: { id: true },
    })
    const hyresgastEpost = `t2a1-${tag}-hg-${sfx}@example.invalid`
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: org.id,
        type: 'INDIVIDUAL',
        firstName: 'Hyres',
        lastName: tag,
        email: hyresgastEpost,
      },
      select: { id: true },
    })
    const fakturor: string[] = []
    for (let i = 0; i < antalForfallna; i++) {
      const f = await prisma.invoice.create({
        data: {
          organizationId: org.id,
          tenantId: tenant.id,
          invoiceNumber: `T2A1-${tag}-${sfx}-${i}`,
          type: 'RENT',
          status: 'OVERDUE',
          subtotal: 1000,
          vatTotal: 0,
          total: 1000,
          dueDate: new Date('2026-08-01T00:00:00Z'),
          issueDate: new Date('2026-07-01T00:00:00Z'),
        },
        select: { id: true },
      })
      fakturor.push(f.id)
    }
    return { id: org.id, agare: agare.id, betraktare: betraktare.id, hyresgastEpost, fakturor }
  }

  beforeAll(async () => {
    prisma = new PrismaService()
    audit = new AiAuditService(prisma)
    a = await byggOrg('a', null, 2)
    b = await byggOrg('b', GILTIGT, 1)
  }, 60_000)

  beforeEach(() => {
    mejl.length = 0
  })

  afterAll(async () => {
    if (!prisma) return
    for (const o of [a, b].filter(Boolean)) {
      await prisma.paymentReminder.deleteMany({ where: { invoice: { organizationId: o.id } } })
      await prisma.invoiceEvent.deleteMany({ where: { invoice: { organizationId: o.id } } })
      await prisma.invoice.deleteMany({ where: { organizationId: o.id } })
      await prisma.tenant.deleteMany({ where: { organizationId: o.id } })
      for (let forsok = 1; ; forsok++) {
        await prisma.aiToolExecution.deleteMany({ where: { organizationId: o.id } })
        try {
          await prisma.user.deleteMany({ where: { organizationId: o.id } })
          await prisma.organization.delete({ where: { id: o.id } })
          break
        } catch (err) {
          if (forsok >= 5) throw err
          await new Promise((res) => setTimeout(res, 200))
        }
      }
    }
    await prisma.$disconnect()
  })

  it.each([
    ['null', null],
    ['blankt', '   '],
  ])(
    'A1 bankgiro %s: sant avslag, 0 PaymentReminder, 0 köade mejl, inga avgifter/verifikat/status/historik',
    async (_n, bankgiro) => {
      await satMal(a.id, bankgiro)
      const fore = await avtryck(a.id)

      const { resultat, kast, sparRad } = await kor(a, 'OWNER', a.agare)

      // EFFEKTERNA FÖRST: jest stannar vid första fallande assertion, och det
      // är effekterna (brev, PaymentReminder, fakturornas tillstånd) som grinden
      // finns för. Faller grinden ska det synas HÄR, inte bara i svarsflaggan.
      expect(mejl).toEqual([])
      expect(await avtryck(a.id)).toEqual(fore)
      // … och avslaget ska vara sant och säga var det rättas.
      expect(kast).toBeNull()
      expect(resultat?.success).toBe(false)
      expect(resultat?.message).toMatch(/^Påminnelserna kan inte skickas: Bankgiro saknas/)
      expect(resultat?.message).toContain('Inställningar → Betalningsinformation')
      // Spåret säger att körningen misslyckades och att den inte orsakade något.
      expect(sparRad?.success).toBe(false)
      expect(sparRad?.effects).toEqual([])
    },
    30_000,
  )

  it('A1 obehörig roll (VIEWER, egen org med giltigt mål) nekas och skriver ingenting', async () => {
    const fore = await avtryck(b.id)
    const { resultat, kast } = await kor(b, 'VIEWER', b.betraktare)
    expect(resultat).toBeNull()
    expect(kast).toBeInstanceOf(ForbiddenException)
    expect(mejl).toEqual([])
    expect(await avtryck(b.id)).toEqual(fore)
  }, 30_000)

  it('A1 annan organisation når inte fakturorna, ens med explicita id:n och eget giltigt mål', async () => {
    await satMal(a.id, null)
    const foreA = await avtryck(a.id)
    const foreB = await avtryck(b.id)
    // B:s ägare namnger A:s fakturor. Verktyget scopar på anropets org (B).
    const { resultat, kast } = await kor(b, 'OWNER', b.agare, { invoiceIds: a.fakturor })
    expect(kast).toBeNull()
    expect(resultat?.success).toBe(true)
    expect(mejl).toEqual([])
    expect(await avtryck(a.id)).toEqual(foreA)
    expect(await avtryck(b.id)).toEqual(foreB)
  }, 30_000)

  it('A1 POSITIV KONTROLL: giltigt bankgiro, egen org, OWNER → brev och PaymentReminder för exakt de förfallna', async () => {
    await satMal(a.id, GILTIGT)
    const fore = await avtryck(a.id)
    const { resultat, kast, sparRad } = await kor(a, 'OWNER', a.agare)

    expect(kast).toBeNull()
    expect(resultat?.success).toBe(true)
    expect(mejl.map((m) => m.to)).toEqual([a.hyresgastEpost, a.hyresgastEpost])
    const rader = await prisma.paymentReminder.findMany({
      where: { invoice: { organizationId: a.id } },
      select: { invoiceId: true, type: true },
    })
    expect(rader.map((r) => r.invoiceId).sort()).toEqual([...a.fakturor].sort())
    expect(rader.every((r) => r.type === 'REMINDER_AI_MANUAL')).toBe(true)
    const efter = await avtryck(a.id)
    expect(efter.paminnelser).toBe(fore.paminnelser + 2)
    // Verktyget tar ingen avgift och bokför inget — samma som före F8.
    expect(efter.rader).toBe(fore.rader)
    expect(efter.verifikat).toBe(fore.verifikat)
    expect(sparRad?.success).toBe(true)
  }, 30_000)
})
