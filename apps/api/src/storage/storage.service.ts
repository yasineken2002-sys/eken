import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// T5 Fas C (#Tier1) — timeout-golv på R2/S3-klienten. Utan detta defaultar
// @smithy/node-http-handler till 0 = OÄNDLIGT: en R2-hängning (uppkopplad men
// inget svar) blockerar då anroparen för alltid. Kritiskt för de SYNKRONA
// vägarna (faktura-PDF-logo, dokument-uppladdning m.fl.) där hängningen håller
// en HTTP-request — Fastify/Node har ingen handler-timeout som räddar. Normala
// ops mot små objekt (~50KB) tar tiotals ms, så golven bryter aldrig normalfall;
// de gör en hängning till ett FEL (tydligt, syns) i stället för oändlig väntan.
const R2_CONNECTION_TIMEOUT_MS = 5_000 // TCP+TLS-handshake (normalt <500ms)
const R2_REQUEST_TIMEOUT_MS = 15_000 // socket-inaktivitet per försök (normalt <1s)
// aws-sdk retrar timeout-fel; håll taket stramt på de synkrona vägarna → worst
// case ~2×(5+15)=40s (bounded) i stället för default 3 försök.
const R2_MAX_ATTEMPTS = 2

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name)
  private readonly s3: S3Client
  private readonly bucket: string
  private readonly hasCredentials: boolean

  constructor(private readonly config: ConfigService) {
    const accountId = config.get<string>('R2_ACCOUNT_ID')
    const accessKeyId = config.get<string>('R2_ACCESS_KEY_ID')
    const secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY')
    const bucket = config.get<string>('R2_BUCKET_NAME')

    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      this.logger.error(
        'R2-konfiguration saknas — kontrollera R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY och R2_BUCKET_NAME',
      )
    }

    this.bucket = bucket ?? ''
    this.hasCredentials = Boolean(accountId && accessKeyId && secretAccessKey)
    this.s3 = new S3Client({
      region: 'auto',
      // ── HÅRDKODAD DEFAULT-JURISDIKTION — ETT VAL, INTE ETT FÖRBISEENDE ────
      //
      // Backupvägen fick en konfigurerbar jurisdiktion (R2_BACKUP_JURISDICTION
      // → r2EndpointFor i backup.service.ts). DEN HÄR vägen lämnades med flit
      // orörd: huvudbucketen FINNS redan i default-jurisdiktionen — uppmätt
      // 2026-08-27, den svarar 200 på default-endpointen och 404 NoSuchBucket
      // på EU-endpointen — och en bucket kan inte flytta mellan jurisdiktioner.
      // Att göra värdnamnet konfigurerbart här hade alltså bara lagt till ett
      // sätt att peka fel, utan att erbjuda något nytt läge.
      //
      // Ska huvudlagringen till EU är det en MIGRERING (ny bucket, kopiera
      // objekt, byt namn), inte en variabel — och då hör den här raden till det
      // arbetet, inte till backupens.
      endpoint: `https://${accountId ?? ''}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: accessKeyId ?? '',
        secretAccessKey: secretAccessKey ?? '',
      },
      // Timeout-golv (se konstanterna ovan) — ersätter SDK:ns oändliga default.
      // Tre golv täcker tre faser av en request:
      //   • connectionTimeout    — TCP+TLS-handshake hänger.
      //   • requestTimeout       — uppkopplad men inga response-HEADERS kommer.
      //     throwOnRequestTimeout: true är AVGÖRANDE — utan den bara LOGGAR
      //     @smithy/node-http-handler (4.x) en varning och låter requesten hänga
      //     vidare (empiriskt verifierat); med den ABORTAS anropet + kastar fel.
      //   • socketTimeout        — HEADERS kom men BODY-strömmen fryser mitt i
      //     (requestTimeout-timern rensas när headers anlänt → utan detta golv
      //     kan getFileBuffer:s stream-läsning hänga oändligt). Node-socketns
      //     idle-timeout (setTimeout) återstartas vid aktivitet → bryter bara vid
      //     äkta frysning, aldrig ett aktivt (om än långsamt) flöde.
      requestHandler: {
        connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
        requestTimeout: R2_REQUEST_TIMEOUT_MS,
        throwOnRequestTimeout: true,
        socketTimeout: R2_REQUEST_TIMEOUT_MS,
      },
      maxAttempts: R2_MAX_ATTEMPTS,
    })
  }

  /**
   * True om alla fyra R2-variablerna är satta.
   *
   * Konstruktorn kastar med flit INTE när de saknas — de flesta vägar tål att
   * lagringen är otillgänglig och ska inte hindra appen från att starta. Men en
   * anropare som MÅSTE ha lagringen (kontraktsarkivet, #473) behöver kunna
   * avvisa DIREKT i stället för att låta AWS-SDK:n gå i timeout mot
   * `https://.r2.cloudflarestorage.com` och returnera ett obegripligt fel efter
   * ~40 sekunder. Speglar `SigningCryptoService.configured`.
   */
  get configured(): boolean {
    return this.bucket !== '' && this.hasCredentials
  }

  async uploadFile(buffer: Buffer, key: string, mimeType: string): Promise<string> {
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: mimeType,
        }),
      )
      return await this.getPresignedUrl(key)
    } catch (err) {
      this.logger.error(`Misslyckades att ladda upp fil till R2: ${key}`, err as Error)
      throw new InternalServerErrorException('Kunde inte spara filen i molnlagringen')
    }
  }

  async deleteFile(key: string): Promise<void> {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
    } catch (err) {
      this.logger.error(`Misslyckades att radera fil i R2: ${key}`, err as Error)
    }
  }

  async getPresignedUrl(key: string, expiresIn = 3600): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn,
    })
  }

  async getFileBuffer(key: string): Promise<Buffer> {
    const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    const body = result.Body
    if (!body) throw new InternalServerErrorException('Filen hittades inte i R2')
    const stream = body as NodeJS.ReadableStream
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array))
    }
    return Buffer.concat(chunks)
  }
}
