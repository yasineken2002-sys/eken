/**
 * LÖSENORDSHASHEN LÄMNAR INTE ANVÄNDARRADEN — och varje ny kolumn tvingar fram
 * ett beslut.
 *
 * `User` var den enda av #445:s fem känsliga modeller helt utan bevakning. En
 * sökning över samtliga specar efter `passwordHash` gav fyra träffar, alla på
 * hyresgäst-/portalsidan — noll på org-sidans användare. Selecten fanns
 * (`PUBLIC_USER_FIELDS`), men ingenting sa att den var rätt eller fullständig.
 *
 * Formen speglar `organization-select.spec.ts` och `tenant-credential-keys.spec.ts`
 * rakt av. Testet läser schemat och källan, aldrig ett attrapp-svar: ett
 * svarsbaserat test hade behövt en attrapp-Prisma som själv låtsas respektera
 * selecten, och därmed bara bevisat att attrappen är konsekvent med sig själv.
 *
 * ── Den bärande kontrollen är partitionen ────────────────────────────────────
 *
 * Att lista dagens uteslutningar hade varit en ögonblicksbild. Partitionen mot
 * `schema.prisma` kräver att VARJE kolumn står antingen i selecten eller i
 * `MEDVETET_UTELÄMNADE` med ett skäl — så en ny kolumn faller testet tills någon
 * klassat den. Det är den kontrollen som gör att bevakningen inte tyst blir
 * inaktuell.
 *
 * Två av dagens uteslutningar var inte självklara och behövde just den
 * klassificeringen: `loginAttempts` och `lockedUntil` är brute force-tillstånd,
 * och att exponera dem berättar för en angripare hur många försök som återstår.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SAFE_USER_SELECT } from './user-select'
import { partitioneraKolumner } from '../common/testing/column-partition'

const SERVICE = join(__dirname, 'users.service.ts')

function utanKommentarer(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/**
 * Kolumner som MEDVETET utelämnas, med skälet. Ett utelämnande ska vara ett
 * skrivet påstående någon kan ifrågasätta, inte en tyst frånvaro.
 */
const MEDVETET_UTELÄMNADE: Record<string, string> = {
  passwordHash:
    'Lösenordshashen. Får aldrig serialiseras; auth-modulen läser den separat ' +
    'för bcrypt-jämförelsen och handprojicerar sina svar.',
  loginAttempts:
    'Brute force-tillstånd. Att exponera antalet misslyckade försök berättar ' +
    'för en angripare hur nära utelåsning hen är — och därmed när det lönar ' +
    'sig att byta konto eller vänta ut fönstret.',
  lockedUntil:
    'Samma skäl som loginAttempts: när utelåsningen släpper är information ' +
    'som bara gynnar den som väntar ut den.',
  organizationId:
    'Intern scope-nyckel. Klienten känner redan sin organisation via JWT:n och ' +
    'har ingen användning för den på varje användarrad.',
  acceptedTermsAt:
    'Villkorsacceptans per användare. Inte känsligt, men ingen yta läser det — ' +
    'org-nivåns termsVersion är den frontend jämför mot.',
  termsVersion: 'Samma som acceptedTermsAt.',
}

describe('SAFE_USER_SELECT', () => {
  const valda = Object.keys(SAFE_USER_SELECT)

  it('bär inte lösenordshashen', () => {
    // Uttrycklig negativ kontroll på det fält som betyder mest. Faller på
    // namnet, inte på en form som kan tolkas om.
    expect(valda).not.toContain('passwordHash')
  })

  it('bär de fält en användarlista faktiskt behöver', () => {
    // Golv åt andra hållet: en tom select hade passerat kontrollen ovan men
    // brutit varje vy som visar användare.
    for (const fält of ['id', 'email', 'firstName', 'lastName', 'role', 'isActive']) {
      expect(valda).toContain(fält)
    }
  })

  it('varje kolumn på modellen är antingen vald eller medvetet utelämnad', () => {
    // Delad partition (#445-utbrytningen). Konfigurationen är DATA — modellnamn,
    // burna nycklar, undantagskarta, golv — aldrig ett predikat. Hjälparen har
    // egna negativkontroller i column-partition.spec.ts; de namngivna
    // kontrollerna ovan i den här filen är avsiktligt KVAR, så att en regression
    // i hjälparen blir röd här också och inte bara där.
    const r = partitioneraKolumner({
      modell: 'User',
      burna: [valda],
      utelämnade: MEDVETET_UTELÄMNADE,
      golv: 15,
    })
    expect(r.oklassade).toEqual([])
    expect(r.föråldrade).toEqual([])
    expect(r.iBåda).toEqual([])
  })

  it('användartjänstens läsningar går genom selecten, inte en egen uppräkning', () => {
    // Konstanten flyttades ut ur tjänsten och bytte namn; det här fångar att
    // något anropsställe blev kvar med den gamla inline-formen.
    const src = utanKommentarer(readFileSync(SERVICE, 'utf8'))
    const läsningar = [...src.matchAll(/prisma\.user\.(findUnique|findFirst|findMany)\(\s*\{/g)]
    expect(läsningar.length).toBeGreaterThanOrEqual(3)
    expect(src).toContain('select: SAFE_USER_SELECT')
    // Ingen kvarvarande kopia av den gamla konstanten.
    expect(src).not.toContain('PUBLIC_USER_FIELDS')
  })
})
