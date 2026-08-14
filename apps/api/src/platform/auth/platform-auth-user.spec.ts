/**
 * SUPERADMINENS TOTP-HEMLIGHET LÄMNAR INTE SERVERN — och varje ny kolumn tvingar
 * fram ett beslut.
 *
 * `PlatformUser` var den sjätte credential-bärande modellen och kom aldrig med på
 * #445:s lista. Mätningen gav ett ovanligt utfall: **starkast skydd av alla fem
 * mätta modeller, och noll bevakning.**
 *
 * Skyddet är att varje metod i `platform-auth.service.ts` deklarerar sin
 * returtyp — `PlatformAuthUser` är fem fält, och kompilatorn hindrar en rå rad
 * från att returneras. Det är den starkaste av de tre mallarna (#445:
 * returtyp > select > mapper), och den enda som upprätthålls före körning.
 *
 * Men ingenting sa att typen var RÄTT eller FULLSTÄNDIG. Läggs en kolumn till på
 * modellen — en `recoveryCodes`, en `apiToken` — hamnar den tyst utanför, och
 * ingen har beslutat om den hör hemma i svaret. Skyddet var alltså korrekt men
 * odokumenterat, precis det tillstånd `User` var i före #458.
 *
 * ── Varför just den här modellen förtjänar vakten ───────────────────────────
 *
 * `totpSecret` är DIREKT ANVÄNDBAR. En `passwordHash` måste knäckas och en
 * token-hash kräver en preimage — men en TOTP-hemlighet genererar giltiga koder
 * omedelbart och för alltid. Läcker den är andra faktorn borta, tyst, och ingen
 * lösenordsändring hjälper.
 *
 * Och det gäller SUPERADMIN-identiteten: den roll som kan impersonera in i vilken
 * organisation som helst.
 *
 * `totpEnabled` är en boolean och hör medvetet till svaret — admin-UI:t visar
 * 2FA-status. De två blandas inte ihop.
 *
 * Formen speglar `user-select.spec.ts` (#458), men partitionerar en SVARSTYP i
 * stället för en Prisma-select — eftersom det är där invarianten bor här.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { partitioneraKolumner } from '../../common/testing/column-partition'

const SERVICE = join(__dirname, 'platform-auth.service.ts')

function utanKommentarer(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/** Fälten `PlatformAuthUser` deklarerar, lästa ur källan. */
function svarstypensFält(): string[] {
  const src = utanKommentarer(readFileSync(SERVICE, 'utf8'))
  const start = src.indexOf('export interface PlatformAuthUser')
  if (start === -1) throw new Error('PlatformAuthUser hittades inte — har typen bytt namn?')
  const kropp = src.slice(start, src.indexOf('}', start))
  return [...kropp.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1] as string)
}

/**
 * Kolumner som MEDVETET utelämnas ur svarstypen, med skälet. Ett utelämnande ska
 * vara ett skrivet påstående någon kan ifrågasätta, inte en tyst frånvaro.
 */
const MEDVETET_UTELÄMNADE: Record<string, string> = {
  totpSecret:
    'TOTP-hemligheten. DIREKT ANVÄNDBAR — genererar giltiga koder omedelbart och ' +
    'för alltid, till skillnad från en hash som måste knäckas. Läcker den är ' +
    'andra faktorn borta för superadmin, och ingen lösenordsändring hjälper. ' +
    'Returneras EN gång vid registrering (generateTotpSetup), nygenererad, till ' +
    'användaren själv — aldrig läst ur databasen till ett svar.',
  passwordHash:
    'Lösenordshashen. Läses för bcrypt-jämförelsen i login och lämnar aldrig ' + 'servicen.',
  lastLoginAt:
    'Intern ops-uppgift. Ingen admin-vy läser den; skulle den behövas är det ett ' +
    'beslut att lägga till, inte en självklarhet.',
  createdAt: 'Intern record-timestamp utan klientanvändning.',
  updatedAt: 'Samma som createdAt.',
}

describe('PlatformAuthUser — superadminens svarstyp', () => {
  const fält = svarstypensFält()

  it('bär inte TOTP-hemligheten eller lösenordshashen', () => {
    // Uttrycklig negativ kontroll på de två som betyder mest. Faller på namnet,
    // inte på en form som kan tolkas om.
    expect(fält).not.toContain('totpSecret')
    expect(fält).not.toContain('passwordHash')
  })

  it('bär totpEnabled — statusen, inte hemligheten', () => {
    // Motsatt kontroll: booleanen SKA vara med, admin-UI:t visar 2FA-status.
    // Utan den här hade en överivrig städning av testet ovan tagit båda.
    expect(fält).toContain('totpEnabled')
  })

  it('varje kolumn på modellen är antingen i svarstypen eller medvetet utelämnad', () => {
    // Delad partition (#445-utbrytningen). Konfigurationen är DATA — modellnamn,
    // burna nycklar, undantagskarta, golv — aldrig ett predikat. Hjälparen har
    // egna negativkontroller i column-partition.spec.ts; de namngivna
    // kontrollerna ovan i den här filen är avsiktligt KVAR, så att en regression
    // i hjälparen blir röd här också och inte bara där.
    const r = partitioneraKolumner({
      modell: 'PlatformUser',
      burna: [fält],
      utelämnade: MEDVETET_UTELÄMNADE,
      golv: 8,
    })
    expect(r.oklassade).toEqual([])
    expect(r.föråldrade).toEqual([])
    expect(r.iBåda).toEqual([])
  })

  it('varje metod som returnerar en användare har en DEKLARERAD returtyp', () => {
    // Det är returtypen som bär skyddet här — inte en select, inte en mapper.
    // En metod utan deklarerad typ får inferrera, och då kan en rå rad slinka ut
    // utan att kompilatorn säger något.
    //
    // PARENTESMATCHNING, inte en lat regex. Första versionen använde
    // `async (\w+)\(([\s\S]*?)\)(\s*:\s*[^{]+)?\{` — och den lata
    // parametergruppen lät matchningen löpa FÖRBI metodkroppen och plocka upp
    // NÄSTA metods returtyp. Negativkontrollen avslöjade det: getProfile med
    // borttagen returtyp rapporterades som `Promise<PlatformTokenPair>`, vilket
    // är issueTokens signatur. Vakten var blind, inte röd — exakt den defektform
    // #434, #441, #444 och #453 handlar om, den här gången i vakten själv.
    const src = utanKommentarer(readFileSync(SERVICE, 'utf8'))
    const metoder: { namn: string; returtyp: string | null }[] = []

    for (const m of src.matchAll(/^ {2}(?:private )?async (\w+)\(/gm)) {
      const namn = m[1] as string
      // Balansera parentesen som öppnar parameterlistan.
      let i = (m.index as number) + m[0].length - 1
      let djup = 0
      for (; i < src.length; i++) {
        if (src[i] === '(') djup++
        else if (src[i] === ')') {
          djup--
          if (djup === 0) break
        }
      }
      // Mellan `)` och kroppens `{` står returtypen, om den finns.
      const kropp = src.indexOf('{', i)
      const mellan = src.slice(i + 1, kropp).trim()
      metoder.push({ namn, returtyp: mellan.startsWith(':') ? mellan : null })
    }

    // Golv: hittar parsern inga metoder har den slutat matcha koden.
    expect(metoder.length).toBeGreaterThanOrEqual(6)

    const utanReturtyp = metoder.filter((m) => m.returtyp === null).map((m) => m.namn)
    expect(utanReturtyp).toEqual([])
  })
})
