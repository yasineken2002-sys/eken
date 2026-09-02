/**
 * ÄR `POST /platform/errors/report` FAKTISKT STÄNGD? (#612)
 *
 * ── Varför en integrationstest och inte bara goldenfilen ────────────────────
 *
 * `authz-surface.golden.txt` flyttar rutten från "VERKLIGT ÖPPNA" till
 * "PlatformGuard" i samma commit, och den raden är ett bra bevis — men det är
 * en KOPPLINGSKONTROLL. Den läser dekoratorer. Den kan inte se om en
 * anonym request ändå går igenom, av samma skäl som CLAUDE.md-avsnittet
 * "Skriv i varje vakt vad den INTE kan se" beskriver.
 *
 * Den här filen bootar i stället en riktig Nest-app på Fastify med den RIKTIGA
 * `JwtAuthGuard` som global vakt och den RIKTIGA `PlatformGuard` +
 * `PlatformJwtStrategy`, och skjuter riktiga requests.
 *
 * ── Den skarpa formen: `@Public()` betyder inte "oskyddad" ──────────────────
 *
 * Plattformsrutter bär `@Public()` för att stänga av ORG-JWT:n, och lägger
 * `PlatformGuard` ovanpå. Defekten var att `report` bara hade den första
 * halvan — den SÅG ut som resten av filen och gjorde motsatsen. Testet nedan
 * kör därför med den globala `JwtAuthGuard` PÅ, så att en borttagen
 * `PlatformGuard` inte ger 401 av misstag utan går rakt igenom.
 *
 * NEGATIVKONTROLL (mätt, se PR-texten): tas `@UseGuards(PlatformGuard)` bort
 * från rutten svarar det anonyma anropet 202 i stället för 401, och
 * `logInternalError` anropas — alltså faller `avvisar anonym rapport`.
 *
 * ── Vad den här filen INTE ser ─────────────────────────────────────────────
 *
 * Den mäter behörigheten på rutten. Den säger ingenting om vad som HAMNAR i
 * `ErrorLog` (fritextens innehåll), om gallring, eller om vem som får LÄSA
 * tabellen. Det ägs av #612:s andra halva.
 */

import { Module, ValidationPipe } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ConfigModule } from '@nestjs/config'
import { PassportModule } from '@nestjs/passport'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { JwtService } from '@nestjs/jwt'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { PlatformJwtStrategy } from '../auth/platform-jwt.strategy'
import { PlatformErrorsController } from './platform-errors.controller'
import { PlatformErrorsService } from './platform-errors.service'

const HEMLIGHET = 'test-platform-secret-612'
const jwt = new JwtService({ secret: HEMLIGHET })

const loggaFel = jest.fn()

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // `ignoreEnvFile` stoppar FILEN apps/api/.env. Den stoppar INTE en
      // variabel som redan står i process.env — där vinner process.env över
      // `load:`. Nollställningen i beforeAll nedan är det som gör `load:`
      // bindande; utan den verifierar guarden med utvecklarens egen hemlighet
      // medan testet signerar med HEMLIGHET, och två fall faller med 401.
      ignoreEnvFile: true,
      load: [() => ({ PLATFORM_JWT_SECRET: HEMLIGHET })],
    }),
    PassportModule,
  ],
  controllers: [PlatformErrorsController],
  providers: [
    PlatformJwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Tjänsten attrapperas: frågan här är BEHÖRIGHET, inte skrivningen. Att den
    // aldrig anropas är dessutom halva assertionen i det anonyma fallet.
    {
      provide: PlatformErrorsService,
      useValue: {
        logFrontendError: loggaFel,
        list: jest.fn(),
        resolve: jest.fn(),
        summary: jest.fn(),
      },
    },
  ],
})
class ProvModul {}

