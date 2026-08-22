#!/usr/bin/env node
/**
 * CI-guard — INGA hoppade tester. Noll, inte ett underhållet tal.
 *
 * ── VAD DEN SKYDDAR MOT ──────────────────────────────────────────────────────
 *
 * En hoppad svit är GRÖN. En kanariefågel inuti en hoppad svit kan inte falla.
 * Det var inte en farhåga utan uppmätt: CI-körningen på main före #564 skrev
 *
 *     Test Suites: 1 skipped, 319 passed, 319 of 320 total
 *     Tests:       13 skipped, 3311 passed, 3324 total
 *
 * och var grön. `ai-effect-extension.spec.ts` — en spec som prövar en
 * Prisma-extension mot en RIKTIG databas — kördes aldrig, eftersom test-jobbet
 * saknade `DATABASE_URL`. Siffran STOD i loggen. Ingen läste den.
 *
 * En siffra som skrivs ut men aldrig prövas är samma sak som ingen siffra.
 *
 * ── VARFÖR NOLL OCH INTE ETT TAL ─────────────────────────────────────────────
 *
 * `E2E_EXPECTED_TESTS` är ett TAL därför att dess rätta värde legitimt är skilt
 * från noll — tre bevisriggar och en R2-beroende spec är medvetet uteslutna.
 *
 * Här är rätt värde noll, mätt. Ett underhållet tal driftar då uppåt en rad i
 * taget: någon hoppar över ett test, CI blir röd, talet höjs, och kontrollen
 * mäter till slut inte det den skulle mäta. En hård nolla kostar ingenting att
 * underhålla så länge svaret är noll — och den dag någon VILL hoppa över ett
 * test ska det kräva ett aktivt beslut här, inte en höjd siffra i förbifarten.
 *
 * ── FAIL-CLOSED ──────────────────────────────────────────────────────────────
 *
 * Saknas filen, går den inte att tolka, eller saknas fälten — RÖD, inte grön.
 * Samma hållning som E2E:s formatkontroll: en kontroll som inte kan läsa sitt
 * eget mätvärde vet ingenting, och att tiga då vore att låta ett trasigt
 * mätinstrument passera som ett godkänt resultat.
 *
 * Lokalt:      node apps/api/scripts/check-no-skipped-tests.mjs <jest-json>
 * Självtest:   node apps/api/scripts/check-no-skipped-tests.mjs --self-test
 */
import { readFileSync } from 'node:fs'

/**
 * Fälten Jest rapporterar och som betyder "kördes inte".
 *
 * `numPendingTests` täcker `it.skip`, `describe.skip` och villkorlig
 * överhoppning; `numTodoTests` täcker `it.todo`. Båda krävs — utan `todo`
 * täcker nollan bara halva mekanismen, och `it.todo` är den enklaste vägen att
 * parkera ett test utan att någon märker det.
 */
export const SKIP_FIELDS = ['numPendingTests', 'numTodoTests']

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate(rå) {
  if (rå === null || rå === undefined) {
    return { ok: false, rule: 'jest-rapporten saknas', detail: 'Kunde inte läsa filen — mätvärdet finns inte.' }
  }
  let d
  try {
    d = typeof rå === 'string' ? JSON.parse(rå) : rå
  } catch (err) {
    return {
      ok: false,
      rule: 'jest-rapporten går inte att tolka som JSON',
      detail: `${err instanceof Error ? err.message : String(err)} — mätvärdet är oläsligt.`,
    }
  }
  if (typeof d !== 'object' || d === null) {
    return { ok: false, rule: 'jest-rapporten är inte ett objekt', detail: 'Formatet har ändrats.' }
  }

  // FAIL-CLOSED: ett saknat fält är inte noll. Byter Jest namn på fälten ska
  // kontrollen bli RÖD och tvinga fram en läsning — inte tyst räkna 0 + 0 = 0.
  const saknade = SKIP_FIELDS.filter((f) => typeof d[f] !== 'number')
  if (saknade.length > 0) {
    return {
      ok: false,
      rule: `jest-rapporten saknar fält: ${saknade.join(', ')}`,
      detail:
        'Ett saknat fält är INTE noll. Har Jest bytt format ska kontrollen bli röd — ' +
        'annars passerar ett trasigt mätinstrument som ett godkänt resultat.',
    }
  }

  const antal = SKIP_FIELDS.reduce((a, f) => a + d[f], 0)
  if (antal === 0) return { ok: true, antal: 0 }

  // Gör felet LÄSBART: vilka tester, inte bara hur många.
  const namn = []
  for (const svit of Array.isArray(d.testResults) ? d.testResults : []) {
    for (const t of Array.isArray(svit.assertionResults) ? svit.assertionResults : []) {
      if (t.status === 'pending' || t.status === 'todo') {
        namn.push(`${t.status}: ${t.fullName ?? t.title ?? '(namnlöst)'}`)
      }
    }
  }
  return {
    ok: false,
    rule: `${antal} test hoppades över (${SKIP_FIELDS.map((f) => `${f}=${d[f]}`).join(', ')})`,
    detail:
      'En hoppad svit är GRÖN, och en kanariefågel inuti den kan inte falla. Vill du ' +
      'verkligen hoppa över ett test ska det vara ett aktivt beslut här — inte en höjd siffra.',
    namn,
  }
}

