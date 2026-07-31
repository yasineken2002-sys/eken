import { Logger } from '@nestjs/common'
import * as Sentry from '@sentry/nestjs'
import { enqueueSafely, isEnqueueProblem, ENQUEUE_TIMEOUT_MS } from './enqueue-safety'

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))

const captureException = Sentry.captureException as jest.MockedFunction<
  typeof Sentry.captureException
>

const OPTS = {
  queue: 'lease-activation',
  jobType: 'create-initial-notices',
  organizationId: 'org-uuid-1',
}

describe('enqueueSafely (T5 C2a / #58)', () => {
  let logger: Logger
  let errorSpy: jest.SpyInstance
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    logger = new Logger('test')
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined)
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
  })

  it('normalfallet: returnerar ok med jobId, larmar INTE och loggar inget fel', async () => {
    const outcome = await enqueueSafely(async () => 'job-42', { ...OPTS, logger })

    expect(outcome).toEqual({ status: 'ok', jobId: 'job-42' })
    expect(isEnqueueProblem(outcome)).toBe(false)
    expect(captureException).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('normalfallet loggar INTE "landade SENT" (regression: mikrotask-ordningen)', async () => {
    // Observatören på inflight registreras före race:ets fortsättning och kör
    // därför först. Med en "klar i tid"-flagga satt i fortsättningen loggades
    // VARJE lyckat enqueue som ett sent falsklarm.
    await enqueueSafely(async () => 'job-7', { ...OPTS, logger })
    await new Promise((r) => setTimeout(r, 20))

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('golvet löser aldrig ut i normalfallet (mätt 0–27 ms mot 5 s golv)', async () => {
    const started = Date.now()
    const outcome = await enqueueSafely(async () => 'job-1', { ...OPTS, logger })

    expect(outcome.status).toBe('ok')
    expect(Date.now() - started).toBeLessThan(ENQUEUE_TIMEOUT_MS / 2)
  })

  it('enqueue-fel: larmar via Sentry FÖRE swallow, kastar inte, returnerar failed', async () => {
    const boom = new Error('MaxRetriesPerRequestError: Reached the max retries per request limit')
    const outcome = await enqueueSafely(() => Promise.reject(boom), { ...OPTS, logger })

    expect(outcome.status).toBe('failed')
    expect(isEnqueueProblem(outcome)).toBe(true)
    expect(captureException).toHaveBeenCalledTimes(1)

    // Taggar: kö, jobbtyp och org (UUID — säker korrelationsnyckel, ej PII).
    const [, ctx] = captureException.mock.calls[0] as [unknown, { tags: Record<string, string> }]
    expect(ctx.tags).toEqual({
      queue: 'lease-activation',
      jobType: 'create-initial-notices',
      org: 'org-uuid-1',
    })

    // Full detalj hamnar i den LOKALA loggen.
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('MaxRetriesPerRequestError')
  })

  it('skrubbning: originalfeltexten läcker ALDRIG till Sentry', async () => {
    const secret = new Error('connect ECONNREFUSED 10.0.0.7:6379 (intern infra)')
    await enqueueSafely(() => Promise.reject(secret), { ...OPTS, logger })

    const [captured] = captureException.mock.calls[0] as [Error]
    expect(captured.message).not.toContain('ECONNREFUSED')
    expect(captured.message).not.toContain('10.0.0.7')
    expect(captured.message).toBe(
      'Enqueue lease-activation/create-initial-notices misslyckades (se serverlogg för detalj)',
    )
  })

  it('hängande enqueue: golvas av timeouten i stället för att blockera (mätt: annars minuter)', async () => {
    const started = Date.now()
    // Löser sig ALDRIG — speglar den frusna Redis vi mätte (pending >240 s).
    const outcome = await enqueueSafely(() => new Promise<string>(() => undefined), {
      ...OPTS,
      logger,
      timeoutMs: 60,
    })
    const elapsed = Date.now() - started

    expect(outcome.status).toBe('timeout')
    expect(isEnqueueProblem(outcome)).toBe(true)
    expect(elapsed).toBeLessThan(2000) // bounded, inte minuter
    expect(captureException).toHaveBeenCalledTimes(1)
    const [captured] = captureException.mock.calls[0] as [Error]
    expect(captured.message).toContain('bekräftades inte inom tidsgränsen')
  })

  it('sen REJECTION efter timeout blir aldrig en unhandled rejection (skulle ge process.exit(1))', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    let rejectLate: (e: Error) => void = () => undefined
    const outcome = await enqueueSafely(
      () =>
        new Promise<string>((_, reject) => {
          rejectLate = reject
        }),
      { ...OPTS, logger, timeoutMs: 30 },
    )
    expect(outcome.status).toBe('timeout')

    // Redis ger upp långt efter att vi redan larmat (mätt: 233 s).
    rejectLate(new Error('MaxRetriesPerRequestError'))
    await new Promise((r) => setTimeout(r, 50))

    process.off('unhandledRejection', onUnhandled)
    expect(unhandled).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('misslyckades SENT'))
  })

  it('sent LANDAT jobb efter timeout loggas som falsklarm (och kastar inte)', async () => {
    let resolveLate: (id: string) => void = () => undefined
    const outcome = await enqueueSafely(
      () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve
        }),
      { ...OPTS, logger, timeoutMs: 30 },
    )
    expect(outcome.status).toBe('timeout')

    resolveLate('job-99')
    await new Promise((r) => setTimeout(r, 50))

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('landade SENT'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('falsklarm'))
  })

  it('org utelämnad: taggen finns men är undefined, inget kastar', async () => {
    const outcome = await enqueueSafely(() => Promise.reject(new Error('nere')), {
      queue: 'pdf',
      jobType: 'avisering-reminder',
      logger,
    })

    expect(outcome.status).toBe('failed')
    const [, ctx] = captureException.mock.calls[0] as [unknown, { tags: Record<string, unknown> }]
    expect(ctx.tags.queue).toBe('pdf')
    expect(ctx.tags.org).toBeUndefined()
  })
})
