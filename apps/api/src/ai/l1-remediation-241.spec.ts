/**
 * L1-RÄTTNINGAR 241 — produktfynd från första riktiga L1-piloten (REVIEW-240, PRE-242).
 *
 *  P1  get_overdue_invoices / get_overdue_status omfattar ENDAST fakturor; modellen tog fakturornas
 *      4500 som "total förfallen skuld" trots att den delade sanningskällan (OverdueDebtService,
 *      hyresavier + fakturor) gav 9500/8000. Svaren bär nu omfattningen och den operativa totalen.
 *  P1b get_rent_notices visade avins bruttobelopp i meddelandet; nu även vad som återstår att betala.
 *  P2  get_revenue_report (betalda fakturors total) valdes som "månadens intäkt"; svaret bär nu även
 *      bokförd intäkt för samma period ur resultaträkningen — samma källa och huvudboksgrind som
 *      get_profit_loss_report — eller ett uttryckligt avstående, aldrig 0 som ersättning.
 *  AF20 Trunkerad fastighetslista: raden säger nu att övriga namn/ID saknas och hur de hämtas.
 *  O1  Dags-/veckorapporten fick inget datum (L1-09: "Vecka 42, 2024"); nu dagens datum och vecka.
 *      Promptregler mot påhittade menyvägar/funktioner, egna belopp och fastighetskopplingar bevisas
 *      här ENDAST som närvaro i requesten — beteendet kräver live-omprov.
 */
