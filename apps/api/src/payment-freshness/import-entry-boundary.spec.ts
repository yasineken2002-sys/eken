/**
 * Mäter markörens ordning vid riktiga controller-/serviceanrop och Nest/Fastify
 * med riktiga JWT- och rollguards. DB/provider/kö-portar är lokala attrapper.
 * Detta bevisar inte markörens beständighet, deduplicering eller kravtrappans
 * effekter; de frågorna hör till PostgreSQL-proven. Proxyavslag före Nest och
 * AI-bekräftelsens/principalens hela kedja ingår inte.
 */
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import multipart from '@fastify/multipart'
import { ConfigService } from '@nestjs/config'
import { APP_GUARD } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { ReconciliationController } from '../reconciliation/reconciliation.controller'
import { ReconciliationService } from '../reconciliation/reconciliation.service'
import { BankStatementImportService } from '../reconciliation/bank-statement-import.service'
import { Psd2Controller } from '../psd2/psd2.controller'
import { Psd2SyncService } from '../psd2/psd2-sync.service'
import { ToolExecutorService } from '../ai/tools/tool-executor.service'

const ORG = 'boundary-org'
const USER = { sub: 'boundary-user', organizationId: ORG, role: 'OWNER' }
const UPLOADS = ['csv', 'bgmax', 'pdf'] as const
type Upload = (typeof UPLOADS)[number]
const paths: Record<Upload, string> = {
  csv: '/reconciliation/import',
  bgmax: '/reconciliation/import-bgmax',
  pdf: '/reconciliation/import-pdf',
}

function ports() {
  return {
    recordImportStarted: jest.fn().mockResolvedValue(undefined),
    importBankStatement: jest.fn().mockResolvedValue({ imported: 0 }),
    importBgMaxFile: jest.fn().mockResolvedValue({ imported: 0 }),
  }
}
function uploads() {
  const reconciliation = ports()
  const statement = { uploadAndParsePdf: jest.fn().mockResolvedValue({}) }
  const controller = new ReconciliationController(reconciliation as never, statement as never)
  return { controller, reconciliation, statement }
}
function upload(controller: ReconciliationController, kind: Upload, request: unknown) {
  if (kind === 'csv') return controller.importStatement(ORG, request as never)
  if (kind === 'bgmax') return controller.importBgMax(ORG, request as never)
  return controller.importPdf(ORG, USER as never, request as never)
}
function expectNoImport(
  reconciliation: ReturnType<typeof ports>,
  statement: ReturnType<typeof uploads>['statement'],
) {
  expect(reconciliation.importBankStatement).not.toHaveBeenCalled()
  expect(reconciliation.importBgMaxFile).not.toHaveBeenCalled()
  expect(statement.uploadAndParsePdf).not.toHaveBeenCalled()
}

