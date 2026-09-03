#!/usr/bin/env node
/**
 * CI-vakt — HISTORIKREGISTRET ÄR FULLSTÄNDIGT, i alla TRE dimensionerna.
 *
 * ── DEFEKTEN DEN FINNS FÖR ──────────────────────────────────────────────────
 *
 * Historiken SAMMANSTÄLLS vid läsning ur domäntabellerna (planens Del 8). Det
 * valet tar bort dubbelskrivningsrisken helt, men lämnar EN kvar: en domän som
 * producerar historik men som ingen kopplade in. Den luckan syns inte i
 * utdata — historiken ser komplett ut, bara kortare. Det är samma tysta form
 * som en dubbelskriven logg med en tappad händelse, och den är värre än en
 * historik man VET är tom.
 *
 * ── REGLERNA ────────────────────────────────────────────────────────────────
 *
 * För VAR OCH EN av modellerna Tenant, Unit och Property:
 *
 * R1  Varje relation på modellen står antingen i `HISTORY_SOURCES` (via
 *     `relations.tenant|unit|property`) eller i `history-sources.ack.json`
 *     under modellens nyckel. En ny relation i schemat fäller bygget tills
 *     någon tar ställning till om den bär historik.
 * R2  Mängderna är DISJUNKTA. En relation som står i båda är ett beslut som
 *     motsäger sig självt.
 * R3  Ingen post pekar på en relation som inte finns. En kvittering som blivit
 *     kvar efter att fältet döpts om skyddar ingenting men ser ut att göra det.
 *
 * Regeln är på FORMEN — "varje relation på modellen" — inte en uppräkning av
 * kända källor. En namnlista kan bara fälla det någon redan tänkt på.
 *
 * ── VARFÖR TVÅ SORTERS KANARIEFÅGLAR ────────────────────────────────────────
 *
 * REGELkanariefågeln prövar att regeln fäller på det den ska: en påhittad
 * relation som saknas i båda mängderna → RÖTT, registrerad → tyst.
 *
 * OMFÅNGSkanariefågeln prövar att mängden vakten läser inte är TOM — per
 * modell. Det är lärdomen av R5 i `check-action-tool-authorization.mjs`:
 * regeln där fungerade, men `otherFiles` defaultade till `[]`, så den prövade
 * ingenting och var grön för alltid. En vakt som mäter ingenting får inte vara
 * grön. Går parsningen av NÅGON av de tre modellerna sönder ska DEN händelsen
 * bli röd, inte tyst. Detsamma gäller ack-filen: en modellnyckel som saknas
 * där är ett tomt omfång, inte ett godkännande.
 *
 * En tredje kanariefågel prövar att registret läses som KOD: ett relationsnamn
 * som bara står i en KOMMENTAR får inte räknas som registrerat.
 *
 * Lokalt:    node apps/api/scripts/check-history-registry.mjs
 * Självtest: node apps/api/scripts/check-history-registry.mjs --self-test
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = join(HERE, '..', 'prisma', 'schema.prisma')
const REGISTRY = join(HERE, '..', 'src', 'history', 'history-sources.registry.ts')
const ACK = join(HERE, '..', 'src', 'history', 'history-sources.ack.json')

/** Modell ↔ dimensionsnyckel i registrets `relations`-objekt. */
const MODELLER = [
  { modell: 'Tenant', dimension: 'tenant' },
  { modell: 'Unit', dimension: 'unit' },
  { modell: 'Property', dimension: 'property' },
]

/** Skalära Prisma-typer. Allt annat med stor begynnelsebokstav är en modell/enum. */
const SKALÄRER = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes'])

/**
 * Relationsfälten på en modell — alltså fält vars typ är en annan MODELL.
 * Enums räknas inte: `type TenantType` är ingen relation.
 *
 * Exporterad så självtestet kör exakt samma kod som CI.
 */