jest.mock('@anthropic-ai/sdk', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { OverdueDebtService } from '../overdue/overdue-debt.service'
import { reportFailure } from './report-evidence'
import { AviseringService } from '../avisering/avisering.service'
import { decideAiToolAccess } from '../common/authz/ai-tool-authz'
import { TOOLS } from './tools/ai-tools.definition'
import {
  assistantRig,
  date,
  done,
  json,
  memoryDb,
  ROLES,
  sdkScript,
  SEPTEMBER,
} from './report-acceptance.fixtures.testing'

/** Läsverktygens strängar ramas in av neutralizeUntrusted (tool-executor); jämför utan EXAKT den ramen. */
const unframe = (s: unknown) => String(s).replace(/^⟦OSÄKER⟧([\s\S]*)⟦\/OSÄKER⟧$/, '$1')

type ToolResult = {
  success: boolean
  message: string
  data?: unknown
  omfattning?: string
  operativTotal?: { total: number; count: number; omfattning: string }
}

function rig(owner = 'EVENO') {
  const db = memoryDb(owner)
  const r = assistantRig(db.prisma)
  const exec = (name: string, input: Record<string, unknown> = {}) =>
    r.executor.executeTool(name, input, 'O-A', { kind: 'USER', id: 'U-A' } as never, 'OWNER', {
      conversationId: 'C-241',
    } as never) as Promise<ToolResult>
  return { db, r, exec }
}

describe('L1-241: rättningar efter första L1-piloten', () => {
  beforeEach(() =>
    jest.useFakeTimers({
      now: date('2026-10-14T12:00:00Z'),
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout'],
    }),
  )
  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  describe('P1 — fakturalistan är en delmängd, den operativa totalen följer med', () => {
    it.each([
      ['FORTNOX', 9500, undefined],
      ['FORTNOX', 8000, 5500],
    ] as const)(
      'get_overdue_invoices (%s): omfattning ENDAST_FAKTUROR, operativTotal = OverdueDebtService (%s)',
      async (owner, expected, paid) => {
        const { db, exec } = rig(owner)
        if (paid !== undefined) db.notice.payments = [{ amount: paid }]
        const snapshot = await new OverdueDebtService(db.prisma as never).getOverdueSnapshot('O-A')
        const res = await exec('get_overdue_invoices')
        expect(res.success).toBe(true)
        // data är oförändrad: samma fakturarader med total och outstanding (#325).
        const invoices = res.data as { total: number; outstanding: number }[]
        expect(Array.isArray(invoices)).toBe(true)
        expect(invoices.map((i) => [Number(i.total), i.outstanding])).toEqual([
          [6000, 4500],
          [100, 0],
        ])
        expect(res.omfattning).toBe('ENDAST_FAKTUROR')
        expect(res.operativTotal!.total).toBe(snapshot.total)
        expect(res.operativTotal!.total).toBe(expected)
        expect(res.operativTotal!.omfattning).toBe('HYRESAVIER_OCH_FAKTUROR')
        expect(res.message).toMatch(/hyresavier ingår inte/i)
        expect(res.message).toContain(new Intl.NumberFormat('sv-SE').format(expected))
        // Negativkontroll: fakturornas 4500 får aldrig stå som totalen.
        expect(res.operativTotal!.total).not.toBe(4500)
        expect(db.prisma.invoice.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { organizationId: 'O-A', status: 'OVERDUE' } }),
        )
      },
    )

    it('get_overdue_invoices: operativTotal = datakontextens "Förfallen skuld" (samma data, cross-surface)', async () => {
      const { db, r, exec } = rig('FORTNOX')
      const ctx = await r.context.buildContext('O-A', 'OWNER')
      const line = ctx.split('\n').find((l) => l.includes('Förfallen skuld'))
      const res = await exec('get_overdue_invoices')
      const total = res.operativTotal!.total
      expect(line).toBeDefined()
      expect(line!.replace(/\s/g, '')).toContain(new Intl.NumberFormat('sv-SE').format(total).replace(/\s/g, ''))
      expect(total).toBe(9500)
      expect(db.prisma.rentNotice.findMany).toHaveBeenCalled()
    })

    it('get_overdue_status: omfattning ENDAST_FAKTUROR och operativTotal', async () => {
      const { db, r, exec } = rig('FORTNOX')
      Object.assign(r.executor, {
        paymentReminders: { getOverdueStatus: jest.fn().mockResolvedValue([]) },
      })
      const res = await exec('get_overdue_status')
      expect(res.omfattning).toBe('ENDAST_FAKTUROR')
      expect(res.operativTotal!.total).toBe(9500)
      expect(res.message).toMatch(/hyresavier ingår inte/i)
      void db
    })

    it.each(['get_overdue_invoices', 'get_overdue_status'] as const)(
      'läsfel i den operativa totalen (%s): listan levereras oförändrad, operativTotal = reportFailure(READ_FAILED) — aldrig 0',
      async (tool) => {
        const { r, exec } = rig('FORTNOX')
        Object.assign(r.executor, {
          paymentReminders: { getOverdueStatus: jest.fn().mockResolvedValue([]) },
        })
        const ok = await exec(tool)
        const spy = jest
          .spyOn(OverdueDebtService.prototype, 'getOverdueSnapshot')
          .mockRejectedValue(new Error('läsfel'))
        const res = await exec(tool)
        spy.mockRestore()
        expect(res.success).toBe(true)
        expect(res.data).toEqual(ok.data)
        expect(res.omfattning).toBe('ENDAST_FAKTUROR')
        // Maskinläsbar teknisk felsignal på samma fält som totalen — inte en saknad nyckel, inte 0.
        expect(res.operativTotal).toEqual(reportFailure('READ_FAILED'))
        expect(unframe(res.message)).toMatch(/kunde inte läsas — ange den inte/)
        expect(unframe(res.message)).not.toMatch(/operativ skuld[^.]*: 0 kr/)
      },
    )

    it('F-A: verktyget och datakontexten läser snapshoten med samma now', async () => {
      const { r, exec } = rig('FORTNOX')
      const spy = jest.spyOn(OverdueDebtService.prototype, 'getOverdueSnapshot')
      await r.context.buildContext('O-A', 'OWNER')
      await exec('get_overdue_invoices')
      const nows = spy.mock.calls.map((c) => (c[1] as Date | undefined)?.toISOString())
      spy.mockRestore()
      expect(nows.length).toBeGreaterThanOrEqual(2)
      expect(new Set(nows)).toEqual(new Set(['2026-10-14T12:00:00.000Z']))
    })

    it('verktygsbeskrivningarna säger att hyresavier inte ingår', () => {
      const d = (n: string) => TOOLS.find((t) => t.name === n)!.description ?? ''
      expect(d('get_overdue_invoices')).toMatch(/hyresavier/i)
      expect(d('get_overdue_status')).toMatch(/hyresavier/i)
    })
  })

  describe('P1b — get_rent_notices visar vad som återstår', () => {
    it('meddelandet bär kvar att betala (payableTotal) bredvid bruttot', async () => {
      const { db, r, exec } = rig()
      const row = {
        ...db.notice,
        id: 'N-1',
        status: 'OVERDUE',
        noticeNumber: 'AVI-1',
        ocrNumber: '9000000001',
        tenant: { type: 'INDIVIDUAL', firstName: 'Syn', lastName: 'A' },
      }
      const prisma = {
        rentNotice: {
          findMany: jest.fn(async (a: { where: { status?: unknown } }) =>
            a.where.status && typeof a.where.status === 'object' ? [] : [row],
          ),
          updateMany: jest.fn(),
        },
      }
      Object.assign(r.executor, {
        aviseringService: Object.assign(Object.create(AviseringService.prototype), { prisma }),
      })
      const res = await exec('get_rent_notices', { status: 'OVERDUE' })
      expect(res.success).toBe(true)
      expect(res.message).toContain(`${new Intl.NumberFormat('sv-SE').format(10000)} kr`)
      expect(res.message).toMatch(/kvar att betala 5\s000 kr/)
    })
  })

  describe('P2 — betalda fakturors total är inte bokförd intäkt', () => {
    it('EVENO: bokfordIntakt = resultaträkningens intäkt för samma period, betalda fakturor oförändrade', async () => {
      const { db, r, exec } = rig('EVENO')
      db.prisma.journalEntryLine.findMany.mockResolvedValue([
        { account: { number: 3911, name: 'Hyra' }, debit: 0, credit: 120000 },
      ])
      const pl = await r.accounting.getProfitLossReport('O-A', SEPTEMBER.fromDate, SEPTEMBER.toDate)
      const res = await exec('get_revenue_report', { from: SEPTEMBER.fromDate, to: SEPTEMBER.toDate })
      const data = res.data as unknown as {
        totalRevenue: number
        measure: unknown
        bokfordIntakt: { status: string; belopp: number; period: { from: string; to: string } }
      }
      expect(res.success).toBe(true)
      expect(data.totalRevenue).toBe(0)
      expect(data.measure).toBeDefined()
      expect(unframe(data.bokfordIntakt.status)).toBe('KNOWN')
      expect(data.bokfordIntakt.belopp).toBe(pl.revenue.total)
      expect(unframe(data.bokfordIntakt.period.from)).toBe('2026-09-01')
      expect(unframe(data.bokfordIntakt.period.to)).toBe('2026-09-30')
      expect(data.bokfordIntakt.belopp).toBe(120000)
      expect(unframe(res.message)).toMatch(/^OBS: betalda fakturors total är INTE bokförd intäkt/)
      expect(res.message).toContain('120')
    })

    it('FORTNOX: bokfordIntakt NOT_DETERMINABLE (EXTERNAL_REPORT_UNAVAILABLE), verktyget lyckas ändå, ingen lokal fallback', async () => {
      const { exec } = rig('FORTNOX')
      const res = await exec('get_revenue_report', { from: SEPTEMBER.fromDate, to: SEPTEMBER.toDate })
      const b = (res.data as unknown as { bokfordIntakt: Record<string, unknown> }).bokfordIntakt
      expect(res.success).toBe(true)
      expect(unframe(b['status'])).toBe('NOT_DETERMINABLE')
      expect(unframe(b['reason'])).toBe('EXTERNAL_REPORT_UNAVAILABLE')
      expect(b).not.toHaveProperty('belopp')
    })

    it('kastande resultaträkning ger NOT_DETERMINABLE (READ_FAILED), aldrig 0', async () => {
      const { r, exec } = rig('EVENO')
      jest.spyOn(r.accounting, 'getProfitLossReport').mockRejectedValue(new Error('läsfel'))
      const res = await exec('get_revenue_report', { from: SEPTEMBER.fromDate, to: SEPTEMBER.toDate })
      const b = (res.data as unknown as { bokfordIntakt: Record<string, unknown> }).bokfordIntakt
      expect(res.success).toBe(true)
      expect(unframe(b['status'])).toBe('NOT_DETERMINABLE')
      expect(unframe(b['reason'])).toBe('READ_FAILED')
      expect(b).not.toHaveProperty('belopp')
    })

    it('ingen roll får bokförd intäkt via get_revenue_report som den inte redan får via get_profit_loss_report', () => {
      for (const role of ROLES)
        expect(decideAiToolAccess('get_revenue_report', role)).toEqual(decideAiToolAccess('get_profit_loss_report', role))
    })
  })

  describe('AF20 — trunkerad fastighetslista', () => {
    it('raden säger att övriga namn/ID saknas och hänvisar till get_properties; ingen gissning', async () => {
      const { db, r } = rig()
      const properties = Array.from({ length: 21 }, (_, i) => ({ id: `P-${i + 1}`, name: `Fastighet-${i + 1}`, type: 'RESIDENTIAL', units: [] }))
      db.prisma.property.findMany.mockImplementation(async (...a: unknown[]) => properties.slice(0, (a[0] as { take?: number }).take))
      const ctx = await r.context.buildContext('O-A', 'OWNER')
      const section = ctx.split('## FASTIGHETSLISTA')[1]!.split('##')[0]!
      expect(section).toMatch(/urval: 20 av 21/)
      expect(section).toMatch(/get_properties/)
      expect(section).toMatch(/gissa aldrig/i)
      expect(section).not.toContain('P-21')
    })
  })

  describe('O1 — datum i rapporterna och promptregler (närvaro)', () => {
    it.each(['daily', 'weekly'] as const)('%s: requesten bär dagens datum och vecka (2026-10-14, vecka 42, 2026)', async (kind) => {
      const sdk = sdkScript([done()])
      const { db, r } = rig()
      db.prisma.property.findMany.mockResolvedValue([{ id: 'P-A', name: 'Eken', type: 'RESIDENTIAL', units: [] }])
      if (kind === 'daily') await r.ai.generateDailyInsights('O-A')
      else await r.ai.generateWeeklySummary('O-A')
      const req = json(sdk.requests[0])
      expect(req).toContain('2026-10-14')
      expect(req).toMatch(/vecka 42, 2026/)
      expect(req).toMatch(/räkna inte fram nya belopp/i)
    })

    it.each([
      // 25 okt 2026 (DST slut, UTC+1): 22:30Z = sön 23:30, 23:30Z = mån 00:30 svensk tid.
      ['2026-10-25T22:30:00Z', '2026-10-25', 43, 2026],
      ['2026-10-25T23:30:00Z', '2026-10-26', 44, 2026],
      // ISO-årsskifte: sön 3 jan 2027 hör till vecka 53 2026, mån 4 jan börjar vecka 1 2027.
      ['2027-01-03T22:30:00Z', '2027-01-03', 53, 2026],
      ['2027-01-03T23:30:00Z', '2027-01-04', 1, 2027],
    ] as const)('F-B: %s → svensk dag %s, vecka %s, %s', async (nu, dag, vecka, år) => {
      jest.setSystemTime(date(nu))
      const sdk = sdkScript([done()])
      const { db, r } = rig()
      db.prisma.property.findMany.mockResolvedValue([{ id: 'P-A', name: 'Eken', type: 'RESIDENTIAL', units: [] }])
      await r.ai.generateDailyInsights('O-A')
      const träffar = [...json(sdk.requests[0]).matchAll(/Dagens datum: (\d{4}-\d{2}-\d{2}) \(vecka (\d+), (\d{4})\)/g)]
      expect(träffar.map((m) => [m[1], Number(m[2]), Number(m[3])])).toEqual([[dag, vecka, år]])
    })

    it('chattens systemprompt bär reglerna mot påhittade funktioner/menyvägar och fastighetskopplingar', async () => {
      const sdk = sdkScript([done()])
      const { r } = rig()
      await r.ai.chat('O-A', 'U-A', 'OWNER', 'Hej')
      const system = json(sdk.requests[0]?.system)
      expect(system).toMatch(/menyvägar/i)
      expect(system).toMatch(/koppla inte/i)
      // F-C: legitim beräkning på användarens begäran tillåts men får aldrig presenteras som källfakta.
      expect(system).toMatch(/presentera aldrig en egen uträkning som en uppgift ur underlaget/i)
      expect(system).toMatch(/visa indata och beräkning/i)
      expect(system).not.toMatch(/räkna inte fram nya belopp/i)
    })
  })
})
