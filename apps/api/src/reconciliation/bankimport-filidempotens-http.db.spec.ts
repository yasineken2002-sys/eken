/**
 * FILNIVÅSKYDDET GENOM DEN FAKTISKA HTTP-VÄGEN (#F034b).
 *
 * ── VARFÖR DEN HÄR FILEN FINNS VID SIDAN AV TJÄNSTEPROVET ───────────────────
 *
 * `bankimport-filidempotens.db.spec.ts` anropar tjänstemetoderna direkt. Den
 * mäter mekaniken, och den mäter den bra — men den kan inte se något av det
 * här:
 *
 *   • att `ImportPågårError` faktiskt blir **409** och inte 500 på tråden
 *   • att felKROPPEN bär `code: 'IMPORT_PAGAR'` och starttiden, så UI:t kan
 *     skilja "pågår" från "fel filformat"
 *   • att `forsok`-fältet överlever `TransformInterceptor` och når klienten
 *   • att multipart-uppladdningen och rollgrinden fortfarande gäller
 *
 * Det är precis den sortens lucka F034:s rapport skrev upp som kvarstående:
 * "HTTP-/DTO-lagret — provet anropar exakt de metoder controllern anropar, men
 * går inte genom pipe-kedjan". För den HÄR leveransen är den stängd.
 *
 * ── VAD DEN INTE MÄTER ──────────────────────────────────────────────────────
 *
 *  • Webbläsaren. Detta är `app.inject` mot Fastify, inte en riktig klient.
 *    Webbsidans tolkning av svaret mäts av `reconciliation-import-besked.spec.ts`
 *    i apps/web (ren funktion, jsdom).
 *  • Autentiseringen i sig. Token signeras av riggen med en syntetisk
 *    hemlighet; provet mäter auktorisationens UTFALL, inte inloggningen.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import multipart from '@fastify/multipart'

import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { PrismaService } from '../common/prisma/prisma.service'
import { InvoicesService } from '../invoices/invoices.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import { AccountingService } from '../accounting/accounting.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { AiPaymentShadowQueue } from '../ai/shadow/payment/payment-shadow.queue'
import { PaymentOutcomeService } from '../ai/shadow/payment/payment-outcome.service'
import { PdfStatementParserService } from './pdf-statement-parser.service'
import { BankImportAttemptService } from './bank-import-attempt.service'
import { BankAccountService } from './bank-account.service'
import { BankStatementImportService } from './bank-statement-import.service'
import { ReconciliationController } from './reconciliation.controller'
import { ReconciliationService } from './reconciliation.service'
import { IMPORT_LEASE_TTL_MS } from './bank-import-identity'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

it('HTTP-provet kräver en uttrycklig provdatabas', () => {
  expect(HAR_DB).toBe(true)
})

const HEMLIGHET = 'f034b-syntetisk-provhemlighet'

const CSV = ['Datum,Text,Belopp,Referens', '2026-03-02,Insattning,9000.00,1234567897'].join('\n')

/**
 * Egenskaper som RAMVERKET frågar efter och som attrappen därför måste svara
 * `undefined` på. Två familjer, båda uppmätta genom att riggen föll på dem:
 *
 *   `then`          Nest `await`:ar sina provider-instanser. En proxy som ger
 *                   en funktion för `then` ser ut som en thenable och kastar
 *                   mitt i modulbygget.
 *   livscykelkrokar `app.close()` anropar `onModuleDestroy` på VARJE provider.
 *                   En proxy som ger en funktion där kastar i `afterAll`.
 *
 * Listan är sluten och namngiven i stället för "allt utom det jag använder":
 * en attrapp som svarar undefined på okända namn slutar vara en attrapp som
 * larmar, och ett oavsiktligt anrop hade då blivit tyst.
 */
const RAMVERKSEGENSKAPER = new Set<string>([
  'then',
  'catch',
  'finally',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'onApplicationShutdown',
  'beforeApplicationShutdown',
])

/**
 * Attrapp som KASTAR vid varje anrop, med sitt eget namn i felet.
 *
 * Se `RAMVERKSEGENSKAPER` ovan för de namn som MÅSTE svara `undefined`.
 */