const giltigRapport = {
  severity: 'ERROR' as const,
  source: 'ADMIN' as const,
  message: 'sond-612: något gick sönder',
  stack: 'Error: sond-612\n    at x (y.tsx:1:1)',
  context: { path: '/organizations' },
}

function plattformsToken(): string {
  return jwt.sign({ sub: 'platform-user-1', type: 'platform' }, { expiresIn: '5m' })
}

describe('POST /platform/errors/report · behörighet (#612)', () => {
  let app: NestFastifyApplication

  // Samma nollställ-och-återställ som env.validation.integration.spec.ts gör i
  // sin boot()/afterEach. Sparas FÖRE nollställningen och läggs tillbaka exakt
  // — inklusive fallet "var inte satt", som ska förbli osatt.
  const sparadHemlighet = process.env.PLATFORM_JWT_SECRET

  beforeAll(async () => {
    delete process.env.PLATFORM_JWT_SECRET
    const modul = await Test.createTestingModule({ imports: [ProvModul] }).compile()
    app = modul.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    // SAMMA pipe som main.ts:150 — inte en förenklad variant. `whitelist` +
    // `forbidNonWhitelisted` är just det som gör ett borttaget DTO-fält till en
    // avvisning i stället för en tyst strippning, och testet nedan mäter den
    // skillnaden. En attrapp-pipe hade bevisat något annat än produktionen gör.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    )
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
    if (sparadHemlighet === undefined) delete process.env.PLATFORM_JWT_SECRET
    else process.env.PLATFORM_JWT_SECRET = sparadHemlighet
  })

  beforeEach(() => loggaFel.mockClear())

  it('avvisar anonym rapport (401) och skriver ingenting', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/platform/errors/report',
      payload: giltigRapport,
    })

    expect(res.statusCode).toBe(401)
    expect(loggaFel).not.toHaveBeenCalled()
  })

  it('avvisar en ORG-token — plattformsrutten tar inte hyresvärdens JWT', async () => {
    // Signerad med rätt hemlighet men fel `type`. Strategin ska fälla den;
    // annars vore "plattformsadmin" bara "vem som helst med en giltig token".
    const orgToken = jwt.sign(
      { sub: 'user-1', type: 'access', organizationId: 'org-1' },
      { expiresIn: '5m' },
    )

    const res = await app.inject({
      method: 'POST',
      url: '/platform/errors/report',
      payload: giltigRapport,
      headers: { authorization: `Bearer ${orgToken}` },
    })

    expect(res.statusCode).toBe(401)
    expect(loggaFel).not.toHaveBeenCalled()
  })

  it('släpper igenom en inloggad plattformsadmin (202) och skriver raden', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/platform/errors/report',
      payload: giltigRapport,
      headers: { authorization: `Bearer ${plattformsToken()}` },
    })

    expect(res.statusCode).toBe(202)
    expect(loggaFel).toHaveBeenCalledTimes(1)
  })

  it('organizationId i kroppen AVVISAS (400) och når aldrig tjänsten', async () => {
    // Fältet är borttaget ur DTO:n. Testet skickar det ändå — poängen är att
    // en angripare med giltig plattformstoken inte ska kunna styra vilken
    // organisation raden bokförs på.
    //
    // Utfallet är 400 och inte en tyst strippning, eftersom pipen kör
    // `forbidNonWhitelisted`. Det är ett MEDVETET brytande kontraktsbyte: en
    // klient som fortfarande skickar fältet får ett synligt fel i stället för
    // att tro att den styr org-kolumnen. Svepet i PR:en visade noll sådana
    // klienter — admins ErrorBoundary skickade det aldrig.
    const res = await app.inject({
      method: 'POST',
      url: '/platform/errors/report',
      payload: { ...giltigRapport, organizationId: '00000000-0000-0000-0000-000000000000' },
      headers: { authorization: `Bearer ${plattformsToken()}` },
    })

    expect(res.statusCode).toBe(400)
    expect(loggaFel).not.toHaveBeenCalled()
  })
})
