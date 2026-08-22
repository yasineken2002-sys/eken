// Sentry / OpenTelemetry MÅSTE laddas innan något annat — den hookar in sig
// i Node:s require-cache och måste hinna wrappa NestJS, Fastify och Prisma
// innan deras moduler initieras.
import './instrument'
import * as Sentry from '@sentry/nestjs'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import { AppModule } from './app.module'
import { GlobalExceptionFilter } from './common/filters/global-exception.filter'
import { TransformInterceptor } from './common/interceptors/transform.interceptor'

async function bootstrap() {
  // Force line-buffered stdout so NestJS logs flush even on crash starts on
  // Railway / non-TTY environments. Without this, block-buffered stdout can
  // swallow all bootstrap output if the process exits before the buffer fills.
  const stdoutHandle = (
    process.stdout as unknown as { _handle?: { setBlocking?: (b: boolean) => void } }
  )._handle
  stdoutHandle?.setBlocking?.(true)

  console.warn('[bootstrap] entering main.ts')

  process.on('uncaughtException', (err) => {
    Sentry.captureException(err)
    console.error('[bootstrap] uncaughtException:', err)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    Sentry.captureException(reason)
    console.error('[bootstrap] unhandledRejection:', reason)
    process.exit(1)
  })

  // trustProxy: 1 — Fastify litar på en (1) proxy framför sig och läser
  // klientens IP från X-Forwarded-For. Det här är vad Railway och nginx
  // kräver för att req.ip ska peka på den faktiska besökaren istället för
  // proxyns interna adress. Utan denna inställning blir signed-from-IP-loggar,
  // ratelimit-buckets och GDPR-audits värdelösa i produktion.
  //
  // 1 = en hop. Bakom Cloudflare → Railway hade vi behövt 2; vi får ändra
  // när vi flyttar till en sådan topologi (eller läsa Cloudflare CF-Connecting-IP).
  // rawBody: true exponerar den oparsade request-bodyn på `req.rawBody` (Buffer).
  // Svix-/Resend-webhooken MÅSTE verifiera signaturen mot exakt de bytes Resend
  // signerade — den JSON-parsade bodyn duger inte (omserialisering ändrar
  // whitespace/nyckelordning och bryter HMAC:en). Gäller bara application/json;
  // multipart-uppladdningar hanteras av @fastify/multipart och påverkas inte.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: 1 }),
    { rawBody: true },
  )

  const config = app.get(ConfigService)
  const port = Number(config.get<string | number>('PORT', 3000))
  const appUrl = config.get<string>('APP_URL', 'http://localhost:5173')

  // Security headers via helmet. CSP är restriktiv för API:t — vi serverar
  // inget HTML/script härifrån utöver Swagger-UI som behöver inline-script
  // och inline-style. I production stängs Swagger av (se nedan), så vi
  // använder en stramare policy där.
  const isProd = config.get('NODE_ENV') === 'production'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(helmet as any, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        scriptSrc: isProd ? ["'self'"] : ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        upgradeInsecureRequests: isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })

  // File uploads (uppladdade filer skickas vidare till Cloudflare R2)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(multipart as any, { limits: { fileSize: 20_000_000 } })

  // CORS
  // .trim() så att ett ALLOWED_ORIGINS satt till enbart blanksteg (t.ex. via
  // ett tomställt fält i Railway/Vercel UI) faller tillbaka på default-listan
  // i stället för att bli truthy → en tom allowlist som blockerar ALL trafik.
  const rawOrigins = config.get<string>('ALLOWED_ORIGINS', '').trim()
  const adminUrl = config.get<string>('ADMIN_URL', 'http://localhost:5175')
  const portalUrl = config.get<string>('PORTAL_URL', 'http://localhost:5174')
  const normalizeOrigin = (o: string) => o.trim().replace(/\/+$/, '').toLowerCase()
  // SECURITY (H2): fallback-listan innehåller bara de tre kända app-URL:erna.
  // Den tidigare wildcard-fallbacken `https://*.app.github.dev` matchade
  // VILKEN github.dev-codespace som helst (inkl. andras) i produktion om
  // ALLOWED_ORIGINS råkade saknas. Behöver en deploy tillåta Codespaces-
  // origins sätter man dem explicit i ALLOWED_ORIGINS.
  const allowedOrigins = (rawOrigins ? rawOrigins.split(',') : [appUrl, portalUrl, adminUrl])
    .map(normalizeOrigin)
    .filter((o) => o.length > 0)

  console.warn(`[CORS] ALLOWED_ORIGINS raw: ${JSON.stringify(rawOrigins)}`)
  console.warn(`[CORS] Allowed origins parsed: ${JSON.stringify(allowedOrigins)}`)

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true)
      const normalizedOrigin = normalizeOrigin(origin)
      const allowed = allowedOrigins.some((o) => {
        if (o.includes('*')) {
          // SECURITY (H2): escapa alla regex-metatecken FÖRST så att en punkt
          // i mönstret bara matchar en punkt (inte valfritt tecken). Annars
          // tillåter `https://app.example.com` även `https://appXexample.com`.
          // Översätt sedan `*` → `.*` så wildcards fortfarande fungerar.
          const pattern = o.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
          const regex = new RegExp('^' + pattern + '$')
          return regex.test(normalizedOrigin)
        }
        return o === normalizedOrigin
      })
      if (allowed) {
        callback(null, true)
      } else {
        console.warn(
          `[CORS] BLOCKED origin=${JSON.stringify(origin)} normalized=${JSON.stringify(
            normalizedOrigin,
          )} allowed=${JSON.stringify(allowedOrigins)}`,
        )
        callback(new Error('Not allowed by CORS'))
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Dev-Tenant-Id'],
  })

  // Versioning
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })

  // Global pipes/filters/interceptors
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  )
  app.useGlobalFilters(app.get(GlobalExceptionFilter))
  app.useGlobalInterceptors(new TransformInterceptor())

  // Swagger
  if (config.get('NODE_ENV') !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Eveno API')
      .setDescription('Fastighetssystem – REST API')
      .setVersion('1.0')
      .addBearerAuth()
      .build()
    const document = SwaggerModule.createDocument(app, swaggerConfig)
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    })
  }

  // ── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────
  //
  // Den här raden är verkningslös utan tjänstvariabeln
  // RAILWAY_DEPLOYMENT_DRAINING_SECONDS, och det är hela poängen med att skriva
  // ned varför den finns.
  //
  // Railways dokumentation, ordagrant: "Once the new deployment is online, the
  // old deployment is sent a SIGTERM signal" och "By default, it is given 0
  // seconds to gracefully shutdown before being forcefully stopped with a
  // SIGKILL." Noll. Och: "We do not send any other signals under any
  // circumstances." Fönstret är alltså inte en egenskap hos plattformen som vi
  // måste anpassa oss till — det är en tjänstvariabel, och den stod på sitt
  // default tills den sattes till 60 tillsammans med den här commiten.
  //
  // MÄTT på den riktiga appen (sond som räknar process.listenerCount('SIGTERM')
  // efter bootstrap, dev-läge, tomma köer):
  //
  //     utan enableShutdownHooks   0 lyssnare    SIGTERM → exit      26 ms
  //     med  enableShutdownHooks   1 lyssnare    SIGTERM → exit   2 564 ms
  //
  // 26 ms är inte en snabb nedstängning, det är ingen nedstängning: utan
  // lyssnare gör Node sin default-åtgärd och dör. 2 564 ms är golvet för en ren
  // stängning med TOMMA köer — sju Bull-köer à två Redis-klienter, Prisma,
  // Redis och Chromium. Talet 60 är därför ett TAK och inte en väntetid: exitar
  // processen tidigare fortsätter deployen direkt, så ett generöst tak kostar
  // ingenting i det vanliga fallet.
  //
  // ── VAD RADEN FAKTISKT VINNER ────────────────────────────────────────────
  //
  // Inte i första hand att aktiva jobb hinner klart. Det viktigaste är att
  // @nestjs/bull redan sätter `queue.onApplicationShutdown = () => this.close()`
  // på varje kö den bygger (bull.providers.js:36-38), och att bulls `close()`
  // börjar med `pause(true)` — som slutar hämta NYA jobb i samma ögonblick.
  //
  // I dag gör den döende containern motsatsen: den plockar nya jobb ur Redis
  // ända fram till SIGKILL, och varje sådant jobb blir ett stall som ingen bad
  // om. Att sluta hämta är den vinst som inte beror på hur lång tiden är.
  //
  // Hooken aktiverar dessutom tre onModuleDestroy som är skrivna men aldrig har
  // körts: PdfService (stänger Chromium), PrismaService ($disconnect) och
  // RedisService (quit). Nest stänger HTTP-servern före shutdown-hookarna, så
  // requests som redan accepterats får också sin chans.
  //
  // VARNING inför nästa läsare: bulls `close()` väntar OBEGRÄNSAT på aktiva
  // jobb (`whenCurrentJobsFinished` → `Promise.all(this.processing)`, ingen
  // tidsgräns — bull/lib/queue.js:615, :887, :1374). Lita inte på att den
  // avslutar. Taket är RAILWAY_DEPLOYMENT_DRAINING_SECONDS, och det som inte
  // hinner blir SIGKILL:at precis som förut — men då som ett stall med en
  // konfigurerad budget (se maxStalledCount i app.module.ts), inte som ett jobb
  // som dör tyst.
  //
  // Raden bevakas av apps/api/scripts/check-graceful-shutdown.mjs (att den finns
  // och står FÖRE app.listen) och av common/shutdown/shutdown-hooks.spec.ts
  // (att den faktiskt ger en SIGTERM-lyssnare). Tas den bort blir båda röda.
  app.enableShutdownHooks()

  await app.listen(port, '0.0.0.0')
  console.warn(`API running on http://0.0.0.0:${port}`)
  console.warn(`Swagger: http://localhost:${port}/api/docs`)
}

void bootstrap()
