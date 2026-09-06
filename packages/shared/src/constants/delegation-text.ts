/**
 * DELEGATIONENS KLARTEXT — EN karta, två läsare.
 *
 * ── VARFÖR DEN INTE FÅR BO I EN FEATURE ─────────────────────────────────────
 *
 * Inkorgens bekräftelse ("Gör alltid så här", `features/inbox`) och
 * delegationssidan (`features/delegationer`) beskriver SAMMA rättighet — den ena
 * innan den ges, den andra efteråt. Två kopior av kartan hade glidit isär, och
 * utfallet är det värsta tänkbara just här: hyresvärden godkänner en mening och
 * läser sedan en annan om samma sak, utan att något blivit rött.
 *
 * Kartan låg i `GorAlltidSaHar.tsx` (PR 2) och flyttades hit i PR 3 i stället
 * för att kopieras. Att låta den ena featuren importera ur den andra hade löst
 * dubbleringen men skapat ett beroende åt fel håll.
 *
 * ── VAD DEN HÄR FILEN INTE KAN SE ───────────────────────────────────────────
 *
 * Att mängden är RÄTT. `@eken/shared` känner inte till effektkatalogen och kan
 * därför inte veta vilka verktyg som är delegerbara. Den kopplingen ägs av
 * `apps/api/src/ai/delegation/delegation-text.spec.ts`, som kräver EXAKT
 * likhet mot `delegerbaraVerktyg()` i båda riktningarna — ett nytt delegerbart
 * verktyg utan text fäller, och en text för något som inte är delegerbart fäller
 * också. Utan den specen är den här filen bara en lista någon skrev en gång.
 */

/**
 * Verktygsnamn i ATT-FORM, så att raden läser som en mening:
 * *"Agenten får lägga upp en fastighet."*
 *
 * Katalogens `label`/`menuLabel` (`ai-tools.catalog.ts`) duger inte: de är
 * pågående respektive imperativ form — *"Skapar faktura"*, *"Skapa faktura"* —
 * och ger *"Agenten får Skapa faktura"*. Formen är en tredje, inte en kopia.
 */
export const DELEGATION_VERKTYGSTEXT: Record<string, string> = {
  create_property: 'lägga upp en fastighet',
  create_unit: 'lägga upp en lägenhet',
  create_invoice: 'skapa ett fakturautkast',
  create_inspection: 'planera en besiktning',
  create_maintenance_ticket: 'lägga upp ett ärende',
  update_maintenance_status: 'ändra status på ett ärende',
  generate_rent_notices: 'skapa månadens hyresavier',
  import_bgmax_file: 'läsa in en bankfil',
}

/** Villkorets fält i klartext, i den ordning en människa läser dem. */
export const DELEGATION_VILLKORSNAMN: Record<string, string> = {
  category: 'Typ av ärende',
  kategori: 'Typ av ärende',
  propertyId: 'Fastighet',
  unitId: 'Lägenhet',
  maxBelopp: 'Högsta belopp',
}

/**
 * Faller tillbaka på det TEKNISKA namnet, aldrig på en tom sträng.
 *
 * Ett verktyg som saknas i kartan ska se OÖVERSATT ut, inte OSYNLIGT: en tom
 * cell hade lästs som "ingen rättighet" om en rättighet som finns. Att fallet
 * inte kan uppstå i dag är specens förtjänst, inte den här funktionens — och
 * den dag specen ändras ska felet vara fult, inte tyst.
 */
export function delegationVerktygstext(toolName: string): string {
  return DELEGATION_VERKTYGSTEXT[toolName] ?? toolName
}

export function delegationVillkorsnamn(fält: string): string {
  return DELEGATION_VILLKORSNAMN[fält] ?? fält
}

/**
 * Villkoret som EN läsbar rad.
 *
 * `null` och `{}` betyder båda "utan avgränsning" i läsytan, och det sägs i
 * klartext — en tom cell hade fått den BREDASTE möjliga rätten att se ut som en
 * detalj som inte fyllts i.
 */
export function delegationVillkorstext(
  villkor: Record<string, unknown> | null | undefined,
): string {
  const poster = Object.entries(villkor ?? {}).filter(([, v]) => v !== null && v !== undefined)
  if (poster.length === 0) return 'Utan avgränsning — hela organisationen'
  return poster.map(([k, v]) => `${delegationVillkorsnamn(k)}: ${String(v)}`).join(' · ')
}

/** Frekvensvillkoret som en läsbar rad. Frånvaron sägs, den lämnas inte tom. */
export function delegationFrekvenstext(
  f: { maxAntal?: number; periodDagar?: number } | null | undefined,
): string {
  if (!f || typeof f.maxAntal !== 'number' || typeof f.periodDagar !== 'number') {
    return 'Inget tak'
  }
  return `Högst ${f.maxAntal} per ${f.periodDagar} dagar`
}
