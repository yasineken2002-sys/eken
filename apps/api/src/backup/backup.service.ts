import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import * as Sentry from '@sentry/nestjs'
import { spawn } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// R2-nyckel-prefix för databasbackuper. Isoleras från användarfiler.
const BACKUP_PREFIX = 'db-backups/'
const DEFAULT_RETENTION_DAYS = 30

// T5 Fas C — timeout-golv på backupens EGNA R2-klient (samma Tier 1-fynd som
// storage.service, men denna väg laddar upp en HEL pg_dump som kan vara stor).
// Utan golv defaultar @smithy/node-http-handler till 0 = OÄNDLIGT → en R2-
// hängning låter backup-cronet hänga för alltid (tyst: en HÄNGNING ger inget
// fel, så scheduler-Sentryn larmar aldrig). VIKTIGT: till skillnad från
// storage.service sätter vi INTE requestTimeout här — för en PutObject kommer
// response-headers först NÄR hela kroppen sänts, så ett requestTimeout skulle
// kapa en LEGITIM stor backup-uppladdning. socketTimeout är rätt golv: Node-
// socketns idle-timeout återstartas av upload-aktivitet → bryter bara en ÄKTA
// frysning (inget flöde), aldrig ett aktivt (om än stort/långsamt) flöde.
const R2_BACKUP_CONNECTION_TIMEOUT_MS = 5_000 // TCP+TLS-handshake
const R2_BACKUP_SOCKET_TIMEOUT_MS = 60_000 // idle-stall (generöst; upload-aktivitet återstartar)

// ── Rena hjälpare (testbara utan DB/R2) ─────────────────────────────────────────

// Sorterbar UTC-nyckel: db-backups/eken-20260707T030512Z.dump
export function backupKey(date: Date): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  return `${BACKUP_PREFIX}eken-${stamp}.dump`
}

