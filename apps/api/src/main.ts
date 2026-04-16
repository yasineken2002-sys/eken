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
import { HttpExceptionFilter } from './common/filters/http-exception.filter'
import { TransformInterceptor } from './common/interceptors/transform.interceptor'

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())

  const config = app.get(ConfigService)
  const port = config.get<number>('PORT', 3000)
  const appUrl = config.get<string>('APP_URL', 'http://localhost:5173')

  // Security
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(helmet as any, {
    contentSecurityPolicy: false, // handled by frontend
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
  app.enableCors({
    origin: [appUrl],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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
  app.useGlobalFilters(new HttpExceptionFilter())
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
