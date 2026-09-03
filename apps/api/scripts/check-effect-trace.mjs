#!/usr/bin/env node
/**
 * CI-vakt — effektspårets PÅKOPPLING.
 *
 * ── DEFEKTEN SOM MÄTTES ─────────────────────────────────────────────────────
 *
 * `AiToolEffect` har EXAKT ETT persisteringsställe: en nästlad
 * `effects: { create: … }` inuti `aiToolExecution.create` i
 * `ai/audit/ai-audit.service.ts`. Med den bortkopplad var 2026-09-01
 *
 *     check-ai-tool-effects.mjs   GRÖN
 *     hela sviten                 GRÖN — 338/338 sviter, 3478/3478 tester
 *
 * Spåret var obevakat. `ai-effect-extension.spec.ts` heter visserligen
 * "effekterna PERSISTERAS som rader", men den anropar
 * `prisma.aiToolExecution.create(...)` DIREKT i testet — den prövar Prismas
 * nästlade skrivning, inte att produktionsvägen använder den. Fel fråga, inte
 * svag vakt.
 *
 * ── ANSVARSDELNING (utskriven i BÅDA filerna) ───────────────────────────────
 *
 *   • `effect-trace-production-path.db.spec.ts` äger MEKANIKEN: den kör
 *     `ToolExecutorService.executeTool` skarpt mot riktig Postgres och kräver
 *     att raden finns. Den faller på injektionen ovan (uppmätt).
 *   • Den här vakten äger PÅKOPPLINGEN: att mängden anropare är HÄRLEDD och
 *     fullständig, att var och en skickar med sina effekter, och att
 *     persisteringsstället har kvar sin nästlade skrivning. En spec kan inte se
 *     en anropare som aldrig körs i test.
 *
 * ── REGLERNA ────────────────────────────────────────────────────────────────
 *
 *   R1  OMFÅNG. Mängden anropare av `logToolExecution(` HÄRLEDS ur källan. En
 *       TOM mängd fäller. Det är R5-lärdomen från check-action-tool-authorization:
 *       regeln fungerade, mängden defaultade till [], och vakten var grön för
 *       alltid.
 *   R2  Varje anropare skickar med `effects:` — eller står kvitterad i
 *       `effect-trace.ack.json` med ett skäl på minst 30 tecken.
 *   R3  KVITTERINGEN FÄLLER ÅT BÅDA HÅLL: en kvittering vars fil inte längre
 *       innehåller något anropsställe är rött. Annars blir ack-filen ett arkiv
 *       av påståenden ingen prövar.
 *   R4  PERSISTERINGEN. `logToolExecution` måste ha kvar sin nästlade
 *       `effects: { create`. Det är injektionen ovan, fångad statiskt.
 *   R5  MEKANIKSPECEN FINNS och kör den riktiga vägen — filen ska existera och
 *       nämna `executeTool`. Utan den raden kan någon radera specen och lämna
 *       kvar en vakt som bara läser text.
 *
 * ── LÄSNINGEN ───────────────────────────────────────────────────────────────
 *
 * Allt via `codeMask` ur den delade skannern: varken en kommentar eller en
 * stränglitteral får uppfylla en regel. En vakt i det här repot mättes en gång
 * grön av en kommentar som nämnde identifieraren den letade efter.
 *
 * Självtest (kanariefåglar):
 *     node apps/api/scripts/check-effect-trace.mjs --self-test
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROT = join(HERE, '..', '..', '..')
const SRC = join(HERE, '..', 'src')
const AUDIT = join(SRC, 'ai', 'audit', 'ai-audit.service.ts')
const SPEC = join(SRC, 'ai', 'audit', 'effect-trace-production-path.db.spec.ts')
const ACK = join(HERE, 'effect-trace.ack.json')

const MIN_SKAL = 30
/** Filer som kan innehålla anropsställen. Formen, inte en uppräkning av namn. */
const KALLKATALOG = join(SRC, 'ai', 'tools')

