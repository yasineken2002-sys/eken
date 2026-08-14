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
import { skaläraKolumner } from '../common/testing/schema-columns'
import { SAFE_ORGANIZATION_SELECT } from './organization-select'

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
 * Alla elva är samma sak: organisationens KOMMERSIELLA förhållande till Eveno.
 * De hör hemma bakom ACCOUNTANT/ADMIN/OWNER, och nås där via
 * `GET /ai-usage/current` respektive `GET /ai/usage`.
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
    const kolumner = skaläraKolumner('Organization')
    // Golv mot en parser som slutat hitta fält.
    expect(kolumner.length).toBeGreaterThanOrEqual(50)

    const oklassade = kolumner.filter((k) => !valda.includes(k) && !(k in MEDVETET_UTELÄMNADE))
    expect(oklassade).toEqual([])

    // En motivering för en kolumn som inte längre finns är en inaktuell text som
    // döljer nästa riktiga fråga — samma skäl som `declared` i authz-surfacens
    // driftkontroll.
    const föråldrade = Object.keys(MEDVETET_UTELÄMNADE).filter((k) => !kolumner.includes(k))
    expect(föråldrade).toEqual([])

    // Partitionen ska vara just en partition (lärdom från #444:s negativkontroll:
    // ett fält i BÅDA mängderna faller ur båda filtren och får vakten att tiga).
    const iBåda = valda.filter((k) => k in MEDVETET_UTELÄMNADE)
    expect(iBåda).toEqual([])
  })
})
