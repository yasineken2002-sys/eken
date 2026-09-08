import { BetalningskorpusSchema } from './betalningsrapport'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  provaKandidater,
  beloppsutfall,
  type Kandidat,
  type Bankrad,
} from '../payment/payment-candidates'
import { INGEN_AVI } from '../payment/payment-fields'

/**
 * KORPUSENS FORM, OCH VAD REGLERNA ENSAMMA KLARAR.
 *
 * ── VARFÖR MÄTNINGEN LIGGER I ETT PROV OCH INTE BARA I RIGGEN ───────────────
 *
 * Riggen (`eval-shadow-agent.ts --betalningar`) kostar pengar och kräver en
 * nyckel. Regeldelen gör det inte: `provaKandidater` är en ren funktion, och
 * hela ablationens NEDRE halva — vad reglerna klarar UTAN modellen — går att
 * mäta gratis och i CI. Att lägga den här betyder att baslinjen inte kan ruttna
 * tyst mellan två betalda körningar.
 *
 * ── TALEN NEDAN ÄR SPÄRRAR, INTE RAPPORTER ──────────────────────────────────
 *
 * Trösklarna är satta UNDER de uppmätta värdena, med marginal, och de finns för
 * att fälla en regeländring som gör mängden sämre — inte för att dokumentera
 * hur bra den är. Den siffran hör hemma i statusblocket i planen, där den kan
 * bära ett datum och en sha.
 */
const korpus = BetalningskorpusSchema.parse(
  JSON.parse(readFileSync(join(__dirname, 'korpus-betalningar.json'), 'utf8')),
)

const kandidater: Kandidat[] = korpus.poster.map((p) => ({
  id: p.id,
  sort: p.sort,
  nummer: p.nummer,
  ocr: p.ocr,
  utestaende: p.utestaende,
  forfallodatum: new Date(p.forfallodatum),
  motpartId: p.motpartId,
  motpartNamn: p.motpartNamn,
}))

function bankrad(r: (typeof korpus.bankrader)[number]): Bankrad {
  return {
    id: r.id,
    datum: new Date(r.datum),
    text: r.text,
    belopp: r.belopp,
    rawOcr: r.rawOcr,
  }
}

describe('mätkorpus för agent 2 — formen', () => {
  it('är 40 bankrader och 14 poster', () => {
    expect(korpus.bankrader).toHaveLength(40)
    expect(korpus.poster).toHaveLength(14)
  })

  it('har unika id:n', () => {
    expect(new Set(korpus.bankrader.map((r) => r.id)).size).toBe(40)
    expect(new Set(korpus.poster.map((p) => p.id)).size).toBe(14)
  })

  it('varje facit.avi är antingen INGEN eller ett id som finns bland posterna', () => {
    const ids = new Set(korpus.poster.map((p) => p.id))
    for (const r of korpus.bankrader) {
      if (r.facit.avi === null || r.facit.avi === INGEN_AVI) continue
      expect(ids.has(r.facit.avi)).toBe(true)
    }
  })

  it('varje bankrad har ett positivt belopp — ingest avvisar övriga', () => {
    for (const r of korpus.bankrader) expect(r.belopp).toBeGreaterThan(0)
  })

  it('alla åtta grupper är representerade, och ingen är tom', () => {
    const grupper = new Set(korpus.bankrader.map((r) => r.facit.grupp))
    expect([...grupper].sort()).toEqual([
      'belopp_och_namn',
      'delbetalning',
      'dubbelbetalning',
      'exakt_ocr',
      'hyra_plus_avgift',
      'ocr_sifferfel',
      'okand_avsandare',
      'retur',
    ])
  })

  it('facit.belopp stämmer med `beloppsutfall` för de rader som pekar på en post', () => {
    // FACIT HÄRLEDS INTE UR KODEN — det är skrivet för hand. Det här provet
    // kräver att de två SÄGER SAMMA SAK, vilket är något annat: glider
    // toleransen i `beloppsutfall` blir provet rött, och då är antingen koden
    // eller facit fel. Att låta facit beräknas av funktionen hade gjort provet
    // till en tautologi.
    for (const r of korpus.bankrader) {
      if (r.facit.avi === null || r.facit.avi === INGEN_AVI) continue
      const post = korpus.poster.find((p) => p.id === r.facit.avi)!
      expect(beloppsutfall(r.belopp, post.utestaende)).toBe(r.facit.belopp)
    }
  })
})

