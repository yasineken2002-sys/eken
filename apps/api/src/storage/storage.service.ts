import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name)
  private readonly s3: S3Client
  private readonly bucket: string

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
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId ?? ''}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: accessKeyId ?? '',
        secretAccessKey: secretAccessKey ?? '',
      },
    })
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
