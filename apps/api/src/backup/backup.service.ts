import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3'
import * as Sentry from '@sentry/nestjs'
import { spawn } from 'node:child_process'
import { PrismaService } from '../common/prisma/prisma.service'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// R2-nyckel-prefix för databasbackuper. Isoleras från användarfiler.
const BACKUP_PREFIX = 'db-backups/'
const DEFAULT_RETENTION_DAYS = 30

// ── R2-JURISDIKTION ─────────────────────────────────────────────────────────
//
// I R2 väljs jurisdiktionen av VÄRDNAMNET, inte av ett fält i anropet:
//
//   default   <konto>.r2.cloudflarestorage.com
//   eu        <konto>.eu.r2.cloudflarestorage.com
//
// En bucket tillhör EXAKT EN jurisdiktion. Frågar man efter den på fel endpoint
// svarar R2 `404 NoSuchBucket` — alltså samma svar som när bucketen inte finns
// alls. Uppmätt 2026-08-27 mot prod: appens bucket ger `200` på default-
// endpointen och `404 NoSuchBucket` på EU-endpointen med SAMMA nycklar.
//
// VARFÖR ETT ENUM OCH INTE EN RÅ ENDPOINT-URL. En felstavad värdnamnssträng är
// syntaktiskt giltig och upptäcks först som ett 404 klockan 03:00 — alltså som
// ett larm som ser ut att handla om en saknad bucket. Ett litet enum kan bara
// stavas fel på ett sätt som går att fånga, och fångas vid uppstart.
//
// `fedramp` finns också hos Cloudflare men är amerikansk myndighetsjurisdiktion
// och medvetet utelämnad: varje värde här är en väg som måste kunna testas.
export const R2_JURISDICTIONS = ['default', 'eu'] as const
export type R2Jurisdiction = (typeof R2_JURISDICTIONS)[number]

/** Variabelnamnet på ETT ställe — meddelanden och grind ska inte kunna glida isär. */
export const R2_BACKUP_JURISDICTION_VAR = 'R2_BACKUP_JURISDICTION'

/**
 * Läser konfigurationsvärdet. `undefined`/tom sträng → `'default'` (bakåt-
 * kompatibelt: så betedde sig koden innan variabeln fanns). Okänt värde → `null`,
 * vilket anroparen MÅSTE behandla som ett fel — aldrig som `'default'`.
 *
 * Att tolka ett oläsbart värde som default vore den tystnad hela ändringen
 * finns för att ta bort: konfigurationen säger `eu`, koden pratar med default,
 * och skillnaden syns först som ett 404 mitt i natten.
 */
export function parseR2Jurisdiction(raw: string | undefined): R2Jurisdiction | null {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === '') return 'default'
  return (R2_JURISDICTIONS as readonly string[]).includes(v) ? (v as R2Jurisdiction) : null
}

/**
 * Värdnamnet för en jurisdiktion. ENDA stället i backupvägen där R2:s värdnamn
 * skrivs — bevakat av `scripts/check-backup-endpoint.mjs`, som fäller om det
 * hårdkodas någon annanstans i `src/backup/`.
 */
export function r2EndpointFor(accountId: string, jurisdiction: R2Jurisdiction): string {
  const prefix = jurisdiction === 'default' ? '' : `${jurisdiction}.`
  return `https://${accountId}.${prefix}r2.cloudflarestorage.com`
}

/**
 * Beskedet operatören läser när bucketen inte finns på den endpoint
 * konfigurationen pekar på.
 *
 * Samma form som `preflightMismatchMessage` (#540): säg vad som är fel OCH vad
 * man gör åt det, före dumpen i stället för mitt i den. Utan den här texten är
 * larmet ett rått `NoSuchBucket`, och de två möjliga orsakerna — fel
 * jurisdiktion, eller ingen bucket alls — är omöjliga att skilja åt klockan tre
 * på natten.
 */
export function preflightBucketMissingMessage(
  bucket: string,
  jurisdiction: R2Jurisdiction,
): string {
  return (
    `Backupen avbröts FÖRE dumpen: backupbucketen ${bucket} hittades inte på ` +
    `${jurisdiction}-endpointen. En bucket tillhör exakt en jurisdiktion — kontrollera ` +
    `att ${R2_BACKUP_JURISDICTION_VAR} matchar den jurisdiktion bucketen skapades i ` +
    `(giltiga värden: ${R2_JURISDICTIONS.join(', ')}). Ingen backup togs, och ingen ` +
    'befintlig backup gallrades.'
  )
}