export function relationerPåModell(schemaText, modellNamn) {
  const modeller = new Set([...schemaText.matchAll(/^model\s+([\p{L}\p{N}_$]+)\s*\{/gmu)].map((m) => m[1]))
  const m = new RegExp(`^model\\s+${modellNamn}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schemaText)
  if (!m) return { relationer: [], modellHittad: false }
  const relationer = []
  for (const rad of m[1].split('\n')) {
    const l = rad.trim()
    if (!l || l.startsWith('//') || l.startsWith('@@')) continue
    const delar = l.split(/\s+/)
    if (delar.length < 2) continue
    const [fält, råTyp] = delar
    const typ = råTyp.replace(/[[\]?]/g, '')
    if (SKALÄRER.has(typ)) continue
    if (!modeller.has(typ)) continue // enum eller okänt → inte en relation
    relationer.push(fält)
  }
  return { relationer, modellHittad: true }
}

/**
 * `tenant: '…'` / `unit: '…'` / `property: '…'` ur registrets `relations`-block
 * — läst som KOD, så en kommentar inte kan uppfylla regeln.
 *
 * codeMask blankar stränginnehåll men BEHÅLLER längder och avgränsare, så en
 * träff i masken ligger på samma offset i råtexten: positionen söks i KODEN,
 * namnet läses ur råtexten. Sökningen är fri från radposition med flit — en
 * post skriven som ett inline-objektliteral hittas lika säkert som en över
 * flera rader.
 */
export function registreradeRelationer(registryText) {
  const kod = codeMask(registryText)
  const ut = { tenant: [], unit: [], property: [] }
  const re = /\b(tenant|unit|property):\s*'/g
  let m
  while ((m = re.exec(kod)) !== null) {
    const namn = /^([A-Za-z0-9_]+)'/.exec(registryText.slice(m.index + m[0].length))
    if (namn) ut[m[1]].push(namn[1])
  }
  return ut
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ schemaText, registryText, ackObjekt }) {
  const problem = []
  const registrerade = registreradeRelationer(registryText)

  for (const { modell, dimension } of MODELLER) {
    const { relationer, modellHittad } = relationerPåModell(schemaText, modell)

    // ── OMFÅNGSKANARIEFÅGLARNA ─────────────────────────────────────────────
    // Mängden som prövas får aldrig vara tom — per modell, och även ack-filens
    // modellnyckel. En vakt som mäter ingenting är grön för alltid (R5-lärdomen).
    if (!modellHittad) {
      problem.push({
        regel: 'OMFÅNG',
        detalj: `\`model ${modell}\` hittades inte i schema.prisma. Skanningen har gått blind — INGA relationer prövades för den modellen.`,
      })
      continue
    }
    if (relationer.length === 0) {
      problem.push({
        regel: 'OMFÅNG',
        detalj: `NOLL relationer lästes ur \`model ${modell}\`. Skanningen har gått blind; reglerna nedan hade varit gröna om allt.`,
      })
      continue
    }
    const ackFörModell = ackObjekt[modell]
    if (ackFörModell === undefined || typeof ackFörModell !== 'object') {
      problem.push({
        regel: 'OMFÅNG',
        detalj: `history-sources.ack.json saknar nyckeln "${modell}". Ett saknat omfång är inte ett godkännande — lägg till modellblocket, även om det är tomt.`,
      })
      continue
    }

    const iRegistret = new Set(registrerade[dimension])
    const kvitterade = new Set(Object.keys(ackFörModell))
    const alla = new Set(relationer)

    for (const rel of relationer) {
      const iReg = iRegistret.has(rel)
      const iAck = kvitterade.has(rel)
      // R1 — varje relation måste vara hanterad
      if (!iReg && !iAck) {
        problem.push({
          regel: 'R1',
          detalj: `Relationen \`${modell}.${rel}\` står varken i HISTORY_SOURCES (relations.${dimension}) eller i history-sources.ack.json under "${modell}". Producerar den historik? Registrera den. Gör den inte det? Kvittera den MED SKÄL.`,
        })
      }
      // R2 — disjunkta mängder
      if (iReg && iAck) {
        problem.push({
          regel: 'R2',
          detalj: `Relationen \`${modell}.${rel}\` står i BÅDA mängderna. Ett beslut kan inte vara både "bär historik" och "bär inte historik".`,
        })
      }
    }

    // R3 — inga poster som pekar på fält som inte finns
    for (const rel of iRegistret) {
      if (!alla.has(rel)) {
        problem.push({
          regel: 'R3',
          detalj: `HISTORY_SOURCES (relations.${dimension}) pekar på \`${modell}.${rel}\` som inte finns i schemat. Omdöpt fält? Källan läser då inget.`,
        })
      }
    }
    for (const rel of kvitterade) {
      if (!alla.has(rel)) {
        problem.push({
          regel: 'R3',
          detalj: `history-sources.ack.json kvitterar \`${modell}.${rel}\` som inte finns i schemat. Kvitteringen skyddar inget men ser ut att göra det.`,
        })
      }
    }
  }

  return problem
}

// ── självtest ────────────────────────────────────────────────────────────────

