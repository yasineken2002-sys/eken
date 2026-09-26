import { createRequire } from 'node:module'
import { HttpStatus } from '@nestjs/common'
import { betroddaRamverksfel, trustedFrameworkClientError } from './trusted-framework-errors'

/**
 * Kanariefågeln för listan i trusted-framework-errors.ts.
 *
 * Klassningen går BLIND på två sätt utan att något blir rött: om adapterns
 * fastify byter namn på felkoden (klassen hittas inte → allt blir 500 igen),
 * eller om uppslaget binds mot fel fastify (apps/api:s egen 5.x, vars klass
 * parsern aldrig kastar). Båda fångas här: varje post MÅSTE finnas, och ett fel
 * skapat av ADAPTERNS klass MÅSTE klassas medan en förfalskning inte får det.
 *
 * Den här specen ser inte att filtret använder klassningen, eller vad en riktig
 * begäran får för svar — det ägs av empty-json-body-http.db.spec.ts.
 */

const adapternsFastify = createRequire(require.resolve('@nestjs/platform-fastify'))('fastify') as {
  errorCodes: Record<string, new () => Error>
}

describe('betrodda ramverksfel', () => {
  it('listan är inte tom, och varje post finns i ADAPTERNS fastify', () => {
    const poster = betroddaRamverksfel()
    expect(poster.length).toBeGreaterThan(0)
    expect(poster.filter((p) => !p.finns)).toEqual([])
  })

  it('ett tomt-JSON-fel skapat av adapterns klass → 400 med listans svenska text', () => {
    const Klass = adapternsFastify.errorCodes['FST_ERR_CTP_EMPTY_JSON_BODY']!
    const utfall = trustedFrameworkClientError(new Klass())
    expect(utfall?.status).toBe(HttpStatus.BAD_REQUEST)
    expect(utfall?.message).not.toMatch(/FST_ERR|content-type is set/)
  })

  it.each([
    ['vanligt Error', new Error('x')],
    ['Error med statusCode 400', Object.assign(new Error('x'), { statusCode: 400 })],
    [
      'förfalskning med samma code, statusCode och name',
      Object.assign(new Error('x'), {
        code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
        statusCode: 400,
        name: 'FastifyError',
      }),
    ],
    ['icke-Error', { code: 'FST_ERR_CTP_EMPTY_JSON_BODY', statusCode: 400 }],
    ['null', null],
  ])('%s → inte betrott', (_n, fel) => {
    expect(trustedFrameworkClientError(fel)).toBeNull()
  })
})
