/**
 * Databasbackup: nyckelformat, retention-härledning och gallring.
 * pg_dump/upload testas end-to-end live (lokal round-trip), inte här.
 */

jest.mock('@aws-sdk/client-s3', () => {
  class Cmd {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  }
  return {
    S3Client: class {
      send = jest.fn()
    },
    PutObjectCommand: class extends Cmd {},
    ListObjectsV2Command: class extends Cmd {},
    DeleteObjectCommand: class extends Cmd {},
  }
})
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))

import { Test } from '@nestjs/testing'
import { ConfigService } from '@nestjs/config'
import { DiscoveryModule } from '@nestjs/core'
import {
  BackupService,
  BackupPreflightError,
  backupKey,
  isBackupExpired,
  parsePgDumpMajor,
  preflightMismatchMessage,
  serverMajorFromVersionNum,
} from './backup.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { BackupScheduler } from './backup.scheduler'

describe('BackupModule — initierar utan att krascha (boot-säkerhet)', () => {
  it('BackupService + BackupScheduler resolvar (även utan R2/DB-config → disabled)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        BackupService,
        BackupScheduler,
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PrismaService, useValue: { $queryRaw: jest.fn() } },
      ],
    }).compile()

    const service = moduleRef.get(BackupService)
    const scheduler = moduleRef.get(BackupScheduler)
    expect(service).toBeInstanceOf(BackupService)
    expect(scheduler).toBeInstanceOf(BackupScheduler)
    // Utan config → disabled (nattjobbet är no-op i dev/test)
    expect(service.enabled).toBe(false)
    // dailyBackup no-oppar tyst när disabled (kastar inte)
    await expect(scheduler.dailyBackup()).resolves.toBeUndefined()
    await moduleRef.close()
  })
})

describe('backupKey', () => {
  it('bygger en sorterbar UTC-nyckel', () => {
    expect(backupKey(new Date('2026-07-07T03:05:12.345Z'))).toBe(
      'db-backups/eken-20260707T030512Z.dump',
    )
  })
})

describe('isBackupExpired', () => {
  const now = new Date('2026-07-07T03:00:00Z')

  it('true när backupen är äldre än retention', () => {
    const old = 'db-backups/eken-20260501T030000Z.dump' // ~67 dagar
    expect(isBackupExpired(old, now, 30)).toBe(true)
  })

  it('false när backupen är inom retention', () => {
    const recent = 'db-backups/eken-20260620T030000Z.dump' // ~17 dagar
    expect(isBackupExpired(recent, now, 30)).toBe(false)
  })

  it('false för okänt nyckelformat (rör aldrig okända filer)', () => {
    expect(isBackupExpired('db-backups/random-file.txt', now, 30)).toBe(false)
  })
})

function makeService(retentionDays = 30) {
  const config = {
    get: (k: string) =>
      (({ BACKUP_RETENTION_DAYS: String(retentionDays) }) as Record<string, string>)[k],
  }
  return new BackupService(config as never, prismaStub() as never)
}

function serviceWith(env: Record<string, string>) {
  return new BackupService({ get: (k: string) => env[k] } as never, prismaStub() as never)
}

/** Prisma-dubbel: `server_version_num` som servern hade svarat. */
function prismaStub(versionNum = '180004') {
  return { $queryRaw: jest.fn().mockResolvedValue([{ v: versionNum }]) }
}

