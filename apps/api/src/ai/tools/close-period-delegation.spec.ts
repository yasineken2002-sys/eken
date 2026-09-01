/**
 * T5 PR1a — AI-verktyget `close_period` delegerar till AccountingPeriodService.
 *
 * Före PR1a hade verktyget en EGEN inline-implementation (egen
 * closedAccountingPeriod.create, egen summary-beräkning) och INGEN
 * förhandskontroll — det kunde stänga en period med ett obalanserat verifikat.
 * Nu finns en stängningsväg, och verktyget ärver därmed spärren.
 *
 * Testerna vaktar ADAPTERN: att ett blockerande fynd blir ett läsbart svar i
 * stället för ett kast, och att varningar följer med i klartext.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ConflictException, ForbiddenException } from '@nestjs/common'
import { ToolExecutorService } from './tool-executor.service'

function makeExecutor(periods: Record<string, unknown>) {
  const noop = {} as never
  const audit = {
    logToolExecution: jest.fn().mockResolvedValue(undefined),
    // Steg 3b: produktionsvägen öppnar och stänger spåret för FÖRE_EFFEKTEN-verktyg.
    beginToolExecution: jest.fn().mockResolvedValue(undefined),
    completeToolExecution: jest.fn().mockResolvedValue(undefined),
  }
  // 24 positionsargument — accountingPeriods är den 24:e (sist).
  return new ToolExecutorService(
    noop, // 1 prisma
    noop, // 2 invoicesService
    noop, // 3 pdfService
    noop, // 4 tenantsService
    noop, // 5 leasesService
    noop, // 6 rentIncreasesService
    noop, // 7 propertiesService
    noop, // 8 unitsService
    noop, // 9 accountingService
    noop, // 10 verifikationsnummer
    noop, // 11 mailService
    noop, // 12 maintenanceService
    noop, // 13 aviseringService
    noop, // 14 inspectionsService
    noop, // 15 maintenancePlanService
    noop, // 16 reconciliationService
    noop, // 17 collectionExport
    noop, // 18 paymentReminders
    noop, // 19 storage
    noop, // 20 redis
    audit as never, // 21 audit
    noop, // 22 documentDelivery
    noop, // 23 signingService
    periods as never, // 24 accountingPeriods
  )
}

const SUMMARY = {
  month: 5,
  year: 2026,
  revenue: 12000,
  expenses: 4000,
  result: 8000,
  entriesCount: 3,
  generatedAt: '2026-06-01T00:00:00.000Z',
}

async function run(executor: ToolExecutorService, input: Record<string, unknown>) {
  return (
    executor as unknown as {
      executeToolUnsafe: (
        name: string,
        input: Record<string, unknown>,
        orgId: string,
        userId: string,
        role: string,
      ) => Promise<{ success: boolean; message: string; data?: unknown }>
    }
  ).executeToolUnsafe('close_period', input, 'org-1', 'user-1', 'ACCOUNTANT')
}

describe('T5 PR1a · close_period delegerar till periodtjänsten', () => {
  it('lyckad stängning återger resultatet och delegerar med rätt argument', async () => {
    const closePeriod = jest
      .fn()
      .mockResolvedValue({ year: 2026, month: 5, summary: SUMMARY, checks: [] })
    const res = await run(makeExecutor({ closePeriod }), { year: 2026, month: 5 })

    expect(closePeriod).toHaveBeenCalledWith('org-1', 2026, 5, {
      actorRole: 'ACCOUNTANT',
      actorUserId: 'user-1',
    })
    expect(res.success).toBe(true)
    expect(res.message).toContain('Period 2026-05 stängd')
    expect(res.data).toEqual(SUMMARY)
  })

  it('varningar följer med i svaret så assistenten kan återge dem', async () => {
    const closePeriod = jest.fn().mockResolvedValue({
      year: 2026,
      month: 5,
      summary: SUMMARY,
      checks: [
        {
          code: 'unbilled-leases',
          severity: 'warning',
          message: '2 aktivt kontrakt saknar hyresavi för månaden.',
          count: 2,
        },
      ],
    })
    const res = await run(makeExecutor({ closePeriod }), { year: 2026, month: 5 })

    expect(res.success).toBe(true)
    expect(res.message).toContain('Observera')
    expect(res.message).toContain('saknar hyresavi')
  })

  it('blockerande fynd blir ett läsbart NEJ, inte ett kast', async () => {
    const closePeriod = jest
      .fn()
      .mockRejectedValue(
        new ConflictException(
          'Perioden kan inte stängas: 1 verifikat i perioden balanserar inte (debet ≠ kredit).',
        ),
      )
    const res = await run(makeExecutor({ closePeriod }), { year: 2026, month: 5 })

    expect(res.success).toBe(false)
    expect(res.message).toContain('balanserar inte')
  })

  it('otillräcklig roll nekas av tjänsten och rapporteras utan att läcka stack', async () => {
    const closePeriod = jest
      .fn()
      .mockRejectedValue(
        new ForbiddenException('Du saknar behörighet att stänga en bokföringsperiod'),
      )
    const res = await run(makeExecutor({ closePeriod }), { year: 2026, month: 5 })

    expect(res.success).toBe(false)
    expect(res.message).toBe('Du saknar behörighet att stänga en bokföringsperiod')
    expect(res.message).not.toContain('at ') // ingen stack-form
  })

  it('ogiltig månad avvisas innan tjänsten ens anropas', async () => {
    const closePeriod = jest.fn()
    const res = await run(makeExecutor({ closePeriod }), { year: 2026, month: 13 })

    expect(res.success).toBe(false)
    expect(closePeriod).not.toHaveBeenCalled()
  })
})
