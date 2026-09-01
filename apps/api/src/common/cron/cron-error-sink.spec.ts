import { Logger } from '@nestjs/common'
import { CronErrorSink } from './cron-error-sink'
import { runCronSafely, forEachOrgSafely } from './cron-safety'
import type { PlatformErrorsService } from '../../platform/errors/platform-errors.service'

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))

/**
 * #605 — ETT CRON-FEL SKA GÅ ATT HITTA I MORGON.
 *
 * Mätt mot `befee7b`: 25 @Cron-jobb, 0 skriver till ErrorLog, 13 har ENDAST den
 * lokala loggen. Containerloggen överlever inte nästa deploy — 204 merges till
 * main på 30 dagar betyder minst lika många containerbyten.
 *
 * ── VAD SPECEN MÄTER ────────────────────────────────────────────────────────
 *
 * Inte "anropades sänkan" isolerat, utan SKILLNADEN: samma framkallade fel, en
 * gång utan sänka och en gång med. Utan den finns felet ingenstans varaktigt;
 * med den finns det i ErrorLog. Ett prov som bara visar det andra fallet skulle
 * inte skilja "sänkan fungerar" från "sänkan anropas alltid".
 */
describe('#605 varaktig felsänka för cron', () => {
  const gör = () => {
    const skrivna: Array<Record<string, unknown>> = []
    const errors = {
      logInternalError: jest.fn(async (p: Record<string, unknown>) => {
        skrivna.push(p)
      }),
    } as unknown as PlatformErrorsService
    return { skrivna, errors, sink: new CronErrorSink(errors) }
  }
  const tyst = new Logger('test-tyst')
  beforeAll(() => {
    jest.spyOn(tyst, 'error').mockImplementation(() => undefined)
  })

  it('UTAN sänka: felet framkallas, körningen fortsätter — och ingenting skrivs', async () => {
    const { skrivna } = gör()
    const ut = await runCronSafely(
      'qq-utan',
      async () => {
        throw new Error('QQCRON-fel')
      },
      { logger: tyst },
    )
    expect(ut).toBeUndefined() // felet sväljs, som förut
    expect(skrivna).toHaveLength(0) // ← och finns ingenstans varaktigt
  })

  it('MED sänka: samma fel finns kvar i ErrorLog när körningen återvänder', async () => {
    const { skrivna, sink } = gör()
    const ut = await runCronSafely(
      'qq-med',
      async () => {
        throw new Error('QQCRON-fel')
      },
      { logger: tyst, sink },
    )
    expect(ut).toBeUndefined()
    // KÄRNAN: skrivningen är SLUTFÖRD när runCronSafely återvänder — inte en
    // flytande promise som en nedstängning kan hinna före (#586:s läxa).
    expect(skrivna).toHaveLength(1)
    expect(skrivna[0]).toMatchObject({ severity: 'CRITICAL', source: 'API' })
    expect(String(skrivna[0]!['message'])).toContain('[cron:qq-med]')
    expect(String(skrivna[0]!['message'])).toContain('QQCRON-fel')
    expect(skrivna[0]!['context']).toMatchObject({ cron: 'qq-med' })
  })

  it('per-org: UTAN sänka försvinner det org-specifika felet, MED sänka bär det org-id', async () => {
    const orgar = [{ id: 'org-1' }, { id: 'org-2' }]
    const faller = async (o: { id: string }) => {
      if (o.id === 'org-2') throw new Error('QQCRON-org')
    }

    const utan = gör()
    const f1 = await forEachOrgSafely('qq-org', orgar, faller, {
      logger: tyst,
      orgIdOf: (o) => o.id,
    })
    expect(f1).toHaveLength(1) // körningen VET om felet …
    expect(utan.skrivna).toHaveLength(0) // … men ingen annan gör det i morgon

    const med = gör()
    const f2 = await forEachOrgSafely('qq-org', orgar, faller, {
      logger: tyst,
      orgIdOf: (o) => o.id,
      sink: med.sink,
    })
    expect(f2).toHaveLength(1)
    expect(med.skrivna).toHaveLength(1)
    expect(med.skrivna[0]).toMatchObject({ organizationId: 'org-2' })
  })

  it('en död databas hänger inte cronet — och tystnar inte', async () => {
    const errors = {
      logInternalError: jest.fn(() => new Promise<void>(() => {})),
    } as unknown as PlatformErrorsService
    const sink = new CronErrorSink(errors)
    const loggat: string[] = []
    jest
      .spyOn(sink['logger'], 'error')
      .mockImplementation((m: unknown) => void loggat.push(String(m)))

    jest.useFakeTimers()
    const p = sink.report('qq-hang', new Error('QQCRON-hang'))
    await jest.advanceTimersByTimeAsync(2_100)
    await p
    jest.useRealTimers()

    // Förlusten är HÖGLJUDD, inte tyst — samma princip som #586.
    expect(loggat.some((m) => m.includes('slutfördes inte inom'))).toBe(true)
  })

  it('sänkan kastar aldrig vidare — den får inte bli orsaken till att cronet faller', async () => {
    const errors = {
      logInternalError: jest.fn(async () => {
        throw new Error('QQCRON-sänkan-sprack')
      }),
    } as unknown as PlatformErrorsService
    const sink = new CronErrorSink(errors)
    jest.spyOn(sink['logger'], 'error').mockImplementation(() => undefined)
    await expect(sink.report('qq-sprack', new Error('x'))).resolves.toBeUndefined()
  })
})
