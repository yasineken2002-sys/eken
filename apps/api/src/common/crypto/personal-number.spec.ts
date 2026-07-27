/**
 * Personnummer krypterat i vila på Tenant och Customer.
 *
 * Buggen som stängs: `Tenant.personalNumber` och `Customer.personalNumber` låg i
 * KLARTEXT i databasen. Vem som helst med läsrättighet på tabellen — en
 * backup-fil, en dump, en läckt DATABASE_URL, en felsökande utvecklare i Prisma
 * Studio — såg samtliga hyresgästers personnummer.
 *
 * Fixen speglar det mönster som redan fanns för signeringsbevisen
 * (SignatureEvidence): AES-256-GCM för värdet + HMAC-SHA256-blind-index för
 * uppslag. Samma nyckel, samma pepper, samma envelope-format — ingen ny
 * kryptografi uppfanns.
 */

import { ConfigService } from '@nestjs/config'
import { SigningCryptoService } from '../../signing/signing-crypto.service'
import { PersonalNumberService } from './personal-number.service'
import { TEST_PII_KEY, TEST_PII_PEPPER, testPersonalNumberService } from './personal-number.testing'

const PN = '19850101-1234'

describe('krav 6 — round-trip: kryptera → lagra → dekryptera ger originalet', () => {
  it('personnumret överlever ett varv genom kolumnparet', () => {
    const pn = testPersonalNumberService()
    const stored = pn.protect(PN)

    expect(pn.reveal(stored.personalNumberEnc)).toBe(PN)
  })

  it('bindestreck och samordningsnummer bevaras exakt som de skrevs in', () => {
    const pn = testPersonalNumberService()
    for (const value of ['198501011234', '19850101-1234', '850101-1234', '19850161-1234']) {
      expect(pn.reveal(pn.protect(value).personalNumberEnc)).toBe(value)
    }
  })

  it('en ny instans med SAMMA nyckel läser det en tidigare instans skrev', () => {
    // Speglar verkligheten: raden krypteras av en process och läses av en annan.
    const enc = testPersonalNumberService().protect(PN).personalNumberEnc
    expect(testPersonalNumberService().reveal(enc)).toBe(PN)
  })

  it('tom och saknad indata skiljs åt — undefined rör inte fältet', () => {
    const pn = testPersonalNumberService()
    // undefined = "PATCH nämnde inte personnumret" → fältet ska lämnas orört.
    expect(pn.protect(undefined)).toEqual({})
    // null/tom = "radera numret" → båda kolumnerna nollas.
    expect(pn.protect(null)).toEqual({ personalNumberEnc: null, personalNumberHash: null })
    expect(pn.protect('   ')).toEqual({ personalNumberEnc: null, personalNumberHash: null })
    expect(pn.reveal(null)).toBeNull()
  })
})

describe('krav 7 — blind-index: uppslag utan att dekryptera någon rad', () => {
  it('samma personnummer ger samma index (deterministiskt → sökbart)', () => {
    const pn = testPersonalNumberService()
    expect(pn.index(PN)).toBe(pn.index(PN))
  })

  it('formatering spelar ingen roll — indexet normaliserar till siffror', () => {
    const pn = testPersonalNumberService()
    // Annars hittas inte hyresgästen bara för att någon skrev bindestreck.
    expect(pn.index('19850101-1234')).toBe(pn.index('198501011234'))
    expect(pn.index(' 19850101 1234 ')).toBe(pn.index('198501011234'))
  })

  it('olika personnummer ger olika index', () => {
    const pn = testPersonalNumberService()
    expect(pn.index('19850101-1234')).not.toBe(pn.index('19850101-1235'))
  })

  it('indexet röjer inte personnumret', () => {
    const pn = testPersonalNumberService()
    const idx = pn.index(PN)
    expect(idx).not.toContain('1985')
    expect(idx).not.toContain('1234')
    expect(idx).toMatch(/^[0-9a-f]{64}$/) // ren HMAC-SHA256-hex
  })

  it('index och chiffertext hänger ihop: protect() skriver indexet av samma nummer', () => {
    const pn = testPersonalNumberService()
    const stored = pn.protect(PN)
    // Det här är precis vad ett `where: { personalNumberHash: pn.index(sökt) }`
    // gör — raden hittas utan att en enda chiffertext rörs.
    expect(stored.personalNumberHash).toBe(pn.index(PN))
  })

  it('en sökning på fel nummer matchar INTE raden', () => {
    const pn = testPersonalNumberService()
    const rows = [
      { id: 'a', ...pn.protect('19850101-1234') },
      { id: 'b', ...pn.protect('19900202-5678') },
      { id: 'c', ...pn.protect('20010303-9012') },
    ]

    const hit = rows.filter((r) => r.personalNumberHash === pn.index('19900202-5678'))
    expect(hit).toHaveLength(1)
    expect(hit[0]!.id).toBe('b')

    expect(rows.filter((r) => r.personalNumberHash === pn.index('19700101-0000'))).toHaveLength(0)
  })
})