describe.each(UPLOADS)('första importförsökets controllergräns: %s', (kind) => {
  test('väntar på markören före lazy multipart; saknad fil lämnar försöket registrerat', async () => {
    const { controller, reconciliation, statement } = uploads()
    let finishMarker!: () => void
    reconciliation.recordImportStarted.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishMarker = resolve
        }),
    )
    const request = { file: jest.fn().mockResolvedValue(null) }
    const operation = upload(controller, kind, request)
    expect(reconciliation.recordImportStarted).toHaveBeenCalledWith(ORG)
    expect(request.file).not.toHaveBeenCalled()
    finishMarker()
    await expect(operation).rejects.toThrow('Ingen fil bifogad')
    expect(request.file).toHaveBeenCalledTimes(1)
    expectNoImport(reconciliation, statement)
  })

  test('multipartfel inträffar efter markören', async () => {
    const { controller, reconciliation, statement } = uploads()
    const request = {
      file: jest.fn().mockImplementation(async () => {
        expect(reconciliation.recordImportStarted).toHaveBeenCalledWith(ORG)
        throw new Error('multipart-boundary-failed')
      }),
    }
    await expect(upload(controller, kind, request)).rejects.toThrow('multipart-boundary-failed')
    expect(reconciliation.recordImportStarted).toHaveBeenCalledTimes(1)
    expectNoImport(reconciliation, statement)
  })

  test('buffer-/storleksfel inträffar efter markören', async () => {
    const { controller, reconciliation, statement } = uploads()
    const filename = kind === 'csv' ? 'bank.csv' : kind === 'bgmax' ? 'bank.txt' : 'bank.pdf'
    const toBuffer = jest.fn().mockImplementation(async () => {
      expect(reconciliation.recordImportStarted).toHaveBeenCalledWith(ORG)
      throw new Error('multipart-file-too-large')
    })
    const request = { file: jest.fn().mockResolvedValue({ filename, toBuffer }) }
    await expect(upload(controller, kind, request)).rejects.toThrow('multipart-file-too-large')
    expect(toBuffer).toHaveBeenCalledTimes(1)
    expectNoImport(reconciliation, statement)
  })

  test('fel filtyp registreras men buffras eller importeras inte', async () => {
    const { controller, reconciliation, statement } = uploads()
    const toBuffer = jest.fn()
    const request = { file: jest.fn().mockResolvedValue({ filename: 'bank.exe', toBuffer }) }
    await expect(upload(controller, kind, request)).rejects.toThrow()
    expect(reconciliation.recordImportStarted).toHaveBeenCalledWith(ORG)
    expect(toBuffer).not.toHaveBeenCalled()
    expectNoImport(reconciliation, statement)
  })

  test('markörfel stoppar även första multipartläsningen', async () => {
    const { controller, reconciliation, statement } = uploads()
    reconciliation.recordImportStarted.mockRejectedValue(new Error('marker-write-failed'))
    const request = { file: jest.fn() }
    await expect(upload(controller, kind, request)).rejects.toThrow('marker-write-failed')
    expect(request.file).not.toHaveBeenCalled()
    expectNoImport(reconciliation, statement)
  })
})

describe('verklig Nest/Fastify-auktorisering före importmarkören', () => {
  const secret = 'synthetic-import-boundary-only-secret'
  const reconciliation = ports()
  const statement = { uploadAndParsePdf: jest.fn().mockResolvedValue({}) }
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret })],
      controllers: [ReconciliationController],
      providers: [
        { provide: ReconciliationService, useValue: reconciliation },
        { provide: BankStatementImportService, useValue: statement },
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.useLogger(false)
    // Litet tak för samma verkliga plugin; 64 byte ska falla mot 32, inte 20 MB.
    await app.register(multipart as never, { limits: { fileSize: 32 } } as never)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    jwt = moduleRef.get(JwtService)
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(() => {
    jest.clearAllMocks()
    reconciliation.recordImportStarted.mockResolvedValue(undefined)
  })
  const emptyBody = '--boundary--\r\n'
  function headers(role: string) {
    return {
      authorization: 'Bearer ' + jwt.sign({ ...USER, role }),
      'content-type': 'multipart/form-data; boundary=boundary',
    }
  }

  test.each(UPLOADS)('%s: saknad JWT ger 401 och VIEWER ger 403 utan markör', async (kind) => {
    const anonymous = await app.inject({
      method: 'POST',
      url: paths[kind],
      headers: { 'content-type': 'multipart/form-data; boundary=boundary' },
      payload: emptyBody,
    })
    expect(anonymous.statusCode).toBe(401)
    const viewer = await app.inject({
      method: 'POST',
      url: paths[kind],
      headers: headers('VIEWER'),
      payload: emptyBody,
    })
    expect(viewer.statusCode).toBe(403)
    expect(reconciliation.recordImportStarted).not.toHaveBeenCalled()
    expectNoImport(reconciliation, statement)
  })

  test.each(UPLOADS)(
    '%s: giltig JWT binder org före saknad-fil-felet; query-org ignoreras',
    async (kind) => {
      const response = await app.inject({
        method: 'POST',
        url: paths[kind] + '?organizationId=another-org',
        headers: headers('OWNER'),
        payload: emptyBody,
      })
      expect(response.statusCode).toBe(400)
      expect(reconciliation.recordImportStarted).toHaveBeenCalledTimes(1)
      expect(reconciliation.recordImportStarted).toHaveBeenCalledWith(ORG)
      expectNoImport(reconciliation, statement)
    },
  )

  test.each(UPLOADS)('%s: verklig multipartgräns lämnar markör men ingen import', async (kind) => {
    const filename = kind === 'csv' ? 'bank.csv' : kind === 'bgmax' ? 'bank.txt' : 'bank.pdf'
    const response = await app.inject({
      method: 'POST',
      url: paths[kind],
      headers: headers('OWNER'),
      payload:
        '--boundary\r\nContent-Disposition: form-data; name="statement"; filename="' +
        filename +
        '"\r\nContent-Type: application/octet-stream\r\n\r\n' +
        'x'.repeat(64) +
        '\r\n--boundary--\r\n',
    })
    expect(response.statusCode).toBe(413)
    expect(reconciliation.recordImportStarted).toHaveBeenCalledWith(ORG)
    expectNoImport(reconciliation, statement)
  })
})

