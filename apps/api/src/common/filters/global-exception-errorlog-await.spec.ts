import { HttpStatus } from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'
import { GlobalExceptionFilter } from './global-exception.filter'
import type { PlatformErrorsService } from '../../platform/errors/platform-errors.service'

/**
 * #586 — ETT FEL FÅR INTE TAPPAS TYST.
 *
 * Filtret skrev tidigare `void this.errorsService.logInternalError(...)`.
 * Promisen flöt fritt: `catch` returnerade, svaret gick ut, och skrivningen låg
 * kvar i mikrotask-kön. Går processen ner däremellan är felet borta — och
 * eftersom `logInternalError` fångar sitt EGET fel och loggar det, blir
 * förlusten TYST. En tom ErrorLog betyder då antingen "inget fel" eller "felet
 * hann inte skrivas", och de två går inte att skilja åt i efterhand.
 *
 * ── VAD SPECEN FAKTISKT MÄTER ──────────────────────────────────────────────
 *
 * Inte "anropades logInternalError" — det gjorde den även med `void`, och en
 * spec som bara mäter det hade varit grön HELA TIDEN. Den mäter om skrivningen
 * hade HUNNIT SLUTFÖRAS när `catch` gav tillbaka kontrollen. Det är precis den
 * skillnad ett SIGTERM i samma ögonblick gör synlig.
 */

const hostFör = (req: Partial<{ url: string; method: string; ip: string }> = {}) => {
  const reply = { status: jest.fn().mockReturnThis(), send: jest.fn().mockResolvedValue(undefined) }
  const request = { url: '/qqtappat', method: 'GET', ip: '127.0.0.1', ...req }
  return {
    host: {
      switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }),
    } as unknown as ArgumentsHost,
    reply,
  }
}

describe('#586 GlobalExceptionFilter inväntar ErrorLog-skrivningen', () => {
  it('skrivningen är SLUTFÖRD när catch återvänder (med void var den det inte)', async () => {
    let skriven = false
    // En skrivning som tar en tick — som en riktig INSERT gör.
    const errors = {
      logInternalError: jest.fn(
        async () =>
          new Promise<void>((r) =>
            setTimeout(() => {
              skriven = true
              r()
            }, 10),
          ),
      ),
    } as unknown as PlatformErrorsService

    const filter = new GlobalExceptionFilter(errors)
    const { host, reply } = hostFör()

    await filter.catch(new Error('QQTAPPAT-fel'), host)

    // KÄRNAN: hade filtret gjort `void` vore skriven=false här — promisen låg
    // kvar i kön och ett SIGTERM i det ögonblicket hade tappat felet.
    expect(skriven).toBe(true)
    expect(errors.logInternalError).toHaveBeenCalledTimes(1)
    expect(reply.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR)
  })

  it('KANARIEFÅGEL: den gamla void-formen hade gett motsatt utfall', async () => {
    // Samma skrivning, men startad som en flytande promise — alltså exakt det
    // filtret gjorde före #586. Utan den här jämförelsen kan provet ovan inte
    // skilja "filtret väntar" från "skrivningen råkade vara synkron".
    let skriven = false
    const write = () =>
      new Promise<void>((r) =>
        setTimeout(() => {
          skriven = true
          r()
        }, 10),
      )
    void write()
    expect(skriven).toBe(false) // tappat, om processen dör nu
    await new Promise((r) => setTimeout(r, 20))
    expect(skriven).toBe(true)
  })

  it('en långsam skrivning håller inte upp svaret för alltid — och tystnar inte', async () => {
    const loggat: string[] = []
    const errors = {
      // Slutförs aldrig: en död databas.
      logInternalError: jest.fn(() => new Promise<void>(() => {})),
    } as unknown as PlatformErrorsService
    const filter = new GlobalExceptionFilter(errors)
    jest
      .spyOn(filter['logger'], 'error')
      .mockImplementation((msg: unknown) => void loggat.push(String(msg)))

    const { host, reply } = hostFör()
    jest.useFakeTimers()
    const p = filter.catch(new Error('QQTAPPAT-hang'), host)
    await jest.advanceTimersByTimeAsync(2_100)
    await p
    jest.useRealTimers()

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR)
    // Förlusten är HÖGLJUDD, inte tyst — det är hela skillnaden mot #586.
    expect(loggat.some((m) => m.includes('slutfördes inte inom'))).toBe(true)
  })

  it('4xx rör aldrig ErrorLog', async () => {
    const errors = { logInternalError: jest.fn() } as unknown as PlatformErrorsService
    const filter = new GlobalExceptionFilter(errors)
    const { host } = hostFör()
    const { HttpException } = await import('@nestjs/common')
    await filter.catch(new HttpException('nej', HttpStatus.BAD_REQUEST), host)
    expect(errors.logInternalError).not.toHaveBeenCalled()
  })
})
