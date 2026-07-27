import { Injectable } from '@nestjs/common'
import { SigningCryptoService } from '../../signing/signing-crypto.service'

/**
 * Personnummer krypterat i vila för Tenant och Customer.
 *
 * Ingen egen kryptografi: all AES-256-GCM och all HMAC går genom
 * `SigningCryptoService` — exakt samma nyckel (SIGNING_PII_KEY), samma pepper
 * (SIGNING_PII_PEPPER), samma envelope (iv[12] + authTag[16] + ciphertext,
 * base64) och samma normalisering som signeringsbevisen redan använder. Den här
 * klassen lägger bara till domänlagret ovanpå: null-hantering, tomma strängar
 * och paret av kolumner som ska skrivas.
 *
 * ATT DELA PEPPER MED SignatureEvidence ÄR AVSIKTLIGT. Blind-indexet blir då
 * jämförbart mellan tabellerna, så en BankID-identitet kan matchas mot rätt
 * hyresgäst utan att någondera raden dekrypteras (se signing.service.ts).
 *
 * FAIL-CLOSED: saknas nycklarna kastar `SigningCryptoService`. Det är med flit —
 * alternativet vore att tyst falla tillbaka på klartext, vilket är precis den
 * bugg det här ska stänga. Nycklarna är därför alltid-kritiska i
 * env.validation.ts, inte längre flagg-villkorade.
 */
@Injectable()
export class PersonalNumberService {
  constructor(private readonly crypto: SigningCryptoService) {}

  /** True om nycklarna finns. Exponeras för boot-grindar och tester. */
  get configured(): boolean {
    return this.crypto.configured
  }

  /**
   * Kolumnparet för ett personnummer, klart att spridas in i en Prisma
   * create/update.
   *
   * - `undefined` in → tomt objekt ut (fältet lämnas orört vid en update).
   * - `null` eller tom sträng in → båda kolumnerna nollställs (radera numret).
   * - värde in → krypterat + blind-index.
   *
   * Skillnaden mellan `undefined` och `null` bärs hela vägen hit med flit: en
   * PATCH som inte nämner personnumret får inte råka radera det.
   */
  protect(personalNumber: string | null | undefined): {
    personalNumberEnc?: string | null
    personalNumberHash?: string | null
  } {
    if (personalNumber === undefined) return {}
    const trimmed = personalNumber?.trim()
    if (!trimmed) return { personalNumberEnc: null, personalNumberHash: null }
    return {
      personalNumberEnc: this.crypto.encrypt(trimmed),
      personalNumberHash: this.crypto.blindIndex(trimmed),
    }
  }

  /**
   * Klartext ur den krypterade kolumnen. Anropas BARA vid användningstillfället
   * (visning för behörig användare, avtals-PDF, inkassoexport) — aldrig för att
   * fylla ett generiskt API-svar eller en logg.
   */
  reveal(personalNumberEnc: string | null | undefined): string | null {
    if (!personalNumberEnc) return null
    return this.crypto.decrypt(personalNumberEnc)
  }

  /**
   * Blind-index för ett sökt personnummer. Används i `where`-satser så att
   * uppslag sker på indexet i databasen, utan att någon rad dekrypteras.
   */
  index(personalNumber: string): string {
    return this.crypto.blindIndex(personalNumber)
  }
}
