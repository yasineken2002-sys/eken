/**
 * PRENUMERATIONSBLOCKET LÄMNAR INTE DEN ÖPPNA ORGANISATIONSRADEN.
 *
 * `GET /organizations/me` är öppen för varje roll och måste vara det. Servicen
 * gjorde `findUnique` utan `select` och utan `omit` — hela raden, inklusive
 * `subscriptionPlan`, `planMonthlyFee`, `aiCreditsBalance`, `trialEndsAt`,
 * `billingEmail`, `suspendedAt`, `cancellationReason`, `excludeFromBilling`.
 * Blocket är avgjort som ACCOUNTANT/ADMIN/OWNER (#441), och tre andra endpoints
 * grindades i samma PR. Utan den här spärren hade de tre grindarna varit
 * verkningslösa: samma fält låg kvar i den öppna org-raden.
 *
 * REFERENSIMPLEMENTATION FÖR #445. Ärendet slog fast att kravet ska vara en
 * allowlist PER MODELL — Organization, Tenant, Customer, BankTransaction, User
 * måste ha explicit select eller en godkänd SAFE_*_SELECT — i stället för en
 * analys per läsning, som blir en taint-analys och därmed antingen brus eller
 * tyst. Formen här är den som ska återanvändas för de fyra återstående.
 *
 * TESTET LÄSER KÄLLAN OCH SCHEMAT, inte ett attrapp-svar. Samma skäl som i
 * invoice-customer-select.spec.ts och invoice-bank-transaction-select.spec.ts:
 * ett svarsbaserat test hade behövt en attrapp-Prisma som själv låtsas respektera
 * selecten, och därmed bara bevisat att attrappen är konsekvent med sig själv.
 *
 * DEN BÄRANDE KONTROLLEN ÄR PARTITIONEN. Ett `select` är fail-closed men långt,
 * och ett bortglömt fält bryter en vy i stället för att läcka. Partitionen mot
 * schema.prisma betalar det priset: varje kolumn måste stå antingen i selecten
 * eller i MEDVETET_UTELÄMNADE med ett skäl, så ett missat fält blir ett rött test
 * i stället för en trasig inställningssida — och en NY kolumn på modellen tvingar
 * fram ett beslut i stället för att flöda ut.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SAFE_ORGANIZATION_SELECT } from './organization-select'
import { partitioneraKolumner } from '../common/testing/column-partition'

const SERVICE = join(__dirname, 'organizations.service.ts')

function utanKommentarer(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/**
 * Kolumner som MEDVETET utelämnas, med skälet. Ett utelämnande ska vara ett
 * skrivet påstående någon kan ifrågasätta, inte en tyst frånvaro.
 *
 * De elva första är samma sak: organisationens KOMMERSIELLA förhållande till
 * Eveno. De hör hemma bakom ACCOUNTANT/ADMIN/OWNER, och nås där via
 * `GET /ai-usage/current` respektive `GET /ai/usage`.
 *
 * Den tolfte är av en ANNAN sort och får därför inte glida in under samma
 * mening: `transactionalEmailsDisabled` är ingen kommersiell uppgift utan en
 * intern DRIFTFLAGGA — en strypventil för utgående post som sätts på demo-,
 * test- och internkonton. Den utelämnas för att den inte är en
 * kundinställning: att en organisation själv kunde stänga av sin egen post via
 * inställningssidan vore ett fotskott med tyst utfall (avierna skulle stå som
 * SENT utan att någon fått dem). Sätts i dag direkt i databasen; ska den bli
 * ställbar hör den hemma i plattformsadmin, inte i `GET /organizations/me`.
 */
const MEDVETET_UTELÄMNADE: Record<string, string> = {
  subscriptionPlan: 'Vilken plan organisationen betalar för.',
  status: 'TRIAL/ACTIVE/SUSPENDED — kommersiellt tillstånd, inte driftdata.',
  planStartedAt: 'När abonnemanget började löpa.',
  trialEndsAt: 'När trial löper ut.',
  billingEmail: 'Faktureringsadress mot Eveno.',
  planMonthlyFee: 'Månadsavgiften — vad bolaget betalar.',
  aiCreditsBalance: 'Köpta AI-credits kvar.',
  suspendedAt: 'När kontot spärrades.',
  cancellationReason: 'Uppsägningsskäl — fritext om kundförhållandet.',
  lastTrialReminderDays: 'Intern påminnelsemarkör för trial-utskicken.',
  excludeFromBilling: 'Intern flagga: undantas från plattformsfaktureringen.',
  transactionalEmailsDisabled:
    'Intern driftflagga: strypventil för utgående post. Inte en kundinställning.',
}