function orört(namn: string): unknown {
  return new Proxy(
    {},
    {
      get: (_mål, prop) => {
        if (typeof prop === 'symbol' || RAMVERKSEGENSKAPER.has(prop)) return undefined
        return () => {
          throw new Error(`${namn} orört`)
        }
      },
    },
  )
}

/** Multipart-kropp för hand — samma form som webbens FormData skickar. */
function multipartKropp(filnamn: string, innehåll: string): { body: string; gräns: string } {
  const gräns = '----f034b' + randomUUID().replace(/-/g, '')
  const body =
    `--${gräns}\r\n` +
    `Content-Disposition: form-data; name="statement"; filename="${filnamn}"\r\n` +
    'Content-Type: text/csv\r\n\r\n' +
    innehåll +
    `\r\n--${gräns}--\r\n`
  return { body, gräns }
}

medDb('bankimportens filnivåskydd över HTTP (#F034b)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let orgId: string
  let kontoId: string
  let annanOrgId: string
  let annanOrgKonto: string
  const jwt = new JwtService({ secret: HEMLIGHET })
  const token = (role = 'OWNER', organizationId = orgId) =>
    jwt.sign({ sub: randomUUID(), organizationId, role })

  function ladda(filnamn: string, innehåll: string, auth = token(), fråga?: string) {
    const q = fråga ?? `?bankAccountId=${kontoId}`
    const { body, gräns } = multipartKropp(filnamn, innehåll)
    return app.inject({
      method: 'POST',
      url: `/v1/reconciliation/import${q}`,
      headers: {
        authorization: `Bearer ${auth}`,
        'content-type': `multipart/form-data; boundary=${gräns}`,
      },
      payload: body,
    })
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ReconciliationController],
      providers: [
        ReconciliationService,
        BankStatementImportService,
        BankImportAttemptService,
        // #F034c — RIKTIG tjänst, inte attrapp: ägandekontrollen är precis det
        // den här filen ska pröva över tråden.
        BankAccountService,
        PrismaService,
        JwtStrategy,
        { provide: ConfigService, useValue: { getOrThrow: () => HEMLIGHET } },
        // ── BEROENDEN SOM IMPORTVÄGEN INTE RÖR ────────────────────────────
        //
        // KLASSTOKEN, inte strängar: Nest löser konstruktorberoenden på klassen.
        // En strängtoken hade sett ut som en registrering och inte varit det —
        // felet blir "can't resolve dependencies" i beforeAll, alltså sent.
        //
        // PROXY SOM KASTAR, inte `{}`. Rör riggen dem blir det ett fel med
        // namn. Med ett tomt objekt hade ett oavsiktligt anrop gett
        // `undefined is not a function` långt från orsaken — eller, värre, en
        // tyst `undefined` som provet läst som ett giltigt värde.
        { provide: InvoicesService, useValue: orört('InvoicesService') },
        { provide: InvoiceEventsService, useValue: orört('InvoiceEventsService') },
        { provide: AccountingService, useValue: orört('AccountingService') },
        { provide: PdfStatementParserService, useValue: orört('PdfStatementParserService') },
        { provide: RentNoticeEventsService, useValue: { record: async () => undefined } },
        { provide: AiPaymentShadowQueue, useValue: { enqueue: async () => undefined } },
        { provide: PaymentOutcomeService, useValue: { registrera: async () => undefined } },
        // Färskheten ÄR en del av importvägen och får inte kasta. Stubbad till
        // no-op: den här filen mäter HTTP-kontraktet, inte täckningsdatumet
        // (det ägs av A11 i tjänsteprovet).
        {
          provide: PaymentFreshnessService,
          useValue: {
            recordImportStarted: async () => undefined,
            recordPaymentDataThrough: async () => undefined,
          },
        },
      ],
    }).compile()

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    await app.register(multipart as never)
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    app.useGlobalGuards(new JwtAuthGuard(new Reflector()), new RolesGuard(new Reflector()))
    app.useGlobalInterceptors(new TransformInterceptor())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    prisma = module.get(PrismaService)
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `http-${sfx}`,
        email: `http-${sfx}@example.invalid`,
        street: 'a',
        city: 'Stockholm',
        postalCode: '11122',
        orgNumber: `5562${sfx.slice(0, 6)}`,
        fiscalYearStartMonth: 1,
      },
      select: { id: true },
    })
    orgId = org.id
    kontoId = (
      await prisma.bankAccount.create({
        data: { organizationId: orgId, name: 'Företagskonto' },
        select: { id: true },
      })
    ).id

    const annan = await prisma.organization.create({
      data: {
        name: `http-annan-${sfx}`,
        email: `http-annan-${sfx}@example.invalid`,
        street: 'a',
        city: 'Stockholm',
        postalCode: '11122',
        orgNumber: `5563${sfx.slice(0, 6)}`,
        fiscalYearStartMonth: 1,
      },
      select: { id: true },
    })
    annanOrgId = annan.id
    annanOrgKonto = (
      await prisma.bankAccount.create({
        data: { organizationId: annanOrgId, name: 'Annans konto' },
        select: { id: true },
      })
    ).id
  }, 60_000)

  afterEach(async () => {
    await prisma.bankTransaction.deleteMany({ where: { organizationId: orgId } })
    await prisma.bankImportAttempt.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    if (prisma) {
      for (const o of [orgId, annanOrgId].filter(Boolean)) {
        await prisma.bankTransaction.deleteMany({ where: { organizationId: o } })
        await prisma.bankImportAttempt.deleteMany({ where: { organizationId: o } })
        await prisma.bankAccount.deleteMany({ where: { organizationId: o } })
        await prisma.organization.delete({ where: { id: o } })
      }
    }
    if (app) await app.close()
  })

  it('A12: första importen svarar 200 med forsok.status=KLAR och replayed=false', async () => {
    const svar = await ladda('utdrag.csv', CSV)
    expect(svar.statusCode).toBe(201)
    const data = svar.json().data
    expect(data.imported).toBe(1)
    // Fältet överlever TransformInterceptor och når klienten.
    expect(data.forsok).toMatchObject({ status: 'KLAR', replayed: false, forsokNr: 1 })
    expect(typeof data.forsok.kordesAt).toBe('string')
  })

  it('A12: upprepning svarar 200 med replayed=true — noll nya rader', async () => {
    await ladda('utdrag.csv', CSV)
    const svar = await ladda('utdrag.csv', CSV)

    expect(svar.statusCode).toBe(201)
    expect(svar.json().data.forsok.replayed).toBe(true)
    expect(await prisma.bankTransaction.count({ where: { organizationId: orgId } })).toBe(1)
  })

  it('A12: pågående import svarar 409 med IMPORT_PAGAR och starttid', async () => {
    await ladda('utdrag.csv', CSV)
    // Arrendet görs levande → nästa anrop möter en pågående körning.
    await prisma.bankImportAttempt.updateMany({
      where: { organizationId: orgId },
      data: { status: 'RUNNING', heartbeatAt: new Date() },
    })

    const svar = await ladda('utdrag.csv', CSV)

    // 409 OCH INTE 500. En pågående import är ett förväntat tillstånd, inte
    // ett serverfel — och skillnaden avgör om operatören väntar eller felsöker.
    expect(svar.statusCode).toBe(409)
    const kropp = svar.json()
    const inre = (kropp.data ?? kropp) as Record<string, unknown>
    expect(inre['code'] ?? kropp.code).toBe('IMPORT_PAGAR')
    const startad = (inre['startadAt'] ?? kropp.startadAt) as string
    expect(typeof startad).toBe('string')
    expect(Number.isNaN(new Date(startad).getTime())).toBe(false)
    // Inga rader av det nekade försöket.
    expect(await prisma.bankTransaction.count({ where: { organizationId: orgId } })).toBe(1)
  })

  it('A12: ett FALLET arrende ger inte 409 — importen tas över och svarar 200', async () => {
    await ladda('utdrag.csv', CSV)
    await prisma.bankImportAttempt.updateMany({
      where: { organizationId: orgId },
      data: {
        status: 'RUNNING',
        heartbeatAt: new Date(Date.now() - IMPORT_LEASE_TTL_MS - 60_000),
      },
    })

    const svar = await ladda('utdrag.csv', CSV)

    // DEN OMVÄNDA RIKTNINGEN. Utan det här provet hade en 409 som ALLTID
    // svarade sett lika grön ut som ett fungerande arrende.
    expect(svar.statusCode).toBe(201)
    expect(svar.json().data.forsok.forsokNr).toBe(2)
    expect(svar.json().data.duplicates).toBe(1)
  })

  it('A12: ändrad ?bank= körs om — inget tyst uppspelat svar', async () => {
    await ladda('utdrag.csv', CSV)
    const svar = await ladda('utdrag.csv', CSV, token(), `?bankAccountId=${kontoId}&bank=SEB`)

    expect(svar.statusCode).toBe(201)
    expect(svar.json().data.forsok.replayed).toBe(false)
    expect(svar.json().data.bank).toBe('SEB')
  })

  // ── #F034c: MÅLKONTOT ÖVER TRÅDEN ─────────────────────────────────────────

  it('K-HTTP1: konto från ANNAN organisation nekas — 404, inga rader, inget försök', async () => {
    const svar = await ladda('utdrag.csv', CSV, token(), `?bankAccountId=${annanOrgKonto}`)

    // 404 och inte 403: att skilja "finns inte" från "tillhör någon annan" hade
    // låtit en anropare räkna ut vilka konto-id som finns i andra organisationer.
    expect(svar.statusCode).toBe(404)
    expect(await prisma.bankTransaction.count({ where: { organizationId: orgId } })).toBe(0)
    expect(await prisma.bankTransaction.count({ where: { organizationId: annanOrgId } })).toBe(0)
    expect(await prisma.bankImportAttempt.count({ where: { organizationId: orgId } })).toBe(0)
  })

  it('K-HTTP2: utan konto nekas importen med ett besked som säger vad man ska göra', async () => {
    const svar = await ladda('utdrag.csv', CSV, token(), '')

    expect(svar.statusCode).toBe(400)
    const kropp = JSON.stringify(svar.json())
    // Organisationen HAR ett konto här, så beskedet ska säga VÄLJ — inte
    // "lägg upp ett konto". De två leder till olika åtgärder.
    expect(kropp).toMatch(/Välj vilket bankkonto/)
    expect(await prisma.bankTransaction.count({ where: { organizationId: orgId } })).toBe(0)
  })

  it('K-HTTP3: samma fil på TVÅ konton i samma organisation — båda importeras', async () => {
    const kontoTvå = await prisma.bankAccount.create({
      data: { organizationId: orgId, name: 'Klientmedelskonto' },
      select: { id: true },
    })

    const ettSvar = await ladda('utdrag.csv', CSV, token(), `?bankAccountId=${kontoId}`)
    const tvåSvar = await ladda('utdrag.csv', CSV, token(), `?bankAccountId=${kontoTvå.id}`)

    expect(ettSvar.statusCode).toBe(201)
    expect(tvåSvar.statusCode).toBe(201)
    // INGEN uppspelning: olika konto = olika import.
    expect(tvåSvar.json().data.forsok.replayed).toBe(false)
    expect(tvåSvar.json().data.imported).toBe(1)
    expect(await prisma.bankTransaction.count({ where: { organizationId: orgId } })).toBe(2)

    await prisma.bankTransaction.deleteMany({ where: { bankAccountId: kontoTvå.id } })
    await prisma.bankImportAttempt.deleteMany({ where: { bankAccountId: kontoTvå.id } })
    await prisma.bankAccount.delete({ where: { id: kontoTvå.id } })
  })

  it('K-HTTP4: kontolistan är org-scopad — andras konton syns inte', async () => {
    const svar = await app.inject({
      method: 'GET',
      url: '/v1/reconciliation/bank-accounts',
      headers: { authorization: `Bearer ${token()}` },
    })

    expect(svar.statusCode).toBe(200)
    const idn = (svar.json().data as Array<{ id: string }>).map((k) => k.id)
    expect(idn).toContain(kontoId)
    expect(idn).not.toContain(annanOrgKonto)
  })

  it('rollgrinden gäller fortfarande: VIEWER nekas, inget importförsök skapas', async () => {
    const svar = await ladda('utdrag.csv', CSV, token('VIEWER'))
    expect(svar.statusCode).toBe(403)
    expect(await prisma.bankImportAttempt.count({ where: { organizationId: orgId } })).toBe(0)
  })
})
