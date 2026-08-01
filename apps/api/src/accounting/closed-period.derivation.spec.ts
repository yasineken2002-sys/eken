/**
 * T5 PR1b — HÄRLEDNINGEN: "är bokföringsperioden stängd?"
 *
 * Den här filen vaktar EN fråga, och den är granskningsfrågan för hela PR1b:
 * betyder den nya uppslagningen exakt samma sak som den gamla?
 *
 * Gamla: `ClosedAccountingPeriod.findUnique(org, år, månad) !== null`.
 * Nya:   händelsen med högst `seq` för (org, år, månad) har type = CLOSED.
 *
 * Uppslagningen sitter framför `VerifikationsnummerService.allocate`, som är den
 * enda punkt i kodbasen som faktiskt hindrar ett verifikat från att skrivas. Blir
 * härledningen fel åt det tillåtande hållet finns ingen andra spärr som räddar —
 * verifikatet landar i en stängd period utan att något säger ifrån. Testerna
 * nedan är därför skrivna kring de fyra sätt det kan gå fel på.
 *
 * Attrappen implementerar `where` och `orderBy` GENERISKT (inte hårdkodat till
 * det svaret vi hoppas på), så att en produktionskod som lägger till ett typfilter
 * eller sorterar på fel kolumn ger ett ANNAT svar och fäller testet.
 */

import { ConflictException } from '@nestjs/common'
import {
  appendPeriodClosedEvent,
  assertPeriodOpen,
  getClosedPeriodStates,
  getClosedPeriods,
  isPeriodClosed,
  periodKeyOf,
} from './closed-period'

interface FakeEvent {
  organizationId: string
  year: number
  month: number
  seq: number
  type: 'CLOSED' | 'REOPENED'
  createdAt: Date
}

/**
 * Attrapp som beter sig som tabellen: generisk where-matchning + generisk
 * orderBy. `$queryRaw` speglar DISTINCT ON ("year","month") ... ORDER BY seq DESC.
 * (Att den RIKTIGA SQL:en har samma semantik verifieras separat mot Postgres —
 * se rapporten; attrappen bevisar att KODEN runt omkring drar rätt slutsats.)
 */
function makeDb(events: FakeEvent[]) {
  return {
    accountingPeriodEvent: {
      findFirst: jest.fn(
        (args: { where: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'> }) => {
          const matches = events.filter((e) =>
            Object.entries(args.where).every(
              ([k, v]) => (e as unknown as Record<string, unknown>)[k] === v,
            ),
          )
          const [key, dir] = Object.entries(args.orderBy ?? {})[0] ?? ['seq', 'desc']
          const sorted = [...matches].sort((a, b) => {
            const av = (a as unknown as Record<string, unknown>)[key]
            const bv = (b as unknown as Record<string, unknown>)[key]
            const cmp = av instanceof Date && bv instanceof Date ? av.getTime() - bv.getTime() : 0
            const num =
              typeof av === 'number' && typeof bv === 'number'
                ? (av as number) - (bv as number)
                : cmp
            return dir === 'desc' ? -num : num
          })
          return Promise.resolve(sorted[0] ?? null)
        },
      ),
    },
    $queryRaw: jest.fn((strings: TemplateStringsArray, organizationId: string) => {
      void strings
      const latestPerPeriod = new Map<string, FakeEvent>()
      for (const e of events.filter((x) => x.organizationId === organizationId)) {
        const key = `${e.year}-${e.month}`
        const cur = latestPerPeriod.get(key)
        if (!cur || e.seq > cur.seq) latestPerPeriod.set(key, e)
      }
      return Promise.resolve(
        [...latestPerPeriod.values()].map((e) => ({
          year: e.year,
          month: e.month,
          type: e.type,
          createdAt: e.createdAt,
        })),
      )
    }),
  }
}

const ORG = 'org-1'
const IN_PERIOD = new Date('2026-05-15T10:00:00Z') // svensk civil tid: 2026-05

/** Bygger en händelsekedja för 2026-05 med löpande seq och stigande createdAt. */
function chain(types: Array<'CLOSED' | 'REOPENED'>, organizationId = ORG): FakeEvent[] {
  return types.map((type, i) => ({
    organizationId,
    year: 2026,
    month: 5,
    seq: i + 1,
    type,
    createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, i)),
  }))
}