describe('PDF-service och bekräftelsens organisationsgräns', () => {
  function fixture() {
    const prisma = { bankStatementImport: { findFirst: jest.fn(), create: jest.fn() } }
    const parser = { parse: jest.fn() }
    const freshness = { recordImportStarted: jest.fn().mockResolvedValue(undefined) }
    const service = new BankStatementImportService(
      prisma as never,
      parser as never,
      ports() as never,
      freshness as never,
    )
    return { service, prisma, parser, freshness }
  }
  test('direkt PDF-anrop markerar före signaturvalidering och når inte parsern', async () => {
    const f = fixture()
    await expect(
      f.service.uploadAndParsePdf(Buffer.from('not-pdf'), 'x.pdf', ORG, USER.sub),
    ).rejects.toThrow()
    expect(f.freshness.recordImportStarted).toHaveBeenCalledWith(ORG)
    expect(f.prisma.bankStatementImport.create).not.toHaveBeenCalled()
    expect(f.parser.parse).not.toHaveBeenCalled()
  })
  test('markörfel före PDF-validering lämnar varken draft eller provideranrop', async () => {
    const f = fixture()
    f.freshness.recordImportStarted.mockRejectedValue(new Error('marker-write-failed'))
    await expect(
      f.service.uploadAndParsePdf(Buffer.from('not-pdf'), 'x.pdf', ORG, USER.sub),
    ).rejects.toThrow('marker-write-failed')
    expect(f.prisma.bankStatementImport.create).not.toHaveBeenCalled()
    expect(f.parser.parse).not.toHaveBeenCalled()
  })
  test('främmande/saknad PDF-import markerar ingen organisation', async () => {
    const f = fixture()
    f.prisma.bankStatementImport.findFirst.mockResolvedValue(null)
    await expect(f.service.confirmImport('foreign-import', ORG, USER.sub)).rejects.toThrow(
      'Importen hittades inte',
    )
    // Attrappen prövar inte SQL-scopet: denna separata assertion äger den frågan.
    expect(f.prisma.bankStatementImport.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-import', organizationId: ORG },
    })
    expect(f.freshness.recordImportStarted).not.toHaveBeenCalled()
  })
  test('egen äldre import markerar före avvisad status', async () => {
    const f = fixture()
    f.prisma.bankStatementImport.findFirst.mockResolvedValue({
      id: 'own-import',
      organizationId: ORG,
      status: 'FAILED',
    })
    await expect(f.service.confirmImport('own-import', ORG, USER.sub)).rejects.toThrow(
      'status FAILED',
    )
    expect(f.freshness.recordImportStarted).toHaveBeenCalledWith(ORG)
    expect(f.freshness.recordImportStarted.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.prisma.bankStatementImport.findFirst.mock.invocationCallOrder[0]!,
    )
  })
})

