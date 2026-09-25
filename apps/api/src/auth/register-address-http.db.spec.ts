/**
 * F-10 — `POST /v1/auth/register` kräver och sparar en företagsadress.
 *
 * ── VAD SOM VAR FEL ─────────────────────────────────────────────────────────
 *
 * Registreringen skrev `street/city/postalCode = ''` för varje ny organisation.
 * Kundprovet fick därefter ett kontrakt vars hyresvärdsadress var ett ensamt
 * kommatecken. Sedan 2026-09-25 är de tre fälten obligatoriska i
 * registreringskontraktet (RegisterSchema + RegisterDto) och prövas med
 * `organizationAddressIssues` INNAN något skrivs.
 *
 * ── VARFÖR RIKTIG HTTP OCH RIKTIG DATABAS ───────────────────────────────────
 *
 * Två av påståendena kan inte mätas av en attrapp: att den riktiga
 * `ValidationPipe` + DTO släpper igenom en giltig kropp och avvisar en ogiltig,
 * och att ett avvisat anrop inte lämnar en HALVSKAPAD organisation eller
 * användare efter sig. Det senare avgörs av vad som finns i PostgreSQL efteråt,
 * inte av vilka mockar som anropades.
 *
 * ── AVGRÄNSNING ─────────────────────────────────────────────────────────────
 *
 * Kontoplanen (`AccountingService.seedDefaultAccounts`) och välkomstmejlet är
 * attrapper: provet mäter organisationens och användarens rader, inte BAS-
 * seedningen. Historisk inloggning prövas mot en organisation som skapas här
 * med TOMMA adressfält — samma form som alla organisationer registrerade före
 * ändringen har.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import { ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter'
import { PrismaService } from '../common/prisma/prisma.service'
import { CustomerNumberService } from '../common/customer-number/customer-number.service'
import { MailService } from '../mail/mail.service'
import { AccountingService } from '../accounting/accounting.service'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'

const hasDatabase = Boolean(process.env.DATABASE_URL)
const withDb = hasDatabase ? describe : describe.skip
it('F-10 registreringsprovet kräver en uttrycklig provdatabas', () => {
  expect(hasDatabase).toBe(true)
})

const HEMLIGHET = 'f10-syntetisk-provhemlighet'
const LOSEN = 'F10-Syntetiskt-123!'

withDb('F-10 · POST /auth/register — företagsadressen', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  const skapadeEpost: string[] = []

  const kropp = (over: Record<string, unknown> = {}) => {
    const email = `f10-${randomUUID()}@example.invalid`
    skapadeEpost.push(email)
    return {
      email,
      password: LOSEN,
      firstName: 'Fia',
      lastName: 'Tio',
      organizationName: 'F10 Syntetisk AB',
      street: 'Storgatan 1',
      postalCode: '111 22',
      city: 'Stockholm',
      acceptTerms: true,
      ...over,
    }
  }

  const registrera = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/auth/register', payload })

  const raderFor = async (email: string) => ({
    orgs: await prisma.organization.count({ where: { email } }),
    users: await prisma.user.count({ where: { email } }),
  })

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService,
        PrismaService,
        CustomerNumberService,
        { provide: JwtService, useValue: new JwtService({ secret: HEMLIGHET }) },
        { provide: ConfigService, useValue: { get: (_k: string, d?: unknown) => d } },
        { provide: MailService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: AccountingService,
          useValue: { seedDefaultAccounts: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    app.useGlobalGuards(new JwtAuthGuard(new Reflector()))
    app.useGlobalInterceptors(new TransformInterceptor())
    app.useGlobalFilters(
      new GlobalExceptionFilter({ logInternalError: async () => undefined } as never),
    )
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    prisma = module.get(PrismaService)
  }, 30_000)

  afterAll(async () => {
    if (prisma && skapadeEpost.length > 0) {
      // FK-riktning: refresh-token → användare → organisation.
      await prisma.refreshToken.deleteMany({ where: { user: { email: { in: skapadeEpost } } } })
      await prisma.user.deleteMany({ where: { email: { in: skapadeEpost } } })
      await prisma.organization.deleteMany({ where: { email: { in: skapadeEpost } } })
    }
    if (app) await app.close()
  })

  it('F10.1 giltig adress → 201, sparad TRIMMAD, land SE', async () => {
    const k = kropp({ street: '  Storgatan 1  ', postalCode: ' 111 22 ', city: ' Stockholm ' })
    const svar = await registrera(k)
    expect(svar.statusCode).toBe(201)
    const org = await prisma.organization.findFirstOrThrow({ where: { email: k.email } })
    expect({
      street: org.street,
      postalCode: org.postalCode,
      city: org.city,
      country: org.country,
    }).toEqual({ street: 'Storgatan 1', postalCode: '111 22', city: 'Stockholm', country: 'SE' })
    expect(await raderFor(k.email)).toEqual({ orgs: 1, users: 1 })
  })

  it.each([
    ['gatuadress saknas helt', { street: undefined }, 'Gatuadress'],
    ['gatuadress enbart blanktecken', { street: '   ' }, 'Gatuadress krävs'],
    ['postnummer tomt', { postalCode: '' }, 'Postnummer krävs'],
    ['postnummer fyra siffror', { postalCode: '1234' }, 'Postnummer måste vara fem siffror'],
    ['postnummer börjar på 0', { postalCode: '01234' }, 'Postnummer måste vara fem siffror'],
    ['ort tom', { city: '' }, 'Ort krävs'],
  ])('F10.2 %s → 400, INGEN organisation och INGEN användare', async (_n, over, text) => {
    const k = kropp(over)
    const svar = await registrera(k)
    expect(svar.statusCode).toBe(400)
    expect(JSON.stringify(svar.json().error)).toContain(text)
    expect(await raderFor(k.email)).toEqual({ orgs: 0, users: 0 })
  })

  it('F10.3 historisk organisation UTAN adress kan fortfarande logga in', async () => {
    const email = `f10-historisk-${randomUUID()}@example.invalid`
    skapadeEpost.push(email)
    const org = await prisma.organization.create({
      data: { name: 'F10 historisk', email, street: '', city: '', postalCode: '' },
    })
    await prisma.user.create({
      data: {
        organizationId: org.id,
        email,
        passwordHash: await bcrypt.hash(LOSEN, 4),
        firstName: 'Gammal',
        lastName: 'Kund',
        role: 'OWNER',
      },
    })
    const svar = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: LOSEN },
    })
    expect(svar.statusCode).toBe(200)
    expect(typeof svar.json().data.accessToken).toBe('string')
    // Ingen backfill: raden är orörd av inloggningen.
    const efter = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })
    expect([efter.street, efter.postalCode, efter.city]).toEqual(['', '', ''])
  })
})