/** Beskedet vid ett oläsbart konfigurationsvärde. Läses vid UPPSTART, inte 03:00. */
export function invalidJurisdictionMessage(): string {
  return (
    `[backup] ${R2_BACKUP_JURISDICTION_VAR} har ett värde som inte känns igen. ` +
    `Giltiga värden: ${R2_JURISDICTIONS.join(', ')}. Backupen är AVSTÄNGD tills det ` +
    'rättas — ett oläsbart värde får aldrig tolkas som "default", eftersom en bucket ' +
    'i EU då skulle sökas på default-endpointen och svara 404 NoSuchBucket, alltså ' +
    'samma svar som en bucket som inte finns.'
  )
}

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

/**
 * ISOLERINGEN MELLAN BACKUPEN OCH APPLIKATIONENS FILLAGRING.
 *
 * Varför grinden finns: en dump innehåller ALL PII för alla organisationer, och
 * hela värdet i den ligger i att den inte kan nås med samma nyckel som når
 * originalet. **En backup som går att radera med samma nyckel som raderade
 * originalet är ingen backup.** En komprometterad — eller bara felanvänd —
 * app-credential ska ta med sig produktionsdatan, inte kopian av den också.
 *
 * ETT ÖVERLAPP RÄCKER. Fram till #541 var villkoret ett AND (`!dedikerad nyckel
 * && !dedikerad bucket`), vilket betydde att en HALVKONFIGURATION passerade:
 * samma nyckel men annan bucket, eller samma bucket men annan nyckel. Båda
 * bryter isoleringen — delad nyckel ger åtkomst till backup-bucketen ändå, och
 * delad bucket gör att app-nyckeln kan lista och radera dumparna. Dessutom
 * ingick `R2_BACKUP_SECRET_ACCESS_KEY` inte alls i jämförelsen.
 *
 * Jämförelsen sker på EFFEKTIVA värden, inte på "är variabeln satt". Det fångar
 * två fall med samma kod: den dedikerade variabeln saknas (och faller tillbaka
 * på huvudvärdet), och den dedikerade variabeln är satt till samma värde som
 * huvudvärdet. Det andra fallet var osynligt för den gamla formen.
 */
export const R2_ISOLATION_FIELDS = ['bucket', 'accessKeyId', 'secretAccessKey'] as const
export type R2IsolationField = (typeof R2_ISOLATION_FIELDS)[number]

/** Variabelnamnen per fält. ALDRIG värden — namnet räcker för att åtgärda felet. */
const R2_ISOLATION_VARS: Record<R2IsolationField, { backup: string; main: string; vad: string }> = {
  bucket: {
    backup: 'R2_BACKUP_BUCKET',
    main: 'R2_BUCKET_NAME',
    vad: 'samma bucket som applikationens fillagring',
  },
  accessKeyId: {
    backup: 'R2_BACKUP_ACCESS_KEY_ID',
    main: 'R2_ACCESS_KEY_ID',
    vad: 'samma access key id som applikationens fillagring',
  },
  secretAccessKey: {
    backup: 'R2_BACKUP_SECRET_ACCESS_KEY',
    main: 'R2_SECRET_ACCESS_KEY',
    vad: 'samma secret access key som applikationens fillagring',
  },
}

export interface R2IsolationOverlap {
  field: R2IsolationField
  /** Var den dedikerade variabeln satt alls, eller föll värdet tillbaka på huvudvärdet? */
  dedicatedSet: boolean
}

/**
 * Effektiva värden på båda sidor. Tomma värden jämförs ALDRIG: en osatt
 * huvudnyckel kan inte "delas", och `enabled` kräver ändå att backupens egna
 * värden finns. Utan den regeln hade två tomma strängar rapporterats som ett
 * överlapp — ett larm om ingenting.
 */
