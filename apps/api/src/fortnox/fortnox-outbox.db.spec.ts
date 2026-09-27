/**
 * Fortnox skiva 01 — utkorgen mot RIKTIG PostgreSQL.
 * PROVPLAN A04, A06, A07, A08, A09, A10, A11, A12, A13, A15.
 *
 * ── VARFÖR RIKTIG DATABAS ───────────────────────────────────────────────────
 *
 * En attrapp svarar det den blev tillsagd oavsett `where`, och kan därför inte
 * pröva den för grova riktningen: att två LEGITIMA händelser blir två rader,
 * att en claim bara vinns av en, att fencingen faktiskt avgränsar. Här
 * utvärderar Postgres villkoren på riktigt.
 *
 * ── RIGGEN ÄR SIN EGEN ──────────────────────────────────────────────────────
 *
 * Varje organisation skapas här och städas här (utkorg före org — FK:n är
 * Restrict). Ingenting läses ur omgivningens data. Sista provet städar och
 * kräver noll kvarvarande rader, så en andra körning mot samma DB bygger inte
 * på skräp.
 *
 * ── VAD DET INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Fortnox. Den externa sidan är `MockFortnoxWorld`, som är SYNTETISK och
 * starkare än verkligheten (exakt, omedelbar referenssökning). Gröna prov här
 * bevisar utkorgens lokala beteende — inga externa garantier.
 */

import { randomUUID } from 'crypto'
import { Prisma, PrismaClient } from '@prisma/client'

import type { PrismaService } from '../common/prisma/prisma.service'
import {
  mapBookkeep,
  mapFullCredit,
  mapPaymentAllocation,
  mapRentNoticeToInvoice,
} from './fortnox-mapping'
import {
  FortnoxEnqueueError,
  FortnoxOutboxService,
  FortnoxPayloadConflictError,
  type FortnoxOutboxOptions,
} from './fortnox-outbox.service'
import type {
  FortnoxCreditIntent,
  FortnoxInvoiceIntent,
  FortnoxPaymentIntent,
  FortnoxTrustedContext,
} from './fortnox.types'
import { MockFortnoxProvider, MockFortnoxWorld } from './providers/mock-fortnox.provider'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const SAMTIDIGA = 20
const POOL = SAMTIDIGA + 8
const LEASE_MS = 60_000
const BACKOFF_MS = 1_000

function urlMedPool(bas: string, pool: number): string {
  const u = new URL(bas)
  u.searchParams.set('connection_limit', String(pool))
  return u.toString()
}

function nyKlient(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: urlMedPool(process.env.DATABASE_URL as string, POOL) } },
  })
}

/** Ett löfte som provet själv släpper. */
function spärr(): {
  vänta: Promise<void>
  släpp: () => void
  nådd: Promise<void>
  markeraNådd: () => void
} {
  let släpp!: () => void
  let markeraNådd!: () => void
  const vänta = new Promise<void>((r) => (släpp = r))
  const nådd = new Promise<void>((r) => (markeraNådd = r))
  return { vänta, släpp, nådd, markeraNådd }
}

/**
 * F02: en klient vars FÖRSTA `fortnoxOutboxEntry.findFirst` får sitt svar
 * FÖRDRÖJT — SELECT:en har körts och läst raden, men svaret når arbetaren
 * först när provet släpper det. Det är GRANSKNINGSFYNDETS form (sent
 * SELECT-svar / pausad process mellan läsning och claim): claimens tidpunkt
 * och villkor byggs först EFTER fördröjningen, av en arbetare som tror på en
 * gammal räknare. Alla andra anrop går rakt igenom till den riktiga klienten.
 *
 * Första versionen höll i stället själva claim-anropet. Den var grön även på
 * den felaktiga koden (CI 36342500874): claimens `nu` var då redan beräknat
 * före fördröjningen, så `nextAttemptAt <= nu` stoppade den gamla arbetaren av
 * ett annat skäl än räknaren. En sond som inte kan falla mäter ingenting.
 */
function medFördröjdLäsning(klient: PrismaClient, s: ReturnType<typeof spärr>): PrismaClient {
  let första = true
  const delegat = klient.fortnoxOutboxEntry
  const hållen = new Proxy(delegat, {
    get(mål, namn) {
      if (namn === 'findFirst' && första) {
        const äkta = mål.findFirst as unknown as (a: unknown) => Promise<unknown>
        return async (args: unknown) => {
          första = false
          const svar = await äkta.call(mål, args)
          s.markeraNådd()
          await s.vänta
          return svar
        }
      }
      const v: unknown = Reflect.get(mål, namn)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(mål) : v
    },
  })
  return new Proxy(klient, {
    get(mål, namn) {
      if (namn === 'fortnoxOutboxEntry') return hållen
      const v: unknown = Reflect.get(mål, namn)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(mål) : v
    },
  })
}

