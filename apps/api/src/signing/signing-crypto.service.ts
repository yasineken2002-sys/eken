import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as crypto from 'crypto'

/**
 * Kryptering + blind-index för känsliga signeringsfält (personnummer).
 *
 * - `blindIndex` = HMAC-SHA256(normaliserat personnr, pepper) → deterministiskt,
 *   sökbart/unikt UTAN att exponera personnumret. Används för identitetsavstämning
 *   (BankID-personnr vs Tenant.personalNumber) och som DB-nyckel.
 * - `encrypt`/`decrypt` = AES-256-GCM envelope (iv + authtag + ciphertext, base64).
 *   Icke-deterministisk → kan inte indexeras (därför blind-index separat).
 *
 * Nycklar läses ur env (SIGNING_PII_KEY = 64 hex-tecken/32 byte, SIGNING_PII_PEPPER).
 * Saknas de är `configured=false` → signering är inte skarpt aktiverbar (fail-fast
 * i modulens flagg-grind). I S1 kör Mock med testnycklar.
 */
@Injectable()
export class SigningCryptoService {
  private readonly aesKey: Buffer | null
  private readonly pepper: string | null

  constructor(config: ConfigService) {
    const keyHex = config.get<string>('SIGNING_PII_KEY')
    const pepper = config.get<string>('SIGNING_PII_PEPPER')
    this.aesKey = keyHex && /^[0-9a-fA-F]{64}$/.test(keyHex) ? Buffer.from(keyHex, 'hex') : null
    this.pepper = pepper && pepper.length >= 16 ? pepper : null
  }

  /** True om både AES-nyckel (32 byte) och pepper (≥16 tecken) finns. */
  get configured(): boolean {
    return this.aesKey?.length === 32 && this.pepper !== null
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new Error('Signerings-krypto ej konfigurerat (SIGNING_PII_KEY/SIGNING_PII_PEPPER)')
    }
  }

  /** Normaliserar ett personnummer till enbart siffror (för konsekvent blind-index). */
  static normalizePersonalNumber(pn: string): string {
    return pn.replace(/\D/g, '')
  }

  /** Deterministiskt blind-index (HMAC) — sökbart utan att röja personnumret. */
  blindIndex(personalNumber: string): string {
    this.assertConfigured()
    return crypto
      .createHmac('sha256', this.pepper!)
      .update(SigningCryptoService.normalizePersonalNumber(personalNumber))
      .digest('hex')
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
