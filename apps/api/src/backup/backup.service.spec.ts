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
  R2_ISOLATION_FIELDS,
  findR2IsolationOverlaps,
  isolationBlockMessage,
  backupKey,
  isBackupExpired,
  parsePgDumpMajor,
  preflightMismatchMessage,
  serverMajorFromVersionNum,
} from './backup.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { BackupScheduler } from './backup.scheduler'
import { BackupFreshnessService } from './backup-freshness.service'
import { alltidLedigtLås } from '../common/redis/lock.test-double'
import { LockService } from '../common/redis/lock.service'

describe('BackupModule — initierar utan att krascha (boot-säkerhet)', () => {
  it('BackupService + BackupScheduler resolvar (även utan R2/DB-config → disabled)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        BackupService,
        BackupScheduler,
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PrismaService, useValue: { $queryRaw: jest.fn() } },
        BackupFreshnessService,
        // Cron-låset (klass A). Boot-testet ska bevisa att modulen RESOLVAR —
        // att den nya beroendekanten faktiskt går att tillfredsställa är en del
        // av det, och en attrapp räcker: låsets beteende prövas i cron-lock.spec.
        { provide: LockService, useValue: alltidLedigtLås },
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
    const scheduler = new Scheduler(service, { check: jest.fn() } as never, alltidLedigtLås)

    // Schemaläggaren får INTE kasta vidare (cron-loopen ska överleva), men
    // runBackup ska ha anropats — larmet sker där.
    await expect(scheduler.dailyBackup()).resolves.toBeUndefined()
    expect(runBackup).toHaveBeenCalledTimes(1)
  })
})

// ── Isoleringsgrinden: backupen får inte dela NÅGOT med fillagringen ──────────
//
// Värdet i en backup ligger i att den inte kan nås med samma nyckel som når
// originalet. Ett överlapp räcker för att det värdet ska vara borta, och det är
// därför grinden fäller på ELLER och inte på OCH.

const ISOLERAT = {
  BACKUP_ENABLED: 'true',
  NODE_ENV: 'production',
  R2_ACCOUNT_ID: 'acc',
  R2_ACCESS_KEY_ID: 'app-ak',
  R2_SECRET_ACCESS_KEY: 'app-sk',
  R2_BUCKET_NAME: 'eken-files',
  R2_BACKUP_BUCKET: 'eken-db-backups',
  R2_BACKUP_ACCESS_KEY_ID: 'backup-ak',
  R2_BACKUP_SECRET_ACCESS_KEY: 'backup-sk',
  DATABASE_URL: 'postgresql://u:p@h:5432/db',
}

describe('findR2IsolationOverlaps', () => {
  const isolerad = {
    backup: { bucket: 'b-bucket', accessKeyId: 'b-ak', secretAccessKey: 'b-sk' },
    main: { bucket: 'm-bucket', accessKeyId: 'm-ak', secretAccessKey: 'm-sk' },
    dedicatedSet: { bucket: true, accessKeyId: true, secretAccessKey: true },
  }

  it('tom lista när ingenting delas', () => {
    expect(findR2IsolationOverlaps(isolerad)).toEqual([])
  })

  it.each(R2_ISOLATION_FIELDS)('fäller på ENBART %s-överlapp', (field) => {
    const input = {
      ...isolerad,
      backup: { ...isolerad.backup, [field]: isolerad.main[field] },
    }
    expect(findR2IsolationOverlaps(input).map((o) => o.field)).toEqual([field])
  })

  it('rapporterar ALLA överlapp, inte bara det första', () => {
    const allt = {
      ...isolerad,
      backup: { ...isolerad.main },
    }
    expect(findR2IsolationOverlaps(allt).map((o) => o.field)).toEqual([...R2_ISOLATION_FIELDS])
  })

  it('tomma värden är inte ett överlapp — en osatt huvudnyckel kan inte delas', () => {
    const tomma = {
      backup: { bucket: '', accessKeyId: undefined, secretAccessKey: '' },
      main: { bucket: '', accessKeyId: undefined, secretAccessKey: '' },
      dedicatedSet: { bucket: false, accessKeyId: false, secretAccessKey: false },
    }
    expect(findR2IsolationOverlaps(tomma)).toEqual([])
  })

  it('skiljer på "osatt → faller tillbaka" och "satt till samma värde"', () => {
    const fallback = findR2IsolationOverlaps({
      backup: { ...isolerad.backup, bucket: 'm-bucket' },
      main: isolerad.main,
      dedicatedSet: { ...isolerad.dedicatedSet, bucket: false },
    })
    expect(fallback[0]).toEqual({ field: 'bucket', dedicatedSet: false })

    const explicit = findR2IsolationOverlaps({
      backup: { ...isolerad.backup, bucket: 'm-bucket' },
      main: isolerad.main,
      dedicatedSet: { ...isolerad.dedicatedSet, bucket: true },
    })
    expect(explicit[0]).toEqual({ field: 'bucket', dedicatedSet: true })
  })
})

