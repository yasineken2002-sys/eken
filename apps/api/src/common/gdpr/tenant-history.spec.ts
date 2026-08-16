/**
 * Håller `TENANT_HISTORY_RELATIONS` mot schemat.
 *
 * Listan är en uppräkning som ska spegla `schema.prisma`. Den sortens vakt är
 * precis den som slutar mäta utan att sluta vara grön: lägger någon till en
 * tolfte modell med FK mot `Tenant` börjar 500-felet om — tyst, och bara för
 * hyresgäster som råkar ha just den sortens historik.
 *
 * Därför läses schemat här, och därför finns en kanariefågel: en påhittad
 * relation matas in i parsern och kontrollen MÅSTE falla. Utan den beviset kan
 * parsern sluta hitta något alls och testet vore grönt för alltid.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TENANT_HISTORY_RELATIONS } from './tenant-history'

const SCHEMA_PATH = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma')

interface ParsedRelation {
  model: string
  column: string
  onDelete: string
}

/**
 * Plockar ut varje relationsfält som pekar på `Tenant`, med dess `onDelete`.
 *
 * Prismas default när `onDelete` saknas på ett OBLIGATORISKT fält är `Restrict`;
 * på ett valfritt fält är den `SetNull` i SQL — men Prisma sätter den bara när
 * den skrivs ut explicit, och de valfria fälten utan `onDelete` i det här
 * schemat har genererats som `ON DELETE RESTRICT`. Vi läser därför "saknas" som
 * Restrict och verifierar antagandet mot den faktiska migrationen nedan.
 */
function parseTenantRelations(schema: string): ParsedRelation[] {
  const out: ParsedRelation[] = []
  let model = ''
  for (const line of schema.split('\n')) {
    const m = /^model\s+(\w+)\s*\{/.exec(line)
    if (m) model = m[1]!
    if (!line.includes('references: [id]')) continue
    if (!/\bTenant\b/.test(line.split('@relation')[0] ?? '')) continue
    const fields = /fields:\s*\[(\w+)\]/.exec(line)
    if (!fields) continue
    const od = /onDelete:\s*(\w+)/.exec(line)
    out.push({ model, column: fields[1]!, onDelete: od ? od[1]! : 'Restrict' })
  }
  return out
}

const schema = readFileSync(SCHEMA_PATH, 'utf8')

describe('TENANT_HISTORY_RELATIONS speglar schemat', () => {
  it('parsern hittar överhuvudtaget relationer (annars mäter resten ingenting)', () => {
    const all = parseTenantRelations(schema)
    expect(all.length).toBeGreaterThan(10)
    expect(all.map((r) => r.model)).toContain('Lease')
  })

  it('listan är EXAKT schemats Restrict-relationer — inte en delmängd', () => {
    const restrict = parseTenantRelations(schema)
      .filter((r) => r.onDelete === 'Restrict')
      .map((r) => `${r.model}.${r.column}`)
      .sort()

    const listed = TENANT_HISTORY_RELATIONS.map((r) => `${r.model}.${r.column}`).sort()

    // toEqual, inte "innehåller": en ny modell som saknas i listan ska falla,
    // och en modell i listan som inte längre finns i schemat likaså.
    expect(listed).toEqual(restrict)
  })

  it('relationer som INTE blockerar hör inte hemma i listan', () => {
    const nonBlocking = parseTenantRelations(schema)
      .filter((r) => r.onDelete !== 'Restrict')
      .map((r) => r.model)

    // Cascade/SetNull städas av databasen och hindrar ingen radering.
    expect(nonBlocking).toContain('TenantSession')
    for (const model of nonBlocking) {
      const alsoBlocking = parseTenantRelations(schema).some(
        (r) => r.model === model && r.onDelete === 'Restrict',
      )
      if (!alsoBlocking) {
        expect(TENANT_HISTORY_RELATIONS.map((r) => r.model)).not.toContain(model)
      }
    }
  })
})

describe('KANARIEFÅGEL — kontrollen faller när schemat får en ny blockerande relation', () => {
  it('en påhittad Restrict-relation mot Tenant gör listan ofullständig', () => {
    // Sonden heter något som bevisligen inte finns i schemat.
    expect(schema).not.toContain('GdprCanaryProbe')

    const injected =
      schema +
      '\nmodel GdprCanaryProbe {\n' +
      '  id       String @id @default(uuid())\n' +
      '  tenantId String\n' +
      '  tenant   Tenant @relation(fields: [tenantId], references: [id])\n' +
      '}\n'

    const restrict = parseTenantRelations(injected)
      .filter((r) => r.onDelete === 'Restrict')
      .map((r) => `${r.model}.${r.column}`)
      .sort()
    const listed = TENANT_HISTORY_RELATIONS.map((r) => `${r.model}.${r.column}`).sort()

    // Det här är hela poängen: samma jämförelse som testet ovan, men med en ny
    // modell i schemat — och den MÅSTE nu skilja sig.
    expect(listed).not.toEqual(restrict)
    expect(restrict).toContain('GdprCanaryProbe.tenantId')
  })
})

describe('migrationen bekräftar att "saknas onDelete" verkligen blev RESTRICT', () => {
  it('Lease_tenantId_fkey är ON DELETE RESTRICT i SQL', () => {
    // Antagandet i parsern läses inte ur Prismas dokumentation utan ur den
    // faktiska SQL som kördes — samma villkor som gav 500-felet i produktion.
    const migrations = join(__dirname, '..', '..', '..', 'prisma', 'migrations')
    const hit = execSync(
      `grep -rh "Lease_tenantId_fkey" ${migrations} | grep -i "ON DELETE" | tail -1`,
      { encoding: 'utf8' },
    ).trim()
    expect(hit).toMatch(/ON DELETE RESTRICT/i)
  })
})