export interface R2IsolationInput {
  backup: Record<R2IsolationField, string | undefined>
  main: Record<R2IsolationField, string | undefined>
  /** Vilka dedikerade R2_BACKUP_*-variabler som faktiskt var satta. */
  dedicatedSet: Record<R2IsolationField, boolean>
}

/** Varje fält där backupen och fillagringen delar värde. Tom lista = isolerat. */
export function findR2IsolationOverlaps(input: R2IsolationInput): R2IsolationOverlap[] {
  return R2_ISOLATION_FIELDS.filter((field) => {
    const b = input.backup[field]
    const m = input.main[field]
    if (!b || !m) return false
    return b === m
  }).map((field) => ({ field, dedicatedSet: input.dedicatedSet[field] }))
}

/**
 * Beskedet operatören läser. Namnger VILKET överlapp som hittades och vad man
 * gör åt det.
 *
 * INGA VÄRDEN, inte ens ett prefix. Ett bucketnamn är i sig harmlöst, men ett
 * prefix av en hemlighet är det inte, och en regel som gäller "bara ibland" blir
 * fel den dagen någon kopierar raden. Variabelnamnet räcker för att åtgärda
 * felet — den som ska rätta det har ändå tillgång till konfigurationen.
 */
export function isolationBlockMessage(overlaps: R2IsolationOverlap[]): string {
  const punkter = overlaps
    .map(({ field, dedicatedSet }) => {
      const { backup, main, vad } = R2_ISOLATION_VARS[field]
      const hur = dedicatedSet
        ? `${backup} är satt till samma värde som ${main}`
        : `${backup} är osatt, så värdet faller tillbaka på ${main}`
      return `${vad} (${hur})`
    })
    .join('; ')

  return (
    '[backup] BLOCKERAD i produktion: backupen delar konfiguration med ' +
    `applikationens fillagring — ${punkter}. En nyckel som når både originalet ` +
    'och kopian gör backupen verkningslös: samma credential som raderar ' +
    'produktionsdatan raderar då även säkerhetskopian. ÅTGÄRD: skapa en egen ' +
    'R2-bucket för backuper och en egen, minimalt scopad API-token (List/Get/' +
    'Put/Delete enbart på den bucketen), och sätt R2_BACKUP_BUCKET, ' +
    'R2_BACKUP_ACCESS_KEY_ID och R2_BACKUP_SECRET_ACCESS_KEY till dessa — ' +
    'inga av dem får dela värde med R2_BUCKET_NAME, R2_ACCESS_KEY_ID eller ' +
    'R2_SECRET_ACCESS_KEY.'
  )
}

/**
 * Förkontrollen fällde — klienten kan inte dumpa servern.
 *
 * Egen typ av ETT skäl: felmeddelandet innehåller bara versionsnummer, inga
 * hemligheter, och ska därför gå OSKRUBBAT till Sentry. `pg_dump`-stderr kan
 * bära host/user/db och skrubbas fortsatt (se `runBackup`:s catch).
 */
export class BackupPreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupPreflightError'
  }
}

/**
 * Major-versionen ur `pg_dump --version`.
 *
 * Formatet är "pg_dump (PostgreSQL) 18.6 (Debian 18.6-1.pgdg12+2)", men även
 * "19devel" och "18rc1" förekommer i PGDG:s förhandsversioner — därför matchas
 * siffran efter "(PostgreSQL)" och inte "första talet i strängen".
 *
 * `null` = formatet känns inte igen. Det är AVSIKTLIGT inte ett fel: se
 * `assertClientCanDumpServer` för varför en oläsbar version varnar i stället för
 * att stoppa backupen.
 */
export function parsePgDumpMajor(output: string): number | null {
  const m = output.match(/\(PostgreSQL\)\s+(\d+)/)
  if (!m) return null
  const major = Number(m[1])
  return Number.isInteger(major) && major > 0 ? major : null
}

/**
 * Major-versionen ur `server_version_num` (180004 → 18, 160015 → 16).
 * Postgres egen kodning: major * 10000 + minor.
 */
export function serverMajorFromVersionNum(versionNum: string | number): number | null {
  const n = Number(versionNum)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n / 10000)
}