const SCHEMA_OK = `
model Tenant {
  id             String  @id
  type           TenantType
  organization   Organization @relation(fields: [organizationId], references: [id])
  leases         Lease[]
  sessions       TenantSession[]
}
model Unit {
  id       String @id
  property Property @relation(fields: [propertyId], references: [id])
  leases   Lease[]
}
model Property {
  id           String @id
  organization Organization @relation(fields: [organizationId], references: [id])
  units        Unit[]
}
model Organization { id String @id }
model Lease { id String @id }
model TenantSession { id String @id }
enum TenantType { PRIVATE COMPANY }
`
const REGISTRY_OK = `
const leases = { key: 'lease', relations: { tenant: 'leases', unit: 'leases' }, table: 'Lease' }
export const HISTORY_SOURCES = [leases]
`
const ACK_OK = {
  __doc__: ['…'],
  Tenant: { organization: 'skäl', sessions: 'skäl' },
  Unit: { property: 'skäl' },
  Property: { organization: 'skäl', units: 'skäl' },
}

function selfTest() {
  let fel = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`  ${ok ? '✅' : '❌'} ${namn}${extra ? ` — ${extra}` : ''}`)
    if (!ok) fel++
  }
  const kör = (över = {}) =>
    evaluate({ schemaText: SCHEMA_OK, registryText: REGISTRY_OK, ackObjekt: ACK_OK, ...över })

  t('baslinje (alla tre modellerna hanterade) → 0 fynd', kör().length === 0, JSON.stringify(kör()))

  // ── REGELKANARIEFÅGELN — på en OBJEKTMODELL, inte bara Tenant ────────────
  const schemaMedSond = SCHEMA_OK.replace(
    '  leases   Lease[]\n}',
    '  leases   Lease[]\n  historikSondKalla SondKalla[]\n}',
  ) + '\nmodel SondKalla { id String @id }\n'
  const r1 = kör({ schemaText: schemaMedSond })
  t('REGELKANARIE: oregistrerad relation på Unit → RÖTT',
    r1.length === 1 && r1[0].regel === 'R1' && r1[0].detalj.includes('Unit.historikSondKalla'),
    JSON.stringify(r1))

  const regMedSond = REGISTRY_OK.replace(
    "relations: { tenant: 'leases', unit: 'leases' }",
    "relations: { tenant: 'leases', unit: 'leases' }, extra: { unit: 'historikSondKalla' }",
  ).replace('export const HISTORY_SOURCES = [leases]',
    "const sond = { key: 's', relations: { unit: 'historikSondKalla' }, table: 'SondKalla' }\nexport const HISTORY_SOURCES = [leases, sond]")
  t('REGELKANARIE: samma relation registrerad → TYST',
    kör({ schemaText: schemaMedSond, registryText: regMedSond }).length === 0,
    JSON.stringify(kör({ schemaText: schemaMedSond, registryText: regMedSond })))

  // ── OMFÅNGSKANARIEFÅGLARNA — alla tre sätten en mängd kan bli tom ────────
  const utanUnit = SCHEMA_OK.replace(/model Unit \{[\s\S]*?\n\}/, 'model UnitX { id String @id }')
  const r2 = kör({ schemaText: utanUnit })
  t('OMFÅNGSKANARIE: `model Unit` saknas → RÖTT',
    r2.some((p) => p.regel === 'OMFÅNG' && p.detalj.includes('model Unit')), JSON.stringify(r2))

  const tomUnit = SCHEMA_OK.replace(/model Unit \{[\s\S]*?\n\}/, 'model Unit {\n  id String @id\n}')
  const r3 = kör({ schemaText: tomUnit })
  t('OMFÅNGSKANARIE: noll relationer på Unit → RÖTT',
    r3.some((p) => p.regel === 'OMFÅNG' && p.detalj.includes('model Unit')), JSON.stringify(r3))

  const ackUtanUnit = { ...ACK_OK }
  delete ackUtanUnit.Unit
  const r4 = kör({ ackObjekt: ackUtanUnit })
  t('OMFÅNGSKANARIE: ack-filen saknar modellnyckeln → RÖTT',
    r4.some((p) => p.regel === 'OMFÅNG' && p.detalj.includes('"Unit"')), JSON.stringify(r4))

  // ── KOD, INTE KOMMENTAR ──────────────────────────────────────────────────
  const regKommentar = REGISTRY_OK + `\n// unit: 'historikSondKalla' — bara prosa, ska inte gälla\n`
  const r5 = kör({ schemaText: schemaMedSond, registryText: regKommentar })
  t('KOMMENTARKANARIE: namnet bara i en kommentar → fortfarande RÖTT',
    r5.length === 1 && r5[0].regel === 'R1', JSON.stringify(r5))

  // R2 + R3
  const r6 = kör({ ackObjekt: { ...ACK_OK, Unit: { property: 'skäl', leases: 'motsägelse' } } })
  t('R2: relation i båda mängderna → RÖTT', r6.some((p) => p.regel === 'R2'), JSON.stringify(r6))

  const r7 = kör({ ackObjekt: { ...ACK_OK, Property: { organization: 'skäl', units: 'skäl', finnsInte: 'skäl' } } })
  t('R3: kvittering av fält som inte finns → RÖTT', r7.some((p) => p.regel === 'R3'), JSON.stringify(r7))

  // ── DEN DELADE SKANNERNS EGNA KANARIEFÅGLAR ──────────────────────────────
  // Vakten läser registret genom `codeMask`. Går skannern sönder blir VARJE
  // konsument röd, inte bara skannerns egen körning (#463). Kravet är dessutom
  // mekaniskt: check-guard-preprocessors.mjs R2 fäller en vakt som använder
  // skannern utan att pröva den.
  for (const f of kanariefåglar()) {
    fel++
    console.error(`  ❌ delad källskanner: ${f}`)
  }


  // ── #668: IDENTIFIERARE ÄR UNICODE, INTE \w ─────────────────────────────
  //
  // `\w` är ASCII i JavaScript. Härledningen ovan missade varje namn med å, ä
  // eller ö — och utfallet var TYSTNAD: objektet hamnade aldrig i mängden och
  // vakten förblev grön om något den aldrig sett.
  //
  // BÅDA FELFORMERNA prövas, inte bara den positiva:
  //   MISSAD  svensk INITIAL → posten hittas inte alls (sänker antalet)
  //   KAPAD   svensk bokstav MITT i namnet → ASCII-svansen matchar, posten
  //           hittas med FEL namn (antalet är OFÖRÄNDRAT, så ett tal döljer det)
  // Plus delsträngs-motprovet: hela namnet ska fångas, inte en svans.
  {
    const schema = `model Ärende {\n  id String\n}\n\nmodel Förvaltning {\n  id String\n  arende Ärende @relation(fields: [x], references: [id])\n}\n`
    const r1 = relationerPåModell(schema, 'Ärende')
    t('#668 MISSAD: modell med svensk INITIAL hittas', r1.modellHittad, JSON.stringify(r1))
    const r2 = relationerPåModell(schema, 'Förvaltning')
    t('#668 KAPAD: hela namnet fångas, inte ASCII-svansen', r2.modellHittad, JSON.stringify(r2))
  }

  if (fel > 0) {
    console.error(`\nSJÄLVTEST: ${fel} kontroll(er) FÖLL.\n`)
    process.exit(1)
  }
  console.warn(
    '\n✅ Självtest grönt — regel-, omfångs- och kommentarkanariefåglarna fäller alla,\n' +
      '   i alla tre dimensionerna, och den delade källskannerns kanariefåglar är gröna.\n',
  )
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest()

  const schemaText = readFileSync(SCHEMA, 'utf8')
  const registryText = readFileSync(REGISTRY, 'utf8')
  const ackObjekt = JSON.parse(readFileSync(ACK, 'utf8'))
  const problem = evaluate({ schemaText, registryText, ackObjekt })

  if (problem.length > 0) {
    console.error('\n=== HISTORIKREGISTRET ÄR OFULLSTÄNDIGT (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.regel}\n   ${p.detalj}\n`)
    console.error(
      'Historiken sammanställs ur domäntabellerna. En domän som inte står i\n' +
        'registret syns aldrig — historiken ser komplett ut, bara kortare.\n' +
        'Se apps/api/src/history/history-sources.registry.ts\n',
    )
    process.exit(1)
  }

  const registrerade = registreradeRelationer(registryText)
  const rader = MODELLER.map(({ modell, dimension }) => {
    const { relationer } = relationerPåModell(schemaText, modell)
    const ack = Object.keys(ackObjekt[modell] ?? {}).length
    return `${modell}: ${relationer.length} relationer (${new Set(registrerade[dimension]).size} registrerade, ${ack} kvitterade)`
  })
  console.warn(`✅ Alla relationer hanterade i tre dimensioner — ${rader.join(' · ')}.`)
}

main()
