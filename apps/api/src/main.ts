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
    console.error('[bootstrap] uncaughtException:', err)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[bootstrap] unhandledRejection:', reason)
    process.exit(1)
  })

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())

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
  const rawOrigins = config.get<string>('ALLOWED_ORIGINS', '')
  const adminUrl = config.get<string>('ADMIN_URL', 'http://localhost:5175')
  const portalUrl = config.get<string>('PORTAL_URL', 'http://localhost:5174')
  const normalizeOrigin = (o: string) => o.trim().replace(/\/+$/, '').toLowerCase()
  const allowedOrigins = (
    rawOrigins ? rawOrigins.split(',') : [appUrl, portalUrl, adminUrl, 'https://*.app.github.dev']
  )
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
          const regex = new RegExp('^' + o.replace(/\*/g, '.*') + '$')
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

  await app.listen(port, '0.0.0.0')
  console.warn(`API running on http://0.0.0.0:${port}`)
  console.warn(`Swagger: http://localhost:${port}/api/docs`)
}

void bootstrap()
