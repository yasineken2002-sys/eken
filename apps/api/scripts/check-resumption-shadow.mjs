#!/usr/bin/env node
/**
 * SKUGGLÄGET ÄR EN AVSAKNAD, INTE EN FLAGGA — och den här vakten mäter det.
 *
 * Återupptagningsmotorn är den första komponenten som agerar utan att en
 * människa bett om det i samma stund. Den byggdes i skuggläge, och skuggläget
 * vilar inte på ett `if` som kan flippas: det vilar på att koden som UTFÖR något
 * inte går att nå från `resumption.service.ts`.
 *
 * Den garantin är bara värd något om något kontrollerar den. En import som
 * smyger in vid nästa refaktorering syns annars inte förrän motorn gjort något.
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * Den mäter FRÅNVARON AV EN KOPPLING i källtexten. Den kan inte se att omdömet
 * är riktigt — det ägs av `resumption-policy.spec.ts`, som prövar varje steg och
 * har en negativkontroll för spärren mot KRÄVER_MÄNNISKA. Och den kan inte se
 * ett utförande som når tjänsten på en väg utan namn: en injicerad `unknown`,
 * ett dynamiskt `require`. Den fångar det troliga, inte det påhittiga.
 *
 * ── VARFÖR FRÅGAN STÄLLS MOT KOD OCH INTE MOT RÅTEXT ────────────────────────
 *
 * Det här skrevs först som ett jest-prov som läste filen som råtext. Det var
 * RÖTT direkt — av tjänstens EGET docblock, som förklarar varför det inte finns
 * någon väg till `ToolExecutorService` och därför nämner den vid namn.
 *
 * En kontroll som läser prosa mäter prosan. Frågan går via `codeMask`, som
 * blankar kommentarer och stränginnehåll men behåller längd och radbrytningar.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TJÄNSTEN = join(HERE, '..', 'src', 'ai', 'resumption', 'resumption.service.ts')

/**
 * Identifierare som INTE får förekomma i kod i motorns tjänstefil.
 *
 * `LIVE` står med därför att `ResumptionMode.LIVE` är enumvärdet för skarpt
 * läge. Skrivs det i tjänsten är skarpt läge påbörjat, och då ska det vara ett
 * medvetet beslut som tar bort den här raden — inte en diff som glider förbi.
 */
const FÖRBJUDNA = [
  { namn: 'ToolExecutorService', varför: 'verktygsutföraren' },
  { namn: 'executeTool', varför: 'utförandeanropet' },
  { namn: 'TenantToolExecutorService', varför: 'hyresgästernas verktygsutförare' },
  { namn: "'LIVE'", varför: 'skarpt läge' },
]

/** Ordgräns med Unicode-medvetenhet: `\b` är ASCII-definierat. */
function finnsIKod(kod, id) {
  if (id.startsWith("'")) return kod.includes(id)
  const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${id}(?![\\p{L}\\p{N}_$])`, 'u')
  return re.test(kod)
}

function kör() {
  const fel = []

  // Den delade skannerns egna kanariefåglar FÖRST. En vakt som bygger på en
  // trasig förbehandlare mäter bara de filer förbehandlaren klarade att läsa.
  const skannerFel = kanariefåglar()
  if (skannerFel.length > 0) {
    fel.push(`Den delade skannerns kanariefåglar föll:\n     • ${skannerFel.join('\n     • ')}`)
  }

  const rå = readFileSync(TJÄNSTEN, 'utf8')
  const kod = codeMask(rå)

  // ── VAKTENS EGEN KANARIEFÅGEL ────────────────────────────────────────────
  //
  // Matar in SAMMA identifierare två gånger: en gång i en kommentar, en gång i
  // kod. Utfallen måste vara MOTSATTA. Ett prov som bara visar det positiva
  // fallet skiljer inte en läsande regel från en blind.
  {
    const iKommentar = `// vi rör aldrig ToolExecutorService här\nconst x = 1\n`
    const iKod = `const y = new ToolExecutorService()\n`
    if (finnsIKod(codeMask(iKommentar), 'ToolExecutorService')) {
      fel.push('KANARIEFÅGEL: en identifierare i en KOMMENTAR gav utslag — vakten läser prosa.')
    }
    if (!finnsIKod(codeMask(iKod), 'ToolExecutorService')) {
      fel.push('KANARIEFÅGEL: en identifierare i KOD gav INGET utslag — vakten är blind.')
    }
    // Och den form som faktiskt fällde det första försöket: identifieraren i
    // ett docblock, med all den omgivande prosa ett riktigt docblock har.
    const iDocblock = `/**\n * Det finns ingen väg härifrån till ToolExecutorService.\n */\nconst z = 1\n`
    if (finnsIKod(codeMask(iDocblock), 'ToolExecutorService')) {
      fel.push('KANARIEFÅGEL: en identifierare i ett DOCBLOCK gav utslag — vakten läser prosa.')
    }
  }

  for (const { namn, varför } of FÖRBJUDNA) {
    if (finnsIKod(kod, namn)) {
      fel.push(
        `${namn} (${varför}) förekommer i KOD i resumption.service.ts.\n` +
          `     Skuggläget vilar på att den vägen inte finns. Är skarpt läge ett fattat\n` +
          `     beslut: ta bort raden ur FÖRBJUDNA i den här vakten, i samma PR.`,
      )
    }
  }

  // Sonden ska vara skarp: filen måste faktiskt innehålla motorn.
  if (!finnsIKod(kod, 'körEttPass')) {
    fel.push('resumption.service.ts saknar `körEttPass` — läser vakten rätt fil?')
  }

  if (fel.length > 0) {
    console.error('❌ Skugglägesvakten föll:\n')
    for (const f of fel) console.error(`   • ${f}\n`)
    process.exit(1)
  }
  console.log(
    `✅ Skuggläget intakt: ingen av ${FÖRBJUDNA.length} utförandeidentifierare förekommer i kod.`,
  )
}

kör()