describe('PSD2-trigger och första providerförsök', () => {
  function controller() {
    const reconciliation = ports()
    const consent = {
      beginConsent: jest.fn().mockResolvedValue({ authUrl: 'https://synthetic.invalid' }),
      handleCallback: jest.fn().mockRejectedValue(new Error('invalid state')),
      appReturnUrl: () => 'https://synthetic.invalid/return',
    }
    const queue = { enqueueOrgSync: jest.fn().mockResolvedValue('job') }
    return {
      reconciliation,
      consent,
      queue,
      instance: new Psd2Controller(consent as never, queue as never, reconciliation as never),
    }
  }
  test('synk inväntar mockad markörport före köpublicering, även när kön nekar', async () => {
    const f = controller()
    let finishMarker!: () => void
    f.reconciliation.recordImportStarted.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishMarker = resolve
        }),
    )
    f.queue.enqueueOrgSync.mockImplementation(async (org: string) => {
      expect(f.reconciliation.recordImportStarted).toHaveBeenCalledWith(org)
      throw new Error('queue-unavailable')
    })
    const operation = f.instance.sync(ORG)
    expect(f.reconciliation.recordImportStarted).toHaveBeenCalledWith(ORG)
    expect(f.queue.enqueueOrgSync).not.toHaveBeenCalled()
    finishMarker()
    await expect(operation).rejects.toThrow('queue-unavailable')
  })
  test('markörfel stoppar köpublicering', async () => {
    const f = controller()
    f.reconciliation.recordImportStarted.mockRejectedValue(new Error('marker-write-failed'))
    await expect(f.instance.sync(ORG)).rejects.toThrow('marker-write-failed')
    expect(f.queue.enqueueOrgSync).not.toHaveBeenCalled()
  })
  test('börja samtycke och offentlig callback skapar ingen importmarkör', async () => {
    const f = controller()
    await f.instance.begin(ORG, USER as never)
    const reply = { status: jest.fn(), header: jest.fn(), send: jest.fn() }
    reply.status.mockReturnValue(reply)
    reply.header.mockReturnValue(reply)
    await f.instance.callback(reply as never, 'untrusted-state', 'code')
    expect(f.consent.beginConsent).toHaveBeenCalledWith(ORG, USER.sub)
    expect(f.consent.handleCallback).toHaveBeenCalledWith('untrusted-state', 'code')
    expect(f.reconciliation.recordImportStarted).not.toHaveBeenCalled()
    expect(f.queue.enqueueOrgSync).not.toHaveBeenCalled()
  })

  function sync() {
    const reconciliation = { ...ports(), ingestFromApi: jest.fn() }
    const prisma = {
      bankConsent: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'consent', consentId: 'bank-consent', accessTokenEnc: 'encrypted' },
          ]),
        update: jest.fn().mockResolvedValue({}),
      },
      bankStatementImport: { create: jest.fn().mockResolvedValue({}) },
    }
    const crypto = { decrypt: jest.fn().mockReturnValue('synthetic-token') }
    const provider = {
      getConsentStatus: jest.fn(),
      listAccounts: jest.fn(),
      fetchTransactions: jest.fn(),
    }
    return {
      reconciliation,
      prisma,
      crypto,
      provider,
      service: new Psd2SyncService(
        prisma as never,
        reconciliation as never,
        crypto as never,
        provider as never,
      ),
    }
  }
  test.each(['ERROR', 'EXPIRED', 'REVOKED'])(
    'markering före decrypt/status %s som tömmer tokens',
    async (status) => {
      const f = sync()
      f.crypto.decrypt.mockImplementation(() => {
        expect(f.reconciliation.recordImportStarted).toHaveBeenCalledWith(ORG)
        return 'synthetic-token'
      })
      f.provider.getConsentStatus.mockResolvedValue({ status })
      await f.service.syncOrganization(ORG)
      expect(f.prisma.bankConsent.findMany).toHaveBeenCalledWith({
        where: { organizationId: ORG, status: 'ACTIVE' },
      })
      expect(f.reconciliation.recordImportStarted).toHaveBeenCalledTimes(1)
      expect(f.prisma.bankConsent.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status, accessTokenEnc: '' }) }),
      )
      expect(f.provider.listAccounts).not.toHaveBeenCalled()
      expect(f.reconciliation.ingestFromApi).not.toHaveBeenCalled()
    },
  )
  test('misslyckad första statuskontroll lämnar markör', async () => {
    const f = sync()
    f.provider.getConsentStatus.mockRejectedValue(new Error('provider-status-unavailable'))
    await expect(f.service.syncOrganization(ORG)).rejects.toThrow('provider-status-unavailable')
    expect(f.reconciliation.recordImportStarted).toHaveBeenCalledWith(ORG)
    expect(f.provider.listAccounts).not.toHaveBeenCalled()
  })
  test('ingen aktiv consent ger ingen påhittad försöksmarkör från intern synk', async () => {
    const f = sync()
    f.prisma.bankConsent.findMany.mockResolvedValue([])
    await f.service.syncOrganization(ORG)
    expect(f.reconciliation.recordImportStarted).not.toHaveBeenCalled()
    expect(f.crypto.decrypt).not.toHaveBeenCalled()
    expect(f.provider.getConsentStatus).not.toHaveBeenCalled()
  })
  test('markörfel stoppar decrypt, provider och auditpost', async () => {
    const f = sync()
    f.reconciliation.recordImportStarted.mockRejectedValue(new Error('marker-write-failed'))
    await expect(f.service.syncOrganization(ORG)).rejects.toThrow('marker-write-failed')
    expect(f.crypto.decrypt).not.toHaveBeenCalled()
    expect(f.provider.getConsentStatus).not.toHaveBeenCalled()
    expect(f.prisma.bankStatementImport.create).not.toHaveBeenCalled()
  })
})