describe('BackupService.enabled — säkerhetsgrindar', () => {
  const fullMainCreds = {
    BACKUP_ENABLED: 'true',
    R2_ACCOUNT_ID: 'acc',
    R2_ACCESS_KEY_ID: 'ak',
    R2_SECRET_ACCESS_KEY: 'sk',
    R2_BUCKET_NAME: 'eken-files',
    DATABASE_URL: 'postgresql://u:p@h:5432/db',
  }

  it('BLOCKERAR i produktion när backup delar kredential + bucket med dokumentlagringen', () => {
    const svc = serviceWith({ ...fullMainCreds, NODE_ENV: 'production' })
    expect(svc.enabled).toBe(false)
  })

  it('tillåts i produktion med dedikerad backup-token + bucket', () => {
    const svc = serviceWith({
      ...fullMainCreds,
      NODE_ENV: 'production',
      R2_BACKUP_BUCKET: 'eken-db-backups',
      R2_BACKUP_ACCESS_KEY_ID: 'bak',
      R2_BACKUP_SECRET_ACCESS_KEY: 'bsk',
    })
    expect(svc.enabled).toBe(true)
  })

  it('tillåts i dev med huvudnycklarna (fallback)', () => {
    const svc = serviceWith(fullMainCreds) // NODE_ENV ej production
    expect(svc.enabled).toBe(true)
  })

  it('disabled när BACKUP_ENABLED inte är true', () => {
    const svc = serviceWith({ ...fullMainCreds, BACKUP_ENABLED: 'false' })
    expect(svc.enabled).toBe(false)
  })
})

describe('BackupService.pruneOldBackups', () => {
  it('tar bort endast utgångna backuper', async () => {
    const service = makeService(30)
    const now = new Date('2026-07-07T03:00:00Z')
    const expired = 'db-backups/eken-20260501T030000Z.dump'
    const fresh = 'db-backups/eken-20260701T030000Z.dump'

    const sent: Array<{ input: Record<string, unknown> }> = []
    ;(service as unknown as { s3: { send: jest.Mock } }).s3 = {
      send: jest.fn((cmd: { input: Record<string, unknown> }) => {
        sent.push(cmd)
        if (cmd.input.Prefix !== undefined) {
          return Promise.resolve({ Contents: [{ Key: expired }, { Key: fresh }] })
        }
        return Promise.resolve({})
      }),
    }

    const pruned = await service.pruneOldBackups(now)

    expect(pruned).toBe(1)
    const deletes = sent.filter((c) => c.input.Key !== undefined).map((c) => c.input.Key)
    expect(deletes).toEqual([expired])
  })
})

// ── Förkontroll: klientens version mot serverns ───────────────────────────────
//
// Riktningen är hela poängen och testas därför åt BÅDA hållen: en äldre klient
// ska fälla, en nyare ska INTE göra det. En kontroll som bara provats i det
// fällande fallet kan mycket väl fälla allt.

describe('parsePgDumpMajor', () => {
  it('läser major ur PGDG:s normalformat', () => {
    expect(parsePgDumpMajor('pg_dump (PostgreSQL) 18.6 (Debian 18.6-1.pgdg12+2)')).toBe(18)
    expect(parsePgDumpMajor('pg_dump (PostgreSQL) 16.15 (Debian 16.15-1.pgdg13+2)')).toBe(16)
  })

  it('klarar förhandsversioner utan minor', () => {
    expect(parsePgDumpMajor('pg_dump (PostgreSQL) 19devel')).toBe(19)
    expect(parsePgDumpMajor('pg_dump (PostgreSQL) 18rc1')).toBe(18)
  })

  it('null när formatet inte känns igen — varning, inte stopp', () => {
    expect(parsePgDumpMajor('något helt annat')).toBeNull()
    expect(parsePgDumpMajor('')).toBeNull()
  })
})

describe('serverMajorFromVersionNum', () => {
  it('180004 → 18, 160015 → 16', () => {
    expect(serverMajorFromVersionNum('180004')).toBe(18)
    expect(serverMajorFromVersionNum(160015)).toBe(16)
  })

  it('null för skräp', () => {
    expect(serverMajorFromVersionNum('abc')).toBeNull()
    expect(serverMajorFromVersionNum('0')).toBeNull()
  })
})

describe('preflightMismatchMessage', () => {
  it('säger vad som är fel, åt vilket håll regeln går, och vad man gör åt det', () => {
    const msg = preflightMismatchMessage(16, 18)
    expect(msg).toContain('pg_dump-klienten (16)')
    expect(msg).toContain('databasservern (18)')
    // Riktningen ska stå i klartext — det är den som inte är självklar.
    expect(msg).toContain('NYARE klient mot en äldre server fungerar, tvärtom aldrig')
    // Åtgärden ska gå att utföra utan att läsa koden.
    expect(msg).toContain('postgresql-client-N i apps/api/Dockerfile till minst 18')
    // Och att ingenting hann hända.
    expect(msg).toContain('Ingen backup togs')
    expect(msg).toContain('ingen befintlig backup gallrades')
  })
})

