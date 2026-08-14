import type { Prisma, Tenant } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import {
  stripTenantCredentialKeys,
  type TenantCredentialKey,
} from '../tenants/tenant-credential-keys'

/**
 * DEN ENDA VÄGEN TILL EN CREDENTIAL-BÄRANDE TENANT-LÄSNING.
 *
 * ── Problemet ───────────────────────────────────────────────────────────────
 *
 * Portalens autentisering MÅSTE läsa `passwordHash` och `*TokenHash` — det är
 * bcrypt-jämförelsen och tokenuppslagningen. Den läser därför med bar `include`,
 * alltså alla skalärer, och skyddet ligger i att `stripTenantCredentials` körs
 * innan objektet lämnar servicen.
 *
 * Det skyddet bars av en KOMMENTAR. Åtta bara läsningar i tenant-auth.service.ts
 * plus en i controllern, och ingenting som hindrade en tionde från att gå direkt
 * till svaret. Precis B1-misstaget, som `stripTenantCredentials` egen docstring
 * anger som skälet funktionen finns.
 *
 * ── Varför en TYP och inte bara en konvention ───────────────────────────────
 *
 * `TenantWithCredentials` är märkt med en unik symbol. Den symbolen finns inte i
 * `PublicTenant`, så de två typerna är strukturellt oförenliga: en funktion vars
 * returtyp är den publika formen kan inte returnera den credential-bärande utan
 * att passera `stripTenantCredentials`, som är den enda konverteraren.
 *
 * Symbolen är en TYPE-ONLY-egenskap — den finns inte i runtime och påverkar
 * varken `JSON.stringify` eller Prismas objekt.
 *
 * ── Vad typen INTE ensam kan ────────────────────────────────────────────────
 *
 * En NestJS-controller med inferrerad returtyp kan fortfarande returnera vad som
 * helst; typen biter först när någon deklarerar den publika formen. Och en helt
 * NY bar `prisma.tenant.find*` skulle inte ha någon typ alls att bita på — den
 * vore ogrindad, och kompilatorn skulle tiga.
 *
 * Det är exakt formen "ett skydd som är BLINT i stället för RÖTT", och den
 * stängs inte av typen utan av `tenant-credential-read.spec.ts`: en NEGATIV
 * mönsterkontroll som failar på varje `prisma.tenant.find*` i `tenant-portal/`
 * som varken har `select` eller går genom den här funktionen. En ny läsning blir
 * röd utan att någon behöver uppdatera en lista.
 */

declare const CREDENTIAL_BRAND: unique symbol

/** Tenant med credential-kolumnerna kvar. Kan inte returneras som publik form. */
export type TenantWithCredentials<T = Tenant> = T & {
  readonly [CREDENTIAL_BRAND]: 'credentials-not-stripped'
}

/** Tenant där credential-kolumnerna är borta. Enda vägen hit: strippning. */
export type PublicTenant<T = Tenant> = Omit<T, TenantCredentialKey>

/**
 * Läser en tenant MED credentials via `findUnique`. Enda tillåtna vägen till en
 * oskuren tenant-läsning i tenant-portal/ — se mönsterkontrollen i specen.
 *
 * Namnet är avsiktligt obekvämt: en läsning som bär hemligheter ska synas i
 * anropsraden, inte gömma sig bakom `findUnique`.
 *
 * SEPARAT FRÅN findFirst-varianten med flit. Ett första utkast lät båda gå via
 * `findFirst`, vilket tyst tog bort `findUnique`:s krav på ett unikt villkor —
 * en semantisk försvagning gömd i en refaktor. Två befintliga läck-specar
 * upptäckte det genom att mocka `findUnique`; utan dem hade det gått igenom.
 */
export async function readTenantWithCredentials<A extends Prisma.TenantFindUniqueArgs>(
  prisma: PrismaService,
  args: A,
): Promise<TenantWithCredentials<Prisma.TenantGetPayload<A>> | null> {
  const rad = await prisma.tenant.findUnique(args)
  return rad as unknown as TenantWithCredentials<Prisma.TenantGetPayload<A>> | null
}

/** `findFirst`-varianten, för icke-unika villkor (t.ex. uppslag på e-post). */
export async function findTenantWithCredentials<A extends Prisma.TenantFindFirstArgs>(
  prisma: PrismaService,
  args: A,
): Promise<TenantWithCredentials<Prisma.TenantGetPayload<A>> | null> {
  const rad = await prisma.tenant.findFirst(args)
  return rad as unknown as TenantWithCredentials<Prisma.TenantGetPayload<A>> | null
}

/** Listvarianten. Samma kontrakt. */
export async function readManyTenantsWithCredentials<A extends Prisma.TenantFindManyArgs>(
  prisma: PrismaService,
  args: A,
): Promise<TenantWithCredentials<Prisma.TenantGetPayload<A>>[]> {
  const rader = await prisma.tenant.findMany(args)
  return rader as unknown as TenantWithCredentials<Prisma.TenantGetPayload<A>>[]
}

/**
 * Konverterar credential-bärande → publik. ENDA vägen ut ur den brandade typen.
 *
 * Delar strippningslistan med hyresvärds-API:ts `mapTenant` (#453), så en kolumn
 * som läggs till där gäller omedelbart här.
 */
export function toPublicTenant<T extends Record<string, unknown>>(
  tenant: TenantWithCredentials<T>,
): PublicTenant<T> {
  return stripTenantCredentialKeys(tenant as unknown as T) as PublicTenant<T>
}
