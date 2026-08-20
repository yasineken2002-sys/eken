/**
 * T5 PR1c2 — RÄTTELSE AV VERIFIKAT: den operatörsstyrda vändningen.
 *
 * Vad testerna vaktar:
 *
 *  1. Rättelsen är originalets SPEGELBILD — samma konton, samma belopp, omvända
 *     sidor — och balanserar. Den som rättar ska aldrig behöva välja ett konto.
 *  2. Datumet är IDAG, aldrig originalets. Det är hela principen: rättelsen visar
 *     NÄR felet upptäcktes. Följden är också att den passerar periodspärren som
 *     all annan bokföring — ingen specialväg förbi låset.
 *  3. Originalet rörs INTE. Ingen update, ingen delete.
 *  4. EN gång per verifikat. En andra rättelse hade tagit ut den första och
 *     lämnat tre verifikat där en rättelse skedde.
 *  5. Rollen grindas i TJÄNSTEN, inte bara i controllern.
 */

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common'
import { Prisma, UserRole } from '@prisma/client'
import { AccountingService } from './accounting.service'

interface RigOpts {
  /** Originalets rader. Decimal speglar hur Prisma faktiskt returnerar dem. */
  lines?: Array<{ accountId: string; debit?: number; credit?: number; description?: string }>
  /**
   * Redan rättat? Sätt till rättelsens nummer.
   *
   * `sourceId` avgör VILKEN väg som reverserade posten, och därmed vilket
   * besked operatören får. Default är den manuella namnrymden — det är den de
   * befintliga fallen modellerar. En AUTOMATISK reversering (annullering,
   * makulering) sätts genom att ange en annan namnrymd.
   */
  reversedBy?: { series: string; verNumber: number; sourceId?: string } | null
  /** Saknas originalet helt. */
  missing?: boolean
  /** allocate kastar (t.ex. stängd period). */
  allocateThrows?: Error
}

function makeRig(opts: RigOpts = {}) {
  const created: Array<Record<string, unknown>> = []
  const original = {
    id: 'je-1',
    organizationId: 'org-1',
    date: new Date('2026-03-15T00:00:00Z'),
    description: 'Hyresavi mars — lgh 12',
    series: 'A',
    verNumber: 7,
    lines: (
      opts.lines ?? [
        { accountId: 'acc-1510', debit: 10000, description: 'Kundfordran' },
        { accountId: 'acc-3911', credit: 10000, description: 'Hyresintäkt' },
      ]
    ).map((l) => ({
      accountId: l.accountId,
      debit: l.debit != null ? new Prisma.Decimal(l.debit) : null,
      credit: l.credit != null ? new Prisma.Decimal(l.credit) : null,
      description: l.description ?? null,
    })),
    reversedBy: opts.reversedBy ? { sourceId: `entry-reversal:je-1`, ...opts.reversedBy } : null,
  }

  const $transaction = jest.fn(
    (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma),
  )

  const prisma = {
    journalEntry: {
      // TVÅ anropare delar den här: uppslaget av ORIGINALET (per id) och
      // createNumberedEntrys idempotenskontroll (per source+sourceId). Skiljs på
      // where — annars svarar attrappen "rättelsen finns redan" på det andra
      // anropet och skrivningen hoppas tyst över.
      findFirst: jest.fn((args: { where: Record<string, unknown> }) => {
        if (args.where.id != null) return Promise.resolve(opts.missing ? null : original)
        return Promise.resolve(null)
      }),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data)
        return Promise.resolve({ id: 'je-rev', series: 'A', verNumber: 8, ...args.data })
      }),
      update: jest.fn(),
      delete: jest.fn(),
    },
    $transaction,
  }

  const verifikationsnummer = {
    allocate: jest.fn((..._args: unknown[]) => {
      if (opts.allocateThrows) return Promise.reject(opts.allocateThrows)
      return Promise.resolve({ series: 'A', verNumber: 8, fiscalYear: 2026 })
    }),
  }

  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return { service, prisma, created, original, verifikationsnummer }
}