describe('SAFE_ORGANIZATION_SELECT', () => {
  const valda = Object.keys(SAFE_ORGANIZATION_SELECT)

  it('bär inte prenumerations- eller faktureringsblocket', () => {
    // Uttrycklig negativ kontroll på namnen. Skulle någon ta in dem i selecten
    // faller testet på fältet, inte på en form som kan tolkas om.
    for (const fält of Object.keys(MEDVETET_UTELÄMNADE)) {
      expect(valda).not.toContain(fält)
    }
  })

  it('bär de fält den öppna vyn faktiskt behöver', () => {
    // Golv åt andra hållet: en tom eller nästan tom select hade passerat
    // kontrollen ovan men brutit varje vy. Stickprov på det som måste finnas.
    for (const fält of ['id', 'name', 'orgNumber', 'logoStorageKey', 'invoiceColor']) {
      expect(valda).toContain(fält)
    }
    expect(valda.length).toBeGreaterThanOrEqual(40)
  })

  it('ingen oskuren organisationsläsning finns kvar i tjänsten', () => {
    // #445:s regel är "explicit select ELLER godkänd SAFE_*_SELECT" — inte
    // "alltid konstanten". Servicen har en avsiktligt SMALARE läsning
    // (`select: { logoStorageKey: true }`, för logo-uppladdningen), och den är
    // lika korrekt: den bär inget block. Kravet är att projektionen FINNS.
    //
    // Första versionen av det här testet krävde konstanten överallt och föll på
    // just den raden. Ett test som är strängare än regeln det bevakar tvingar
    // fram sämre kod för att bli grönt.
    const src = utanKommentarer(readFileSync(SERVICE, 'utf8'))
    const läsningar = [
      ...src.matchAll(
        /prisma\.organization\.(findUnique|findFirst|findMany)\(\s*\{([\s\S]*?)\n\s{4}\}\)/g,
      ),
    ]
    // Golv: hittar regexen inga läsningar har den slutat matcha koden, och ett
    // "inga överträdelser" hade varit tomt-mängd-sant. Jfr #273:s rimlighetsgolv.
    expect(läsningar.length).toBeGreaterThanOrEqual(2)
    const oskurna = läsningar
      .map(([block]) => block)
      .filter((block) => !/\b(select|omit):/.test(block))
    expect(oskurna).toEqual([])

    // Och den breda vyn ska gå via konstanten, inte via en egen uppräkning.
    expect(src).toContain('select: SAFE_ORGANIZATION_SELECT')
  })

  it('varje kolumn på modellen är antingen vald eller medvetet utelämnad', () => {
    // Delad partition (#445-utbrytningen). Konfigurationen är DATA — modellnamn,
    // burna nycklar, undantagskarta, golv — aldrig ett predikat. Hjälparen har
    // egna negativkontroller i column-partition.spec.ts; de namngivna
    // kontrollerna ovan i den här filen är avsiktligt KVAR, så att en regression
    // i hjälparen blir röd här också och inte bara där.
    const r = partitioneraKolumner({
      modell: 'Organization',
      burna: [valda],
      utelämnade: MEDVETET_UTELÄMNADE,
      golv: 50,
    })
    expect(r.oklassade).toEqual([])
    expect(r.föråldrade).toEqual([])
    expect(r.iBåda).toEqual([])
    // KANARIEFÅGEL — villkor 2 för utbrytningen (#445).
    //
    // Utan den här är en trasig hjälpare TYST: returnerar `partitioneraKolumner`
    // alltid tomma mängder passerar varje konsument, även med en verklig
    // överträdelse i schemat. Uppmätt under utbrytningen — en bruten hjälpare
    // plus en oklassad kolumn gav grönt på alla fyra.
    //
    // Kontrollen matar in en partition som MÅSTE ge utslag och kräver att den
    // gör det. En regression i hjälparen blir därmed röd på fyra ställen i
    // stället för noll, vilket var hela villkoret utbrytningen vilade på.
    expect(
      partitioneraKolumner({ modell: 'Organization', burna: [[]], utelämnade: {}, golv: 1 })
        .oklassade.length,
    ).toBeGreaterThan(0)
  })
})
