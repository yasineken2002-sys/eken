import { Prisma } from '@prisma/client'

/**
 * FASTIGHETSBETECKNINGEN ÄR NYCKELN — EN definition, delad av alla skrivare.
 *
 * `@@unique([organizationId, propertyDesignation])` jämför den LAGRADE strängen.
 * Normaliserar en skrivväg och en annan inte, så gäller villkoret olika saker
 * beroende på vem som skrev — och det är inte ett gränsfall utan två skrivvägar
 * i dag: `PropertiesService` (UI + AI-verktyget) och `ImportService`.
 *
 * ── BARA TRIM, OCH DET ÄR ETT VAL ───────────────────────────────────────────
 *
 * Kantblanksteg är osynliga i UI:t. Trimmas de inte kan "EKEN 1:2 " och
 * "EKEN 1:2" ligga som två fastigheter utan att någon ser skillnaden, och då
 * skyddar villkoret ingenting mot en klippa-och-klistra-inmatning.
 *
 * Mer än så gör vi INTE. Att skiftlägesnormalisera det lagrade värdet vore att
 * ändra det operatören skrev, och en separat härledd jämförelsekolumn är ett
 * större beslut än det här problemet motiverar: "Eken 1:2" och "eken 1:2" blir
 * alltså fortfarande två rader. Det är en känd gräns och inte ett förbiseende —
 * en omkörning skickar samma sträng, inte en variant av den.
 */
export function normaliseraBeteckning(v: string): string {
  return v.trim()
}

/**
 * Betyder den här P2002:an "beteckningen finns redan i organisationen"?
 *
 * ALDRIG EN BLIND FÅNGST: `Property` kan få fler unika villkor, och ett fel som
 * betyder något annat ska fortsätta upp. Prisma rapporterar `meta.target` som en
 * kolumn-array; okänd form klassas som "inte vår konflikt" och kastas vidare.
 */
export function ärBeteckningskonflikt(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false
  const target = (err.meta as { target?: unknown } | undefined)?.target
  const fält = Array.isArray(target)
    ? target.map(String)
    : typeof target === 'string'
      ? [target]
      : []
  return fält.includes('propertyDesignation')
}

/** EN text för samma sakförhållande, oavsett vilken skrivväg som träffade den. */
export function beteckningUpptagenText(beteckning: string): string {
  return (
    `Fastighetsbeteckningen "${beteckning}" finns redan i organisationen. ` +
    'Beteckningen identifierar fastigheten i det offentliga registret och kan ' +
    'bara tillhöra en fastighet. Öppna den befintliga fastigheten, eller ' +
    'kontrollera att beteckningen är rätt inskriven.'
  )
}
