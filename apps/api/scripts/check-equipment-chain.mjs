#!/usr/bin/env node
/**
 * CI-vakt — UTRUSTNINGENS BYTESKEDJA ÄR EN KEDJA, INTE EN GRAF.
 *
 * ── VARFÖR DEN HÖR TILL BYGGET OCH INTE TILL EN SENARE STÄDNING ────────────
 *
 * `UnitEquipment.replacedById` är en självreferens. Två fel är möjliga:
 *
 *   FÖRGRENING  två föregångare pekar på samma efterträdare
 *   CYKEL       A → B → A (eller längre)
 *
 * Förgreningen spärras av `@unique` på `replacedById` — databasen avvisar den
 * andra raden. Cykeln kan en unik-constraint INTE hindra: varje rad har exakt
 * en föregångare och en efterträdare, vilket är precis vad en cykel också har.
 *
 * Och en cykel går inte sönder högljutt. Historiken skulle svara
 * EQUIPMENT_REPLACED för varje länk och se rimlig ut; en läsare som följer
 * kedjan bakåt hamnar i en oändlig slinga. Det är samma familj som de tysta
 * defekterna i det här projektet: fel utfall, inget fel.
 *
 * ── VAD VAKTEN FAKTISKT GÖR, OCH VAD DEN INTE GÖR ──────────────────────────
 *
 * Den är STATISK. Den kan bara pröva att spärrarna STÅR i schemat:
 *
 *   R1  `replacedById` bär `@unique` — annars är förgrening möjlig i DB.
 *   R2  självrelationen har ett namngivet `@relation` med båda sidorna, så
 *       riktningen är entydig.
 *
 * Att kedjan FAKTISKT är cykelfri i en levande databas ägs av
 * `unit-equipment.db.spec.ts`, som bygger en cykel mot riktig Postgres och
 * kräver att `assertNoEquipmentCycle` fäller. Att något står i ett schema är
 * inte samma sak som att det gäller — samma gräns som check-append-only.mjs
 * skriver ut om sig själv.
 *
 * Lokalt:    node apps/api/scripts/check-equipment-chain.mjs
 * Självtest: node apps/api/scripts/check-equipment-chain.mjs --self-test
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = join(HERE, '..', 'prisma', 'schema.prisma')

const MODELL = 'UnitEquipment'
const FÄLT = 'replacedById'
const RELATION = 'EquipmentReplacement'

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate(schemaText) {
  const problem = []
  const m = new RegExp(`^model\\s+${MODELL}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schemaText)

  // OMFÅNGSKANARIEFÅGELN: en vakt vars mängd är tom är grön för alltid.
  if (!m) {
    problem.push({
      regel: 'OMFÅNG',
      detalj: `\`model ${MODELL}\` hittades inte i schema.prisma. Skanningen har gått blind — INGA regler prövades.`,
    })
    return problem
  }
  const kropp = m[1]

  const fältrad = kropp.split('\n').find((r) => new RegExp(`^\\s*${FÄLT}\\s`).test(r))
  if (!fältrad) {
    problem.push({
      regel: 'OMFÅNG',
      detalj: `Fältet \`${MODELL}.${FÄLT}\` hittades inte. Antingen är bytesföljden borttagen — då ska den här vakten också bort — eller så har fältet döpts om och vakten mäter ingenting.`,
    })
    return problem
  }

  // R1 — förgreningsspärren
  if (!/@unique/.test(fältrad)) {
    problem.push({
      regel: 'R1',
      detalj: `\`${MODELL}.${FÄLT}\` saknar @unique. Utan den kan TVÅ föregångare peka på samma efterträdare, och en förgrenad graf är ingen bytesföljd. Databasen är enda stället som kan hindra det.`,
    })
  }

  // R2 — entydig riktning
  const nRel = (kropp.match(new RegExp(`@relation\\("${RELATION}"`, 'g')) ?? []).length
  if (nRel !== 2) {
    problem.push({
      regel: 'R2',
      detalj: `Självrelationen "${RELATION}" har ${nRel} sida(or), förväntat 2 (föregångare + efterträdare). Utan båda sidorna namngivna är riktningen inte entydig, och Prisma kan inte skilja "ersatte" från "ersattes av".`,
    })
  }

  return problem
}

// ── självtest ────────────────────────────────────────────────────────────────

const OK = `
model UnitEquipment {
  id           String @id
  replacedById String? @unique
  replacedBy UnitEquipment? @relation("EquipmentReplacement", fields: [replacedById], references: [id])
  replaces   UnitEquipment? @relation("EquipmentReplacement")
}
`

function selfTest() {
  let fel = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`  ${ok ? '✅' : '❌'} ${namn}${extra ? ` — ${extra}` : ''}`)
    if (!ok) fel++
  }

  t('baslinje → 0 fynd', evaluate(OK).length === 0, JSON.stringify(evaluate(OK)))

  const utanUnique = OK.replace('replacedById String? @unique', 'replacedById String?')
  const r1 = evaluate(utanUnique)
  t('R1: @unique borttagen → RÖTT', r1.length === 1 && r1[0].regel === 'R1', JSON.stringify(r1))

  const enSida = OK.replace('  replaces   UnitEquipment? @relation("EquipmentReplacement")\n', '')
  const r2 = evaluate(enSida)
  t('R2: bara en sida av självrelationen → RÖTT', r2.some((p) => p.regel === 'R2'), JSON.stringify(r2))

  const r3 = evaluate('model Nagot { id String @id }')
  t('OMFÅNG: modellen saknas → RÖTT', r3.length === 1 && r3[0].regel === 'OMFÅNG', JSON.stringify(r3))

  const utanFält = OK.replace(/  replacedById String\? @unique\n/, '')
  const r4 = evaluate(utanFält)
  t('OMFÅNG: fältet saknas → RÖTT', r4.some((p) => p.regel === 'OMFÅNG'), JSON.stringify(r4))

  for (const f of kanariefåglar()) {
    fel++
    console.error(`  ❌ delad källskanner: ${f}`)
  }

  if (fel > 0) {
    console.error(`\nSJÄLVTEST: ${fel} kontroll(er) FÖLL.\n`)
    process.exit(1)
  }
  console.warn('\n✅ Självtest grönt — regel- och omfångskanariefåglarna fäller alla.\n')
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest()
  const problem = evaluate(readFileSync(SCHEMA, 'utf8'))
  if (problem.length > 0) {
    console.error('\n=== BYTESFÖLJDEN KAN FÖRGRENA SIG (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.regel}\n   ${p.detalj}\n`)
    console.error(
      'En förgrenad eller cyklisk kedja går inte sönder högljutt — historiken\n' +
        'ser rimlig ut och en läsare som följer den bakåt slutar aldrig.\n',
    )
    process.exit(1)
  }
  console.warn(`✅ Bytesföljden: ${MODELL}.${FÄLT} är @unique och självrelationen "${RELATION}" har båda sidorna.`)
}

main()
