/**
 * REDIGERA KONTAKTUPPGIFTER — formulärets regler som RENA funktioner.
 *
 * Webs vitest kör med `environment: 'node'` och renderar ingenting, så
 * valideringen och "vad ska skickas"-frågan måste bo utanför komponenten för att
 * gå att pröva. Det kostar en indirektion, och det är hela priset.
 *
 * ── FÄLTMÄNGDEN ÄR VERKTYGETS, INTE DTO:NS ──────────────────────────────────
 *
 * `UpdateTenantDto` tar emot typ, namn, personnummer, orgnummer och adress.
 * AI-verktyget `update_tenant` kan bara ändra **e-post och telefon** — dess
 * input_schema har exakt de två fälten utöver `tenantId`/`tenantName`.
 *
 * Delmängdsregeln säger att människan ska kunna MINST lika mycket som agenten.
 * Den säger ingenting om att människan ska kunna mer, och att passa på att öppna
 * namn- och personnummerredigering i samma veva vore en annan ändring med andra
 * konsekvenser (personnumret är krypterat at-rest och bär ett blindindex;
 * namnbyte rör avtal och avier). Modalen redigerar därför exakt de två fälten.
 *
 * ── BARA DET SOM FAKTISKT ÄNDRATS SKICKAS ───────────────────────────────────
 *
 * `bygguppdatering` returnerar `null` när ingenting skiljer sig från utgångsläget.
 * Skälet är inte sparsamhet utan spårbarhet: en PATCH som skriver tillbaka samma
 * e-post är en ändring i historiken som ingen gjorde, och den som läser
 * hyresgästens historik ska inte se rader utan innehåll.
 */

export interface Kontaktutkast {
  email: string
  phone: string
}

/** Det som faktiskt skickas. `null` = ingenting har ändrats. */
export type Kontaktuppdatering = { email?: string; phone?: string } | null

/**
 * E-postkontrollen är MEDVETET grov. Servern validerar med `@IsEmail()` och är
 * auktoriteten; den här finns bara för att slippa ett serveranrop för en adress
 * utan snabel-a. En egen sträng-regex som försöker vara exakt hade blivit en
 * andra sanning som avviker från serverns — och avvikelsen hade visat sig som
 * ett fält användaren inte får spara trots att adressen är giltig.
 */
export function epostSerRimligUt(v: string): boolean {
  const t = v.trim()
  if (t.length < 3) return false
  const at = t.indexOf('@')
  return at > 0 && at < t.length - 1 && !t.includes(' ')
}

export function kontaktFel(utkast: Kontaktutkast): string | null {
  const email = utkast.email.trim()
  if (email === '') return 'E-postadressen kan inte tas bort — hyresgästen nås via den.'
  if (!epostSerRimligUt(email)) return 'E-postadressen ser inte ut att vara giltig.'
  return null
}

export function bygguppdatering(utgang: Kontaktutkast, utkast: Kontaktutkast): Kontaktuppdatering {
  const uppdatering: { email?: string; phone?: string } = {}
  const email = utkast.email.trim()
  const phone = utkast.phone.trim()

  if (email !== utgang.email.trim()) uppdatering.email = email
  // TELEFON FÅR TÖMMAS, e-post inte. Telefonnumret är valfritt i modellen
  // (`phone` är nullable) och en hyresgäst som byter till att bara nås via
  // e-post ska kunna det. Tom sträng skickas då som tom sträng — inte som
  // `undefined`, vilket hade betytt "rör inte fältet".
  if (phone !== (utgang.phone ?? '').trim()) uppdatering.phone = phone

  return Object.keys(uppdatering).length === 0 ? null : uppdatering
}
