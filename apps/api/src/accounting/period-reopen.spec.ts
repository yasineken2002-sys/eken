/**
 * T5 PR1c — ÅTERÖPPNING: fyra grindar, alla i tjänsten.
 *
 * Vad testerna vaktar, i tur och ordning efter hur illa det slutar om de faller:
 *
 *  1. ORSAKEN grindar. En felaktig bokförd post får ALDRIG bli en återöppning —
 *     regeln bor i `canReopenForCorrection` och ingen annanstans.
 *  2. RÄKENSKAPSÅRSSPÄRREN räknas från årets slut, inte från månaden, och i civil
 *     månadsaritmetik. Gränsen testas på dagen, i båda räkenskapsårsvarianterna.
 *  3. ROLLEN grindas i TJÄNSTEN, inte bara i controllern — en intern anropare
 *     eller ett framtida AI-verktyg ska träffa samma spärr.
 *  4. TILLSTÅNDET: en period som inte är stängd kan inte öppnas.
 *
 * Och genomgående: när en grind stänger får INGEN händelse skrivas. En avvisad
 * återöppning som ändå lämnat ett spår i historiken vore värre än ingen spärr
 * alls — den hade sett ut som att åtgärden gick igenom.
 */

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common'
import { Prisma, UserRole } from '@prisma/client'
import { AccountingPeriodService, canReopenForCorrection } from './accounting-period.service'

interface RigOpts {
  /** Periodens händelsekedja, äldst först. */
  history?: Array<{ seq: number; type: 'CLOSED' | 'REOPENED'; summary?: unknown }>
  fiscalYearStartMonth?: number
  notifyUsers?: string[]
}

function makeRig(opts: RigOpts = {}) {
  const history = (opts.history ?? [{ seq: 1, type: 'CLOSED' as const }]).map((e) => ({
    seq: e.seq,
    type: e.type,
    createdAt: new Date('2026-04-01T10:00:00Z'),
    actorLabel: null,
    reason: null,
    reasonCategory: null,
    summary: e.summary ?? null,
  }))
  const events: Array<Record<string, unknown>> = []
  const notified: Array<Record<string, unknown>> = []

  const $transaction = jest.fn(
    (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma),
  )

  const prisma = {
    accountingPeriodEvent: {
      findFirst: jest.fn(() => {
        const top = [...history].sort((a, b) => b.seq - a.seq)[0]
        return Promise.resolve(top ?? null)
      }),
      findMany: jest.fn().mockResolvedValue(history),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        events.push(args.data)
        return Promise.resolve(args.data)
      }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        fiscalYearStartMonth: opts.fiscalYearStartMonth ?? 1,
        vatReportingPeriod: 'QUARTERLY',
      }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ firstName: 'Petra', lastName: 'Lund' }),
      findMany: jest
        .fn()
        .mockResolvedValue((opts.notifyUsers ?? ['u-1', 'u-2']).map((id) => ({ id }))),
    },
    notification: {
      createMany: jest.fn((args: { data: Array<Record<string, unknown>> }) => {
        notified.push(...args.data)
        return Promise.resolve({ count: args.data.length })
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction,
  }

  return { service: new AccountingPeriodService(prisma as never), prisma, events, notified }
}

const OWNER = { actorRole: UserRole.OWNER, actorUserId: 'u-owner' }
const GOOD_REASON = 'Hyresavin för lgh 12 saknades helt vid avstämningen'

/** En period som ligger tryggt innanför räkenskapsårsfönstret. */
function currentPeriod(): { year: number; month: number } {
  const now = new Date()
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }
}

