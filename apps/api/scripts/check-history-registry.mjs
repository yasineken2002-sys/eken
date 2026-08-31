#!/usr/bin/env node
/**
 * CI-vakt — HISTORIKREGISTRET ÄR FULLSTÄNDIGT.
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
 * R1  VARJE relation på `model Tenant` står antingen i `HISTORY_SOURCES` eller
 *     i `history-sources.ack.json`. En ny relation i schemat fäller bygget
 *     tills någon tar ställning till om den bär historik.
 * R2  Mängderna är DISJUNKTA. En relation som står i båda är ett beslut som
 *     motsäger sig självt.
 * R3  Ingen post pekar på en relation som inte finns. En kvittering som blivit
 *     kvar efter att fältet döpts om skyddar ingenting men ser ut att göra det.
 *
 * Regeln är på FORMEN — "varje relation på Tenant" — inte en uppräkning av
 * kända källor. En namnlista kan bara fälla det någon redan tänkt på.
 *
 * ── VARFÖR TVÅ SORTERS KANARIEFÅGLAR ────────────────────────────────────────
 *
 * REGELkanariefågeln prövar att regeln fäller på det den ska: en påhittad
 * relation som saknas i båda mängderna → RÖTT, registrerad → tyst.
 *
 * OMFÅNGSkanariefågeln prövar att mängden vakten läser inte är TOM. Det är
 * lärdomen av R5 i `check-action-tool-authorization.mjs`: regeln där fungerade,
 * men `otherFiles` defaultade till `[]`, så den prövade ingenting och var grön
 * för alltid. En vakt som mäter ingenting får inte vara grön. Går parsningen av
 * `model Tenant` sönder — ett omdöpt modellnamn, en ändrad schemaform — ska
 * DEN händelsen bli röd, inte tyst.
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

/** Skalära Prisma-typer. Allt annat med stor begynnelsebokstav är en modell/enum. */
const SKALÄRER = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes'])

/**
 * Relationsfälten på en modell — alltså fält vars typ är en annan MODELL.
 * Enums räknas inte: `type TenantType` är ingen relation.
 *
 * Exporterad så självtestet kör exakt samma kod som CI.
 */
export function relationerPåModell(schemaText, modellNamn) {
  const modeller = new Set([...schemaText.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]))
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