const ACTOR = { actorRole: UserRole.ACCOUNTANT, actorUserId: 'u-1' }
const REASON = 'Fel belopp — hyran var 8 400 kr, inte 10 000 kr'

/** Summerar debet/kredit ur de rader som skickades till create. */
function sums(data: Record<string, unknown>) {
  const lines = (data.lines as { create: Array<{ debit?: number; credit?: number }> }).create
  return {
    debit: lines.reduce((s, l) => s + Number(l.debit ?? 0), 0),
    credit: lines.reduce((s, l) => s + Number(l.credit ?? 0), 0),
    lines,
  }
}

describe('T5 PR1c2 · rättelse av verifikat', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('Rättelsen är originalets spegelbild', () => {
    it('vänder debet och kredit rad för rad, med samma konton och belopp', async () => {
      const { service, created } = makeRig()
      await service.reverseJournalEntry({
        entryId: 'je-1',
        organizationId: 'org-1',
        ...ACTOR,
        reason: REASON,
      })

      expect(created).toHaveLength(1)
      const { lines } = sums(created[0]!)
      expect(lines).toEqual([
        // 1510 hade DEBET 10000 → rättelsen krediterar samma konto.
        { accountId: 'acc-1510', credit: 10000, description: 'Rättelse: Kundfordran' },
        { accountId: 'acc-3911', debit: 10000, description: 'Rättelse: Hyresintäkt' },
      ])
    })

    it('balanserar — Σdebet = Σkredit, precis som originalet', async () => {
      const { service, created } = makeRig({
        lines: [
          { accountId: 'acc-1510', debit: 12500 },
          { accountId: 'acc-3911', credit: 10000 },
          { accountId: 'acc-2611', credit: 2500 },
        ],
      })
      await service.reverseJournalEntry({
        entryId: 'je-1',
        organizationId: 'org-1',
        ...ACTOR,
        reason: REASON,
      })

      const { debit, credit } = sums(created[0]!)
      expect(debit).toBe(12500)
      expect(credit).toBe(12500)
    })

    it('beskrivningen pekar ut originalet och bär skälet', async () => {
      const { service, created } = makeRig()
      await service.reverseJournalEntry({
        entryId: 'je-1',
        organizationId: 'org-1',
        ...ACTOR,
        reason: REASON,
      })

      expect(created[0]!.description).toBe(
        `Rättelse av verifikat A7 (bokfört 2026-03-15): ${REASON}`,
      )
    })

    it('länkar tillbaka till originalet', async () => {
      const { service, created } = makeRig()
      await service.reverseJournalEntry({
        entryId: 'je-1',
        organizationId: 'org-1',
        ...ACTOR,
        reason: REASON,
      })

      expect(created[0]).toMatchObject({
        reversalOfEntryId: 'je-1',
        // MANUAL: en operatörshandling, inte en följd av ett domänflöde.
        source: 'MANUAL',
        sourceId: 'entry-reversal:je-1',
      })
    })
  })

  describe('Datumet är IDAG — och därför gäller periodspärren', () => {
    it('dateras till idag, inte till originalets datum', async () => {
      const { service, created, verifikationsnummer } = makeRig()
      await service.reverseJournalEntry({
        entryId: 'je-1',
        organizationId: 'org-1',
        ...ACTOR,
        reason: REASON,
      })

      const bookedDate = created[0]!.date as Date
      expect(bookedDate.toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10))
      expect(bookedDate.getTime()).toBeGreaterThan(new Date('2026-03-15').getTime())

      // Samma datum skickas till allocate → periodspärren prövar INNEVARANDE
      // period, inte originalets.
      const allocDate = verifikationsnummer.allocate.mock.calls[0]![2] as Date
      expect(allocDate.toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10))
    })

    it('stängd innevarande period → allocate stoppar rättelsen, inget skrivs', async () => {
      // Ingen specialväg förbi låset: en rättelse är en bokföring.
      const { service, created } = makeRig({
        allocateThrows: new ConflictException('Bokföringsperioden 2026-08 är stängd'),
      })

      await expect(
        service.reverseJournalEntry({
          entryId: 'je-1',
          organizationId: 'org-1',
          ...ACTOR,
          reason: REASON,
        }),
      ).rejects.toThrow(/är stängd/)
      expect(created).toHaveLength(0)
    })
  })

  describe('Originalet rörs inte', () => {
    it('ingen update eller delete mot verifikatet', async () => {
      const { service, prisma } = makeRig()
      await service.reverseJournalEntry({
        entryId: 'je-1',
        organizationId: 'org-1',
        ...ACTOR,
        reason: REASON,
      })

      expect(prisma.journalEntry.update).not.toHaveBeenCalled()
      expect(prisma.journalEntry.delete).not.toHaveBeenCalled()
      // Enda skrivningen är den NYA posten.
      expect(prisma.journalEntry.create).toHaveBeenCalledTimes(1)
    })
  })

  describe('En gång per verifikat', () => {
    it('redan rättat → 409 som pekar ut rättelsen, inget nytt skrivs', async () => {
      const { service, created } = makeRig({ reversedBy: { series: 'A', verNumber: 12 } })

      await expect(
        service.reverseJournalEntry({
          entryId: 'je-1',
          organizationId: 'org-1',
          ...ACTOR,
          reason: REASON,
        }),
      ).rejects.toThrow(/redan rättat, med verifikat A12/)
      expect(created).toHaveLength(0)
    })

    it('SAMTIDIGHET: P2002 på rättelselänken blir ett begripligt besked, inte 500', async () => {
      // Kontrollen av `reversedBy` sker före skrivningen, så två dubbelklick kan
      // båda passera den. Förloraren krockar på ett unikt index och ska få veta
      // vad som hände — inte en rå 500 och en CRITICAL i Sentry.
      const { service, prisma, original } = makeRig()
      prisma.journalEntry.create = jest.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['reversalOfEntryId'] },
        }),
      )
      // Vid omläsningen finns vinnarens rättelse.
      prisma.journalEntry.findFirst = jest.fn((args: { where: Record<string, unknown> }) => {
        if (args.where.id != null) return Promise.resolve(original)
        if (args.where.reversalOfEntryId != null)
          // Manuell mot manuell: vinnaren skriver SAMMA sourceId som förloraren
          // skulle ha gjort. Förkontrollen i createReversalEntry ska därför inte
          // fälla — det är P2002-vägen nedan som ska pröva sig fram och ge
          // beskedet. Bär raden en ANNAN namnrymd är det en automatisk
          // reversering, och då fälls den tidigare (eget test).
          return Promise.resolve({ series: 'A', verNumber: 9, sourceId: 'entry-reversal:je-1' })
        return Promise.resolve(null)
      }) as never

      await expect(
        service.reverseJournalEntry({
          entryId: 'je-1',
          organizationId: 'org-1',
          ...ACTOR,
          reason: REASON,
        }),
      ).rejects.toThrow(/redan rättat, med verifikat A9/)
    })

    it('IDEMPOTENSTRÄFF: förloraren får INTE "bokfört" när skälet var någon annans', async () => {
      // Den tredje samtidighetsgrenen: B:s transaktion startar EFTER att A
      // committat, så idempotenskontrollen returnerar A:s post i stället för att
      // krocka. För de fyra AUTOMATISKA motverifikaten är det rätt (identiska
      // anrop), men här bär posten A:s skäl medan B:s tyst kastades — och skälet
      // är dokumenterat som något som inte går att ändra efteråt.
      const { service, prisma, original } = makeRig()
      prisma.journalEntry.findFirst = jest.fn((args: { where: Record<string, unknown> }) => {
        if (args.where.id != null) return Promise.resolve(original)
        // Idempotenskontrollen: vinnarens rättelse finns redan, med ANNAT skäl.
        return Promise.resolve({
          id: 'je-rev-a',
          series: 'A',
          verNumber: 9,
          // Samma namnrymd — se noten i SAMTIDIGHET-fallet ovan.
          sourceId: 'entry-reversal:je-1',
          description: 'Rättelse av verifikat A7 (bokfört 2026-03-15): Nagon annans skal',
        })
      }) as never

      await expect(
        service.reverseJournalEntry({
          entryId: 'je-1',
          organizationId: 'org-1',
          ...ACTOR,
          reason: REASON,
        }),
      ).rejects.toThrow(/rättades precis av någon annan, med verifikat A9.*skäl bokfördes inte/s)
    })

    it('identiskt skäl → tyst OK, för då hände det användaren bad om', async () => {
      const { service, prisma, original } = makeRig()
      const sameDescription = `Rättelse av verifikat A7 (bokfört 2026-03-15): ${REASON}`
      prisma.journalEntry.findFirst = jest.fn((args: { where: Record<string, unknown> }) => {
        if (args.where.id != null) return Promise.resolve(original)
        // Samma namnrymd — manuell mot manuell, se noten längre upp.
        return Promise.resolve({
          id: 'x',
          series: 'A',
          verNumber: 9,
          sourceId: 'entry-reversal:je-1',
          description: sameDescription,
        })
      }) as never

      await expect(
        service.reverseJournalEntry({
          entryId: 'je-1',
          organizationId: 'org-1',
          ...ACTOR,
          reason: REASON,
        }),
      ).resolves.toMatchObject({ description: sameDescription })
    })

    it('P2002 på VERIFIKATIONSSERIEN maskeras INTE — det är ett annat fel', async () => {
      // Tre unika index på JournalEntry betyder tre olika saker. En dubblett i
      // nummerserien (BFL 5 kap 6 §) är allvarlig och måste fortsätta upp som
      // ett fel; att svälja den som "redan rättat" hade dolt den. Lärdomen från
      // plattforms-fakturanumret (#214): disambiguera på meta.target.
      const { service, prisma } = makeRig()
      const serialCollision = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['organizationId', 'series', 'fiscalYear', 'verNumber'] },
      })
      prisma.journalEntry.create = jest.fn().mockRejectedValue(serialCollision)

      await expect(
        service.reverseJournalEntry({
          entryId: 'je-1',
          organizationId: 'org-1',
          ...ACTOR,
          reason: REASON,
        }),
      ).rejects.toBe(serialCollision)
    })

    it('beskedet säger vad man gör i stället', async () => {
      const { service } = makeRig({ reversedBy: { series: 'A', verNumber: 12 } })
      await expect(
        service.reverseJournalEntry({
          entryId: 'je-1',
          organizationId: 'org-1',
          ...ACTOR,
          reason: REASON,
        }),
      ).rejects.toThrow(/rätta rättelsen/)
    })
  })

  describe('Grindarna', () => {
    it.each([UserRole.MANAGER, UserRole.VIEWER])('%s nekas i tjänsten', async (role) => {
      const { service, created, prisma } = makeRig()
      await expect(
        service.reverseJournalEntry({
          entryId: 'je-1',
          organizationId: 'org-1',
          actorRole: role,
          actorUserId: 'u-x',
          reason: REASON,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(created).toHaveLength(0)
      // Nekas INNAN verifikatet ens slås upp.
      expect(prisma.journalEntry.findFirst).not.toHaveBeenCalled()
    })

    it('saknad roll nekas (fail-closed)', async () => {
      const { service } = makeRig()
      await expect(
        service.reverseJournalEntry({
          entryId: 'je-1',
          organizationId: 'org-1',
          actorUserId: 'u-x',
          reason: REASON,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it.each([
      ['', 'tomt'],
      ['   ', 'blanksteg'],
      ['fel', 'för kort'],
    ])('skäl som är %s (%s) avvisas', async (reason) => {
      const { service, created } = makeRig()
      await expect(
        service.reverseJournalEntry({
          entryId: 'je-1',
          organizationId: 'org-1',
          ...ACTOR,
          reason,
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(created).toHaveLength(0)
    })

    it('verifikat i annan organisation → hittas inte', async () => {
      const { service } = makeRig({ missing: true })
      await expect(
        service.reverseJournalEntry({
          entryId: 'je-1',
          organizationId: 'org-2',
          ...ACTOR,
          reason: REASON,
        }),
      ).rejects.toThrow(/hittades inte/)
    })
  })
})