function tsFiler(dir) {
  const ut = []
  for (const namn of readdirSync(dir)) {
    const full = join(dir, namn)
    if (statSync(full).isDirectory()) ut.push(...tsFiler(full))
    // FORM, inte ord: `\.spec\.ts$` — aldrig `includes('spec')`, som hade
    // uteslutit hela apps/api/src/inspections/ på delsträngen "spec".
    else if (/\.ts$/.test(namn) && !/\.spec\.ts$/.test(namn)) ut.push(full)
  }
  return ut
}
/** Anropsställen för logToolExecution, härledda ur koden. */
export function hittaAnropare(filer) {
  const träffar = []
  for (const { rel, text } of filer) {
    const kod = codeMask(text)
    const rader = kod.split('\n')
    rader.forEach((rad, i) => {
      if (/\blogToolExecution\s*\(/.test(rad)) {
        // Anropets argumentobjekt sträcker sig till nästa `})` på samma nivå.
        // Fönstret avgränsas STRUKTURELLT (blockslutet), aldrig av något som
        // ingår i det vi letar efter.
        const slut = Math.min(rader.length, i + 60)
        const kropp = rader.slice(i, slut).join('\n')
        const stopp = kropp.indexOf('\n    })')
        const fönster = stopp === -1 ? kropp : kropp.slice(0, stopp)
        träffar.push({ rel, rad: i + 1, skickarEffects: /\beffects\s*:/.test(fönster) })
      }
    })
  }
  return träffar
}

/**
 * Metoder i auditservicen som TAR EMOT effekter — härledda, inte uppräknade.
 *
 * Radvis på Prettier-normaliserad indentering: klassmedlemmar står på två stegs
 * indrag och avslutas av `  }`. Den gränsen är strukturell och kan inte
 * förväxlas med något inuti kroppen.
 */
export function metoderMedEffects(src) {
  const rader = codeMask(src).split('\n')
  const ut = []
  for (let i = 0; i < rader.length; i++) {
    const m = /^  (?:private |public |protected )?(?:async )?([\p{L}\p{N}_$]+)\s*\(/u.exec(rader[i])
    if (!m) continue
    // `constructor(...) {}` stänger på SIN EGEN rad, så sökningen efter nästa
    // `  }` svalde hela klassen och matchade `effects` någonstans långt ner.
    // Uppmätt: den härledda mängden blev 4 i stället för 3.
    if (m[1] === 'constructor') continue
    if (/\{\s*\}\s*$/.test(rader[i])) continue
    let slut = rader.length
    for (let j = i + 1; j < rader.length; j++) {
      // `^  \}` ensamt räcker INTE: ett parameterobjekt stängs också på två
      // stegs indrag (`  }): Promise<void> {`), och kroppen klipptes då vid
      // SIGNATUREN i stället för vid metodslutet. Uppmätt: R4 blev röd för två
      // skrivare som faktiskt hade sin nästlade create. Metodens slut är den
      // klammer som står ENSAM på sin rad.
      if (/^  \}\s*$/.test(rader[j])) { slut = j; break }
    }
    const kropp = rader.slice(i, slut).join('\n')
    if (/\beffects\??\s*:/.test(kropp)) ut.push({ namn: m[1], kropp, från: i, till: slut })
  }
  return ut
}

export function granska({ filer, auditSrc, ack, specFinns, specSrc }) {
  const fel = []
  const anropare = hittaAnropare(filer)

  // R1 — omfång.
  if (anropare.length === 0) {
    fel.push('R1 noll anropare av logToolExecution hittades — vakten mäter ingenting')
  }

  // R2/R3 — effects eller kvittering.
  const kvitterade = new Map((ack.kvitterade ?? []).map((k) => [k.fil, k.skal ?? '']))
  for (const a of anropare) {
    if (a.skickarEffects) continue
    const skal = kvitterade.get(a.rel)
    if (skal === undefined) {
      fel.push(
        `R2 ${a.rel}:${a.rad} anropar logToolExecution UTAN effects — spåret blir tomt ` +
          'utan att någon märker det. Skicka med drainEffects(), eller kvittera i ' +
          'effect-trace.ack.json med ett skäl.',
      )
    } else if (skal.trim().length < MIN_SKAL) {
      fel.push(`R2 kvitteringen för ${a.rel} har ett skäl kortare än ${MIN_SKAL} tecken`)
    }
  }
  // R3 — en kvittering ska falla både när filen försvinner OCH när den inte
  // längre BEHÖVS. Det andra är det lömska: efter att hyresgästvägen kopplades
  // på skickade alla anropare `effects`, och en kvittering som mätte på "filen
  // finns" hade stått kvar som ett sant påstående om ett problem som var löst.
  // Villkoret är därför "filen har ett anropsställe SOM SAKNAR effects".
  const filerSomBehöverKvittering = new Set(
    anropare.filter((a) => !a.skickarEffects).map((a) => a.rel),
  )
  for (const fil of kvitterade.keys()) {
    if (!filerSomBehöverKvittering.has(fil)) {
      fel.push(
        `R3 onödig kvittering: ${fil} står i effect-trace.ack.json men alla dess ` +
          'anropsställen skickar numera effects (eller finns inte kvar). Ta bort ' +
          'den — annars är ack-filen ett arkiv av påståenden ingen prövar.',
      )
    }
  }

  // R4 — persisteringen finns kvar, i VARJE skrivare som tar emot effekter.
  //
  // Regeln är på FORM, inte en uppräkning av metodnamn: varje metod i
  // auditservicen som tar en `effects`-parameter måste också föra den vidare in
  // i en nästlad `effects: { create: … }`. `beginToolExecution` utesluts därmed
  // av sig själv — den öppnar raden och tar inga effekter.
  //
  // ⚠️ VARFÖR PER SKRIVARE. Först räckte det att formen fanns NÅGONSTANS i
  // filen. Det höll så länge det bara fanns en skrivare; med tre (steg 3b) kunde
  // två bära den och den tredje tappa den utan att något blev rött — och
  // kanariefågeln, som tog bort EN förekomst, slutade fälla. Exakt samma defekt
  // som R2 i check-effect-idempotency hade veckan innan.
  for (const m of metoderMedEffects(auditSrc)) {
    if (!/effects\s*:\s*\{\s*create\s*:/.test(m.kropp)) {
      fel.push(
        `R4 ${m.namn} tar emot effects men skriver ingen nästlad ` +
          '`effects: { create: … }` — effektspåret persisteras inte den vägen. ' +
          'Uppmätt: med den bortkopplad var HELA sviten grön.',
      )
    }
  }
  if (metoderMedEffects(auditSrc).length === 0) {
    fel.push('R4 ingen skrivare med effects-parameter hittades — vakten mäter ingenting')
  }

  // R5 — mekanikspecen finns och kör den riktiga vägen.
  if (!specFinns) {
    fel.push('R5 effect-trace-production-path.db.spec.ts saknas — mekaniken är oprövad')
  } else if (!/\bexecuteTool\s*\(/.test(codeMask(specSrc))) {
    fel.push(
      'R5 produktionsvägsspecen anropar inte executeTool — då prövar den något annat ' +
        'än produktionsvägen, vilket var hela defekten den finns för.',
    )
  }

  return { fel, antalAnropare: anropare.length, utanEffects: anropare.filter((a) => !a.skickarEffects).length }
}

function läsFiler() {
  return tsFiler(KALLKATALOG).map((full) => ({
    rel: full.slice(ROT.length + 1),
    text: readFileSync(full, 'utf8'),
  }))
}

function kör() {
  const { fel, antalAnropare, utanEffects } = granska({
    filer: läsFiler(),
    auditSrc: readFileSync(AUDIT, 'utf8'),
    ack: JSON.parse(readFileSync(ACK, 'utf8')),
    specFinns: existsSync(SPEC),
    specSrc: existsSync(SPEC) ? readFileSync(SPEC, 'utf8') : '',
  })
  if (fel.length) {
    console.error('❌ Effektspårets påkoppling håller inte:')
    for (const f of fel) console.error(`   • ${f}`)
    process.exit(1)
  }
  console.error(
    `✅ Effektspåret är påkopplat: ${antalAnropare} anropare av logToolExecution, ` +
      `${utanEffects} utan effects (kvitterade med skäl).`,
  )
}

function självtest() {
  const fel = []
  const t = (namn, ok, extra = '') => {
    if (!ok) fel.push(`${namn}${extra ? ` — ${extra}` : ''}`)
  }
  const FILER = läsFiler()
  const AUDIT_SRC = readFileSync(AUDIT, 'utf8')
  const ACK_OBJ = JSON.parse(readFileSync(ACK, 'utf8'))
  const bas = {
    filer: FILER,
    auditSrc: AUDIT_SRC,
    ack: ACK_OBJ,
    specFinns: existsSync(SPEC),
    specSrc: readFileSync(SPEC, 'utf8'),
  }

  // KANARIE 0 — härledningen ser lika många anropare som en rå sökning i KOD.
  //
  // Jämförelsen går mot `codeMask`-ad text, inte mot råfilen. Skälet är mätt:
  // med råfilen blev det 5 mot 4, och den femte var en KOMMENTAR i
  // effect-idempotency.ts som citerar anropet. Att kräva likhet mot råtexten
  // hade alltså krävt att vakten räknar prosa som ett anropsställe — precis
  // tvärtemot regeln. Att maskningen i sin tur fungerar prövas av den delade
  // skannerns egna kanariefåglar nedan, och av prosa-kanariefågeln efter den här.
  const sedda = hittaAnropare(FILER).length
  let rått = 0
  for (const f of FILER) rått += (codeMask(f.text).match(/\blogToolExecution\s*\(/g) ?? []).length
  t('KANARIE 0 (härledningen ser lika många som en rå sökning i KOD)', sedda === rått,
    `härledda ${sedda}, rå sökning i kod ${rått}`)
  t('KANARIE 0 (ett anrop i PROSA räknas inte som anropsställe)',
    hittaAnropare([{ rel: 'p.ts', text: '// void this.audit.logToolExecution({ effects })\nconst x = 1' }])
      .length === 0,
    'en kommentar som citerar anropet räknades som ett anropsställe')
  t('KANARIE 0 (antalet är inte noll)', sedda > 0, 'inga anropare alls hittades')
  // De fyra void-anroparna ska ligga i mängden — talet står med flit, och det
  // täcker BÅDA exekverarna: två i tool-executor.service.ts (ägarvägen, fel-
  // och lyckadgrenen) och två i tenant-tool-executor.service.ts (hyresgästvägen,
  // samma två grenar). Räknade omfånget bara den ena vägen skulle den andra
  // kunna tappa sin påkoppling utan att något blev rött.
  const perFil = {}
  for (const a of hittaAnropare(FILER)) perFil[a.rel] = (perFil[a.rel] ?? 0) + 1
  t('KANARIE 0 (alla fyra void-anroparna är med)', sedda === 4, `hittade ${sedda}, väntade 4`)
  t('KANARIE 0 (BÅDA exekverarna är med i omfånget)',
    Object.keys(perFil).some((f) => /\/tool-executor\.service\.ts$/.test(f)) &&
      Object.keys(perFil).some((f) => /\/tenant-tool-executor\.service\.ts$/.test(f)),
    `filer i omfånget: ${JSON.stringify(perFil)}`)

  // KANARIE OMFÅNG — tom mängd FÄLLER.
  t('KANARIE omfång (tom filmängd → fäller)',
    granska({ ...bas, filer: [] }).fel.some((f) => f.startsWith('R1')),
    'en tom anroparmängd gjorde vakten grön')

  // KANARIE REGEL — anropare utan effects, utan kvittering, fäller exakt en gång.
  const utan = [{ rel: 'x/y.ts', text: 'void this.audit.logToolExecution({\n  toolName,\n    })' }]
  const r2 = granska({ ...bas, filer: utan, ack: { kvitterade: [] } }).fel.filter((f) => f.startsWith('R2'))
  t('KANARIE regel (anropare utan effects → exakt 1 brott)', r2.length === 1, JSON.stringify(r2))
  const med = [{ rel: 'x/y.ts', text: 'void this.audit.logToolExecution({\n  toolName,\n  effects: drainEffects(),\n    })' }]
  t('KANARIE regel (anropare MED effects → 0 brott)',
    granska({ ...bas, filer: med, ack: { kvitterade: [] } }).fel.filter((f) => f.startsWith('R2')).length === 0)

  // KANARIE R3 — kvittering utan anropsställe fäller …
  t('KANARIE R3 (kvittering utan anropsställe → fäller)',
    granska({ ...bas, ack: { kvitterade: [{ fil: 'finns/inte.ts', skal: 'x'.repeat(40) }] } }).fel.some((f) =>
      f.startsWith('R3')),
    'en död kvittering gjorde vakten grön')
  // … och en kvittering för en fil vars anropare NUMERA skickar effects fäller
  // också. Utan den här står kvitteringen kvar som ett påstående om ett löst
  // problem, och nästa läsare tror att luckan finns.
  t('KANARIE R3 (kvittering som inte längre behövs → fäller)',
    granska({
      ...bas,
      filer: [{ rel: 'x/y.ts', text: 'void this.audit.logToolExecution({\n  effects: drainEffects(),\n    })' }],
      ack: { kvitterade: [{ fil: 'x/y.ts', skal: 'x'.repeat(40) }] },
    }).fel.some((f) => f.startsWith('R3')),
    'en onödig kvittering gjorde vakten grön')

  // KANARIE R4 — DEN VIKTIGA, och nu PER SKRIVARE.
  //
  // Att ta bort ALLA förekomster fäller förstås. Det avgörande är att det räcker
  // att ta bort EN: med tre skrivare kunde två bära formen och den tredje tappa
  // den, och en kanariefågel som bara prövade "finns någonstans" hade tigit.
  const utanAlla = AUDIT_SRC.replaceAll(/effects:\s*\{\s*create:/g, 'effekter_borta: { skapa:')
  t('KANARIE R4 (all persistering bortkopplad → fäller)',
    granska({ ...bas, auditSrc: utanAlla }).fel.some((f) => f.startsWith('R4')),
    'den injektion som gjorde HELA sviten grön gick igenom vakten också')

  const skrivare = metoderMedEffects(AUDIT_SRC)
  t('KANARIE R4 (alla tre skrivarna härleds)', skrivare.length === 3,
    `hittade ${skrivare.length}: ${skrivare.map((m) => m.namn).join(', ')}`)

  // EN SKRIVARE I TAGET. Radintervallet kommer från den maskerade texten, men
  // codeMask bevarar radbrytningar — så samma index pekar på råfilens rader, och
  // injektionen kan göras där utan att röra de andra skrivarna.
  let prövade = 0
  const råRader = AUDIT_SRC.split('\n')
  for (const m of skrivare) {
    // FORMEN SPÄNNER FLERA RADER. Prettier bryter den som
    //     effects: {
    //       create: args.effects.map(…)
    // så en RADVIS regex träffar aldrig. Första försöket prövade därför noll av
    // tre skrivare och var ändå grönt — fångat först av räkningen nedan.
    const kropp = råRader.slice(m.från, m.till).join('\n')
    if (!/effects:\s*\{\s*create:/.test(kropp)) continue
    const kopia = [...råRader]
    kopia.splice(
      m.från,
      m.till - m.från,
      ...kropp.replace(/effects:\s*\{\s*create:/, 'x: { y:').split('\n'),
    )
    prövade++
    t(`KANARIE R4 (${m.namn} ensam bortkopplad → fäller)`,
      granska({ ...bas, auditSrc: kopia.join('\n') }).fel.some((f) => f.includes(m.namn)),
      `att koppla bort ${m.namn} ensam gjorde inte vakten röd`)
  }
  // Utan den här raden kunde loopen ovan ha prövat NOLL skrivare och ändå varit
  // grön — samma tomma-mängd-fälla som R5 i check-action-tool-authorization.
  t('KANARIE R4 (varje skrivare prövades var för sig)', prövade === 3,
    `prövade ${prövade} av ${skrivare.length}`)

  // KANARIE R5 — specen borta, och spec som inte kör den riktiga vägen.
  t('KANARIE R5 (specen saknas → fäller)',
    granska({ ...bas, specFinns: false }).fel.some((f) => f.startsWith('R5')))
  t('KANARIE R5 (spec utan executeTool → fäller)',
    granska({ ...bas, specSrc: 'it("x", () => expect(1).toBe(1))' }).fel.some((f) => f.startsWith('R5')))


  // ── #668: IDENTIFIERARE ÄR UNICODE, INTE \w ─────────────────────────────
  //
  // `\w` är ASCII. Metodhärledningen missade varje namn med å, ä eller ö —
  // och utfallet var TYSTNAD: metoden hamnade aldrig i mängden, så en
  // oinstrumenterad metod med svenskt namn hade passerat vakten.
  //
  // BÅDA FELFORMERNA prövas:
  //   MISSAD  svensk INITIAL → hittas inte alls (sänker antalet)
  //   KAPAD   svensk bokstav MITT i namnet → ASCII-svansen matchar, FEL namn
  //           (antalet är OFÖRÄNDRAT, så ett tal döljer det)
  {
    const ur = (src) => JSON.stringify(metoderMedEffects(src))
    // Kroppen MÅSTE bära `effects:` — det är vad funktionen letar efter.
    // Utan den blev mängden tom och kanariefågeln föll av fel skäl.
    const s1 = 'class C {\n  private async ärLevande() {\n    return { effects: [] }\n  }\n}\n'
    t('#668 MISSAD: metod med svensk INITIAL härleds', ur(s1).includes('ärLevande'), ur(s1))
    const s2 = 'class C {\n  private async förvaltaAvi() {\n    return { effects: [] }\n  }\n}\n'
    t('#668 KAPAD: hela namnet fångas, inte svansen',
      ur(s2).includes('förvaltaAvi') && !ur(s2).includes('"rvaltaAvi"'), ur(s2))
  }

  // Den DELADE skannerns egna kanariefåglar.
  for (const f of kanariefåglar()) fel.push(`delad skanner: ${f}`)

  if (fel.length) {
    console.error('❌ Självtestet föll:')
    for (const f of fel) console.error(`   • ${f}`)
    process.exit(1)
  }
  console.error(`✅ Självtest grönt (${sedda} anropare härledda, lika många som en rå sökning).`)
}

if (process.argv.includes('--self-test')) självtest()
else kör()