medDb('Fortnox-utkorg mot riktig PostgreSQL', () => {
  let prisma: PrismaClient
  const städa: string[] = []
  const klienter: PrismaClient[] = []
  let nuMs = Date.parse('2026-10-01T08:00:00Z')
  const klocka: FortnoxOutboxOptions = {
    now: () => new Date(nuMs),
    random: () => 0,
    leaseMs: LEASE_MS,
    backoffBaseMs: BACKOFF_MS,
  }

  function tjänst(world: MockFortnoxWorld, klient: PrismaClient = prisma): FortnoxOutboxService {
    return new FortnoxOutboxService(
      klient as unknown as PrismaService,
      new MockFortnoxProvider(world),
      klocka,
    )
  }

  async function skapaOrg(namn: string): Promise<string> {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `fortnox-rigg-${namn}-${sfx}`,
        email: `fortnox-rigg-${sfx}@example.se`,
        street: 'Syntetgatan 1',
        city: 'Provstad',
        postalCode: '11111',
      },
      select: { id: true },
    })
    städa.push(org.id)
    return org.id
  }

  function ctx(
    organizationId: string,
    över: Partial<FortnoxTrustedContext> = {},
  ): FortnoxTrustedContext {
    return {
      organizationId,
      connectionId: 'conn-syntetisk-1',
      fortnoxTenantId: 'fnx-foretag-1',
      ...över,
    }
  }

  function faktura(
    c: FortnoxTrustedContext,
    noticeId: string,
    totalOre = 1_000_000,
  ): FortnoxInvoiceIntent {
    const r = mapRentNoticeToInvoice(c, {
      organizationId: c.organizationId,
      noticeId,
      immutableVersion: 1,
      noticeNumber: `A-${noticeId}`,
      customerRef: 'K-100',
      currency: 'SEK',
      totalOre,
      invoiceDate: '2026-10-01',
      dueDate: '2026-10-31',
      bookkeepingDate: '2026-10-01',
      propertyUse: 'RESIDENTIAL',
      lines: [{ component: 'RENT', description: 'Hyra', vatRatePercent: 0, amountOre: totalOre }],
      accountMapping: { receivableAccount: 1510, revenueAccount: 3911 },
    })
    if (!r.ok) throw new Error(r.reason)
    return r.intent
  }

  function betalning(
    c: FortnoxTrustedContext,
    noticeId: string,
    allokering: string,
    amountOre: number,
    confirmedPaidOre = 0,
  ): FortnoxPaymentIntent {
    const r = mapPaymentAllocation(c, {
      organizationId: c.organizationId,
      fortnoxTenantId: c.fortnoxTenantId,
      paymentAllocationId: allokering,
      noticeId,
      immutableVersion: 1,
      currency: 'SEK',
      originalAmountOre: 1_000_000,
      confirmedPaidOre,
      confirmedCreditedOre: 0,
      amountOre,
      paidAt: '2026-10-05',
      bookkeepingDate: '2026-10-05',
    })
    if (!r.ok) throw new Error(r.reason)
    return r.intent
  }

  function kredit(
    c: FortnoxTrustedContext,
    noticeId: string,
    creditId: string,
  ): FortnoxCreditIntent {
    const r = mapFullCredit(c, {
      organizationId: c.organizationId,
      fortnoxTenantId: c.fortnoxTenantId,
      creditId,
      originalNoticeId: noticeId,
      immutableVersion: 1,
      originalReference: `A-${noticeId}`,
      currency: 'SEK',
      originalAmountOre: 1_000_000,
      creditAmountOre: 1_000_000,
      paidOre: 0,
      previousCreditsOre: 0,
      collectionHandover: false,
      badDebt: false,
      propertyUse: 'RESIDENTIAL',
      originalLines: [
        { component: 'RENT', description: 'Hyra', vatRatePercent: 0, amountOre: 1_000_000 },
      ],
      bookkeepingDate: '2026-10-10',
    })
    if (!r.ok) throw new Error(r.reason)
    return r.intent
  }

  /** Köar faktura + bokföring och kör båda till kvittens. Returnerar nycklarna. */
  async function bokfördFaktura(
    svc: FortnoxOutboxService,
    c: FortnoxTrustedContext,
    noticeId: string,
  ): Promise<{ skapa: string; bokför: string; externalId: string }> {
    const f = faktura(c, noticeId)
    const s = await svc.enqueue(c, { operation: 'INVOICE_CREATE', immutableVersion: 1, payload: f })
    const b = await svc.enqueue(c, {
      operation: 'INVOICE_BOOKKEEP',
      immutableVersion: 1,
      payload: mapBookkeep(f),
    })
    expect(await svc.processOne(c, s.entry.eventKey)).toEqual({
      status: 'DONE',
      state: 'ACKNOWLEDGED',
    })
    expect(await svc.processOne(c, b.entry.eventKey)).toEqual({
      status: 'DONE',
      state: 'ACKNOWLEDGED',
    })
    const rad = await svc.findScoped(c, b.entry.eventKey)
    return { skapa: s.entry.eventKey, bokför: b.entry.eventKey, externalId: rad!.externalId! }
  }

  beforeAll(async () => {
    prisma = nyKlient()
    await prisma.$connect()
  })

  afterAll(async () => {
    // Säkerhetsnät om ett prov kastade före städprovet. Städprovet nedan är det
    // som MÄTER städningen.
    if (städa.length > 0) {
      await prisma.fortnoxOutboxEntry.deleteMany({ where: { organizationId: { in: städa } } })
      await prisma.organization.deleteMany({ where: { id: { in: städa } } })
    }
    for (const k of klienter) await k.$disconnect()
    await prisma.$disconnect()
  })

  describe('A13 · migrationen och riggens förutsättningar', () => {
    it('tabellen finns, dubblettskyddet är (organizationId, eventKey) och externalId är inte unikt', async () => {
      const index = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>(
        Prisma.sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'FortnoxOutboxEntry'`,
      )
      const unika = index.filter((i) => /CREATE UNIQUE INDEX/.test(i.indexdef))
      expect(unika.map((i) => i.indexname).sort()).toEqual([
        'FortnoxOutboxEntry_organizationId_eventKey_key',
        'FortnoxOutboxEntry_pkey',
      ])
      expect(unika.some((i) => i.indexdef.includes('"externalId"'))).toBe(false)
    })

    it('FK mot Organization är RESTRICT, och org med utkorgsrad går inte att radera', async () => {
      const fk = await prisma.$queryRaw<{ confdeltype: string }[]>(
        Prisma.sql`SELECT confdeltype FROM pg_constraint WHERE conname = 'FortnoxOutboxEntry_organizationId_fkey'`,
      )
      expect(fk).toEqual([{ confdeltype: 'r' }])

      const org = await skapaOrg('restrict')
      const c = ctx(org)
      await tjänst(new MockFortnoxWorld()).enqueue(c, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: faktura(c, 'avi-restrict'),
      })
      await expect(prisma.organization.delete({ where: { id: org } })).rejects.toMatchObject({
        code: 'P2003',
      })
    })
  })

  describe('A04 · lika belopp är inte samma händelse; samma händelse är en rad', () => {
    it('två 400 000-allokeringar samma dag → två rader; samma igen → en; ändrad payload → konflikt', async () => {
      const org = await skapaOrg('a04')
      const c = ctx(org)
      const svc = tjänst(new MockFortnoxWorld())
      const f = faktura(c, 'avi-a04')
      await svc.enqueue(c, { operation: 'INVOICE_CREATE', immutableVersion: 1, payload: f })
      await svc.enqueue(c, {
        operation: 'INVOICE_BOOKKEEP',
        immutableVersion: 1,
        payload: mapBookkeep(f),
      })

      const a = await svc.enqueue(c, {
        operation: 'PAYMENT_CREATE',
        immutableVersion: 1,
        payload: betalning(c, 'avi-a04', 'alloc-a', 400_000),
      })
      const b = await svc.enqueue(c, {
        operation: 'PAYMENT_CREATE',
        immutableVersion: 1,
        payload: betalning(c, 'avi-a04', 'alloc-b', 400_000),
      })
      expect([a.status, b.status]).toEqual(['CREATED', 'CREATED'])
      expect(a.entry.eventKey).not.toBe(b.entry.eventKey)

      const igen = await svc.enqueue(c, {
        operation: 'PAYMENT_CREATE',
        immutableVersion: 1,
        payload: betalning(c, 'avi-a04', 'alloc-a', 400_000),
      })
      expect(igen.status).toBe('EXISTING')
      expect(igen.entry.id).toBe(a.entry.id)

      await expect(
        svc.enqueue(c, {
          operation: 'PAYMENT_CREATE',
          immutableVersion: 1,
          payload: betalning(c, 'avi-a04', 'alloc-a', 400_001),
        }),
      ).rejects.toBeInstanceOf(FortnoxPayloadConflictError)

      const rader = await prisma.fortnoxOutboxEntry.findMany({
        where: { organizationId: org, operation: 'PAYMENT_CREATE' },
      })
      expect(rader).toHaveLength(2)
      expect(rader.find((r) => r.id === a.entry.id)!.payloadHash).toBe(a.entry.payloadHash)
    })
  })

  describe('A06 · samtidig köning', () => {
    it(`${SAMTIDIGA} samtidiga enqueue av samma händelse → exakt en rad`, async () => {
      const org = await skapaOrg('a06')
      const annanOrg = await skapaOrg('a06b')
      const c = ctx(org)
      const svc = tjänst(new MockFortnoxWorld())
      const f = faktura(c, 'avi-a06')

      const svar = await Promise.all(
        Array.from({ length: SAMTIDIGA }, () =>
          svc.enqueue(c, { operation: 'INVOICE_CREATE', immutableVersion: 1, payload: f }),
        ),
      )
      expect(svar.filter((s) => s.status === 'CREATED')).toHaveLength(1)
      expect(svar.filter((s) => s.status === 'EXISTING')).toHaveLength(SAMTIDIGA - 1)
      expect(new Set(svar.map((s) => s.entry.id)).size).toBe(1)

      await svc.enqueue(c, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: faktura(c, 'avi-a06-annan'),
      })
      const c2 = ctx(annanOrg)
      await svc.enqueue(c2, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: faktura(c2, 'avi-a06'),
      })

      expect(await prisma.fortnoxOutboxEntry.count({ where: { organizationId: org } })).toBe(2)
      expect(await prisma.fortnoxOutboxEntry.count({ where: { organizationId: annanOrg } })).toBe(1)
    })
  })

  describe('A07 · claim, fencing och avgränsning', () => {
    it('två samtidiga processOne → ett send', async () => {
      const org = await skapaOrg('a07a')
      const c = ctx(org)
      const world = new MockFortnoxWorld()
      const svc = tjänst(world)
      const { entry } = await svc.enqueue(c, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: faktura(c, 'avi-a07a'),
      })
      const s = spärr()
      world.beforeSend = async () => {
        s.markeraNådd()
        await s.vänta
      }
      const p1 = svc.processOne(c, entry.eventKey)
      await s.nådd
      const p2 = await tjänst(world).processOne(c, entry.eventKey)
      s.släpp()
      expect(p2).toEqual({ status: 'NOT_CLAIMABLE' })
      expect(await p1).toEqual({ status: 'DONE', state: 'ACKNOWLEDGED' })
      expect(world.sendCount(entry.eventKey)).toBe(1)
    })

    it('ett sent svar efter utgången lease skriver ingenting (STALE)', async () => {
      const org = await skapaOrg('a07b')
      const c = ctx(org)
      const world = new MockFortnoxWorld()
      const svc = tjänst(world)
      const { entry } = await svc.enqueue(c, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: faktura(c, 'avi-a07b'),
      })
      const s = spärr()
      world.beforeReturn = async () => {
        s.markeraNådd()
        await s.vänta
      }
      const gammal = svc.processOne(c, entry.eventKey)
      await s.nådd
      nuMs += LEASE_MS + 1
      expect(await tjänst(world).recoverExpiredLeases(c)).toBe(1)
      s.släpp()
      expect(await gammal).toEqual({ status: 'STALE' })

      const rad = await svc.findScoped(c, entry.eventKey)
      expect(rad).toMatchObject({
        state: 'UNKNOWN',
        lastErrorClass: 'LEASE_EXPIRED',
        externalId: null,
      })
      expect(world.effectCount(entry.eventKey)).toBe(1)
    })

    it('fel organisation, anslutning eller företag ser inte raden och kan inte röra den', async () => {
      const org = await skapaOrg('a07c')
      const annanOrg = await skapaOrg('a07c2')
      const c = ctx(org)
      const world = new MockFortnoxWorld()
      const svc = tjänst(world)
      const { entry } = await svc.enqueue(c, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: faktura(c, 'avi-a07c'),
      })
      for (const fel of [
        ctx(annanOrg),
        ctx(org, { connectionId: 'conn-annan' }),
        ctx(org, { fortnoxTenantId: 'fnx-annat' }),
      ]) {
        expect(await svc.findScoped(fel, entry.eventKey)).toBeNull()
        expect(await svc.processOne(fel, entry.eventKey)).toEqual({ status: 'NOT_FOUND' })
        expect(await svc.reconcileUnknown(fel, entry.eventKey)).toEqual({ status: 'NOT_FOUND' })
        expect(await svc.recoverExpiredLeases(fel)).toBe(0)
      }
      expect(world.sendCount()).toBe(0)
      expect((await svc.findScoped(c, entry.eventKey))!.state).toBe('READY')
    })
  })

  describe('A08 · timeout efter extern effekt, återläsning i NY instans', () => {
    it('UNKNOWN → ny klient + ny tjänst → exakt match → ACKNOWLEDGED, send fortfarande 1', async () => {
      const org = await skapaOrg('a08')
      const c = ctx(org)
      const world = new MockFortnoxWorld()
      const svc = tjänst(world)
      const { entry } = await svc.enqueue(c, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: faktura(c, 'avi-a08'),
      })
      world.sendScript.push('EFFECT_THEN_UNKNOWN')
      expect(await svc.processOne(c, entry.eventKey)).toEqual({ status: 'DONE', state: 'UNKNOWN' })
      expect(world.effectCount(entry.eventKey)).toBe(1)

      // "Omstart": ny anslutning, ny tjänst, ny provider. Bara DB:n och den
      // externa världen överlever.
      const ny = nyKlient()
      klienter.push(ny)
      await ny.$connect()
      const efter = tjänst(world, ny)
      expect(await efter.processOne(c, entry.eventKey)).toEqual({ status: 'NOT_CLAIMABLE' })
      expect(await efter.reconcileUnknown(c, entry.eventKey)).toEqual({
        status: 'DONE',
        state: 'ACKNOWLEDGED',
        errorClass: null,
      })
      const rad = await efter.findScoped(c, entry.eventKey)
      expect(rad!.externalId).toBe(world.effects[0]!.externalId)
      expect(rad!.bookedConfirmed).toBe(false)
      expect(world.sendCount(entry.eventKey)).toBe(1)
    })
  })

  describe('A09 · okänt utfall utan säker match sänds aldrig om', () => {
    it.each([
      ['NOT_FOUND', 'UNKNOWN', 'LOOKUP_NOT_FOUND'],
      ['UNAVAILABLE', 'UNKNOWN', 'LOOKUP_UNAVAILABLE'],
      ['AMBIGUOUS', 'MANUAL_REVIEW', 'LOOKUP_AMBIGUOUS'],
      ['MISMATCH_AMOUNT', 'MANUAL_REVIEW', 'LOOKUP_MISMATCH'],
      ['MISMATCH_REFERENCE', 'MANUAL_REVIEW', 'LOOKUP_MISMATCH'],
      ['UNSUPPORTED', 'MANUAL_REVIEW', 'LOOKUP_UNSUPPORTED'],
    ] as const)('lookup %s → %s (%s), send förblir 1', async (läge, tillstånd, klass) => {
      const org = await skapaOrg(`a09-${läge}`)
      const c = ctx(org)
      const world = new MockFortnoxWorld()
      const svc = tjänst(world)
      const { entry } = await svc.enqueue(c, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: faktura(c, `avi-a09-${läge}`),
      })
      world.sendScript.push('EFFECT_THEN_UNKNOWN')
      await svc.processOne(c, entry.eventKey)
      world.lookupMode = läge
      expect(await svc.reconcileUnknown(c, entry.eventKey)).toEqual({
        status: 'DONE',
        state: tillstånd,
        errorClass: klass,
      })
      nuMs += 24 * 3600_000
      expect(await svc.processOne(c, entry.eventKey)).toEqual({ status: 'NOT_CLAIMABLE' })
      expect(world.sendCount(entry.eventKey)).toBe(1)
      expect((await svc.findScoped(c, entry.eventKey))!.externalId).toBeNull()
    })

    it('betalning kan inte återläsas säkert per allokering → MANUAL_REVIEW, ingen omsändning', async () => {
      const org = await skapaOrg('a09-bet')
      const c = ctx(org)
      const world = new MockFortnoxWorld()
      const svc = tjänst(world)
      await bokfördFaktura(svc, c, 'avi-a09-bet')
      const { entry } = await svc.enqueue(c, {
        operation: 'PAYMENT_CREATE',
        immutableVersion: 1,
        payload: betalning(c, 'avi-a09-bet', 'alloc-1', 400_000),
      })
      world.sendScript.push('EFFECT_THEN_UNKNOWN')
      await svc.processOne(c, entry.eventKey)
      expect(await svc.reconcileUnknown(c, entry.eventKey)).toMatchObject({
        state: 'MANUAL_REVIEW',
        errorClass: 'LOOKUP_UNSUPPORTED',
      })
      expect(world.sendCount(entry.eventKey)).toBe(1)
    })
  })

  describe('A10 · processavbrott — återhämtning från DB, ingen blind omsändning', () => {
    it('(a) död efter claim, före nätverket → UNKNOWN, noll send', async () => {
      const org = await skapaOrg('a10a')
      const c = ctx(org)
      const world = new MockFortnoxWorld()
      const { entry } = await tjänst(world).enqueue(c, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: faktura(c, 'avi-a10a'),
      })
      const s = spärr()
      world.beforeSend = async () => {
        s.markeraNådd()
        await s.vänta
      }
      const zombie = tjänst(world).processOne(c, entry.eventKey)
      await s.nådd
      world.beforeSend = null

      nuMs += LEASE_MS + 1
      const ny = nyKlient()
      klienter.push(ny)
      await ny.$connect()
      const efter = tjänst(world, ny)
      expect(await efter.recoverExpiredLeases(c)).toBe(1)
      expect(world.sendCount(entry.eventKey)).toBe(0)
      expect(await efter.processOne(c, entry.eventKey)).toEqual({ status: 'NOT_CLAIMABLE' })
      expect((await efter.findScoped(c, entry.eventKey))!.state).toBe('UNKNOWN')

      // Zombien vaknar: dess svar får inte skriva över UNKNOWN.
      s.släpp()
      expect(await zombie).toEqual({ status: 'STALE' })
      expect((await efter.findScoped(c, entry.eventKey))!.state).toBe('UNKNOWN')
    })

    it('(b) död efter extern framgång, före lokal kvittens → UNKNOWN → återläsning → ACK, send 1', async () => {
      const org = await skapaOrg('a10b')
      const c = ctx(org)
      const world = new MockFortnoxWorld()
      const { entry } = await tjänst(world).enqueue(c, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: faktura(c, 'avi-a10b'),
      })
      const s = spärr()
      world.beforeReturn = async () => {
        s.markeraNådd()
        await s.vänta
      }
      const zombie = tjänst(world).processOne(c, entry.eventKey)
      await s.nådd
      world.beforeReturn = null
      expect(world.effectCount(entry.eventKey)).toBe(1)

      nuMs += LEASE_MS + 1
      const ny = nyKlient()
      klienter.push(ny)
      await ny.$connect()
      const efter = tjänst(world, ny)
      expect(await efter.recoverExpiredLeases(c)).toBe(1)
      expect(await efter.processOne(c, entry.eventKey)).toEqual({ status: 'NOT_CLAIMABLE' })
      expect(await efter.reconcileUnknown(c, entry.eventKey)).toMatchObject({
        state: 'ACKNOWLEDGED',
      })

      s.släpp()
      expect(await zombie).toEqual({ status: 'STALE' })
      const rad = await efter.findScoped(c, entry.eventKey)
      expect(rad).toMatchObject({ state: 'ACKNOWLEDGED', externalId: world.effects[0]!.externalId })
      expect(world.sendCount(entry.eventKey)).toBe(1)
    })
  })

  describe('A11 · felklassning och tidsstyrt återförsök', () => {
    it('SAFE_TO_RETRY väntar sin tid och ger upp efter 5 försök → MANUAL_REVIEW', async () => {
      const org = await skapaOrg('a11')
      const c = ctx(org)
      const world = new MockFortnoxWorld()
      const svc = tjänst(world)
      const { entry } = await svc.enqueue(c, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: faktura(c, 'avi-a11'),
      })
      world.sendScript.push(
        'SAFE_TO_RETRY',
        'SAFE_TO_RETRY',
        'SAFE_TO_RETRY',
        'SAFE_TO_RETRY',
        'SAFE_TO_RETRY',
      )
      for (let försök = 1; försök <= 4; försök++) {
        expect(await svc.processOne(c, entry.eventKey)).toEqual({
          status: 'DONE',
          state: 'RETRY_WAIT',
        })
        expect(await svc.processOne(c, entry.eventKey)).toEqual({ status: 'NOT_CLAIMABLE' })
        const rad = await svc.findScoped(c, entry.eventKey)
        expect(rad!.nextAttemptAt.getTime()).toBe(nuMs + BACKOFF_MS * 2 ** (försök - 1))
        nuMs = rad!.nextAttemptAt.getTime()
      }
      expect(await svc.processOne(c, entry.eventKey)).toEqual({
        status: 'DONE',
        state: 'MANUAL_REVIEW',
      })
      const rad = await svc.findScoped(c, entry.eventKey)
      expect(rad).toMatchObject({ attempts: 5, lastErrorClass: 'RETRY_EXHAUSTED' })
      nuMs += 24 * 3600_000
      expect(await svc.processOne(c, entry.eventKey)).toEqual({ status: 'NOT_CLAIMABLE' })
      expect(world.sendCount(entry.eventKey)).toBe(5)
    })

    // F02 (GRANSKNINGSFYND-00b7d307). Provet ovan kör sekventiellt och kan inte
    // se en arbetare vars läsning blivit gammal över en ANNAN arbetares
    // retry-cykel. Här hålls A mellan läsning (attempts = 3) och claim, medan
    // B tar försök 4 och hela dess väntetid löper ut. Mätt: faktiska
    // adapteranrop och lagrat slutläge/räknare — inte bara A:s svar.
    it('F02: en gammal läsning kan inte ta ett försök bortom taket (A07/A11)', async () => {
      const org = await skapaOrg('f02')
      const c = ctx(org)
      const world = new MockFortnoxWorld()
      const svc = tjänst(world)
      const { entry } = await svc.enqueue(c, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: faktura(c, 'avi-f02'),
      })
      const nyckel = entry.eventKey
      world.sendScript.push(...Array.from({ length: 10 }, () => 'SAFE_TO_RETRY' as const))

      for (let försök = 1; försök <= 3; försök++) {
        expect(await svc.processOne(c, nyckel)).toEqual({ status: 'DONE', state: 'RETRY_WAIT' })
        nuMs = (await svc.findScoped(c, nyckel))!.nextAttemptAt.getTime()
      }
      expect((await svc.findScoped(c, nyckel))!.attempts).toBe(3)

      const s = spärr()
      const gammalA = tjänst(world, medFördröjdLäsning(prisma, s)).processOne(c, nyckel)
      await s.nådd // A har läst attempts = 3; svaret är ännu inte levererat

      expect(await svc.processOne(c, nyckel)).toEqual({ status: 'DONE', state: 'RETRY_WAIT' })
      nuMs = (await svc.findScoped(c, nyckel))!.nextAttemptAt.getTime()
      expect((await svc.findScoped(c, nyckel))!.attempts).toBe(4)

      s.släpp()
      const utfallA = await gammalA

      // Dränera som en vanlig arbetare: låt varje väntetid löpa ut och ta allt
      // som går att ta. Så syns ett eventuellt SJÄTTE adapteranrop i räknaren.
      for (let varv = 0; varv < 10; varv++) {
        const rad = await svc.findScoped(c, nyckel)
        if (rad!.state === 'RETRY_WAIT') nuMs = Math.max(nuMs, rad!.nextAttemptAt.getTime())
        const r = await svc.processOne(c, nyckel)
        if (r.status !== 'DONE') break
      }

      expect(world.sendCount(nyckel)).toBe(5)
      expect(await svc.findScoped(c, nyckel)).toMatchObject({
        state: 'MANUAL_REVIEW',
        attempts: 5,
        lastErrorClass: 'RETRY_EXHAUSTED',
      })
      expect(utfallA).toEqual({ status: 'NOT_CLAIMABLE' })
    })

    it.each([
      ['AUTH', 'AUTH_REQUIRED', 'AUTH'],
      ['REJECTED', 'REJECTED', 'REJECTED'],
      ['UNKNOWN_NO_EFFECT', 'UNKNOWN', 'UNKNOWN'],
      ['EFFECT_THEN_THROW', 'UNKNOWN', 'PROVIDER_THREW'],
    ] as const)('%s → %s, ingen automatisk loop', async (scenario, tillstånd, klass) => {
      const org = await skapaOrg(`a11-${scenario}`)
      const c = ctx(org)
      const world = new MockFortnoxWorld()
      const svc = tjänst(world)
      const { entry } = await svc.enqueue(c, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: faktura(c, `avi-a11-${scenario}`),
      })
      world.sendScript.push(scenario)
      expect(await svc.processOne(c, entry.eventKey)).toEqual({ status: 'DONE', state: tillstånd })
      const rad = await svc.findScoped(c, entry.eventKey)
      // Felklassen är en fast vokabulär — adapterns fritext lagras aldrig.
      expect(rad!.lastErrorClass).toBe(klass)
      nuMs += 24 * 3600_000
      expect(await svc.processOne(c, entry.eventKey)).toEqual({ status: 'NOT_CLAIMABLE' })
      expect(world.sendCount(entry.eventKey)).toBe(1)
    })
  })

  describe('A12 · skapad är inte bokförd; beroenden gäller', () => {
    it('bokföring väntar på skapande; betalning och kredit väntar på originalets bokföring', async () => {
      const org = await skapaOrg('a12')
      const c = ctx(org)
      const world = new MockFortnoxWorld()
      const svc = tjänst(world)
      const f = faktura(c, 'avi-a12')
      const skapa = await svc.enqueue(c, {
        operation: 'INVOICE_CREATE',
        immutableVersion: 1,
        payload: f,
      })
      const bokför = await svc.enqueue(c, {
        operation: 'INVOICE_BOOKKEEP',
        immutableVersion: 1,
        payload: mapBookkeep(f),
      })
      expect(skapa.entry.eventKey).not.toBe(bokför.entry.eventKey)
      expect(bokför.entry.dependsOnEventKey).toBe(skapa.entry.eventKey)

      expect(await svc.processOne(c, bokför.entry.eventKey)).toEqual({
        status: 'BLOCKED',
        reason: 'PREDECESSOR_NOT_ACKNOWLEDGED',
      })
      expect(world.sendCount()).toBe(0)

      await svc.processOne(c, skapa.entry.eventKey)
      const efterSkapa = await svc.findScoped(c, skapa.entry.eventKey)
      expect(efterSkapa).toMatchObject({ state: 'ACKNOWLEDGED', bookedConfirmed: false })

      const bet = await svc.enqueue(c, {
        operation: 'PAYMENT_CREATE',
        immutableVersion: 1,
        payload: betalning(c, 'avi-a12', 'alloc-1', 400_000),
      })
      const kre = await svc.enqueue(c, {
        operation: 'CREDIT_CREATE',
        immutableVersion: 1,
        payload: kredit(c, 'avi-a12', 'kredit-1'),
      })
      expect(bet.entry.dependsOnEventKey).toBe(bokför.entry.eventKey)
      expect(kre.entry.dependsOnEventKey).toBe(bokför.entry.eventKey)
      // Create-kvittensen uppfyller inte bokföringskravet.
      expect(await svc.processOne(c, bet.entry.eventKey)).toMatchObject({ status: 'BLOCKED' })
      expect(await svc.processOne(c, kre.entry.eventKey)).toMatchObject({ status: 'BLOCKED' })

      expect(await svc.processOne(c, bokför.entry.eventKey)).toEqual({
        status: 'DONE',
        state: 'ACKNOWLEDGED',
      })
      const efterBokför = await svc.findScoped(c, bokför.entry.eventKey)
      // Samma externa objekt för skapande och bokföring.
      expect(efterBokför).toMatchObject({
        bookedConfirmed: true,
        externalId: efterSkapa!.externalId,
      })

      expect(await svc.processOne(c, bet.entry.eventKey)).toEqual({
        status: 'DONE',
        state: 'ACKNOWLEDGED',
      })
    })

    it.each(['ACK_UNBOOKED', 'ACK_WRONG_OBJECT'] as const)(
      'bokföringskvittens %s räknas aldrig som bokförd → MANUAL_REVIEW',
      async (scenario) => {
        const org = await skapaOrg(`a12-${scenario}`)
        const c = ctx(org)
        const world = new MockFortnoxWorld()
        const svc = tjänst(world)
        const f = faktura(c, `avi-a12-${scenario}`)
        const skapa = await svc.enqueue(c, {
          operation: 'INVOICE_CREATE',
          immutableVersion: 1,
          payload: f,
        })
        const bokför = await svc.enqueue(c, {
          operation: 'INVOICE_BOOKKEEP',
          immutableVersion: 1,
          payload: mapBookkeep(f),
        })
        await svc.processOne(c, skapa.entry.eventKey)
        world.sendScript.push(scenario)
        expect(await svc.processOne(c, bokför.entry.eventKey)).toEqual({
          status: 'DONE',
          state: 'MANUAL_REVIEW',
        })
        expect(await svc.findScoped(c, bokför.entry.eventKey)).toMatchObject({
          bookedConfirmed: false,
          lastErrorClass: 'BOOKKEEP_UNVERIFIED',
        })
      },
    )

    it('saknad föregångare, annat företag, fel belopp eller fel avsiktsform nekas vid köning', async () => {
      const org = await skapaOrg('a12-neka')
      const c = ctx(org)
      const svc = tjänst(new MockFortnoxWorld())
      const f = faktura(c, 'avi-a12-neka')

      await expect(
        svc.enqueue(c, {
          operation: 'INVOICE_BOOKKEEP',
          immutableVersion: 1,
          payload: mapBookkeep(f),
        }),
      ).rejects.toBeInstanceOf(FortnoxEnqueueError)
      await expect(
        svc.enqueue(c, {
          operation: 'PAYMENT_CREATE',
          immutableVersion: 1,
          payload: betalning(c, 'avi-a12-neka', 'alloc-1', 400_000),
        }),
      ).rejects.toBeInstanceOf(FortnoxEnqueueError)

      await svc.enqueue(c, { operation: 'INVOICE_CREATE', immutableVersion: 1, payload: f })
      const annat = ctx(org, { fortnoxTenantId: 'fnx-annat' })
      await expect(
        svc.enqueue(annat, {
          operation: 'INVOICE_BOOKKEEP',
          immutableVersion: 1,
          payload: mapBookkeep(f),
        }),
      ).rejects.toBeInstanceOf(FortnoxEnqueueError)
      await expect(
        svc.enqueue(c, {
          operation: 'INVOICE_BOOKKEEP',
          immutableVersion: 1,
          payload: { ...mapBookkeep(f), amountOre: 999_999 },
        }),
      ).rejects.toBeInstanceOf(FortnoxEnqueueError)
      await expect(
        svc.enqueue(c, {
          operation: 'INVOICE_CREATE',
          immutableVersion: 1,
          payload: betalning(c, 'avi-a12-neka', 'alloc-1', 400_000),
        }),
      ).rejects.toBeInstanceOf(FortnoxEnqueueError)
      expect(await prisma.fortnoxOutboxEntry.count({ where: { organizationId: org } })).toBe(1)
    })
  })

  describe('A15 · samma händelse får aldrig en andra extern effekt', () => {
    it('version 2 avvisas av utkorgen även utan mapping', async () => {
      const org = await skapaOrg('a15-v2')
      const c = ctx(org)
      const svc = tjänst(new MockFortnoxWorld())
      await expect(
        svc.enqueue(c, {
          operation: 'INVOICE_CREATE',
          immutableVersion: 2,
          payload: faktura(c, 'avi-a15-v2'),
        }),
      ).rejects.toBeInstanceOf(FortnoxEnqueueError)
      expect(await prisma.fortnoxOutboxEntry.count({ where: { organizationId: org } })).toBe(0)
    })

    it.each(['ACKNOWLEDGED', 'UNKNOWN'] as const)(
      'ändrad payload för samma källa/operation i läge %s → konflikt, inget nytt send',
      async (läge) => {
        const org = await skapaOrg(`a15-${läge}`)
        const c = ctx(org)
        const world = new MockFortnoxWorld()
        const svc = tjänst(world)
        const { entry } = await svc.enqueue(c, {
          operation: 'INVOICE_CREATE',
          immutableVersion: 1,
          payload: faktura(c, `avi-a15-${läge}`),
        })
        if (läge === 'UNKNOWN') world.sendScript.push('EFFECT_THEN_UNKNOWN')
        expect(await svc.processOne(c, entry.eventKey)).toEqual({ status: 'DONE', state: läge })

        await expect(
          svc.enqueue(c, {
            operation: 'INVOICE_CREATE',
            immutableVersion: 1,
            payload: faktura(c, `avi-a15-${läge}`, 1_000_100),
          }),
        ).rejects.toBeInstanceOf(FortnoxPayloadConflictError)
        const rad = await svc.findScoped(c, entry.eventKey)
        expect(rad).toMatchObject({ state: läge, payloadHash: entry.payloadHash, attempts: 1 })
        expect(world.sendCount()).toBe(1)
        expect(await prisma.fortnoxOutboxEntry.count({ where: { organizationId: org } })).toBe(1)
      },
    )
  })

  describe('A13 · städning', () => {
    it('riggen lämnar noll egna rader efter sig', async () => {
      await prisma.fortnoxOutboxEntry.deleteMany({ where: { organizationId: { in: städa } } })
      await prisma.organization.deleteMany({ where: { id: { in: städa } } })
      expect(
        await prisma.fortnoxOutboxEntry.count({ where: { organizationId: { in: städa } } }),
      ).toBe(0)
      expect(await prisma.organization.count({ where: { id: { in: städa } } })).toBe(0)
      städa.length = 0
    })
  })
})
