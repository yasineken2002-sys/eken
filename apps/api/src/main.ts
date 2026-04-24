import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import * as path from 'path'
import { AppModule } from './app.module'
import { GlobalExceptionFilter } from './common/filters/global-exception.filter'
import { TransformInterceptor } from './common/interceptors/transform.interceptor'

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())

  const config = app.get(ConfigService)
  const port = config.get<number>('PORT', 3000)
  const appUrl = config.get<string>('APP_URL', 'http://localhost:5173')

  // Security
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(helmet as any, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })

  // File uploads
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(multipart as any, { limits: { fileSize: 20_000_000 } })

  // Static files (uploaded logos)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(fastifyStatic as any, {
    root: path.join(process.cwd(), 'uploads'),
    prefix: '/uploads/',
  })

  // CORS
  const rawOrigins = config.get<string>('ALLOWED_ORIGINS', '')
  const adminUrl = config.get<string>('ADMIN_URL', 'http://localhost:5175')
  const portalUrl = config.get<string>('PORTAL_URL', 'http://localhost:5174')
  const allowedOrigins = rawOrigins
    ? rawOrigins.split(',').map((o) => o.trim())
    : [appUrl, portalUrl, adminUrl, 'https://*.app.github.dev']

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true)
      const allowed = allowedOrigins.some((o) => {
        if (o.includes('*')) {
          const regex = new RegExp('^' + o.replace(/\*/g, '.*') + '$')
          return regex.test(origin)
        }
        return o === origin
      })
      if (allowed) callback(null, true)
      else callback(new Error('Not allowed by CORS'))
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
      .setTitle('Eken API')
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