/**
 * Meddelandet operatören läser klockan tre på natten.
 *
 * `pg_dump`:s eget besked är "aborting because of server version mismatch" plus
 * två versionsnummer. Det säger VAD som hände men varken varför riktningen
 * spelar roll eller vad man gör åt det — och den som läser det gör det i ett
 * Sentry-mejl, utan koden framför sig.
 */
export function preflightMismatchMessage(clientMajor: number, serverMajor: number): string {
  return (
    `Backupen avbröts FÖRE dumpen: pg_dump-klienten (${clientMajor}) är äldre än ` +
    `databasservern (${serverMajor}). pg_dump vägrar dumpa en nyare server — regeln är ` +
    'enkelriktad: en NYARE klient mot en äldre server fungerar, tvärtom aldrig. ' +
    'Ingen backup togs, och ingen befintlig backup gallrades. ' +
    `ÅTGÄRD: höj postgresql-client-N i apps/api/Dockerfile till minst ${serverMajor} ` +
    'och deploya om — versionen är ett golv, inte en exakt matchning.'
  )
}

// Sorterbar UTC-nyckel: db-backups/eken-20260707T030512Z.dump
export function backupKey(date: Date): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  return `${BACKUP_PREFIX}eken-${stamp}.dump`
}

/**
 * Tidsstämpeln ur en backup-nyckel (`db-backups/eken-20260707T030512Z.dump`).
 * `null` för okänt format — samma försiktighetsregel som `isBackupExpired`:
 * en fil vi inte känner igen tolkas aldrig.
 */
