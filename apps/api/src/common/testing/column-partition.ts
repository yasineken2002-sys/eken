import { skaläraKolumner } from './schema-columns'

/**
 * KOLUMNPARTITIONEN — den enda av vaktfamiljerna som har flera instanser.
 *
 * Sex vakter mättes inför utbrytningen (#445). De visade sig vara FYRA former,
 * inte sex kopior av en:
 *
 *   a) PLATSKONTROLL      "ingen bar `X: true` utanför undantagslistan"
 *                         → 1 instans (#284)
 *   a') LÄSNINGSFORM      "ingen bar `prisma.X.find*` utan select här"
 *                         → 1 instans (#455)
 *   b) KOLUMNPARTITION    "varje kolumn är klassad som burten eller utelämnad"
 *                         → 4 instanser (#448, #458, #461, #462)
 *   c) MEKANISMNÄRVARO    "varje metod deklarerar sin returtyp"
 *                         → 1 instans (#462)
 *
 * Bara b) är värd att bryta ut. De fyra instanserna var byte för byte samma tre
 * assertions, med skillnad bara i variabelnamn.
 *
 * ── #453 hör INTE hit, och skälet är villkoret nedan ────────────────────────
 *
 * `tenant-credential-keys.spec.ts` ser ut som en femte instans men är en annan
 * form: den filtrerar först kolumnerna genom ett MÖNSTER (credential-formen) och
 * partitionerar bara träffarna. Att stödja den hade krävt att konsumenten
 * skickar in ett predikat — alltså logik, inte data — och då är hjälparen
 * tillbaka i det tillstånd utbrytningen ska undvika: så konfigurerbar att den
 * slutar säga något. Den lämnas bespoke, med det som skäl.
 *
 * ── Varför utbrytning är rätt HÄR, och villkoren den vilar på ───────────────
 *
 * Utbrytning KONCENTRERAR risk. Fyra kopior av en subtil regel är fyra
 * tillfällen att drifta blint; en delad hjälpare med ett fel gör fyra vakter
 * blinda samtidigt. Dagen gav båda utfallen: #444:s relationsdetektor var
 * korrekt av en TILLFÄLLIGHET (namnprefix), och när regeln flyttades till
 * `schema-columns.ts` fick båda vakterna rättningen gratis.
 *
 * Skillnaden mellan utfallen är EN sak — om det delade är negativkontrollerat.
 * Utbrytningen vilar därför på tre villkor, alla uppfyllda:
 *
 *   1. Hjälparen har EGNA negativkontroller, minst en per påstående den gör.
 *      Se column-partition.spec.ts.
 *   2. Varje konsument BEHÅLLER en egen, namngiven negativkontroll ("bär inte
 *      passwordHash", "bär inte totpSecret"). En regression i hjälparen blir
 *      därmed röd på fyra ställen i stället för noll.
 *   3. Konfigurationen är DATA — modellnamn, nyckellistor, undantagskarta,
 *      golv. Aldrig ett predikat.
 *
 * ── Det egentliga skälet: kopieringslotteriet ───────────────────────────────
 *
 * Ingen drift hade hunnit uppstå mellan de fyra. Vinsten är framåtriktad: en
 * FEMTE konsument får hela uppsättningen assertions per automatik i stället för
 * det urval den råkar kopiera. `iBåda`-kontrollen finns i #462 bara för att jag
 * kopierade #458 — hade jag kopierat #453 hade den saknats.
 */
export interface KolumnPartition {
  /** Prisma-modellens namn, exakt som i schema.prisma. */
  modell: string
  /**
   * Nycklar som svaret BÄR. Flera listor när modellen har flera svarsformer —
   * en kolumn räknas som klassad om den bärs av MINST en form.
   */
  burna: readonly (readonly string[])[]
  /** Kolumn → skäl. Ett utelämnande ska vara ett skrivet påstående. */
  utelämnade: Record<string, string>
  /**
   * Rimlighetsgolv: minsta antal kolumner parsern ska hitta på modellen. Utan
   * det vore "inga oklassade" tomt-mängd-sant om parsern slutat matcha schemat
   * (#273).
   */
  golv: number
}

/** Vad partitionen fann. Returneras så att konsumenten kan assertera vidare. */
export interface PartitionsResultat {
  kolumner: string[]
  /** Kolumner som varken bärs eller är utelämnade — måste vara tom. */
  oklassade: string[]
  /** Utelämnanden för kolumner som inte längre finns — måste vara tom. */
  föråldrade: string[]
  /** Kolumner som står i BÅDA mängderna — måste vara tom. */
  iBåda: string[]
}

/**
 * Partitionerar modellens kolumner mot de burna nycklarna och undantagen.
 *
 * Kastar om golvet inte nås — det är inte en assertion konsumenten kan glömma.
 * Övriga tre mängder returneras för att konsumenten ska assertera dem, så att
 * felmeddelandet pekar på rätt spec-fil.
 */
export function partitioneraKolumner(p: KolumnPartition): PartitionsResultat {
  const kolumner = skaläraKolumner(p.modell)
  if (kolumner.length < p.golv) {
    throw new Error(
      `column-partition: hittade ${kolumner.length} kolumner på ${p.modell}, ` +
        `golvet är ${p.golv}. Parsern har sannolikt slutat matcha schemat — ` +
        'en partition mot för få kolumner är tomt-mängd-sann.',
    )
  }
  const burna = p.burna.flat()
  return {
    kolumner,
    oklassade: kolumner.filter((k) => !burna.includes(k) && !(k in p.utelämnade)),
    föråldrade: Object.keys(p.utelämnade).filter((k) => !kolumner.includes(k)),
    iBåda: burna.filter((k) => k in p.utelämnade),
  }
}