describe('T5 PR1b · härledningen "är perioden stängd?"', () => {
  describe('Fälla 1 — typfilter: kedjan avgörs av SENASTE händelsen, inte av att något hänt', () => {
    const CASES: Array<{ label: string; types: Array<'CLOSED' | 'REOPENED'>; closed: boolean }> = [
      { label: '∅ (aldrig rörd)', types: [], closed: false },
      { label: '[C] stängd', types: ['CLOSED'], closed: true },
      { label: '[C,R] återöppnad', types: ['CLOSED', 'REOPENED'], closed: false },
      { label: '[C,R,C] omstängd', types: ['CLOSED', 'REOPENED', 'CLOSED'], closed: true },
      {
        label: '[C,R,C,R] återöppnad igen',
        types: ['CLOSED', 'REOPENED', 'CLOSED', 'REOPENED'],
        closed: false,
      },
    ]

    it.each(CASES)('$label → stängd=$closed (punktform)', async ({ types, closed }) => {
      const db = makeDb(chain(types))
      await expect(isPeriodClosed(db as never, ORG, IN_PERIOD)).resolves.toBe(closed)
    })

    it.each(CASES)('$label → stängd=$closed (bulkform, samma svar)', async ({ types, closed }) => {
      const db = makeDb(chain(types))
      const set = await getClosedPeriods(db as never, ORG)
      // Punkt- och bulkformen får ALDRIG kunna svara olika på samma period —
      // den ena grindar allocate, den andra backfillens gap-detektion.
      expect(set.has(periodKeyOf({ year: 2026, month: 5 }))).toBe(closed)
    })

    it.each(CASES)('$label → assertPeriodOpen kastar=$closed', async ({ types, closed }) => {
      const db = makeDb(chain(types))
      const call = assertPeriodOpen(db as never, ORG, IN_PERIOD, 'test')
      if (closed) await expect(call).rejects.toBeInstanceOf(ConflictException)
      else await expect(call).resolves.toBeUndefined()
    })

    it('uppslagningen skickar INGET typfilter till databasen', async () => {
      const db = makeDb(chain(['CLOSED']))
      await isPeriodClosed(db as never, ORG, IN_PERIOD)

      const args = db.accountingPeriodEvent.findFirst.mock.calls[0]![0] as {
        where: Record<string, unknown>
      }
      expect(args.where).toEqual({ organizationId: ORG, year: 2026, month: 5 })
      expect(args.where).not.toHaveProperty('type')
    })

    it('KONTRAFAKTISKT: ett typfilter hade gjort perioden permanent öppen', async () => {
      // Beviset att fällan är verklig, inte dekorativ. Samma kedja [C,R,C]:
      // vår uppslagning säger STÄNGD, den naiva "har någonsin återöppnats?"
      // säger ÖPPEN — och hade därmed släppt in ett verifikat i en stängd period.
      const events = chain(['CLOSED', 'REOPENED', 'CLOSED'])
      const db = makeDb(events)

      await expect(isPeriodClosed(db as never, ORG, IN_PERIOD)).resolves.toBe(true)

      const naive = await db.accountingPeriodEvent.findFirst({
        where: { organizationId: ORG, year: 2026, month: 5, type: 'REOPENED' },
        orderBy: { seq: 'desc' },
      })
      expect(naive).not.toBeNull() // → "har återöppnats" → naiv slutsats: öppen. FEL.
    })
  })

  describe('Fälla 3 — ordningstvetydighet: seq avgör, aldrig createdAt', () => {
    it('två händelser med IDENTISK createdAt → seq ger entydigt svar', async () => {
      const sameInstant = new Date('2026-06-01T08:00:00.000Z')
      // Insättningsordningen är medvetet omvänd mot seq-ordningen: en sortering
      // som faller tillbaka på createdAt (stabil sort → insättningsordning) hade
      // plockat REOPENED och kallat perioden ÖPPEN.
      const events: FakeEvent[] = [
        {
          organizationId: ORG,
          year: 2026,
          month: 5,
          seq: 2,
          type: 'CLOSED',
          createdAt: sameInstant,
        },
        {
          organizationId: ORG,
          year: 2026,
          month: 5,
          seq: 1,
          type: 'REOPENED',
          createdAt: sameInstant,
        },
      ]
      const db = makeDb(events)

      await expect(isPeriodClosed(db as never, ORG, IN_PERIOD)).resolves.toBe(true)
      expect((await getClosedPeriods(db as never, ORG)).has('2026-05')).toBe(true)
    })

    it('omvänt: REOPENED har högst seq trots äldre createdAt → perioden är öppen', async () => {
      const events: FakeEvent[] = [
        {
          organizationId: ORG,
          year: 2026,
          month: 5,
          seq: 1,
          type: 'CLOSED',
          createdAt: new Date('2026-06-01T09:00:00.000Z'),
        },
        {
          organizationId: ORG,
          year: 2026,
          month: 5,
          seq: 2,
          type: 'REOPENED',
          // Tidigare klocktid än stängningen (klockskev/samtidiga skrivningar).
          createdAt: new Date('2026-06-01T08:00:00.000Z'),
        },
      ]
      const db = makeDb(events)
      await expect(isPeriodClosed(db as never, ORG, IN_PERIOD)).resolves.toBe(false)
    })
  })

  describe('Fälla 4 — org-scope: en organisations historik avgör bara dess egen period', () => {
    it('org A återöppnad, org B stängd — samma period, olika svar', async () => {
      const events = [...chain(['CLOSED', 'REOPENED'], 'org-A'), ...chain(['CLOSED'], 'org-B')]
      const db = makeDb(events)

      await expect(isPeriodClosed(db as never, 'org-A', IN_PERIOD)).resolves.toBe(false)
      await expect(isPeriodClosed(db as never, 'org-B', IN_PERIOD)).resolves.toBe(true)
      expect((await getClosedPeriods(db as never, 'org-A')).has('2026-05')).toBe(false)
      expect((await getClosedPeriods(db as never, 'org-B')).has('2026-05')).toBe(true)
    })

    it('org utan egna händelser påverkas inte av andras stängningar', async () => {
      const db = makeDb(chain(['CLOSED'], 'org-A'))
      await expect(isPeriodClosed(db as never, 'org-C', IN_PERIOD)).resolves.toBe(false)
    })
  })

  describe('Periodhärledning i svensk civil tid (oförändrad från PR1a)', () => {
    it('22:30 UTC 31 mars tillhör april i Sverige (sommartid) — inte mars', async () => {
      const db = makeDb([
        {
          organizationId: ORG,
          year: 2026,
          month: 4,
          seq: 1,
          type: 'CLOSED',
          createdAt: new Date('2026-05-01T00:00:00Z'),
        },
      ])
      // Posten är 00:30 svensk tid 1 april → april är stängd → spärren slår.
      await expect(
        isPeriodClosed(db as never, ORG, new Date('2026-03-31T22:30:00Z')),
      ).resolves.toBe(true)
      // Samma ögonblick klassat som mars hade sluppit förbi.
      await expect(
        isPeriodClosed(db as never, ORG, new Date('2026-03-31T12:00:00Z')),
      ).resolves.toBe(false)
    })
  })

  describe('Skrivningen: seq-allokering och spegling', () => {
    /**
     * Attrapp för skrivvägen: håller händelser i en lista, upprätthåller
     * @@unique([org, year, month, seq]) och den GAMLA tabellens
     * @@unique([org, year, month]) — det är just den senare som en `create` på
     * speglingen hade krockat med vid omstängning.
     */
    function makeWriteTx() {
      const events: Array<Record<string, unknown>> = []
      const mirror = new Map<string, Record<string, unknown>>()
      return {
        events,
        mirror,
        tx: {
          accountingPeriodEvent: {
            findFirst: jest.fn((args: { where: Record<string, unknown> }) => {
              const matching = events.filter((e) =>
                Object.entries(args.where).every(([k, v]) => e[k] === v),
              )
              const top = matching.sort((a, b) => (b.seq as number) - (a.seq as number))[0]
              return Promise.resolve(top ?? null)
            }),
            create: jest.fn((args: { data: Record<string, unknown> }) => {
              const d = args.data
              const key = `${d.organizationId}-${d.year}-${d.month}-${d.seq}`
              if (events.some((e) => `${e.organizationId}-${e.year}-${e.month}-${e.seq}` === key)) {
                return Promise.reject(new Error('P2002 unique (org, year, month, seq)'))
              }
              events.push(d)
              return Promise.resolve(d)
            }),
          },
          closedAccountingPeriod: {
            upsert: jest.fn(
              (args: {
                where: { organizationId_year_month: Record<string, unknown> }
                create: Record<string, unknown>
                update: Record<string, unknown>
              }) => {
                const w = args.where.organizationId_year_month
                const key = `${w.organizationId}-${w.year}-${w.month}`
                const existing = mirror.get(key)
                mirror.set(key, existing ? { ...existing, ...args.update } : args.create)
                return Promise.resolve(mirror.get(key))
              },
            ),
          },
        },
      }
    }

    const CLOSE = {
      organizationId: ORG,
      year: 2026,
      month: 5,
      actorUserId: 'user-1',
      actorLabel: 'Anna Svensson',
      summary: { result: 1000 },
    }

    it('första stängningen får seq 1 och skapar spegelraden', async () => {
      const { tx, events, mirror } = makeWriteTx()
      const res = await appendPeriodClosedEvent(tx as never, CLOSE)

      expect(res.seq).toBe(1)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'CLOSED', seq: 1, actorType: 'USER' })
      expect(mirror.size).toBe(1)
    })

    it('OMSTÄNGNING (PR1c-vägen) får seq 2 och kraschar INTE på spegelns unika index', async () => {
      // Regressionsskydd för FAR:s fynd: med `create` i stället för `upsert` hade
      // den här andra stängningen krockat med den kvarvarande spegelraden, rullat
      // tillbaka hela den legitima omstängningen och rapporterats som "perioden är
      // redan stängd". Ingen annan test i PR1b övar den här vägen.
      const { tx, events, mirror } = makeWriteTx()
      await appendPeriodClosedEvent(tx as never, CLOSE)
      const second = await appendPeriodClosedEvent(tx as never, {
        ...CLOSE,
        summary: { result: 2000 },
      })

      expect(second.seq).toBe(2)
      expect(events).toHaveLength(2)
      // Speglingen visar den GÄLLANDE stängningen, inte den första.
      expect(mirror.size).toBe(1)
      expect([...mirror.values()][0]).toMatchObject({ summary: { result: 2000 } })
      // Den ursprungliga händelsens ögonblicksbild är ORÖRD.
      expect(events[0]!.summary).toEqual({ result: 1000 })
    })

    it('händelsens unika index serialiserar fortfarande två samtidiga stängningar', async () => {
      // Händelsen skrivs FÖRE speglingen, så den förlorande transaktionen når
      // aldrig upserten — serialiseringen ligger kvar på (org, år, månad, seq).
      const { tx } = makeWriteTx()
      const [a, b] = await Promise.allSettled([
        appendPeriodClosedEvent(tx as never, CLOSE),
        appendPeriodClosedEvent(tx as never, CLOSE),
      ])

      const outcomes = [a!.status, b!.status].sort()
      expect(outcomes).toEqual(['fulfilled', 'rejected'])
    })

    it('okänd aktör → SYSTEM, ingen påhittad användare', async () => {
      const { tx, events } = makeWriteTx()
      await appendPeriodClosedEvent(tx as never, {
        organizationId: ORG,
        year: 2026,
        month: 5,
        summary: {},
      })
      expect(events[0]).toMatchObject({ actorType: 'SYSTEM' })
      expect(events[0]).not.toHaveProperty('actorUserId')
    })
  })

  describe('closedAt speglar den GÄLLANDE stängningen', () => {
    it('omstängd period rapporterar den senaste stängningens tidpunkt', async () => {
      const events = chain(['CLOSED', 'REOPENED', 'CLOSED'])
      const states = await getClosedPeriodStates(makeDb(events) as never, ORG)

      expect(states).toHaveLength(1)
      // Den tredje händelsen (seq 3) är den gällande — inte den första.
      expect(states[0]!.closedAt).toEqual(events[2]!.createdAt)
    })

    it('återöppnad period listas inte alls som stängd', async () => {
      const states = await getClosedPeriodStates(
        makeDb(chain(['CLOSED', 'REOPENED'])) as never,
        ORG,
      )
      expect(states).toHaveLength(0)
    })
  })
})