// Härleder backupens tidsstämpel ur nyckeln och avgör om den passerat retention.
// Okänt nyckelformat → false (rör ALDRIG en fil vi inte känner igen).
export function isBackupExpired(key: string, now: Date, retentionDays: number): boolean {
  const m = key.match(/eken-(\d{8})T(\d{6})Z\.dump$/)
  if (!m) return false
  const d = m[1]!
  const t = m[2]!
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`
  const backupTime = new Date(iso).getTime()
  if (Number.isNaN(backupTime)) return false
  return now.getTime() - backupTime > retentionDays * 24 * 60 * 60 * 1000
}

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name)
  private readonly s3: S3Client
  private readonly bucket: string
  private readonly databaseUrl: string
  readonly retentionDays: number
  readonly enabled: boolean

  constructor(private readonly config: ConfigService) {
    // Dedikerade backup-kredentialer (fallback till huvudnycklarna i dev). En
    // dump innehåller ALL PII för alla organisationer — den ska ligga bakom en
    // separat, minimalt scopad R2-token så att en läckt dokumentlagrings-nyckel
    // inte ger tillgång till hela databasdumpen (och vice versa).
    const accountId =
      config.get<string>('R2_BACKUP_ACCOUNT_ID') ?? config.get<string>('R2_ACCOUNT_ID')
    const accessKeyId =
      config.get<string>('R2_BACKUP_ACCESS_KEY_ID') ?? config.get<string>('R2_ACCESS_KEY_ID')
    const secretAccessKey =
      config.get<string>('R2_BACKUP_SECRET_ACCESS_KEY') ??
      config.get<string>('R2_SECRET_ACCESS_KEY')
    const backupBucket = config.get<string>('R2_BACKUP_BUCKET')
    this.bucket = backupBucket ?? config.get<string>('R2_BUCKET_NAME') ?? ''
    this.databaseUrl = config.get<string>('DATABASE_URL') ?? ''
    this.retentionDays = Number(
      config.get<string>('BACKUP_RETENTION_DAYS') ?? DEFAULT_RETENTION_DAYS,
    )

    // Delar backupen BÅDE kredential OCH bucket med dokumentlagringen? Då är
    // isoleringen inte på plats — förbjud i produktion (fail-closed) tills en
    // dedikerad backup-token + bucket konfigurerats.
    const isProd = config.get<string>('NODE_ENV') === 'production'
    const sharesMainCredsAndBucket = !config.get<string>('R2_BACKUP_ACCESS_KEY_ID') && !backupBucket

    // Kör bara om explicit aktiverat OCH all config finns — annars no-op (dev/test).
    this.enabled =
      config.get<string>('BACKUP_ENABLED') === 'true' &&
      !!accountId &&
      !!accessKeyId &&
      !!secretAccessKey &&
      !!this.bucket &&
      !!this.databaseUrl &&
      !(isProd && sharesMainCredsAndBucket)

    if (config.get<string>('BACKUP_ENABLED') === 'true' && isProd && sharesMainCredsAndBucket) {
      this.logger.error(
        '[backup] BLOCKERAD i produktion: backupen delar R2-kredential och bucket med ' +
          'dokumentlagringen. Sätt R2_BACKUP_BUCKET + R2_BACKUP_ACCESS_KEY_ID/' +
          'R2_BACKUP_SECRET_ACCESS_KEY (dedikerad, minimalt scopad token) innan aktivering.',
      )
    }

    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId ?? ''}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: accessKeyId ?? '', secretAccessKey: secretAccessKey ?? '' },
      // Timeout-golv (se konstanterna ovan). ENDAST connection + socket (idle) —
      // INGET requestTimeout, för att inte kapa en stor backup-uppladdning.
      // maxAttempts lämnas default (3): async cron, ingen latensbudget, mer
      // resiliens är önskvärt (till skillnad från storage.service:s synkrona väg).
      requestHandler: {
        connectionTimeout: R2_BACKUP_CONNECTION_TIMEOUT_MS,
        socketTimeout: R2_BACKUP_SOCKET_TIMEOUT_MS,
      },
    })
  }

  // Tar en full pg_dump (custom-format), laddar upp till R2 och gallrar gamla
  // backuper. Kastar vid fel så att schemaläggaren kan larma. Custom-format (-Fc)
  // är komprimerat och kan pg_restore:as selektivt.
  async runBackup(): Promise<{ key: string; bytes: number; pruned: number }> {
    const key = backupKey(new Date())
    const tmpPath = join(tmpdir(), `eken-backup-${Date.now()}.dump`)

    try {
      // Förskapa temp-filen med 0600 (bara ägaren) innan pg_dump skriver PII till
      // den — POSIX bevarar behörigheten vid trunkering.
      await writeFile(tmpPath, '', { mode: 0o600 })
      await this.pgDump(tmpPath)
      const body = await readFile(tmpPath)
      if (body.length === 0) throw new Error('pg_dump gav en tom fil')

      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/octet-stream',
        }),
      )

      const pruned = await this.pruneOldBackups()
      this.logger.log(
        `[backup] OK ${key} (${(body.length / 1024 / 1024).toFixed(1)} MB), gallrade ${pruned} gamla`,
      )
      return { key, bytes: body.length, pruned }
    } catch (err) {
      // Full detalj (kan innehålla pg_dump-stderr med host/user/db) enbart i den
      // lokala loggen. Sentry får ett skrubbat meddelande — dess läsarkrets är
      // bredare än de som har DB-/infra-access.
      this.logger.error(
        `[backup] MISSLYCKADES: ${err instanceof Error ? err.message : String(err)}`,
      )
      Sentry.captureException(new Error('Databasbackup misslyckades (se serverlogg för detalj)'))
      throw err
    } finally {
      await unlink(tmpPath).catch(() => undefined)
    }
  }

  // Listar befintliga backuper (nyaste först) — för runbook/observability.
  async listBackups(): Promise<Array<{ key: string; size: number; lastModified?: Date }>> {
    const res = await this.s3.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: BACKUP_PREFIX }),
    )
    return (res.Contents ?? [])
      .filter((o) => o.Key)
      .map((o) => ({
        key: o.Key!,
        size: o.Size ?? 0,
        ...(o.LastModified ? { lastModified: o.LastModified } : {}),
      }))
      .sort((a, b) => b.key.localeCompare(a.key))
  }

  // Gallrar backuper äldre än retentionDays. Returnerar antal borttagna.
  async pruneOldBackups(now: Date = new Date()): Promise<number> {
    const res = await this.s3.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: BACKUP_PREFIX }),
    )
    const expired = (res.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => !!k && isBackupExpired(k, now, this.retentionDays))
    for (const key of expired) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
    }
    return expired.length
  }

  // pg_dump via spawn (aldrig shell → ingen kommandoinjektion). Lösenordet flyttas
  // från connection-strängen till PGPASSWORD-env så det INTE syns i `ps aux` (argv
  // är läsbart för andra processer; env är det inte). Custom-format till fil.
  private pgDump(outPath: string): Promise<void> {
    const url = new URL(this.databaseUrl)
    const password = decodeURIComponent(url.password)
    url.password = ''
    const connWithoutPassword = url.toString()

    return new Promise((resolve, reject) => {
      const proc = spawn(
        'pg_dump',
        ['-Fc', '--no-owner', '--no-privileges', '-f', outPath, connWithoutPassword],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, PGPASSWORD: password },
        },
      )
      let stderr = ''
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString()
      })
      proc.on('error', reject)
      proc.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`pg_dump avslutades med kod ${code}: ${stderr.slice(0, 500)}`)),
      )
    })
  }
}