// ── självtest ────────────────────────────────────────────────────────────────
function selfTest() {
  let ok = true
  const fail = (m) => {
    ok = false
    console.error(`❌ ${m}`)
  }
  const grön = (label, r) =>
    r.ok ? console.log(`✅ inget falsklarm: ${label}`) : fail(`FALSKLARM: ${label} → ${r.rule}`)
  const röd = (label, r, väntad) => {
    if (r.ok) return fail(`MISSADE: ${label}`)
    if (väntad && !r.rule.includes(väntad)) {
      return fail(`${label} fälldes av FEL regel: "${r.rule}" — väntade "${väntad}"`)
    }
    console.log(`✅ fångad: ${label} (${r.rule})`)
  }

  const rent = { numPendingTests: 0, numTodoTests: 0, numTotalTests: 10, testResults: [] }

  // ── KANARIEFÅGEL: kontrollen måste ge utslag på ett KÄNT hoppat test ──────
  // Utan den kan `evaluate` returnera ok för allt och varje fall nedan bli grönt.
  const kändHoppning = evaluate({
    ...rent,
    numPendingTests: 1,
    testResults: [{ assertionResults: [{ status: 'pending', fullName: 'zz hoppat test' }] }],
  })
  if (kändHoppning.ok || !kändHoppning.namn?.some((n) => n.includes('zz hoppat test'))) {
    fail(`kanariefågel: ett känt hoppat test gav ${JSON.stringify(kändHoppning).slice(0, 90)}`)
  } else console.log('✅ kanariefågel: ett känt hoppat test fäller kontrollen OCH namnges')

  grön('paritet — noll hoppade', evaluate(rent))

  röd('ett it.skip (pending)', evaluate({ ...rent, numPendingTests: 1 }), 'numPendingTests=1')
  röd('ett it.todo', evaluate({ ...rent, numTodoTests: 1 }), 'numTodoTests=1')
  röd(
    'en hel hoppad svit',
    evaluate({ ...rent, numPendingTests: 13, numPendingTestSuites: 1 }),
    '13 test hoppades över',
  )

  // ── FAIL-CLOSED — det viktigaste ─────────────────────────────────────────
  röd('rapporten saknas helt', evaluate(null), 'saknas')
  röd('rapporten är inte JSON', evaluate('{ trasig'), 'går inte att tolka')
  röd('rapporten är inte ett objekt', evaluate('42'), 'inte ett objekt')
  for (const f of SKIP_FIELDS) {
    const utan = { ...rent }
    delete utan[f]
    röd(`fältet ${f} borttaget (omdöpt format)`, evaluate(utan), `saknar fält: ${f}`)
  }
  röd(
    'fältet finns men är en sträng (typbyte)',
    evaluate({ ...rent, numPendingTests: '0' }),
    'saknar fält: numPendingTests',
  )

  console.log(ok ? '\n✅ Självtest OK.' : '\n❌ Självtest misslyckades.')
  process.exit(ok ? 0 : 1)
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest()

  const sökväg = process.argv[2]
  if (!sökväg) {
    console.error('❌ Ingen jest-rapport angiven.\n   Användning: check-no-skipped-tests.mjs <jest-json>')
    process.exit(1)
  }
  let rå = null
  try {
    rå = readFileSync(sökväg, 'utf8')
  } catch (err) {
    console.error(
      `\n=== HOPPADE TESTER: MÄTVÄRDET GÅR INTE ATT LÄSA (CI-guard) ===\n\n` +
        `❌ kunde inte läsa ${sökväg}\n   ${err instanceof Error ? err.message : String(err)}\n\n` +
        'FAIL-CLOSED: en kontroll som inte kan läsa sitt eget mätvärde vet ingenting.\n',
    )
    process.exit(1)
  }

  const r = evaluate(rå)
  if (!r.ok) {
    console.error('\n=== HOPPADE TESTER (CI-guard) ===\n')
    console.error(`❌ ${r.rule}\n   ${r.detail}`)
    if (r.namn?.length) {
      console.error('\n   Hoppade:')
      for (const n of r.namn.slice(0, 40)) console.error(`     • ${n}`)
      if (r.namn.length > 40) console.error(`     … och ${r.namn.length - 40} till`)
    }
    console.error(
      '\nRegeln: en hoppad svit är grön, och en kanariefågel inuti den kan inte falla.\n' +
        'Rätt värde är NOLL — se skälet i ci.yml där steget bor.\n',
    )
    process.exit(1)
  }
  console.log('✅ noll hoppade tester (numPendingTests + numTodoTests = 0).')
}

main()