describe('BackupService.assertClientCanDumpServer', () => {
  /** Ersätter versionsavläsningarna — spawn/DB rörs inte i enhetstestet. */
  function withVersions(service: BackupService, client: number | null, server: number | null) {
    const priv = service as unknown as {
      pgDumpMajor: () => Promise<number | null>
      serverMajor: () => Promise<number | null>
    }
    priv.pgDumpMajor = () => Promise.resolve(client)
    priv.serverMajor = () => Promise.resolve(server)
  }

  it('FÄLLER när klienten är äldre än servern (16 mot 18)', async () => {
    const service = makeService()
    withVersions(service, 16, 18)
    await expect(service.assertClientCanDumpServer()).rejects.toBeInstanceOf(BackupPreflightError)
  })

  it('släpper igenom när klienten är NYARE än servern (18 mot 16)', async () => {
    const service = makeService()
    withVersions(service, 18, 16)
    await expect(service.assertClientCanDumpServer()).resolves.toBeUndefined()
  })

  it('släpper igenom vid samma version', async () => {
    const service = makeService()
    withVersions(service, 18, 18)
    await expect(service.assertClientCanDumpServer()).resolves.toBeUndefined()
  })

  it('okänd version stoppar INTE backupen (pg_dump är sistahandsskyddet)', async () => {
    const service = makeService()
    withVersions(service, null, 18)
    await expect(service.assertClientCanDumpServer()).resolves.toBeUndefined()
    withVersions(service, 16, null)
    await expect(service.assertClientCanDumpServer()).resolves.toBeUndefined()
  })
})

describe('BackupService.runBackup — förkontrollen kommer FÖRE allt annat', () => {
  it('kastar, larmar till Sentry med versionsbeskedet, och rör varken R2 eller filsystem', async () => {
    const Sentry = jest.requireMock('@sentry/nestjs') as { captureException: jest.Mock }
    Sentry.captureException.mockClear()

    const service = makeService()
    const priv = service as unknown as {
      pgDumpMajor: () => Promise<number | null>
      serverMajor: () => Promise<number | null>
      pgDump: () => Promise<void>
    }
    priv.pgDumpMajor = () => Promise.resolve(16)
    priv.serverMajor = () => Promise.resolve(18)
    // Skulle dumpen ändå köras är det ett fel i sig — låt den skrika.
    priv.pgDump = () => Promise.reject(new Error('pg_dump kördes trots förkontrollen'))

    const send = jest.fn()
    ;(service as unknown as { s3: { send: jest.Mock } }).s3 = { send }

    await expect(service.runBackup()).rejects.toBeInstanceOf(BackupPreflightError)

    // Ingen uppladdning, ingen listning, ingen gallring.
    expect(send).not.toHaveBeenCalled()

    // Larmet ska bära versionsbeskedet OSKRUBBAT — det innehåller inga
    // hemligheter, och den som läser Sentry ska kunna åtgärda direkt.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1)
    const rapporterat = Sentry.captureException.mock.calls[0]![0] as Error
    expect(rapporterat).toBeInstanceOf(BackupPreflightError)
    expect(rapporterat.message).toContain('postgresql-client-N')
  })
})

describe('BackupScheduler — ett fällt förkontroll-larm sväljs inte tyst', () => {
  it('runBackup anropas och felet larmas innan schemaläggaren sväljer det', async () => {
    const service = makeService()
    const runBackup = jest
      .spyOn(service, 'runBackup')
      .mockRejectedValue(new BackupPreflightError('fällde'))
    Object.defineProperty(service, 'enabled', { value: true })

    const { BackupScheduler: Scheduler } = await import('./backup.scheduler')
    const scheduler = new Scheduler(service)

    // Schemaläggaren får INTE kasta vidare (cron-loopen ska överleva), men
    // runBackup ska ha anropats — larmet sker där.
    await expect(scheduler.dailyBackup()).resolves.toBeUndefined()
    expect(runBackup).toHaveBeenCalledTimes(1)
  })
})
