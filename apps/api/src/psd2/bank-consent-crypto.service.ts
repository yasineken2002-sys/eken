import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as crypto from 'crypto'

/**
 * App-layer envelope-kryptering för PSD2-tokens (access/refresh). AES-256-GCM:
 * base64(iv[12] + authTag[16] + ciphertext). Icke-deterministisk — kolumnen
 * `accessTokenEnc`/`refreshTokenEnc` innehåller ENDAST chiffertext och lämnar
 * aldrig backend i klartext (aldrig frontend/logg/AI).
 *
 * Nyckel ur env (PSD2_TOKEN_KEY = 64 hex-tecken/32 byte). Saknas den är
 * `configured=false` → PSD2 är inte skarpt aktiverbar (fail-fast i modulens
 * flagg-grind). I test kör Mock med en testnyckel.
 *
 * Separat nyckel från signeringens SIGNING_PII_KEY: olika domäner, olika
 * skadepotential, oberoende rotation.
 */
@Injectable()
export class BankConsentCryptoService {
  private readonly aesKey: Buffer | null

  constructor(config: ConfigService) {
    const keyHex = config.get<string>('PSD2_TOKEN_KEY')
    this.aesKey = keyHex && /^[0-9a-fA-F]{64}$/.test(keyHex) ? Buffer.from(keyHex, 'hex') : null
  }

  /** True om AES-nyckeln (32 byte) finns. */
  get configured(): boolean {
    return this.aesKey?.length === 32
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new Error('PSD2-token-krypto ej konfigurerat (PSD2_TOKEN_KEY)')
    }
  }

  /** AES-256-GCM → base64(iv[12] + authTag[16] + ciphertext). */
  encrypt(plaintext: string): string {
    this.assertConfigured()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.aesKey!, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, ct]).toString('base64')
  }

  decrypt(enc: string): string {
    this.assertConfigured()
    const raw = Buffer.from(enc, 'base64')
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const ct = raw.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.aesKey!, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  }
}
