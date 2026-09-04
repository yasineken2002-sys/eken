import * as crypto from 'node:crypto'

/**
 * VÄLJAR-TOKEN — handtaget mellan "vi vet vem du är" och "vilket konto?".
 *
 * ── VARFÖR DEN INTE ÄR ETT JWT, OCH VAD SOM GÖR SKILLNADEN ────────────────
 *
 * Ett kontoval sker EFTER att BankID intygat identiteten men INNAN någon
 * session finns. Token bär alltså ett halvfärdigt auth-tillstånd, och om den
 * råkade fungera som access-token vore hela BankID-inloggningen kringgången: den
 * som lyckats identifiera sig hade fått en session utan att välja konto, och
 * utan att systemet vet vilken organisation hen agerar i.
 *
 * Fyra saker skiljer den från en access-token, och de är oberoende av varandra:
 *
 *  1. FORMEN ÄR INTE JWT. Strängen är `v1.<payload>.<sig>` — inget JOSE-huvud.
 *     `passport-jwt` avvisar den vid parsningen, före signaturkontrollen.
 *  2. NYCKELN ÄR EN ANNAN. Signaturen är HMAC med en HÄRLEDD nyckel
 *     (`sha256(JWT_SECRET + '|' + KONTEXT)`), inte `JWT_SECRET` självt. Även en
 *     parser som accepterade formen kan inte validera den som ett JWT, och en
 *     läckt väljar-token säger ingenting om `JWT_SECRET`.
 *  3. PAYLOADEN SAKNAR DET EN SESSION BEHÖVER. Ingen `sub`, ingen
 *     `organizationId`, ingen `role`. `JwtStrategy.validate` kastar 401 på
 *     saknad `sub`/`organizationId` — det finns inget att bygga en användare av.
 *  4. DEN ÄR INTE ENSAM AUKTORITET. `BankIdOrder`-raden är det: den är
 *     single-use och förbrukas vid valet. En replay av token mot en förbrukad
 *     order avvisas oavsett hur giltig signaturen är.
 *
 * Punkt 4 är den bärande. De tre första gör token svår att missbruka; den fjärde
 * gör en lyckad kopia verkningslös.
 *
 * ── TVÅ REALM, TVÅ KONTEXTER, INGEN DEFAULT ───────────────────────────────
 *
 * Web (`User`, JWT) och portalen (`Tenant`, `TenantSession`) är skilda
 * autentiseringsvärldar med skilda sessioner. En väljar-token från den ena får
 * därför aldrig kunna verifieras i den andra — den härledda nyckeln skiljer dem
 * åt, och därför tar `sign`/`verify` kontexten som ett OBLIGATORISKT argument.
 *
 * Ingen default, med flit: ett defaultvärde hade gjort det möjligt att glömma
 * argumentet i portalen och tyst hamna i webbens kontext, alltså att de två
 * realmen delade nyckel utan att någon skrev det. Ett glömt argument ska vara
 * ett kompileringsfel.
 */

export const CHOOSE_KONTEXT_WEB = 'bankid-choose-v1'
export const CHOOSE_KONTEXT_PORTAL = 'bankid-tenant-choose-v1'
const PREFIX = 'v1'

/** Två minuter. Ett kontoval är ett klick, inte ett ärende. */
export const CHOOSE_TOKEN_TTL_MS = 2 * 60 * 1000

export interface ChooseTokenPayload {
  /** Ordern valet hör till. Auktoriteten ligger i RADEN, inte i token. */
  orderRef: string
  /** Blindindexet identifieringen gav — så valet inte kan flyttas till en annan person. */
  subjectHash: string
  /**
   * FRUSEN KANDIDATLISTA. Sätts av portalen (#745 PR 4), utelämnas av webben.
   *
   * Webbflödet härleder om sin kontolista ur `subjectHash` vid valet, vilket är
   * säkert men inte fryst: ett konto som tillkommer mellan identifiering och val
   * hade dykt upp i mängden. Portalen signerar i stället exakt de hyresgästrader
   * som MATCHADE, så valet är avgränsat till det användaren faktiskt såg — och
   * en rad i en organisation som inte matchade kan inte väljas ens om någon
   * gissar dess id.
   */
  tenantIds?: string[]
  /** Millisekunder sedan epoch. */
  exp: number
}

function derivedKey(jwtSecret: string, kontext: string): Buffer {
  return crypto.createHash('sha256').update(`${jwtSecret}|${kontext}`).digest()
}

const b64url = (b: Buffer): string => b.toString('base64url')

export function signChooseToken(
  payload: Omit<ChooseTokenPayload, 'exp'>,
  jwtSecret: string,
  now: Date,
  kontext: string,
): string {
  const full: ChooseTokenPayload = { ...payload, exp: now.getTime() + CHOOSE_TOKEN_TTL_MS }
  const body = b64url(Buffer.from(JSON.stringify(full), 'utf8'))
  const sig = b64url(
    crypto.createHmac('sha256', derivedKey(jwtSecret, kontext)).update(body).digest(),
  )
  return `${PREFIX}.${body}.${sig}`
}

/**
 * Verifierar och packar upp. Returnerar `null` vid ALLA fel — fel form, fel
 * signatur, utgången — och skiljer dem inte åt.
 *
 * Att inte skilja dem åt är avsiktligt: ett svar som säger "signaturen stämmer
 * men den är utgången" bekräftar för en angripare att hen gissat rätt nyckel.
 * Anroparen har ändå bara ett handlingsalternativ (neka), så informationen har
 * ingen mottagare som kan använda den.
 */
export function verifyChooseToken(
  token: string,
  jwtSecret: string,
  now: Date,
  kontext: string,
): ChooseTokenPayload | null {
  const delar = token.split('.')
  if (delar.length !== 3 || delar[0] !== PREFIX) return null
  const [, body, sig] = delar as [string, string, string]

  const väntad = b64url(
    crypto.createHmac('sha256', derivedKey(jwtSecret, kontext)).update(body).digest(),
  )
  // Konstant tid: en jämförelse som avbryter vid första felaktiga tecknet läcker
  // signaturen en byte i taget. Längdkontrollen först — timingSafeEqual kastar
  // på olika längd, och det kastet vore i sig en sidokanal.
  if (sig.length !== väntad.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(väntad))) return null

  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ChooseTokenPayload
    if (typeof p.orderRef !== 'string' || typeof p.subjectHash !== 'string') return null
    if (typeof p.exp !== 'number' || p.exp <= now.getTime()) return null
    // Kandidatlistan är valfri men får inte vara något ANNAT än strängar: en
    // manipulerad payload kan inte passera signaturen, men typkontrollen står
    // här så att en framtida avsändare inte kan smyga in en annan form.
    if (p.tenantIds !== undefined) {
      if (!Array.isArray(p.tenantIds) || p.tenantIds.some((t) => typeof t !== 'string')) return null
    }
    return p
  } catch {
    return null
  }
}