// ── KANARIEFÅGEL ─────────────────────────────────────────────────────────────
//
// De namngivna testerna ovan skyddar mot SPECIFIKA återfall ("just den här
// kollisionen fälls"). De upptäcker inte att mekanismen gått blind — en
// jämförelse som alltid returnerar tom lista gör dem röda en och en, men en
// jämförelse som tappat ETT fält märks bara om någon råkar ha skrivit ett test
// för just det fältet.
//
// Kanariefågeln matar därför in en konfiguration som MÅSTE ge utslag på VARJE
// fält i R2_ISOLATION_FIELDS, och kräver att antalet stämmer. Läggs ett fält
// till i listan utan att jämförelsen implementerar det blir den här röd — inte
// tyst grön.
describe('KANARIEFÅGEL — isoleringsjämförelsen mäter fortfarande', () => {
  it('en helt delad konfiguration ger utslag på EXAKT alla kända fält', () => {
    const delat = 'identiskt-varde'
    const allaDelade = {
      backup: Object.fromEntries(R2_ISOLATION_FIELDS.map((f) => [f, delat])),
      main: Object.fromEntries(R2_ISOLATION_FIELDS.map((f) => [f, delat])),
      dedicatedSet: Object.fromEntries(R2_ISOLATION_FIELDS.map((f) => [f, true])),
    } as Parameters<typeof findR2IsolationOverlaps>[0]

    const träffar = findR2IsolationOverlaps(allaDelade)

    // Antalet är poängen: en jämförelse som tappat ett fält ger färre.
    expect(träffar).toHaveLength(R2_ISOLATION_FIELDS.length)
    expect(träffar.map((o) => o.field).sort()).toEqual([...R2_ISOLATION_FIELDS].sort())
    // Och varje fält måste ha ett eget besked — annars kan operatören inte se
    // VILKET överlapp som fälldes.
    const besked = isolationBlockMessage(träffar)
    for (const field of R2_ISOLATION_FIELDS) {
      expect(besked).toContain(
        field === 'bucket'
          ? 'R2_BACKUP_BUCKET'
          : `R2_BACKUP_${field === 'accessKeyId' ? 'ACCESS_KEY_ID' : 'SECRET_ACCESS_KEY'}`,
      )
    }
  })

  it('och en helt isolerad konfiguration ger INGET utslag (fäller inte allt)', () => {
    const isolerad = {
      backup: Object.fromEntries(R2_ISOLATION_FIELDS.map((f) => [f, `backup-${f}`])),
      main: Object.fromEntries(R2_ISOLATION_FIELDS.map((f) => [f, `app-${f}`])),
      dedicatedSet: Object.fromEntries(R2_ISOLATION_FIELDS.map((f) => [f, true])),
    } as Parameters<typeof findR2IsolationOverlaps>[0]

    expect(findR2IsolationOverlaps(isolerad)).toEqual([])
  })
})

describe('isolationBlockMessage — namnger felet utan att läcka värden', () => {
  // Sentinelvärden med hög entropi. Poängen är att de INTE ska kunna matcha
  // vanliga ord i beskedet: ett trubbigt prefixtest (t.ex. 'back' ur
  // 'backup-ak') träffar ordet "backup" och mäter då stavning, inte läckage.
  const HEMLIGA_VÄRDEN = [
    'Zq7Kx-app-access-key',
    'Vn4Rm-app-secret',
    'Ht2Ws-backup-access-key',
    'Jd8Pl-backup-secret',
    'Bg5Cy-bucket-name',
  ]

  it('namnger variabeln och åtgärden', () => {
    const msg = isolationBlockMessage([{ field: 'accessKeyId', dedicatedSet: true }])
    expect(msg).toContain('R2_BACKUP_ACCESS_KEY_ID är satt till samma värde som R2_ACCESS_KEY_ID')
    expect(msg).toContain('minimalt scopad API-token')
    expect(msg).toContain('samma credential som raderar')
  })

  it('säger när den dedikerade variabeln är OSATT och faller tillbaka', () => {
    const msg = isolationBlockMessage([{ field: 'bucket', dedicatedSet: false }])
    expect(msg).toContain('R2_BACKUP_BUCKET är osatt, så värdet faller tillbaka på R2_BUCKET_NAME')
  })

  it('läcker ALDRIG ett värde — inte ens ett prefix', () => {
    const msg = isolationBlockMessage(
      R2_ISOLATION_FIELDS.map((field) => ({ field, dedicatedSet: true })),
    )
    for (const värde of HEMLIGA_VÄRDEN) {
      expect(msg).not.toContain(värde)
      expect(msg).not.toContain(värde.slice(0, 5))
    }
  })
})

describe('BackupService.enabled — ETT överlapp räcker för att blockera i prod', () => {
  it('tillåts när backupen är helt isolerad', () => {
    expect(serviceWith(ISOLERAT).enabled).toBe(true)
  })

  it.each([
    ['bucket', 'R2_BACKUP_BUCKET', 'R2_BUCKET_NAME'],
    ['access key id', 'R2_BACKUP_ACCESS_KEY_ID', 'R2_ACCESS_KEY_ID'],
    ['secret access key', 'R2_BACKUP_SECRET_ACCESS_KEY', 'R2_SECRET_ACCESS_KEY'],
  ])('BLOCKERAR när bara %s delas', (_namn, backupVar, mainVar) => {
    const env = { ...ISOLERAT, [backupVar]: ISOLERAT[mainVar as keyof typeof ISOLERAT] }
    expect(serviceWith(env).enabled).toBe(false)
  })

  it.each([['R2_BACKUP_BUCKET'], ['R2_BACKUP_ACCESS_KEY_ID'], ['R2_BACKUP_SECRET_ACCESS_KEY']])(
    'BLOCKERAR när %s är osatt (faller tillbaka på huvudvärdet)',
    (backupVar) => {
      const env: Record<string, string> = { ...ISOLERAT }
      delete env[backupVar]
      expect(serviceWith(env).enabled).toBe(false)
    },
  )

  it('dev är fortfarande tillåtet med huvudnycklarna (fallback)', () => {
    const env: Record<string, string> = { ...ISOLERAT }
    delete env.NODE_ENV
    delete env.R2_BACKUP_BUCKET
    delete env.R2_BACKUP_ACCESS_KEY_ID
    delete env.R2_BACKUP_SECRET_ACCESS_KEY
    expect(serviceWith(env).enabled).toBe(true)
  })
})