/** `relation: '…'` ur registret — läst som KOD, så en kommentar inte kan uppfylla regeln. */
export function registreradeRelationer(registryText) {
  // codeMask blankar stränginnehåll men BEHÅLLER längder och avgränsare, så en
  // träff i masken ligger på samma offset i råtexten. Därför söks positionen i
  // KODEN (en kommentar kan inte uppfylla regeln) medan NAMNET läses ur råtexten.
  //
  // Sökningen är fri från radposition med flit: en post skriven som ett inline-
  // objektliteral ska hittas lika säkert som en över flera rader. Ett mönster
  // förankrat i radstart hade tyst missat den formen — och en missad post ser
  // ut som en oregistrerad relation, vilket är rätt utfall men fel orsak.
  const kod = codeMask(registryText)
  const ut = []
  const re = /relation:\s*'/g
  let m
  while ((m = re.exec(kod)) !== null) {
    const namn = /^([A-Za-z0-9_]+)'/.exec(registryText.slice(m.index + m[0].length))
    if (namn) ut.push(namn[1])
  }
  return ut
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ schemaText, registryText, ackObjekt }) {
  const problem = []
  const { relationer, modellHittad } = relationerPåModell(schemaText, 'Tenant')

  // ── OMFÅNGSKANARIEFÅGELN ──────────────────────────────────────────────────
  // Mängden som prövas får aldrig vara tom. En vakt som mäter ingenting är
  // grön för alltid — det var precis R5:s defekt.
  if (!modellHittad) {
    problem.push({
      regel: 'OMFÅNG',
      detalj: '`model Tenant` hittades inte i schema.prisma. Skanningen har gått blind — INGA relationer prövades.',
    })
    return problem
  }
  if (relationer.length === 0) {
    problem.push({
      regel: 'OMFÅNG',
      detalj: 'NOLL relationer lästes ur `model Tenant`. Skanningen har gått blind; regeln nedan hade varit grön om allt.',
    })
    return problem
  }

  const registrerade = new Set(registreradeRelationer(registryText))
  const kvitterade = new Set(Object.keys(ackObjekt).filter((k) => k !== '__doc__'))
  const alla = new Set(relationer)

  // R1 — varje relation måste vara hanterad
  for (const rel of relationer) {
    const iReg = registrerade.has(rel)
    const iAck = kvitterade.has(rel)
    if (!iReg && !iAck) {
      problem.push({
        regel: 'R1',
        detalj: `Relationen \`Tenant.${rel}\` står varken i HISTORY_SOURCES eller i history-sources.ack.json. Producerar den historik? Registrera den. Gör den inte det? Kvittera den MED SKÄL.`,
      })
    }
    // R2 — disjunkta mängder
    if (iReg && iAck) {
      problem.push({
        regel: 'R2',
        detalj: `Relationen \`Tenant.${rel}\` står i BÅDA mängderna. Ett beslut kan inte vara både "bär historik" och "bär inte historik".`,
      })
    }
  }

  // R3 — inga poster som pekar på fält som inte finns
  for (const rel of registrerade) {
    if (!alla.has(rel)) {
      problem.push({
        regel: 'R3',
        detalj: `HISTORY_SOURCES pekar på \`Tenant.${rel}\` som inte finns i schemat. Omdöpt fält? Källan läser då inget.`,
      })
    }
  }
  for (const rel of kvitterade) {
    if (!alla.has(rel)) {
      problem.push({
        regel: 'R3',
        detalj: `history-sources.ack.json kvitterar \`Tenant.${rel}\` som inte finns i schemat. Kvitteringen skyddar inget men ser ut att göra det.`,
      })
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
model Organization { id String @id }
model Lease { id String @id }
model TenantSession { id String @id }
enum TenantType { PRIVATE COMPANY }
`
const REGISTRY_OK = `
const leases = { key: 'lease', relation: 'leases', table: 'Lease' }
export const HISTORY_SOURCES = [leases]
`
const ACK_OK = { __doc__: ['…'], organization: 'skäl', sessions: 'skäl' }

function selfTest() {
  let fel = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`  ${ok ? '✅' : '❌'} ${namn}${extra ? ` — ${extra}` : ''}`)
    if (!ok) fel++
  }

  // baslinje
  t('baslinje (allt hanterat) → 0 fynd',
    evaluate({ schemaText: SCHEMA_OK, registryText: REGISTRY_OK, ackObjekt: ACK_OK }).length === 0,
    JSON.stringify(evaluate({ schemaText: SCHEMA_OK, registryText: REGISTRY_OK, ackObjekt: ACK_OK })))

  // ── REGELKANARIEFÅGELN ───────────────────────────────────────────────────
  // En påhittad historikkälla som saknas i båda mängderna MÅSTE fälla.
  const schemaMedSond = SCHEMA_OK.replace(
    '  sessions       TenantSession[]',
    '  sessions       TenantSession[]\n  historikSondKalla SondKalla[]',
  ) + '\nmodel SondKalla { id String @id }\n'
  const r1 = evaluate({ schemaText: schemaMedSond, registryText: REGISTRY_OK, ackObjekt: ACK_OK })
  t('REGELKANARIE: oregistrerad relation → RÖTT',
    r1.length === 1 && r1[0].regel === 'R1', JSON.stringify(r1))

  // …och registrerad → tyst igen.
  const regMedSond = REGISTRY_OK.replace(
    "const leases = { key: 'lease', relation: 'leases', table: 'Lease' }",
    "const leases = { key: 'lease', relation: 'leases', table: 'Lease' }\nconst s = { key: 's', relation: 'historikSondKalla', table: 'SondKalla' }",
  )
  t('REGELKANARIE: samma relation registrerad → TYST',
    evaluate({ schemaText: schemaMedSond, registryText: regMedSond, ackObjekt: ACK_OK }).length === 0)

  // ── OMFÅNGSKANARIEFÅGELN ─────────────────────────────────────────────────
  // Mängden vakten prövar får inte vara tom. Två sätt den kan bli det:
  const r2 = evaluate({ schemaText: 'model Nagot { id String @id }', registryText: REGISTRY_OK, ackObjekt: ACK_OK })
  t('OMFÅNGSKANARIE: `model Tenant` saknas → RÖTT',
    r2.length === 1 && r2[0].regel === 'OMFÅNG', JSON.stringify(r2))

  const r3 = evaluate({ schemaText: 'model Tenant {\n  id String @id\n}', registryText: REGISTRY_OK, ackObjekt: ACK_OK })
  t('OMFÅNGSKANARIE: noll relationer lästa → RÖTT',
    r3.length === 1 && r3[0].regel === 'OMFÅNG', JSON.stringify(r3))

  // ── KOD, INTE KOMMENTAR ──────────────────────────────────────────────────
  // Ett relationsnamn som bara står i en kommentar får INTE räknas.
  const regKommentar = REGISTRY_OK + `\n// relation: 'historikSondKalla' — bara prosa, ska inte gälla\n`
  const r4 = evaluate({ schemaText: schemaMedSond, registryText: regKommentar, ackObjekt: ACK_OK })
  t('KOMMENTARKANARIE: namnet bara i en kommentar → fortfarande RÖTT',
    r4.length === 1 && r4[0].regel === 'R1', JSON.stringify(r4))

  // R2 + R3
  const r5 = evaluate({ schemaText: SCHEMA_OK, registryText: REGISTRY_OK, ackObjekt: { ...ACK_OK, leases: 'motsägelse' } })
  t('R2: relation i båda mängderna → RÖTT', r5.some((p) => p.regel === 'R2'), JSON.stringify(r5))

  const r6 = evaluate({ schemaText: SCHEMA_OK, registryText: REGISTRY_OK, ackObjekt: { ...ACK_OK, finnsInte: 'skäl' } })
  t('R3: kvittering av fält som inte finns → RÖTT', r6.some((p) => p.regel === 'R3'), JSON.stringify(r6))

  // ── DEN DELADE SKANNERNS EGNA KANARIEFÅGLAR ──────────────────────────────
  //
  // Vakten läser registret genom `codeMask` ur scripts/lib/source-scan.mjs.
  // Går den skannern sönder skulle den här vakten fortsätta rapportera grönt
  // på en felaktig mätning — den skulle inte veta om det. Genom att köra
  // skannerns egna kanariefåglar här blir VARJE konsument röd när den delade
  // mekanismen bryts, inte bara skannerns egen körning (#463).
  //
  // Kravet är dessutom mekaniskt: check-guard-preprocessors.mjs R2 fäller en
  // vakt som använder skannern utan att pröva den.
  for (const f of kanariefåglar()) {
    fel++
    console.error(`  ❌ delad källskanner: ${f}`)
  }

  if (fel > 0) {
    console.error(`\nSJÄLVTEST: ${fel} kontroll(er) FÖLL.\n`)
    process.exit(1)
  }
  console.warn(
    '\n✅ Självtest grönt — regel-, omfångs- och kommentarkanariefåglarna fäller alla,\n' +
      '   och den delade källskannerns egna kanariefåglar är gröna.\n',
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

  const { relationer } = relationerPåModell(schemaText, 'Tenant')
  const reg = registreradeRelationer(registryText).length
  const ack = Object.keys(ackObjekt).filter((k) => k !== '__doc__').length
  console.warn(
    `✅ ${relationer.length} relationer på Tenant, alla hanterade: ${reg} registrerade som historikkällor, ${ack} kvitterade med skäl.`,
  )
}

main()
