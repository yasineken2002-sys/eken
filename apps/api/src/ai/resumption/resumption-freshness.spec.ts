import {
  ATERUPPTAGNING_TYSTNAD_MAX_MS,
  bedömTystnad,
  ResumptionFreshnessService,
} from './resumption-freshness.service'
import { HJARTSLAG_MS } from './resumption.service'

import type { TystnadsUtfall } from './resumption-freshness.service'

/**
 * Specen äger MEKANIKEN i tystnadsdomen och i larmvägen.
 *
 * VAD DEN INTE KAN SE: att cronet faktiskt registreras och körs. Det ägs av
 * `cron-classification.ack.json` (klass A, låsnyckeln finns i filen) och av
 * `check-cron-error-sink.mjs`, som mäter att jobbet når den varaktiga sänkan.
 * Och den kan inte se att motorn i produktion verkligen skriver — det är hela
 * saken larmet finns för, och den frågan kan bara databasen svara på.
 */

const NU = new Date('2026-09-02T12:00:00.000Z')
const sedan = (ms: number) => new Date(NU.getTime() - ms)

describe('tystnadsdomen', () => {
  it('en färsk körning är inte tyst', () => {
    expect(bedömTystnad(sedan(60_000), NU)).toMatchObject({ tyst: false, harNågonKörning: true })
  })

  it('exakt på tröskeln är INTE tyst — `>` och inte `>=`', () => {
    expect(bedömTystnad(sedan(ATERUPPTAGNING_TYSTNAD_MAX_MS), NU).tyst).toBe(false)
    expect(bedömTystnad(sedan(ATERUPPTAGNING_TYSTNAD_MAX_MS + 1), NU).tyst).toBe(true)
  })

  // "Det finns ingen körning" fick inte se friskare ut än "körningen är gammal"
  // — exakt den defekten hade backupen innan #574.
  it('INGEN körning alls är lika högljutt som en gammal', () => {
    expect(bedömTystnad(null, NU)).toMatchObject({
      tyst: true,
      harNågonKörning: false,
      ageMs: null,
    })
  })

  it('bär BÅDA talen, inte ett omdöme — åldern och tröskeln går att jämföra', () => {
    const u = bedömTystnad(sedan(90 * 60_000), NU)
    expect(u.ageMs).toBe(90 * 60_000)
    expect(u.tröskelMs).toBe(ATERUPPTAGNING_TYSTNAD_MAX_MS)
  })
})

describe('tröskeln är ett beslut, och den måste vara SAMMANHÄNGANDE', () => {
  // ── DET HÄR ÄR PROVET SOM GÖR TALET TILL MER ÄN EN ÅSIKT ────────────────
  //
  // Tröskeln får INTE härledas ur hjärtslaget (två gränser som ska kunna ändras
  // var för sig får inte vara en gräns). Men den måste ÖVERSTIGA det, annars är
  // larmet en falsklarmsmaskin: en frisk men sysslolös motor skriver bara en rad
  // i timmen, och en tröskel under en timme hade då larmat om en motor som gör
  // precis vad den ska.
  //
  // Provet fäller alltså den enda kopplingen som faktiskt måste hålla, utan att
  // införa en härledning.
  it('överstiger hjärtslaget — annars larmar den på en FRISK motor', () => {
    expect(ATERUPPTAGNING_TYSTNAD_MAX_MS).toBeGreaterThan(HJARTSLAG_MS)
  })

  it('tolererar EN missad puls men inte TVÅ', () => {
    // En missad puls: hjärtslaget kom, nästa uteblev, tredje är på väg.
    expect(bedömTystnad(sedan(2 * HJARTSLAG_MS - 1), NU).tyst).toBe(false)
    // Två missade pulser plus marginalen — nu är det inte längre brus.
    expect(bedömTystnad(sedan(2 * HJARTSLAG_MS + 20 * 60_000), NU).tyst).toBe(true)
  })

  it('överlever det längsta MÄTTA omstartsvarvet med god marginal', () => {
    // Railway-omstart mätt till 90–165 s 2026-09-02.
    const längstaMättaAvbrott = 165_000
    expect(bedömTystnad(sedan(HJARTSLAG_MS + längstaMättaAvbrott), NU).tyst).toBe(false)
  })
})

describe('larmvägen', () => {
  let sinkAnrop: Array<{ cron: string; text: string }>
  let tjänst: ResumptionFreshnessService

  const bygg = (senaste: Date | null) => {
    sinkAnrop = []
    tjänst = Object.create(ResumptionFreshnessService.prototype) as ResumptionFreshnessService
    Object.assign(tjänst, {
      prisma: {
        aiResumptionRun: {
          findFirst: async () => (senaste ? { startedAt: senaste } : null),
        },
      },
      locks: { runIfUnlocked: async () => ({ ran: true }) },
      cronErrors: {
        report: async (cron: string, err: unknown) => {
          sinkAnrop.push({ cron, text: err instanceof Error ? err.message : String(err) })
        },
      },
      logger: { log: () => undefined, warn: () => undefined },
      senastLarmadSignatur: null,
    })
    return tjänst
  }

  it('larmar till cron-felsänkan när motorn tystnat — ingen ny kanal', async () => {
    const t = bygg(sedan(4 * 60 * 60 * 1000))
    const u: TystnadsUtfall = await t.check(NU)
    expect(u.tyst).toBe(true)
    expect(sinkAnrop).toHaveLength(1)
    expect(sinkAnrop[0]?.cron).toBe('ai-resumption-freshness')
    expect(sinkAnrop[0]?.text).toMatch(/inte skrivit en körningsrad/)
  })

  it('larmar med en EGEN text när ingen körning finns alls', async () => {
    const t = bygg(null)
    await t.check(NU)
    expect(sinkAnrop[0]?.text).toMatch(/ALDRIG skrivit/)
  })

  it('tiger om en frisk motor', async () => {
    const t = bygg(sedan(60_000))
    expect((await t.check(NU)).tyst).toBe(false)
    expect(sinkAnrop).toEqual([])
  })

  it('dämpar upprepning inom samma timme, men inte när det förvärras', async () => {
    const t = bygg(sedan(4 * 60 * 60 * 1000))
    await t.check(NU)
    await t.check(NU)
    expect(sinkAnrop).toHaveLength(1)

    // En timme djupare tystnad är ett NYTT larm — dämpningen får inte dölja att
    // tillståndet förvärras.
    await t.check(new Date(NU.getTime() + 60 * 60 * 1000))
    expect(sinkAnrop).toHaveLength(2)
  })

  it('nollställer dämpningen när motorn kommer tillbaka', async () => {
    const t = bygg(sedan(4 * 60 * 60 * 1000))
    await t.check(NU)
    expect(sinkAnrop).toHaveLength(1)

    // Motorn återhämtar sig…
    Object.assign(t, {
      prisma: { aiResumptionRun: { findFirst: async () => ({ startedAt: sedan(60_000) }) } },
    })
    await t.check(NU)
    expect(sinkAnrop).toHaveLength(1)

    // …och tystnar igen. Det ska larmas på nytt, inte dämpas bort.
    Object.assign(t, {
      prisma: {
        aiResumptionRun: { findFirst: async () => ({ startedAt: sedan(4 * 60 * 60 * 1000) }) },
      },
    })
    await t.check(NU)
    expect(sinkAnrop).toHaveLength(2)
  })
})
