// Mocka Sentry på samma sätt som backup.service.spec.ts (referensmönstret).
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))

import { Logger } from '@nestjs/common'
import { captureException } from '@sentry/nestjs'
import { forEachOrgSafely, runCronSafely } from './cron-safety'

const mockedCapture = captureException as jest.Mock

// Tyst logger-spion — bevisar full detalj loggas lokalt utan brus i testutdata.
function fakeLogger(): Logger {
  return { error: jest.fn(), warn: jest.fn(), log: jest.fn() } as unknown as Logger
}

beforeEach(() => {
  mockedCapture.mockClear()
})

describe('runCronSafely', () => {
  it('returnerar kroppens värde och larmar INTE när allt lyckas', async () => {
    const logger = fakeLogger()
    const result = await runCronSafely('happy-cron', async () => 42, { logger })

    expect(result).toBe(42)
    expect(mockedCapture).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('fångar ett kast, larmar Sentry FÖRE swallow, och kastar INTE vidare', async () => {
    const logger = fakeLogger()
    const boom = new Error('transient DB-blipp på första findMany')

    // Sväljs (resolvar undefined) — kastar inte vidare.
    const result = await runCronSafely(
      'rent-reminder',
      async () => {
        throw boom
      },
      { logger },
    )

    expect(result).toBeUndefined()

    // Full detalj till lokal logg (rapporterar felet, döljer det inte).
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect((logger.error as jest.Mock).mock.calls[0][0]).toContain('transient DB-blipp')

    // Sentry: skrubbat meddelande (INTE originalet) + cron-tagg.
    expect(mockedCapture).toHaveBeenCalledTimes(1)
    const [sentryErr, ctx] = mockedCapture.mock.calls[0]
    expect(sentryErr).toBeInstanceOf(Error)
    expect((sentryErr as Error).message).toContain('rent-reminder')
    expect((sentryErr as Error).message).not.toContain('DB-blipp') // skrubbat
    expect(ctx).toEqual(
      expect.objectContaining({ tags: expect.objectContaining({ cron: 'rent-reminder' }) }),
    )
  })
})

describe('forEachOrgSafely', () => {
  it('kör alla items och returnerar TOM fel-lista utan larm när allt lyckas', async () => {
    const logger = fakeLogger()
    const processed: number[] = []

    const failures = await forEachOrgSafely(
      'ok-cron',
      [1, 2, 3],
      async (n) => {
        processed.push(n)
      },
      { logger },
    )

    expect(processed).toEqual([1, 2, 3])
    expect(failures).toEqual([])
    expect(mockedCapture).not.toHaveBeenCalled()
  })

  it('isolerar ett fel: item 1 och 3 körs ändå, item 2:s fel hamnar i listan + Sentry med org-kontext', async () => {
    const logger = fakeLogger()
    const processed: string[] = []
    const items = [
      { id: 'a', organizationId: 'org-1' },
      { id: 'b', organizationId: 'org-2' },
      { id: 'c', organizationId: 'org-3' },
    ]
    const boom = new Error('org-2 kraschade')

    const failures = await forEachOrgSafely(
      'rent-bad-debt',
      items,
      async (item) => {
        if (item.id === 'b') throw boom
        processed.push(item.id)
      },
      { logger, orgIdOf: (item) => item.organizationId },
    )

    // Isolering: item 2 avbröt INTE item 3.
    expect(processed).toEqual(['a', 'c'])

    // Fel-listan: exakt item 2:s fel, inget mer.
    expect(failures).toEqual([{ item: items[1], error: boom }])

    // Sentry: en gång, för org-2, skrubbat meddelande + org-tagg.
    expect(mockedCapture).toHaveBeenCalledTimes(1)
    const [sentryErr, ctx] = mockedCapture.mock.calls[0]
    expect((sentryErr as Error).message).not.toContain('kraschade') // skrubbat
    expect(ctx).toEqual(
      expect.objectContaining({
        tags: expect.objectContaining({ cron: 'rent-bad-debt', org: 'org-2' }),
      }),
    )

    // Lokal logg fick org-kontext + full detalj.
    const logCall = (logger.error as jest.Mock).mock.calls[0][0] as string
    expect(logCall).toContain('org-2')
    expect(logCall).toContain('org-2 kraschade')
  })

  it('äger INTE utfallstaxonomin: returnerar ENBART fel-listan (ingen summary/notis)', async () => {
    const logger = fakeLogger()
    const notify = jest.fn()

    const failures = await forEachOrgSafely(
      'taxonomy-cron',
      [{ organizationId: 'org-x' }],
      async () => {
        throw new Error('fail')
      },
      { logger, orgIdOf: (i) => i.organizationId },
    )

    // Returvärdet är EXAKT fel-listan (en array), inte ett summary-objekt.
    expect(Array.isArray(failures)).toBe(true)
    expect(failures).toHaveLength(1)
    const [failure] = failures
    expect(Object.keys(failure!).sort()).toEqual(['error', 'item'])

    // Hjälparen skickar ingen notis själv — den känner inte ens till notify.
    expect(notify).not.toHaveBeenCalled()
  })
})
