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
import { BackupService, backupKey, isBackupExpired } from './backup.service'
import { BackupScheduler } from './backup.scheduler'

describe('BackupModule — initierar utan att krascha (boot-säkerhet)', () => {
  it('BackupService + BackupScheduler resolvar (även utan R2/DB-config → disabled)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        BackupService,
        BackupScheduler,
        { provide: ConfigService, useValue: { get: () => undefined } },
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
  return new BackupService(config as never)
}

function serviceWith(env: Record<string, string>) {
  return new BackupService({ get: (k: string) => env[k] } as never)
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