describe('krav 8 — det lagrade värdet är chiffertext, inte klartext', () => {
  it('kolumnvärdet innehåller inte personnumret i någon form', () => {
    const pn = testPersonalNumberService()
    const enc = pn.protect(PN).personalNumberEnc!

    expect(enc).not.toContain(PN)
    expect(enc).not.toContain('198501011234')
    expect(enc).not.toContain('1985')
    // Inte heller om någon tolkar base64:en som rå text.
    expect(Buffer.from(enc, 'base64').toString('latin1')).not.toContain('1985')
  })

  it('samma personnummer krypteras OLIKA varje gång (slumpad IV)', () => {
    const pn = testPersonalNumberService()
    const encs = new Set(Array.from({ length: 50 }, () => pn.protect(PN).personalNumberEnc))
    // Återanvänd IV i GCM är ett katastrofalt fel — 50 krypteringar av samma
    // värde måste ge 50 olika chiffertexter.
    expect(encs.size).toBe(50)
  })

  it('envelopen har samma form som SignatureEvidence: iv[12] + tag[16] + ct', () => {
    const pn = testPersonalNumberService()
    const raw = Buffer.from(pn.protect(PN).personalNumberEnc!, 'base64')
    expect(raw.length).toBe(12 + 16 + Buffer.byteLength(PN, 'utf8'))
  })

  it('formatet är BOKSTAVLIGEN SigningCryptoService:s — inget eget schema', () => {
    // Låser att personnummer-kryptot och signeringsbevisen delar implementation.
    // Byter någon ut den ena måste den andra följa med.
    const config = {
      get: (k: string) =>
        ({ SIGNING_PII_KEY: TEST_PII_KEY, SIGNING_PII_PEPPER: TEST_PII_PEPPER })[k],
    } as unknown as ConfigService
    const signing = new SigningCryptoService(config)
    const pn = new PersonalNumberService(signing)

    // Krypterat av personnummer-lagret, läst av signeringslagret.
    expect(signing.decrypt(pn.protect(PN).personalNumberEnc!)).toBe(PN)
    // ...och tvärtom.
    expect(pn.reveal(signing.encrypt(PN))).toBe(PN)
    // Blind-indexet är samma HMAC → en BankID-identitet kan jämföras direkt mot
    // hyresgästens hash utan att någon rad dekrypteras.
    expect(pn.index(PN)).toBe(signing.blindIndex(PN))
  })
})

describe('krav 9 — manipulerad chiffertext faller på GCM:s auth-tag', () => {
  const pn = testPersonalNumberService()

  /** Vänder en bit i byte `i` av envelopen och returnerar den som base64. */
  function tamper(enc: string, i: number): string {
    const raw = Buffer.from(enc, 'base64')
    raw[i] = raw[i]! ^ 0x01
    return raw.toString('base64')
  }

  it('ändrad ciphertext avvisas', () => {
    const enc = pn.protect(PN).personalNumberEnc!
    // Sista byten ligger i ciphertexten (efter iv[12] + tag[16]).
    expect(() => pn.reveal(tamper(enc, Buffer.from(enc, 'base64').length - 1))).toThrow()
  })

  it('ändrad auth-tag avvisas', () => {
    const enc = pn.protect(PN).personalNumberEnc!
    expect(() => pn.reveal(tamper(enc, 12))).toThrow()
  })

  it('ändrad IV avvisas', () => {
    const enc = pn.protect(PN).personalNumberEnc!
    expect(() => pn.reveal(tamper(enc, 0))).toThrow()
  })

  it('varje enskild byte i envelopen är integritetsskyddad', () => {
    const enc = pn.protect(PN).personalNumberEnc!
    const len = Buffer.from(enc, 'base64').length
    for (let i = 0; i < len; i++) {
      expect(() => pn.reveal(tamper(enc, i))).toThrow()
    }
  })

  it('en chiffertext krypterad med ANNAN nyckel går inte att läsa', () => {
    const other = new PersonalNumberService(
      new SigningCryptoService({
        get: (k: string) =>
          ({ SIGNING_PII_KEY: 'b'.repeat(64), SIGNING_PII_PEPPER: TEST_PII_PEPPER })[k],
      } as unknown as ConfigService),
    )
    const enc = other.protect(PN).personalNumberEnc!
    // Tyst fel vore värst tänkbara utfall — det ska kasta, inte returnera skräp.
    expect(() => pn.reveal(enc)).toThrow()
  })

  it('avhugget värde avvisas (inte tolkat som en kortare giltig envelope)', () => {
    const enc = pn.protect(PN).personalNumberEnc!
    const raw = Buffer.from(enc, 'base64')
    expect(() => pn.reveal(raw.subarray(0, raw.length - 3).toString('base64'))).toThrow()
  })
})

describe('fail-closed: utan nycklar krypteras ingenting tyst', () => {
  const unconfigured = new PersonalNumberService(
    new SigningCryptoService({ get: () => undefined } as unknown as ConfigService),
  )

  it('protect() kastar hellre än att skriva klartext', () => {
    expect(unconfigured.configured).toBe(false)
    // Det farliga alternativet vore en tyst fallback till klartext — precis den
    // bugg det här ska stänga.
    expect(() => unconfigured.protect(PN)).toThrow(/ej konfigurerat/i)
  })

  it('index() kastar utan pepper', () => {
    expect(() => unconfigured.index(PN)).toThrow(/ej konfigurerat/i)
  })

  it('att radera ett personnummer fungerar ändå (inget krypto behövs)', () => {
    expect(unconfigured.protect(null)).toEqual({
      personalNumberEnc: null,
      personalNumberHash: null,
    })
  })
})