export function parseBackupKeyDate(key: string): Date | null {
  const m = key.match(/eken-(\d{8})T(\d{6})Z\.dump$/)
  if (!m) return null
  const d = m[1]!
  const t = m[2]!
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? null : parsed
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
  /** Jurisdiktionen klienten faktiskt pratar med. Läses av förkontrollens besked. */
  readonly jurisdiction: R2Jurisdiction
  private readonly databaseUrl: string
  readonly retentionDays: number
  readonly enabled: boolean
  /** Kör vi skarpt? Färskhetslarmet larmar bara i produktion. */
  readonly isProduction: boolean
  /**
   * VARFÖR backupen inte kommer att köra i produktion — `null` när den kör.
   *
   * Grinden visste redan detta men behöll det för sig själv: `enabled = false`
   * är ett tyst tillstånd, och det var precis det som lät backupen vara
   * avstängd i 45 dagar utan signal. Färskhetslarmet läser fältet, så att en
   * AVSTÄNGD backup larmar lika högt som en trasig.
   */
  readonly productionBlockReason: string | null

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
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

    // ── JURISDIKTIONEN ───────────────────────────────────────────────────────
    //
    // `null` = värdet känns inte igen. Det behandlas som ett KONFIGURATIONSFEL
    // och stänger av backupen — aldrig som `'default'`. Se
    // invalidJurisdictionMessage för varför tystnaden är det farliga.
    //
    // Att det stänger av i stället för att kasta följer den här filens egen
    // linje: isoleringsgrinden gör likadant. Ett fel i en backupvariabel ska
    // inte hindra API:t från att starta och servera hyresgäster — det ska
    // synas HÖGT vid uppstart och blockera nattjobbet, vilket det gör via
    // logger.error + productionBlockReason + färskhetslarmet.
    const jurisdictionRaw = config.get<string>(R2_BACKUP_JURISDICTION_VAR)
    const jurisdiction = parseR2Jurisdiction(jurisdictionRaw)
    this.jurisdiction = jurisdiction ?? 'default'
    if (jurisdiction === null) this.logger.error(invalidJurisdictionMessage())
    this.databaseUrl = config.get<string>('DATABASE_URL') ?? ''
    this.retentionDays = Number(
      config.get<string>('BACKUP_RETENTION_DAYS') ?? DEFAULT_RETENTION_DAYS,
    )

    // Delar backupen NÅGON del av sin konfiguration med dokumentlagringen? Då är
    // isoleringen inte på plats — förbjud i produktion (fail-closed) tills en
    // dedikerad backup-token + bucket konfigurerats. ETT överlapp räcker; se
    // docblocket vid findR2IsolationOverlaps för varför AND var fel.
    const isProd = config.get<string>('NODE_ENV') === 'production'
    const overlaps = findR2IsolationOverlaps({
      backup: {
        bucket: this.bucket,
        accessKeyId,
        secretAccessKey,
      },
      main: {
        bucket: config.get<string>('R2_BUCKET_NAME'),
        accessKeyId: config.get<string>('R2_ACCESS_KEY_ID'),
        secretAccessKey: config.get<string>('R2_SECRET_ACCESS_KEY'),
      },
      dedicatedSet: {
        bucket: !!backupBucket,
        accessKeyId: !!config.get<string>('R2_BACKUP_ACCESS_KEY_ID'),
        secretAccessKey: !!config.get<string>('R2_BACKUP_SECRET_ACCESS_KEY'),
      },
    })

    // Kör bara om explicit aktiverat OCH all config finns — annars no-op (dev/test).
    this.enabled =
      config.get<string>('BACKUP_ENABLED') === 'true' &&
      !!accountId &&
      !!accessKeyId &&
      !!secretAccessKey &&
      !!this.bucket &&
      !!this.databaseUrl &&
      jurisdiction !== null &&
      !(isProd && overlaps.length > 0)

    if (config.get<string>('BACKUP_ENABLED') === 'true' && isProd && overlaps.length > 0) {
      this.logger.error(isolationBlockMessage(overlaps))
    }

    // Skälet formuleras EN gång, här, där all konfiguration finns läst.
    // Färskhetslarmet ska inte behöva gissa sig till varför jobbet står stilla.
    this.isProduction = isProd
    this.productionBlockReason = !isProd
      ? null
      : config.get<string>('BACKUP_ENABLED') !== 'true'
        ? 'BACKUP_ENABLED är inte satt till "true" — nattjobbet är avstängt'
        : jurisdiction === null
          ? `${R2_BACKUP_JURISDICTION_VAR} har ett okänt värde (giltiga: ${R2_JURISDICTIONS.join(', ')})`
          : overlaps.length > 0
            ? 'isoleringsgrinden blockerar: backupen delar konfiguration med applikationens fillagring'
            : !accountId || !accessKeyId || !secretAccessKey || !this.bucket
              ? 'R2-konfigurationen är ofullständig (konto, nyckel, hemlighet eller bucket saknas)'
              : !this.databaseUrl
                ? 'DATABASE_URL saknas'
                : null

    this.s3 = new S3Client({
      region: 'auto',
      // ENDA endpoint-härledningen i backupvägen. Värdnamnet får inte skrivas
      // här — se r2EndpointFor och scripts/check-backup-endpoint.mjs.
      endpoint: r2EndpointFor(accountId ?? '', this.jurisdiction),
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
      // FÖRST av allt: kan klienten över huvud taget dumpa den här servern?
      // Kastar BackupPreflightError med ett läsbart besked om inte — se
      // assertClientCanDumpServer. Ligger före temp-filen så att ingenting
      // skapas, skrivs eller gallras när svaret är nej.
      await this.assertClientCanDumpServer()

      // SEDAN: finns bucketen på den endpoint konfigurationen pekar på? Fel
      // jurisdiktion ger `404 NoSuchBucket` — exakt samma svar som "bucketen
      // finns inte". Utan den här kontrollen är de två omöjliga att skilja åt i
      // ett nattligt larm. Ligger också före temp-filen: ingenting skapas,
      // skrivs eller gallras när svaret är nej.
      await this.assertBackupBucketReachable()

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
      // Förkontrollens besked innehåller BARA versionsnummer och en åtgärd —
      // inga host/user/db — och går därför oskrubbat vidare. Det är hela
      // poängen med kontrollen: den som får larmet ska kunna åtgärda utan att
      // först skaffa serveraccess. Övriga fel skrubbas som förut, eftersom
      // pg_dump-stderr kan bära anslutningsdetaljer.
      Sentry.captureException(
        err instanceof BackupPreflightError
          ? err
          : new Error('Databasbackup misslyckades (se serverlogg för detalj)'),
      )
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

  /**
   * VÄGRAR TA BACKUP OM BUCKETEN INTE FINNS PÅ DEN KONFIGURERADE ENDPOINTEN.
   *
   * Samma form som versionskontrollen nedan (#540): ett läsbart besked FÖRE
   * dumpen i stället för ett rått fel mitt i den.
   *
   * ── VARFÖR DEN BEHÖVS ────────────────────────────────────────────────────
   *
   * En bucket tillhör exakt en jurisdiktion, och R2 svarar `404 NoSuchBucket`
   * när man frågar efter den på fel endpoint. Det är samma svarskod som när
   * bucketen inte finns alls. De två orsakerna — fel `R2_BACKUP_JURISDICTION`,
   * eller ingen bucket — kräver helt olika åtgärder, och ingen av dem går att
   * läsa ut ur svaret. Uppmätt 2026-08-27: appens egen bucket svarade `200` på
   * default-endpointen och `404 NoSuchBucket` på EU-endpointen, med samma
   * nycklar.
   *
   * ── VAD DEN INTE GÖR ─────────────────────────────────────────────────────
   *
   * Bara 404 översätts. Ett `403` (nekad behörighet) eller ett nätverksfel
   * propagerar OFÖRÄNDRAT — de är redan entydiga, och att svepa in dem i en
   * text om jurisdiktion skulle peka operatören åt fel håll. En förkontroll som
   * gissar orsak är sämre än ingen.
   */
  async assertBackupBucketReachable(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }))
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      if (status === 404) {
        throw new BackupPreflightError(
          preflightBucketMissingMessage(this.bucket, this.jurisdiction),
        )
      }
      throw err
    }
  }

  /**
   * VÄGRAR TA BACKUP OM KLIENTEN ÄR ÄLDRE ÄN SERVERN.
   *
   * `pg_dump` har redan en egen spärr — men dess besked är
   * "aborting because of server version mismatch" plus två versionsnummer, och
   * det dyker upp i ett Sentry-larm klockan tre på natten hos någon som inte har
   * koden framför sig. Den här kontrollen finns för att felet ska säga vad som är
   * fel OCH vad man gör åt det, före dumpen i stället för mitt i den.
   *
   * VARFÖR EN OLÄSBAR VERSION VARNAR I STÄLLET FÖR ATT STOPPA: kontrollen är ett
   * bättre FELMEDDELANDE, inte en ny säkerhetsspärr. Kan versionen inte läsas
   * (formatändring i pg_dump, DB tillfälligt onåbar) vore det fel att stoppa en
   * backup som mycket väl kan fungera — pg_dump:s egen spärr står kvar som
   * sistahandsskydd och fäller högljutt om kombinationen ändå är omöjlig. Att
   * stoppa här hade bytt ett tydligt fel mot ett självförvållat backup-bortfall.
   * (Jfr regeln om varning kontra fail-fast: fail-fast bara när appen KÖR osäkert.)
   */
  async assertClientCanDumpServer(): Promise<void> {
    const clientMajor = await this.pgDumpMajor()
    const serverMajor = await this.serverMajor()

    if (clientMajor === null || serverMajor === null) {
      this.logger.warn(
        '[backup] Kunde inte jämföra pg_dump-klientens version med serverns ' +
          `(klient: ${clientMajor ?? 'okänd'}, server: ${serverMajor ?? 'okänd'}). ` +
          'Fortsätter — pg_dump fäller själv om kombinationen är omöjlig.',
      )
      return
    }

    if (clientMajor < serverMajor) {
      throw new BackupPreflightError(preflightMismatchMessage(clientMajor, serverMajor))
    }
  }

  /** `pg_dump --version` → major, eller null om utdatan inte går att tolka. */
  private pgDumpMajor(): Promise<number | null> {
    return new Promise((resolve) => {
      let stdout = ''
      const proc = spawn('pg_dump', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString()
      })
      // Saknad binär eller nollskild kod → null (okänd), aldrig ett kast: se
      // docblocket ovan om varför den här kontrollen inte får fälla backupen
      // på egen hand.
      proc.on('error', () => resolve(null))
      proc.on('close', (code) => resolve(code === 0 ? parsePgDumpMajor(stdout) : null))
    })
  }

  /** Serverns major ur `server_version_num`, eller null om frågan inte går fram. */
  private async serverMajor(): Promise<number | null> {
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ v: string }>
      >`SELECT current_setting('server_version_num') AS v`
      const v = rows[0]?.v
      return v === undefined ? null : serverMajorFromVersionNum(v)
    } catch {
      return null
    }
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