describe('T5 PR1c · återöppning', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('Grind 2 — orsaken avgör, och regeln bor på ETT ställe', () => {
    it('canReopenForCorrection säger nej för ALLA roller (revisor finns inte än)', () => {
      for (const role of Object.values(UserRole)) {
        expect(canReopenForCorrection(role)).toBe(false)
      }
    })

    it('MISSING_ENTRY släpps igenom och skriver en REOPENED-händelse', async () => {
      const { service, events } = makeRig()
      const p = currentPeriod()

      const res = await service.reopenPeriod('org-1', p.year, p.month, {
        ...OWNER,
        reason: GOOD_REASON,
        reasonCategory: 'MISSING_ENTRY',
      })

      expect(res.reasonCategory).toBe('MISSING_ENTRY')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: 'REOPENED',
        seq: 2,
        reasonCategory: 'MISSING_ENTRY',
        reason: GOOD_REASON,
        actorType: 'USER',
        actorLabel: 'Petra Lund',
      })
      // En återöppning har ingen ögonblicksbild att ta (tvingas även av CHECK).
      expect(events[0]).not.toHaveProperty('summary')
    })

    it('EXISTING_ENTRY_INCORRECT blockeras — och INGEN händelse skrivs', async () => {
      const { service, events } = makeRig()
      const p = currentPeriod()

      await expect(
        service.reopenPeriod('org-1', p.year, p.month, {
          ...OWNER,
          reason: 'Fel belopp på hyresavin för lgh 4',
          reasonCategory: 'EXISTING_ENTRY_INCORRECT',
        }),
      ).rejects.toBeInstanceOf(ConflictException)

      expect(events).toHaveLength(0)
    })

    it('blockeringen FÖRKLARAR i stället för att bara neka', async () => {
      const { service } = makeRig()
      const p = currentPeriod()

      await expect(
        service.reopenPeriod('org-1', p.year, p.month, {
          ...OWNER,
          reason: 'Fel belopp på hyresavin för lgh 4',
          reasonCategory: 'EXISTING_ENTRY_INCORRECT',
        }),
      ).rejects.toThrow(/ändras aldrig i efterhand.*ny post idag.*står kvar/s)
    })
  })

  describe('Grind 3 — räkenskapsårsspärren räknas från ÅRETS slut', () => {
    // Kalenderår: FY2025 slutade 2025-12-31 → spärr från 2026-07-01.
    it.each([
      ['2026-06-30T12:00:00Z', false, 'dagen före gränsen'],
      ['2026-07-02T12:00:00Z', true, 'dagen efter gränsen'],
    ])('kalenderår, dec 2025, nu %s → blockerad=%s (%s)', async (now, blocked) => {
      jest.useFakeTimers().setSystemTime(new Date(now))
      try {
        const { service, events } = makeRig({ fiscalYearStartMonth: 1 })
        const call = service.reopenPeriod('org-1', 2025, 12, {
          ...OWNER,
          reason: GOOD_REASON,
          reasonCategory: 'MISSING_ENTRY',
        })
        if (blocked) {
          await expect(call).rejects.toThrow(/Räkenskapsåret 2025 avslutades 2025-12-31/)
          expect(events).toHaveLength(0)
        } else {
          await expect(call).resolves.toBeDefined()
        }
      } finally {
        jest.useRealTimers()
      }
    })

    it('BRUTET år maj–apr: mars 2026 är fem månader gammal men INTE blockerad', async () => {
      // Perioden tillhör FY2025 (maj 2025–apr 2026), som slutade 2026-04-30 →
      // spärr först från 2026-11-01. Räknat från MÅNADEN hade den sett gammal ut.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-01T12:00:00Z'))
      try {
        const { service } = makeRig({ fiscalYearStartMonth: 5 })
        await expect(
          service.reopenPeriod('org-1', 2026, 3, {
            ...OWNER,
            reason: GOOD_REASON,
            reasonCategory: 'MISSING_ENTRY',
          }),
        ).resolves.toBeDefined()
      } finally {
        jest.useRealTimers()
      }
    })

    it('BRUTET år maj–apr: samma period blockeras efter 2026-11', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-11-02T12:00:00Z'))
      try {
        const { service, events } = makeRig({ fiscalYearStartMonth: 5 })
        await expect(
          service.reopenPeriod('org-1', 2026, 3, {
            ...OWNER,
            reason: GOOD_REASON,
            reasonCategory: 'MISSING_ENTRY',
          }),
        ).rejects.toThrow(/Räkenskapsåret 2025 avslutades 2026-04-30/)
        expect(events).toHaveLength(0)
      } finally {
        jest.useRealTimers()
      }
    })

    it('spärren har ingen override — inget argument öppnar den', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-02T12:00:00Z'))
      try {
        const { service } = makeRig({ fiscalYearStartMonth: 1 })
        await expect(
          service.reopenPeriod('org-1', 2025, 12, {
            ...OWNER,
            reason: GOOD_REASON,
            reasonCategory: 'MISSING_ENTRY',
            // Inga fler fält finns att skicka — signaturen bär ingen bakväg.
          }),
        ).rejects.toBeInstanceOf(ConflictException)
      } finally {
        jest.useRealTimers()
      }
    })
  })

  describe('Grind 1 — rollen grindas i TJÄNSTEN, inte bara i controllern', () => {
    it.each([UserRole.ADMIN, UserRole.ACCOUNTANT, UserRole.MANAGER, UserRole.VIEWER])(
      '%s nekas och inget skrivs',
      async (role) => {
        const { service, events } = makeRig()
        const p = currentPeriod()
        await expect(
          service.reopenPeriod('org-1', p.year, p.month, {
            actorRole: role,
            actorUserId: 'u-x',
            reason: GOOD_REASON,
            reasonCategory: 'MISSING_ENTRY',
          }),
        ).rejects.toBeInstanceOf(ForbiddenException)
        expect(events).toHaveLength(0)
      },
    )

    it('saknad roll nekas (fail-closed)', async () => {
      const { service } = makeRig()
      const p = currentPeriod()
      await expect(
        service.reopenPeriod('org-1', p.year, p.month, {
          actorUserId: 'u-x',
          reason: GOOD_REASON,
          reasonCategory: 'MISSING_ENTRY',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })
  })

  describe('Grind 4 — tillståndet', () => {
    it('period som aldrig stängts kan inte öppnas', async () => {
      const { service, events } = makeRig({ history: [] })
      const p = currentPeriod()
      await expect(
        service.reopenPeriod('org-1', p.year, p.month, {
          ...OWNER,
          reason: GOOD_REASON,
          reasonCategory: 'MISSING_ENTRY',
        }),
      ).rejects.toThrow(/inte stängd/)
      expect(events).toHaveLength(0)
    })

    it('ATOMÄRT: skrivningen vägrar även om tjänstens snabb-nej passerats', async () => {
      // TOCTOU-fönstret: tjänstens kontroll ligger UTANFÖR transaktionen. Två
      // samtidiga återöppningar kunde annars båda slinka igenom och ge kedjan
      // CLOSED → REOPENED → REOPENED. Här simuleras exakt det: snabb-nejet ser
      // en stängd period, men när transaktionen väl läser är den redan öppnad.
      const { service, prisma, events } = makeRig()
      const p = currentPeriod()
      let call = 0
      const base = { createdAt: new Date(), actorLabel: null, reason: null, reasonCategory: null }
      prisma.accountingPeriodEvent.findFirst = jest.fn(() => {
        call += 1
        // 1:a = tjänstens snabb-nej (stängd). 2:a = inuti tx (någon hann före).
        return Promise.resolve(
          call === 1
            ? { ...base, seq: 1, type: 'CLOSED' as const, summary: null }
            : { ...base, seq: 2, type: 'REOPENED' as const, summary: null },
        )
      })

      await expect(
        service.reopenPeriod('org-1', p.year, p.month, {
          ...OWNER,
          reason: GOOD_REASON,
          reasonCategory: 'MISSING_ENTRY',
        }),
      ).rejects.toThrow(/inte stängd/)
      expect(events).toHaveLength(0)
    })

    it('P2002 från unik-indexet blir ett begripligt besked, inte en 500', async () => {
      // Den ÄKTA samtidigheten: båda transaktionerna läser samma max(seq) och
      // försöker skriva seq N+1. Unik-indexet låter en vinna; förloraren ska få
      // ett svar användaren förstår, inte en CRITICAL i Sentry för ett dubbelklick.
      const { service, prisma } = makeRig()
      const p = currentPeriod()
      const p2002 = Object.assign(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      )
      prisma.accountingPeriodEvent.create = jest.fn().mockRejectedValue(p2002)

      await expect(
        service.reopenPeriod('org-1', p.year, p.month, {
          ...OWNER,
          reason: GOOD_REASON,
          reasonCategory: 'MISSING_ENTRY',
        }),
      ).rejects.toThrow(/är redan öppen/)
    })

    it('redan återöppnad period kan inte öppnas igen', async () => {
      const { service, events } = makeRig({
        history: [
          { seq: 1, type: 'CLOSED' },
          { seq: 2, type: 'REOPENED' },
        ],
      })
      const p = currentPeriod()
      await expect(
        service.reopenPeriod('org-1', p.year, p.month, {
          ...OWNER,
          reason: GOOD_REASON,
          reasonCategory: 'MISSING_ENTRY',
        }),
      ).rejects.toThrow(/inte stängd/)
      expect(events).toHaveLength(0)
    })
  })

  describe('Skälet', () => {
    it.each([
      ['', 'tomt'],
      ['   ', 'bara blanksteg'],
      ['fel', 'för kort'],
    ])('avvisar skäl som är %s (%s)', async (reason) => {
      const { service, events } = makeRig()
      const p = currentPeriod()
      await expect(
        service.reopenPeriod('org-1', p.year, p.month, {
          ...OWNER,
          reason,
          reasonCategory: 'MISSING_ENTRY',
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(events).toHaveLength(0)
    })

    it('trimmar skälet innan det sparas', async () => {
      const { service, events } = makeRig()
      const p = currentPeriod()
      await service.reopenPeriod('org-1', p.year, p.month, {
        ...OWNER,
        reason: `   ${GOOD_REASON}   `,
        reasonCategory: 'MISSING_ENTRY',
      })
      expect(events[0]!.reason).toBe(GOOD_REASON)
    })
  })

  describe('Ögonblicksbilden och speglingen', () => {
    it('returnerar den hävda stängningens summary — orörd', async () => {
      const snapshot = { month: 5, year: 2026, result: 8000, entriesCount: 3 }
      const { service } = makeRig({ history: [{ seq: 1, type: 'CLOSED', summary: snapshot }] })
      const p = currentPeriod()

      const res = await service.reopenPeriod('org-1', p.year, p.month, {
        ...OWNER,
        reason: GOOD_REASON,
        reasonCategory: 'MISSING_ENTRY',
      })
      expect(res.previousSummary).toEqual(snapshot)
    })

    it('RÖR INTE ClosedAccountingPeriod — attrappen har inte ens tabellen', async () => {
      // Klienttypen för återöppningen saknar closedAccountingPeriod, så ett försök
      // att skriva speglingen hade kraschat här. Att testet passerar ÄR beviset.
      const { service, prisma } = makeRig()
      const p = currentPeriod()
      await service.reopenPeriod('org-1', p.year, p.month, {
        ...OWNER,
        reason: GOOD_REASON,
        reasonCategory: 'MISSING_ENTRY',
      })
      expect(prisma).not.toHaveProperty('closedAccountingPeriod')
    })
  })

  describe('Notisen', () => {
    it('går till de ansvariga, med skälet i klartext', async () => {
      const { service, notified } = makeRig({ notifyUsers: ['u-1', 'u-2', 'u-3'] })
      const p = currentPeriod()
      await service.reopenPeriod('org-1', p.year, p.month, {
        ...OWNER,
        reason: GOOD_REASON,
        reasonCategory: 'MISSING_ENTRY',
      })

      expect(notified).toHaveLength(3)
      expect(notified[0]).toMatchObject({ type: 'SYSTEM', link: '/accounting' })
      expect(String(notified[0]!.message)).toContain(GOOD_REASON)
      expect(String(notified[0]!.message)).toContain('Petra Lund')
    })

    it('en trasig notis rullar INTE tillbaka återöppningen', async () => {
      const { service, prisma, events } = makeRig()
      prisma.notification.createMany = jest.fn().mockRejectedValue(new Error('DB nere'))
      const p = currentPeriod()

      await expect(
        service.reopenPeriod('org-1', p.year, p.month, {
          ...OWNER,
          reason: GOOD_REASON,
          reasonCategory: 'MISSING_ENTRY',
        }),
      ).resolves.toBeDefined()
      // Händelsen i loggen är det som räknas — notisen är best-effort.
      expect(events).toHaveLength(1)
    })
  })
})
