import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as crypto from 'crypto'

/**
 * AES-256-GCM för Fortnox-tokens och PKCE-verifier: base64(iv[12] + tag[16] + ct).
 * Samma form som BankConsentCryptoService, men EGEN nyckel (FORTNOX_TOKEN_KEY,
 * 64 hex): olika domän, olika skadepotential, oberoende rotation.
 *
 * Saknas nyckeln är `configured=false` och modulens factory väljer Stub — då
 * finns ingen väg som kan skapa en anslutning.
 */
@Injectable()
export class FortnoxTokenCryptoService {
  private readonly aesKey: Buffer | null

  constructor(config: ConfigService) {
    const keyHex = config.get<string>('FORTNOX_TOKEN_KEY')
    this.aesKey = keyHex && /^[0-9a-fA-F]{64}$/.test(keyHex) ? Buffer.from(keyHex, 'hex') : null
  }

  get configured(): boolean {
    return this.aesKey?.length === 32
  }

  private key(): Buffer {
    if (!this.aesKey) throw new Error('Fortnox-token-krypto ej konfigurerat (FORTNOX_TOKEN_KEY)')
    return this.aesKey
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
  }

  decrypt(enc: string): string {
    const raw = Buffer.from(enc, 'base64')
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  }
}