describe('AI:s verkliga BgMax-case, efter dess rollgrind', () => {
  function ai() {
    const reconciliation = ports()
    // Kör verklig case-kod utan att konstruera alla orelaterade tjänster.
    const executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(executor, { reconciliationService: reconciliation, logger: { error: jest.fn() } })
    const run = (
      executor as unknown as {
        executeToolUnsafe: (
          name: string,
          input: Record<string, unknown>,
          org: string,
          user: string,
          role: string,
        ) => Promise<{ success: boolean; message: string }>
      }
    ).executeToolUnsafe.bind(executor)
    return { reconciliation, run }
  }
  test('tomt innehåll når markören innan tidig retur', async () => {
    const f = ai()
    const result = await f.run('import_bgmax_file', {}, ORG, USER.sub, 'OWNER')
    expect(result.success).toBe(false)
    expect(result.message).toContain('fileContent')
    expect(f.reconciliation.recordImportStarted).toHaveBeenCalledWith(ORG)
    expect(f.reconciliation.importBgMaxFile).not.toHaveBeenCalled()
  })
  test('nekad roll kan inte markera en import', async () => {
    const f = ai()
    await expect(f.run('import_bgmax_file', {}, ORG, USER.sub, 'VIEWER')).rejects.toThrow()
    expect(f.reconciliation.recordImportStarted).not.toHaveBeenCalled()
    expect(f.reconciliation.importBgMaxFile).not.toHaveBeenCalled()
  })
  test('markörfel returnerar misslyckande före BgMax-parsern', async () => {
    const f = ai()
    f.reconciliation.recordImportStarted.mockRejectedValue(new Error('marker-write-failed'))
    const result = await f.run(
      'import_bgmax_file',
      { fileContent: Buffer.from('bank').toString('base64') },
      ORG,
      USER.sub,
      'OWNER',
    )
    expect(result.success).toBe(false)
    expect(f.reconciliation.importBgMaxFile).not.toHaveBeenCalled()
  })
})

describe('ytterligare tidiga valideringsgränser', () => {
  test('ogiltigt bankval registrerar CSV-försöket före buffring', async () => {
    const { controller, reconciliation, statement } = uploads()
    const toBuffer = jest.fn()
    const request = { file: jest.fn().mockResolvedValue({ filename: 'bank.csv', toBuffer }) }
    await expect(controller.importStatement(ORG, request as never, 'unknown-bank')).rejects.toThrow(
      'Ogiltig bank',
    )
    expect(reconciliation.recordImportStarted).toHaveBeenCalledWith(ORG)
    expect(toBuffer).not.toHaveBeenCalled()
    expectNoImport(reconciliation, statement)
  })
})
