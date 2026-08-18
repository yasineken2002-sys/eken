/**
 * VAKT: raderingsordningen får inte växa ifrån schemat.
 *
 * `delete-organization.ts` räknar upp de tabeller som måste raderas explicit.
 * En uppräkning kan bara krympa tyst — läggs en ny tabell med `organizationId`
 * till i schemat, och den varken kaskaderar eller står i listan, så upptäcks
 * det först när någon kör skriptet mot en org som råkar ha en rad där.
 *
 * Vakten läser SCHEMAT, inte den genererade klienten: en ny modell ska fälla
 * det här testet direkt, utan `prisma generate` emellan.
 *
 * Kanariefågeln längst ned är hela skälet att vakten går att lita på — den
 * matar in en modell som MÅSTE rapporteras som otäckt och kräver att den blir
 * det. Utan den kan parsern sluta hitta modeller och testet förbli grönt.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { DELETION_STEPS, clientKey, assertDevDatabase } from './delete-organization'

const SCHEMA = join(__dirname, '..', '..', 'prisma', 'schema.prisma')

type Model = { name: string; hasOrgId: boolean; cascadesFromOrg: boolean }

/** Plockar ut modellerna och hur var och en förhåller sig till Organization. */
export function parseModels(schema: string): Model[] {
  return [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => {
    const name = m[1] ?? ''
    const body = m[2] ?? ''
    return {
      name,
      hasOrgId: /^\s*organizationId\s+\S/m.test(body),
      // Kaskad räknas bara om relationsfältet PEKAR på Organization och säger Cascade.
      cascadesFromOrg: body
        .split('\n')
        .some((l) => /\s(Organization)(\?|\[\])?\s/.test(l) && /onDelete:\s*Cascade/.test(l)),
    }
  })
}

/** Modeller som varken faller via kaskad eller hanteras av skriptet. */
export function uncovered(models: Model[], handled: ReadonlySet<string>): string[] {
  return models
    .filter(
      (m) => m.hasOrgId && m.name !== 'Organization' && !m.cascadesFromOrg && !handled.has(m.name),
    )
    .map((m) => m.name)
    .sort()
}

describe('raderingsordningen för en organisation', () => {
  const schema = readFileSync(SCHEMA, 'utf8')
  const models = parseModels(schema)
  const handled = new Set(DELETION_STEPS.map((s) => s.model))

  it('parsern hittar faktiskt modeller i schemat', () => {
    // Utan den här raden kan alla påståenden nedan vara tomma och gröna.
    expect(models.length).toBeGreaterThan(50)
    expect(models.some((m) => m.name === 'Organization')).toBe(true)
    expect(models.filter((m) => m.hasOrgId).length).toBeGreaterThan(40)
    expect(models.some((m) => m.cascadesFromOrg)).toBe(true)
  })

  it('varje tabell med organizationId faller via kaskad eller står i skriptet', () => {
    expect(uncovered(models, handled)).toEqual([])
  })

  it('varje steg i skriptet motsvarar en modell som finns i schemat', () => {
    const names = new Set(models.map((m) => m.name))
    expect(DELETION_STEPS.map((s) => s.model).filter((m) => !names.has(m))).toEqual([])
  })

  it('inget steg står två gånger', () => {
    expect(DELETION_STEPS.length).toBe(handled.size)
  })

  // Kanariefåglarna mäter SKILLNADEN injektionen gör, inte hela schemats
  // renhet. Skrivna som `toEqual([...])` mot hela mängden hade de blivit röda
  // av någon ANNANS otäckta tabell — alltså av rätt fel men fel orsak, och
  // signalen "mekanismen fungerar" hade druknat i den. Uppmätt: en injicerad
  // otäckt modell i schemat gjorde tre tester röda i stället för ett.
  const baseline = uncovered(models, handled)
  const injected = (fejk: string): string[] =>
    uncovered(parseModels(schema + '\n' + fejk), handled).filter((n) => !baseline.includes(n))

  it('KANARIEFÅGEL: en ny otäckt tabell rapporteras som otäckt', () => {
    // Matas in i parsern, inte i schemat — kravet är att mekanismen ger utslag.
    const fejk = `model KanariefagelOtackt {\n  id String @id\n  organizationId String\n}\n`
    expect(parseModels(schema + '\n' + fejk).some((m) => m.name === 'KanariefagelOtackt')).toBe(
      true,
    )
    expect(injected(fejk)).toEqual(['KanariefagelOtackt'])
  })

  it('KANARIEFÅGEL: en ny tabell som kaskaderar rapporteras INTE som otäckt', () => {
    // Andra halvan: vakten får inte vara röd för allt nytt, bara för det otäckta.
    const fejk =
      `model KanariefagelKaskad {\n  id String @id\n  organizationId String\n` +
      `  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)\n}\n`
    expect(injected(fejk)).toEqual([])
  })
})

describe('säkerhetsgrinden', () => {
  it('släpper igenom localhost/eken_dev', () => {
    expect(assertDevDatabase('postgresql://eken:eken@localhost:5432/eken_dev', false)).toEqual({
      host: 'localhost',
      database: 'eken_dev',
    })
  })

  it('vägrar allt annat utan --allow-non-dev', () => {
    expect(() =>
      assertDevDatabase('postgresql://u:p@db.railway.internal:5432/railway', false),
    ).toThrow(/Vägrar köra mot db\.railway\.internal\/railway/)
    // Rätt databasnamn på fel värd räcker inte.
    expect(() => assertDevDatabase('postgresql://u:p@prod.example:5432/eken_dev', false)).toThrow(
      /Vägrar/,
    )
  })

  it('släpper igenom med --allow-non-dev', () => {
    expect(assertDevDatabase('postgresql://u:p@prod.example:5432/eken_prod', true).database).toBe(
      'eken_prod',
    )
  })

  it('kastar på saknad eller otolkbar URL', () => {
    expect(() => assertDevDatabase(undefined, true)).toThrow(/DATABASE_URL saknas/)
    expect(() => assertDevDatabase('inte-en-url', true)).toThrow(/DATABASE_URL saknas/)
  })
})

describe('clientKey', () => {
  it('mappar modellnamn till Prisma-klientens egenskap', () => {
    expect(clientKey('JournalEntryLine')).toBe('journalEntryLine')
    expect(clientKey('Account')).toBe('account')
  })
})
