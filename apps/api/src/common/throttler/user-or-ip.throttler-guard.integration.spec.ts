/**
 * STRYPER STRYPNINGEN FAKTISKT? — och varför just den frågan behövde ett test.
 *
 * `auth-throttle-mode.spec.ts` bevakar att E2E-uppmjukningen inte går att sätta
 * i produktion: sju flaggvarianter, båda fail-fast-lagren. Det är sju tester på
 * att skyddet inte kan STÄNGAS AV — och noll på att det FUNGERAR när det är på.
 *
 * Före den här filen fanns inget test i hela kodbasen som gav ett 429. Sökning
 * på `429|ThrottlerException` över samtliga specar: tom.
 *
 * Det spelar roll nu, av ett skäl PR:en själv skapar: E2E-sviten kommer att köra
 * med `E2E_RELAX_AUTH_THROTTLE=true`, alltså med strypningen HELT frånvarande.
 * Ett E2E kan därför bli grönt medan verkliga användare möter 429 — och en
 * regression I strypningen fångas inte av det jobb som är tänkt att fånga
 * regressioner. Den här filen är då den enda platsen kontrollen bevisas alls.
 *
 * ── Vad testet gör ──────────────────────────────────────────────────────────
 *
 * Bootar en riktig Nest-app på Fastify med den RIKTIGA `UserOrIpThrottlerGuard`
 * och den riktiga `ThrottlerModule`, mot en endpoint med `@Throttle` — och
 * hamrar tills taket slår. Ingen attrapp: en attrapp-guard hade bara bevisat att
 * attrappen är konsekvent med sig själv (samma skäl som selectvakterna anger).
 *
 * Läget styrs via `process.env` före modulbygget, eftersom guarden löser sitt
 * läge EN gång i konstruktorn — vilket är hela poängen med den designen.
 */

import { Controller, Get, Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { Throttle, ThrottlerModule } from '@nestjs/throttler'
import { UserOrIpThrottlerGuard } from './user-or-ip.throttler-guard'
import { E2E_AUTH_THROTTLE_FLAG } from './auth-throttle-mode'

// Samma form som auth-endpointsen: lågt tak, långt fönster.
const TAK = 3

@Controller('probe')
class ProbeController {
  @Get('login')
  @Throttle({ default: { limit: TAK, ttl: 60_000 } })
  login(): { ok: true } {
    return { ok: true }
  }
}

@Module({
  imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 100 }] })],
  controllers: [ProbeController],
  providers: [{ provide: APP_GUARD, useClass: UserOrIpThrottlerGuard }],
})
class ProbeModule {}

async function bootaApp(): Promise<NestFastifyApplication> {
  const modul = await Test.createTestingModule({ imports: [ProbeModule] }).compile()
  const app = modul.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

/** Skjuter n requests i följd och returnerar statuskoderna. */
async function hamra(app: NestFastifyApplication, n: number): Promise<number[]> {
  const koder: number[] = []
  for (let i = 0; i < n; i++) {
    const res = await app.inject({ method: 'GET', url: '/probe/login' })
    koder.push(res.statusCode)
  }
  return koder
}

describe('UserOrIpThrottlerGuard — strikt läge', () => {
  const original = process.env[E2E_AUTH_THROTTLE_FLAG]
  let app: NestFastifyApplication

  beforeAll(async () => {
    delete process.env[E2E_AUTH_THROTTLE_FLAG]
    app = await bootaApp()
  })

  afterAll(async () => {
    await app.close()
    if (original === undefined) delete process.env[E2E_AUTH_THROTTLE_FLAG]
    else process.env[E2E_AUTH_THROTTLE_FLAG] = original
  })

  it('släpper igenom upp till taket och stryper därefter (429)', async () => {
    const koder = await hamra(app, TAK + 2)

    // De första TAK ska passera …
    expect(koder.slice(0, TAK)).toEqual(Array(TAK).fill(200))
    // … och allt därefter strypas. DET är påståendet som saknades helt.
    expect(koder.slice(TAK)).toEqual([429, 429])
  })
})

describe('UserOrIpThrottlerGuard — E2E-uppmjukat läge', () => {
  const original = process.env[E2E_AUTH_THROTTLE_FLAG]
  let app: NestFastifyApplication

  beforeAll(async () => {
    process.env[E2E_AUTH_THROTTLE_FLAG] = 'true'
    // NODE_ENV är 'test' under Jest, så uppmjukningen är tillåten här.
    app = await bootaApp()
  })

  afterAll(async () => {
    await app.close()
    if (original === undefined) delete process.env[E2E_AUTH_THROTTLE_FLAG]
    else process.env[E2E_AUTH_THROTTLE_FLAG] = original
  })

  it('stryper inte alls — och det är skillnaden E2E-sviten kör med', async () => {
    // Positiv kontroll på uppmjukningen, och samtidigt den explicita
    // dokumentationen av vad E2E-jobbet INTE testar: här finns ingen 429 att
    // regressera på.
    const koder = await hamra(app, TAK + 5)
    expect(koder).toEqual(Array(TAK + 5).fill(200))
  })
})
