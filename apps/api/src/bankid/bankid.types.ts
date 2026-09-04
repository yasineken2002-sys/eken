/**
 * BankIdProvider — leverantörsneutral port för INLOGGNING med BankID.
 *
 * ── EGEN PORT, INTE EN DEL AV DocumentSigningProvider ──────────────────────
 *
 * `signing.types.ts` säger det redan från andra hållet: `DocumentSigningProvider`
 * är "EGEN port, skild från en framtida BankIdProvider (inloggning) — de delar
 * bara en intern broker-transport, inte detta interface".
 *
 * Skälet är att de två svarar på olika frågor, och det syns i formen:
 *
 *   DocumentSigningProvider   "signera det HÄR dokumentet, av DE HÄR parterna,
 *                             och ge mig en förseglad PDF med bevis per part"
 *                             — envelope, flerpart, contentHash, webhook.
 *   BankIdProvider            "vem är personen framför skärmen just nu?"
 *                             — en part, ingen handling, inget dokument.
 *
 * En gemensam abstraktion hade tvingat inloggningen att bära envelope- och
 * dokumentbegrepp den inte har, och signeringen att bära ett auth-flöde den inte
 * använder. Att samma broker kan leverera båda är en implementationsdetalj i
 * adaptern, inte en egenskap hos porten.
 *
 * ── NEUTRAL MOT BROKER ─────────────────────────────────────────────────────
 *
 * Inga leverantörsfält i det här interfacet. `orderRef` är BankID:s egen
 * standardmodell (auth-start → orderRef → collect), inte en brokers, och
 * `autoStartToken`/`qrData` är valfria därför att olika brokers exponerar det ena,
 * det andra eller båda. En adapter som behöver mer bär det internt.
 *
 * S1: bara Stub (inert) + Mock (test). Skarp adapter i S3 (kräver avtal/nycklar).
 */

/** DI-token för den valda providern (Stub/Mock/skarp via useFactory). */
export const BANKID_PROVIDER = Symbol('BANKID_PROVIDER')

/**
 * Vad anroparen skickar in för att starta en autentisering.
 *
 * `endUserIp` krävs av BankID:s standardmodell och är alltså inte ett
 * brokerfält. `personalNumber` är MEDVETET valfritt: den moderna vägen är att
 * användaren identifierar sig i appen (QR eller autostart) och att
 * personnumret kommer TILLBAKA i `completionData` — inte att det matas in
 * först. Fältet finns för de flöden som ändå kräver det, och när det används
 * gäller samma regel som för svaret: det blindindexeras omedelbart.
 */
export interface BankIdStartInput {
  endUserIp: string
  personalNumber?: string
}

export interface BankIdStartResult {
  /** Handtaget hela flödet vilar på. Opakt för oss. */
  orderRef: string
  /** För att starta BankID-appen på samma enhet. Saknas hos vissa brokers. */
  autoStartToken?: string
  /** För QR på annan enhet. Roterar hos vissa brokers; anroparen pollar. */
  qrData?: string
}

/**
 * Identiteten BankID intygar.
 *
 * ── KLARTEXTEN LEVER BARA I MINNET ────────────────────────────────────────
 *
 * `personalNumber` är RÅTT här, och det är avsiktligt: porten kan inte veta
 * vilket blindindex kärnan använder, och en provider som själv hashade hade
 * gjort matchningen omöjlig att byta ut. Kravet ligger i stället på ANROPAREN:
 *
 *   Tjänsten som tar emot ett `BankIdCollectComplete` ska OMEDELBART blindindexera
 *   personnumret (`SigningCryptoService.blindIndex`, HMAC-SHA256 med
 *   `SIGNING_PII_PEPPER`) och därefter bara bära hashen vidare. Klartexten får
 *   ALDRIG lagras, loggas, hamna i ett felmeddelande eller i ett Sentry-event.
 *
 * Det är samma regel som redan gäller signeringens `ProviderPartyEvidence`
 * (`signing.types.ts`), och den står här därför att en port utan den regeln
 * inbjuder nästa person att spara "bara tillfälligt".
 *
 * `givenName`/`surname` bärs separat och inte som ett hopslaget `name`: en
 * matchning eller en visning som behöver förnamnet ska slippa gissa var
 * mellanslaget går.
 */
export interface BankIdCompletionData {
  personalNumber: string
  givenName: string
  surname: string
}

export type BankIdCollectResult =
  /** Ordern lever; anroparen pollar igen. `hintCode` är rådtext till användaren. */
  | { status: 'pending'; hintCode?: string }
  /**
   * Ordern är död och kan inte återupptas — avbruten, utgången, eller nekad.
   * `reason` är maskinläsbar; den ska ALDRIG bära personuppgifter.
   */
  | { status: 'failed'; reason: string }
  /** Ordern är fullbordad. Se docblocket på BankIdCompletionData. */
  | { status: 'complete'; completionData: BankIdCompletionData }

export interface BankIdProvider {
  /** Kort namn för loggar och prov: 'STUB' | 'MOCK' | leverantörens. */
  readonly name: string

  start(input: BankIdStartInput): Promise<BankIdStartResult>

  /**
   * Frågar om ordern. Anroparen pollar tills status inte längre är `pending`.
   *
   * Att `collect` inte kastar vid `failed` är avsiktligt: ett avbrutet BankID är
   * ett normalt utfall i flödet, inte ett fel i systemet. Kast reserveras för
   * att providern inte kan svara alls.
   */
  collect(orderRef: string): Promise<BankIdCollectResult>
}
