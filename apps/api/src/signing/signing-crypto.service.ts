import { Injectable, Logger } from '@nestjs/common'
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
 *
 * ── LÄSNING MED TVÅ NYCKLAR ──────────────────────────────────────────────────
 * `SIGNING_PII_KEY_OLD` är VALFRI. Är den satt försöker `decrypt` först med den
 * nya nyckeln och faller sedan tillbaka på den gamla.
 *
 * Det gör en nyckelrotation möjlig UTAN nedtid. Utan fallbacken måste
 * chiffertexten och appens nyckel bytas i samma ögonblick, och mellan de två
 * finns ett fönster där varje `reveal()` kastar — 13 produktionsanropare i dag
 * (inkassoexport, portalens /me, tenants, customers, avtals-PDF). Vid en
 * handfull rader är det sekunder; vid femhundra hyresgäster är det ett avbrott.
 *
 * Fallbacken är självdiskriminerande och behöver ingen markör: AES-256-GCM med
 * fel nyckel KASTAR på authTag — den returnerar aldrig skräp. Fel nyckel kan
 * alltså inte "lyckas" tyst.
 *
 * Frånvarande `_OLD` är NORMALTILLSTÅNDET, inte ett fel: ingen varning, ingen
 * logg. Först när en läsning faktiskt lyckas via den gamla nyckeln loggas det —
 * då är en rotation påbörjad men inte slutförd, och den signalen ska finnas.
 *
 * Loggen är medvetet INTE nedtryckt till en gång per process. Tillståndet är
 * transient och ska vara högljutt tills det är åtgärdat; en rad per läst
 * ej-roterad rad är priset. Syns den efter att en rotation ansetts klar är
 * rotationen inte klar.
 *
 * `scripts/rotate-pii-secrets.ts` har medvetet EGEN kryptering utan fallback.
 * Dess klassificerare vilar helt på att dekryptering med en BESTÄMD nyckel
 * antingen lyckas eller kastar — en fallback där skulle göra `ATT_ROTERA` och
 * `REDAN_ROTERAD` omöjliga att skilja åt. Rör den inte.
 */
@Injectable()
export class SigningCryptoService {
  private readonly logger = new Logger(SigningCryptoService.name)
  private readonly aesKey: Buffer | null
  /** Föregående nyckel under en pågående rotation. Null = normaltillståndet. */
  private readonly previousAesKey: Buffer | null
  private readonly pepper: string | null

  constructor(config: ConfigService) {
    const keyHex = config.get<string>('SIGNING_PII_KEY')
    const previousKeyHex = config.get<string>('SIGNING_PII_KEY_OLD')
    const pepper = config.get<string>('SIGNING_PII_PEPPER')
    this.aesKey = SigningCryptoService.parseKey(keyHex)
    this.previousAesKey = SigningCryptoService.parseKey(previousKeyHex)
    this.pepper = pepper && pepper.length >= 16 ? pepper : null
  }

  private static parseKey(hex: string | undefined): Buffer | null {
    return hex && /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null
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

  /**
   * Klartext ur envelopen. Försöker med den aktuella nyckeln och, om
   * `SIGNING_PII_KEY_OLD` är satt, därefter med den föregående.
   *
   * Faller BÅDA kastas det FÖRSTA felet vidare — det beskriver läget som
   * betyder något ("aktuell nyckel kan inte läsa raden"), och beteendet är
   * därmed identiskt med hur metoden betedde sig innan fallbacken fanns. Ingen
   * tyst fallback till null: en oläsbar rad ska stoppa anroparen, inte se ut som
   * ett saknat värde.
   */
  decrypt(enc: string): string {
    this.assertConfigured()
    try {
      return this.decryptWith(this.aesKey!, enc)
    } catch (primärt) {
      if (!this.previousAesKey) throw primärt
      // Kastar den här också bubblar DET felet — men vi kastar hellre det
      // primära, se nedan.
      let klartext: string
      try {
        klartext = this.decryptWith(this.previousAesKey, enc)
      } catch {
        throw primärt
      }
      this.logger.warn(
        '[signing-crypto] en rad lästes med SIGNING_PII_KEY_OLD — nyckelrotationen är ' +
          'påbörjad men INTE slutförd. Kör scripts/rotate-pii-secrets.ts --mode=key, ' +
          'och ta inte bort _OLD förrän en torrkörning ger 0 ATT_ROTERA.',
      )
      return klartext
    }
  }

  /**
   * Klartext ur envelopen med ENBART den aktuella nyckeln — förbi fallbacken.
   *
   * `decrypt` ovan är rätt för produktionsläsning: den ska lyckas så länge NÅGON
   * av nycklarna bär raden, för det är hela poängen med rotation utan nedtid.
   * Men den egenskapen gör den obrukbar för en KONTROLL av om den aktuella
   * nyckeln hör ihop med datan — ett `OK` därifrån kan lika gärna komma från
   * `_OLD` (#472: exakt det läget mättes under rotationen 2026-08-15).
   *
   * Den här metoden finns bara för den frågan, och ska inte användas för att
   * läsa data: under en pågående rotation kastar den på varje ännu inte
   * omkrypterad rad, vilket är korrekt här och fel överallt annars.
   *
   * Speglar skälet till att `scripts/rotate-pii-secrets.ts` har egen kryptering
   * utan fallback — en klassificerare måste kunna binda utfallet till EN bestämd
   * nyckel.
   */
  decryptWithCurrentKey(enc: string): string {
    this.assertConfigured()
    return this.decryptWith(this.aesKey!, enc)
  }

  private decryptWith(key: Buffer, enc: string): string {
    const raw = Buffer.from(enc, 'base64')
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const ct = raw.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  }
}
