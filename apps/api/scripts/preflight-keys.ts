/**
 * Förhandskontroll av API-nycklar för de manuella kunskapsbas-scripten
 * (`knowledge:eval`, `knowledge:embed`).
 *
 * VARFÖR (#385): dev-nyckeln för Anthropic slutade fungera och `knowledge:eval`
 * föll på ett opakt `401 {"type":"error",...}` mitt i körningen — efter att ha
 * spenderat ~22 Voyage-embeddings. Felet sa varken VAD som var fel eller VAD man
 * skulle göra, och gick inte att skilja från ett transient nätfel.
 *
 * TRE TILLSTÅND, TRE BESKED. De blandas ofta ihop och kräver helt olika åtgärd:
 *   • SAKNAS      — ingen nyckel i miljön. Fixas i apps/api/.env.
 *   • FELFORMAD   — nyckeln finns men har fel form (t.ex. klistrad med citattecken
 *                   eller avhuggen). Fixas utan att kontakta någon.
 *   • OGILTIG     — nyckeln ser rätt ut men avvisas (401). Återkallad eller fel
 *                   konto — kräver en NY nyckel, inte en rättad.
 *
 * Kontrollen körs FÖRE allt arbete, så en trasig nyckel kostar noll Voyage-anrop
 * och noll väntetid.
 */

/** Fel som ska skrivas ut som ett BESKED, inte som ett stacktrace. */
export class PreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreflightError'
  }
}

interface KeySpec {
  /** Miljövariabelns namn, t.ex. "ANTHROPIC_API_KEY". */
  envVar: string
  /** Vad nyckeln används till, i klartext. */
  whatFor: string
  /** Förväntat prefix, t.ex. "sk-ant-". Tomt = ingen formkontroll. */
  expectedPrefix: string
}

/**
 * Kontrollerar att nyckeln finns och har rätt form. Kastar PreflightError med
 * ett besked som säger vad som ska göras. Rör inte nätet.
 */
export function requireApiKey(spec: KeySpec): string {
  const raw = process.env[spec.envVar]

  if (raw === undefined || raw.trim() === '') {
    throw new PreflightError(
      `${spec.envVar} saknas — ${spec.whatFor} kan inte köras.\n\n` +
        `  Lägg in nyckeln i apps/api/.env:\n` +
        `      ${spec.envVar}=${spec.expectedPrefix}…\n\n` +
        `  Eller sätt den bara för den här körningen:\n` +
        `      ${spec.envVar}=… pnpm --filter @eken/api <script>\n\n` +
        `  En explicit satt miljövariabel vinner över --env-file-if-exists=.env.`,
    )
  }

  const key = raw.trim()

  // Vanligaste klistrfelet: citattecken följer med från en lösenordshanterare.
  if (/^["']|["']$/.test(key)) {
    throw new PreflightError(
      `${spec.envVar} är omgiven av citattecken.\n\n` +
        `  .env-filer ska INTE ha citattecken runt värdet. Ta bort dem:\n` +
        `      ${spec.envVar}=${spec.expectedPrefix}…      (inte "${spec.expectedPrefix}…")`,
    )
  }

  if (spec.expectedPrefix && !key.startsWith(spec.expectedPrefix)) {
    throw new PreflightError(
      `${spec.envVar} har fel form — förväntade en nyckel som börjar med "${spec.expectedPrefix}".\n\n` +
        `  Hittade i stället något som börjar med "${key.slice(0, Math.min(8, key.length))}…" (${key.length} tecken).\n` +
        `  Kontrollera att rätt nyckel hamnat i rätt variabel i apps/api/.env.`,
    )
  }

  return key
}

/**
 * Verifierar att nyckeln faktiskt accepteras, med ett gratis GET-anrop mot
 * modellistan. Skiljer 401 (ogiltig nyckel) från nätfel — de kräver olika
 * åtgärd och ska inte ge samma besked.
 */
export async function verifyAnthropicKey(key: string): Promise<void> {
  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    })
  } catch (err) {
    throw new PreflightError(
      `Kunde inte nå api.anthropic.com: ${err instanceof Error ? err.message : String(err)}\n\n` +
        `  Det här är ett NÄTFEL, inte ett nyckelfel. Kontrollera anslutningen och kör om.`,
    )
  }

  if (res.status === 401) {
    throw new PreflightError(
      `ANTHROPIC_API_KEY avvisas av Anthropic (401 authentication_error).\n\n` +
        `  Nyckeln har rätt FORM men accepteras inte — den är återkallad, hör till\n` +
        `  ett annat konto, eller har aldrig varit giltig. Detta går INTE att rätta\n` +
        `  genom att redigera värdet: en NY nyckel måste utfärdas.\n\n` +
        `  1. Skapa en ny nyckel i Anthropics konsol\n` +
        `  2. Ersätt ANTHROPIC_API_KEY i apps/api/.env\n` +
        `  3. Kör om\n\n` +
        `  Använd INTE produktionsnyckeln som reserv — dev-kostnader hamnar då på\n` +
        `  produktionskvoten, som AiQuotaService stoppar riktiga kunder mot. Se #385.`,
    )
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new PreflightError(
      `Anthropic svarade ${res.status} på förhandskontrollen.\n\n` +
        `  ${body.slice(0, 200)}\n\n` +
        `  Är det 429 eller 5xx är det tillfälligt — vänta och kör om.`,
    )
  }
}

/**
 * Samma för Voyage. Det finns ingen gratis listnings-endpoint, så vi embeddar
 * en enda kort sträng — några tokens, i praktiken kostnadsfritt, och det är den
 * billigaste vägen att skilja en ogiltig nyckel från ett nätfel.
 */
export async function verifyVoyageKey(key: string, model: string): Promise<void> {
  let res: Response
  try {
    res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: ['ping'], model, input_type: 'query' }),
    })
  } catch (err) {
    throw new PreflightError(
      `Kunde inte nå api.voyageai.com: ${err instanceof Error ? err.message : String(err)}\n\n` +
        `  Det här är ett NÄTFEL, inte ett nyckelfel. Kontrollera anslutningen och kör om.`,
    )
  }

  if (res.status === 401 || res.status === 403) {
    throw new PreflightError(
      `VOYAGE_API_KEY avvisas av Voyage (${res.status}).\n\n` +
        `  Nyckeln har rätt form men accepteras inte — återkallad eller fel konto.\n` +
        `  En NY nyckel måste utfärdas; värdet går inte att rätta.\n\n` +
        `  1. Skapa en ny nyckel på voyageai.com\n` +
        `  2. Ersätt VOYAGE_API_KEY i apps/api/.env\n` +
        `  3. Kör om`,
    )
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new PreflightError(
      `Voyage svarade ${res.status} på förhandskontrollen.\n\n` +
        `  ${body.slice(0, 200)}\n\n` +
        `  Är det 429 eller 5xx är det tillfälligt — vänta och kör om.`,
    )
  }
}

/**
 * Skriver ut ett PreflightError som ett rent besked och avslutar. Andra fel
 * kastas vidare med stacktrace — de är buggar, inte miljöproblem.
 */
export function exitOnPreflightError(err: unknown, scriptLabel: string): never {
  if (err instanceof PreflightError) {
    console.error(`\n[${scriptLabel}] FÖRHANDSKONTROLLEN STOPPADE KÖRNINGEN\n\n${err.message}\n`)
    process.exit(1)
  }
  console.error(`[${scriptLabel}] MISSLYCKADES:`, err instanceof Error ? err.message : err)
  process.exit(1)
}