describe('vad de deterministiska reglerna klarar UTAN modellen', () => {
  it('kontrollgruppen exakt_ocr ger INGEN_FRAGA — och bara den', () => {
    for (const r of korpus.bankrader) {
      const utfall = provaKandidater(bankrad(r), kandidater)
      const förväntat = r.facit.regel === 'INGEN_FRAGA'
      expect([r.id, utfall.typ === 'INGEN_FRAGA']).toEqual([r.id, förväntat])
    }
  })

  it('DUBBELBETALNING når fram trots exakt OCR — regeln kräver att beloppet ryms', () => {
    // NEGATIVKONTROLLEN FÖR DEN LAGNING KORPUSEN AVSLÖJADE. Raderna bär ett
    // KORREKT OCR (hyresgästen betalade samma avi två gånger), och den första
    // versionen av regeln svarade därför "automatiken tar den" och föreslog
    // aldrig något — trots att avstämningen avvisar en överbetalning och raden
    // blir UNMATCHED. Utfallet hade varit tystnad med pengar på kontot.
    const dubbla = korpus.bankrader.filter((r) => r.facit.grupp === 'dubbelbetalning')
    expect(dubbla.length).toBeGreaterThan(0)
    for (const r of dubbla) {
      const utfall = provaKandidater(bankrad(r), kandidater)
      expect([r.id, utfall.typ]).toEqual([r.id, 'KANDIDATER'])
    }
  })

  it('rätt post finns bland kandidaterna för varje rad som har en (recall)', () => {
    const medPost = korpus.bankrader.filter(
      (r) => r.facit.avi !== null && r.facit.avi !== INGEN_AVI && r.facit.regel !== 'INGEN_FRAGA',
    )
    const missade: string[] = []
    for (const r of medPost) {
      const utfall = provaKandidater(bankrad(r), kandidater)
      const träff =
        utfall.typ === 'KANDIDATER' && utfall.kandidater.some((k) => k.id === r.facit.avi)
      if (!träff) missade.push(`${r.id} (${r.facit.grupp})`)
    }
    // 100 % ELLER INGET. Saknas rätt post i kandidatmängden kan modellen
    // strukturellt inte svara rätt, och varje procent träffgrad ovanpå det
    // mäter något annat än förmågan att välja. Missade rader räknas UPP i
    // felmeddelandet — ett tal hade sagt att det finns ett problem, listan
    // säger vilket.
    expect(missade).toEqual([])
  })

  it('reglerna ensamma avgör de fall där det inte finns något att välja mellan', () => {
    // ETT AKTIVT NEJ UTAN MODELLANROP. `okand_avsandare` och `retur` ska falla
    // ut som INGEN redan av reglerna — de bär varken OCR-närhet, belopp inom
    // toleransen eller ett namn som är en hyresgäst.
    const utan = korpus.bankrader.filter((r) =>
      ['okand_avsandare', 'retur'].includes(r.facit.grupp),
    )
    const kvar: string[] = []
    for (const r of utan) {
      const utfall = provaKandidater(bankrad(r), kandidater)
      if (utfall.typ !== 'INGEN') kvar.push(`${r.id} → ${utfall.typ}`)
    }
    // TRÖSKELN ÄR SATT UNDER DET UPPMÄTTA, med marginal, och finns för att
    // fälla en regeländring som gör mängden sämre. Att den inte är noll är
    // ärligt: en retur på ett belopp som råkar sammanfalla med en öppen avi
    // KAN inte skiljas ut av en regel, och ska då gå till modellen.
    expect(kvar.length).toBeLessThanOrEqual(3)
  })
})
