/**
 * KÖLIVSCYKELN UNDER DRIFTPAUS — mot RIKTIG Redis och RIKTIG Bull 4.16.5.
 *
 * ── VARFÖR INTE EN ATTRAPP ──────────────────────────────────────────────────
 *
 * Påståendena nedan handlar om vad BULL gör: att en konsument som aldrig
 * registrerats inte kan plocka ett jobb, att en GLOBAL paus (`pause(false)`,
 * alltså i Redis) gäller även en process som ansluter efteråt, och att
 * waiting/delayed överlever. Inget av det är en egenskap hos vår kod — det är en
 * egenskap hos Bull och Redis, och en attrapp hade bara mätt vad vi trodde.
 * Därför `.db.spec.ts` och därför `REDIS_URL`.
 *
 * ── PREFIXET ÄR SÄKERHETSSPÄRREN ────────────────────────────────────────────
 *
 * Varje körning får ett eget `prefix` med pid och tidsstämpel. Filen kan därför
 * inte röra en riktig kö ens om den av misstag pekas mot en delad Redis, och den
 * städar bara sina EGNA nycklar. Ingen `clean`, ingen `empty`, ingen `remove` mot
 * något annat prefix.
 *
 * Och prefixet är också ett MÄTOBJEKT: sista testet visar att en läsning mot fel
 * prefix ger noll i varje räknare medan jobben ligger kvar under det rätta. Ett
 * tomt resultat är alltså inget bevis för avskärmning — det är den vanligaste
 * formen av falskt lugn i just den här operationen.
 */

import { BullModule, InjectQueue, Process, Processor } from '@nestjs/bull'
import { Injectable } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'
import type { Queue } from 'bull'
import Bull from 'bull'
import { AUTOMATION_PAUSE_VAR, pausedUnless } from './automation-pause'
import { runQueueOps } from '../../scripts/queue-ops'

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379'
const QUEUE = 'driftpaus-prov'
const PREFIX = `test:driftpaus:${process.pid}:${Date.now()}`

/** Väggklocktid — Bull pollar Redis, så väntan måste vara verklig. */
const vanta = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Det som faktiskt KONSUMERATS, delat mellan alla modulinstanser i filen.
 * Att räknaren lever utanför Nest är poängen: den överlever en "omstart"
 * (close + ny compile) och kan därför visa att en andra process inte heller
 * förbrukade något.
 */
const konsumerat: string[] = []

@Injectable()
@Processor(QUEUE)
class ProvWorker {
  @Process()
  async utfor(job: { data: { id: string } }): Promise<void> {
    konsumerat.push(job.data.id)
  }
}

/**
 * Bulls egen bokföring över inkopplade processorer (`queue.js:704-731`). Fältet
 * är ett RUNTIME-fält och står inte i paketets typer, därav den smala castningen
 * — den är avgränsad till den här funktionen i stället för utspridd i fyra
 * assertioner.
 *
 * KASTAR om fältet saknas i stället för att falla tillbaka på `{}`. En sond som
 * tyst ger tomt när den slutat hitta det den mäter hade gjort varje pausat
 * påstående nedan grönt av BLINDHET. Att den kan ge något annat än tomt bevisas
 * av kanariefågeln i första testet.
 */
function inkoppladeHandlers(queue: Queue<{ id: string }>): string[] {
  const handlers = (queue as unknown as { handlers?: Record<string, unknown> }).handlers
  if (handlers === undefined) {
    throw new Error(
      'bull: queue.handlers saknas — sonden mäter inte längre det den tror. ' +
        'Kontrollera Bull-versionen innan något av påståendena nedan tolkas.',
    )
  }
  return Object.keys(handlers)
}

/** Injiceras bara för att komma åt den kö Nest byggde — samma instans workern fick. */
@Injectable()
class KoHandtag {
  constructor(@InjectQueue(QUEUE) readonly queue: Queue<{ id: string }>) {}
}

/**
 * Ett riktigt Nest-startförlopp med riktig Bull-kö. `pausedUnless` är
 * PRODUKTIONENS grind — den är inte avskriven här.
 */
async function bootaProcess(env: NodeJS.ProcessEnv): Promise<{
  mod: TestingModule
  queue: Queue<{ id: string }>
}> {
  const mod = await Test.createTestingModule({
    imports: [
      BullModule.forRoot({ redis: REDIS_URL, prefix: PREFIX }),
      BullModule.registerQueue({ name: QUEUE }),
    ],
    providers: [KoHandtag, ...pausedUnless(ProvWorker, env)],
  }).compile()
  // init() kör BullExplorer.onModuleInit → queue.process(...) för varje
  // registrerad @Processor. Utan den mäter provet en kö som aldrig kopplats in.
  await mod.init()
  return { mod, queue: mod.get(KoHandtag).queue }
}

const PAUSAT = { [AUTOMATION_PAUSE_VAR]: 'true' } as NodeJS.ProcessEnv
const NORMALT = { [AUTOMATION_PAUSE_VAR]: 'false' } as NodeJS.ProcessEnv

describe('Driftpaus × Bull 4.16.5 mot riktig Redis', () => {
  jest.setTimeout(60_000)

  /** Städar BARA filens egna nycklar, och bara vid slutet. */
  afterAll(async () => {
    const städare = new Bull(QUEUE, REDIS_URL, { prefix: PREFIX })
    await städare.isReady()
    const client = städare.client
    const nycklar = await client.keys(`${PREFIX}:*`)
    if (nycklar.length > 0) await client.del(...nycklar)
    await städare.close()
  })

  it('KANARIEFÅGELN: i normalt läge registreras en handler och jobbet konsumeras', async () => {
    const { mod, queue } = await bootaProcess(NORMALT)
    try {
      // `queue.handlers` är Bulls egen bokföring över inkopplade processorer
      // (queue.js:704-731). Tom = processen kan inte plocka något jobb.
      expect(inkoppladeHandlers(queue).length).toBeGreaterThan(0)

      await queue.add({ id: 'kanarie-1' })
      await vanta(1_500)

      expect(konsumerat).toContain('kanarie-1')
      const counts = await queue.getJobCounts()
      expect(counts.completed).toBeGreaterThan(0)
    } finally {
      await mod.close()
    }
  })

  it('pausat läge: INGEN handler kopplas in — konsumtion är strukturellt omöjlig', async () => {
    const { mod, queue } = await bootaProcess(PAUSAT)
    try {
      expect(inkoppladeHandlers(queue)).toEqual([])
    } finally {
      await mod.close()
    }
  })

  it('pausat läge: väntande och fördröjda jobb BEVARAS — inte klarmarkerade, inte tappade', async () => {
    const { mod, queue } = await bootaProcess(PAUSAT)
    const föreCompleted = (await queue.getJobCounts()).completed
    try {
      await queue.add({ id: 'väntande-1' })
      await queue.add({ id: 'väntande-2' })
      await queue.add({ id: 'fördröjd-1' }, { delay: 60_000 })

      // Gott om tid för en opausad konsument att hinna plocka allt.
      await vanta(2_000)

      const counts = await queue.getJobCounts()
      expect(counts.waiting).toBe(2)
      expect(counts.delayed).toBe(1)
      expect(counts.active).toBe(0)
      // DEN VIKTIGASTE RADEN: pausen får inte kvittera jobb som klara.
      expect(counts.completed).toBe(föreCompleted)
      expect(counts.failed).toBe(0)

      expect(konsumerat).not.toContain('väntande-1')
      expect(konsumerat).not.toContain('väntande-2')
    } finally {
      await mod.close()
    }
  })

  it('OMSTART i pausat läge förbrukar fortfarande ingenting', async () => {
    // Samma Redis, samma prefix, ny processinstans — exakt formen "Railway
    // startade om containern mitt i underhållsfönstret".
    const { mod, queue } = await bootaProcess(PAUSAT)
    try {
      expect(inkoppladeHandlers(queue)).toEqual([])
      await vanta(1_500)
      const counts = await queue.getJobCounts()
      expect(counts.waiting).toBe(2)
      expect(counts.delayed).toBe(1)
      expect(konsumerat).not.toContain('väntande-1')
    } finally {
      await mod.close()
    }
  })

  it('en GLOBAL paus gäller även en process som ansluter EFTERÅT — och återupptas inte av den', async () => {
    // Driftverktygets åtgärd: global paus i Redis, utan Nest.
    const verktyg = new Bull(QUEUE, REDIS_URL, { prefix: PREFIX })
    await verktyg.isReady()
    await verktyg.pause(false)
    expect(await verktyg.isPaused(false)).toBe(true)

    // Och nu startar en NY process i NORMALT läge — alltså med konsumenten
    // registrerad. Den får inte häva den globala pausen, och får inte
    // konsumera. Det är den farligaste formen: en omstart mitt i ett
    // underhållsfönster som tyst öppnar köerna igen.
    const { mod, queue } = await bootaProcess(NORMALT)
    try {
      expect(inkoppladeHandlers(queue).length).toBeGreaterThan(0)
      await queue.add({ id: 'under-global-paus' })
      await vanta(2_000)

      expect(await verktyg.isPaused(false)).toBe(true)
      expect(konsumerat).not.toContain('under-global-paus')
      expect(konsumerat).not.toContain('väntande-1')
    } finally {
      await mod.close()
      await verktyg.close()
    }
  })

  it('UTTRYCKLIG återöppning bearbetar de bevarade jobben enligt befintlig semantik', async () => {
    const verktyg = new Bull(QUEUE, REDIS_URL, { prefix: PREFIX })
    await verktyg.isReady()
    expect(await verktyg.isPaused(false)).toBe(true)

    const { mod, queue } = await bootaProcess(NORMALT)
    try {
      // Återöppningen är ETT uttryckligt handgrepp, skilt från healthcheck,
      // timeout och omstart — ingen av dem gjorde det ovan.
      await verktyg.resume(false)
      expect(await verktyg.isPaused(false)).toBe(false)

      await vanta(3_000)

      // De två väntande OCH det som köades under pausen ska nu vara körda.
      // Den fördröjda ligger kvar tills dess tid är inne — befintlig semantik,
      // inte något pausen ändrade.
      expect(konsumerat).toContain('väntande-1')
      expect(konsumerat).toContain('väntande-2')
      expect(konsumerat).toContain('under-global-paus')
      expect(konsumerat).not.toContain('fördröjd-1')

      const counts = await queue.getJobCounts()
      expect(counts.delayed).toBe(1)
      expect(counts.failed).toBe(0)
    } finally {
      await mod.close()
      await verktyg.close()
    }
  })

  it('ett REDAN AKTIVT jobb rapporteras som aktivt vid paus och körs klart — paus ≠ stoppat', async () => {
    // Formen är den som avskärmningsordningen kallar incidentfallet: `pause()`
    // returnerar, men ett jobb var redan igång. Att kalla det stoppat bara för
    // att paus anropats är precis felet.
    const kö = new Bull<{ id: string }>(QUEUE, REDIS_URL, { prefix: PREFIX })
    await kö.isReady()
    await kö.resume(false)

    let startat = false
    let slutfört = false
    let slappLoss: () => void = () => {}
    const håller = new Promise<void>((r) => {
      slappLoss = r
    })

    kö.process(async () => {
      startat = true
      await håller
      slutfört = true
    })

    await kö.add({ id: 'långkörare' })
    await vanta(1_000)
    expect(startat).toBe(true)

    // GLOBAL paus MEDAN jobbet kör. `doNotWaitActive = true` gör att anropet
    // återvänder utan att invänta det aktiva jobbet — annars hade provet hängt
    // på sitt eget jobb, vilket också är svaret på varför en operatör inte kan
    // tolka ett returnerat `pause()` som "allt arbete är stoppat".
    await kö.pause(false, true)
    expect(await kö.isPaused(false)).toBe(true)

    const underPaus = await kö.getJobCounts()
    expect(underPaus.active).toBe(1)
    expect(slutfört).toBe(false)

    // Jobbet körs klart — pausen avbröt det inte, och fick inte göra det.
    slappLoss()
    await vanta(1_500)
    expect(slutfört).toBe(true)

    await kö.close()
  })

  it('FEL PREFIX ger noll i varje räknare — ett tomt resultat bevisar ingen avskärmning', async () => {
    // Den vanligaste formen av falskt lugn i den här operationen: verktyget
    // pekas mot fel prefix (eller fel Redis-databas), svarar noll överallt, och
    // noll läses som "inga jobb kvar" eller "ingen paus behövs".
    //
    // DISKRIMINERANDE PAR. Testet ovanför lämnade kön GLOBALT PAUSAD med ett
    // fördröjt jobb kvar. Samma två frågor ställs nu mot båda prefixen, och de
    // ska ge OLIKA svar — annars mäter provet ingenting.
    const rättKö = new Bull(QUEUE, REDIS_URL, { prefix: PREFIX })
    const felKö = new Bull(QUEUE, REDIS_URL, { prefix: `${PREFIX}:fel-prefix` })
    try {
      await Promise.all([rättKö.isReady(), felKö.isReady()])

      const rätt = await rättKö.getJobCounts()
      expect(rätt.delayed).toBe(1) // jobbet ligger BEVISLIGEN kvar
      expect(await rättKö.isPaused(false)).toBe(true) // pausen ligger BEVISLIGEN kvar

      const fel = await felKö.getJobCounts()
      expect(fel).toEqual({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 })
      // Och pausflaggan syns inte heller. Ett verktyg som pekats fel rapporterar
      // alltså "inga jobb, ingen paus" om ett system som har båda delarna.
      expect(await felKö.isPaused(false)).toBe(false)

      // Repeatables: appen registrerar inga i dag (inget `repeat:` i
      // produktionskoden), och läsningen ska visa DET talet, inte anta det.
      expect(await rättKö.getRepeatableJobs(0, -1, true)).toHaveLength(0)
    } finally {
      // Stängs i finally: en öppen ioredis-anslutning hindrar jest från att
      // avsluta, och en svit som hänger ser ut som en trasig grind i CI.
      await Promise.all([felKö.close(), rättKö.close()])
    }
  })
})

/**
 * DRIFTVERKTYGET SKARPT — samma Redis, eget prefix.
 *
 * Verktygets spärrar (redigering, måltext, --confirm) mäts utan server i
 * `scripts/queue-ops.spec.ts`. Här mäts det som bara en riktig server kan svara
 * på: att `--action=pause` verkligen sätter den GLOBALA flaggan, att jobben står
 * kvar efteråt, och att en ofullständig inventering rapporteras som just det.
 *
 * Prefixet är ett EGET (`:verktyg`) och inte filens andra prefix, så testerna
 * ovan inte kan bli beroende av körordningen.
 */
describe('queue-ops mot riktig Redis', () => {
  jest.setTimeout(60_000)

  const VERKTYGSPREFIX = `${PREFIX}:verktyg`
  const KO_A = 'mail:high'
  const KO_B = 'psd2-sync'

  afterAll(async () => {
    const städare = new Bull(KO_A, REDIS_URL, { prefix: VERKTYGSPREFIX })
    await städare.isReady()
    const nycklar = await städare.client.keys(`${VERKTYGSPREFIX}:*`)
    if (nycklar.length > 0) await städare.client.del(...nycklar)
    await städare.close()
  })

  it('pausar globalt, BEVARAR jobben och rapporterar en ofullständig inventering som sådan', async () => {
    const köA = new Bull(KO_A, REDIS_URL, { prefix: VERKTYGSPREFIX })
    const köB = new Bull(KO_B, REDIS_URL, { prefix: VERKTYGSPREFIX })
    try {
      await Promise.all([köA.isReady(), köB.isReady()])
      await köA.add({ id: 'verktyg-1' })
      await köB.add({ id: 'verktyg-2' }, { delay: 600_000 })

      const mål = `${new URL(REDIS_URL).hostname}:${new URL(REDIS_URL).port || '6379'}/db0 prefix=${VERKTYGSPREFIX}`

      // LÄSLÄGE FÖRST — och det ska inte skriva något.
      const läst = await runQueueOps({
        redisUrl: REDIS_URL,
        prefix: VERKTYGSPREFIX,
        action: 'inspect',
        queues: [KO_A, KO_B],
      })
      expect(läst.target).toBe(mål)
      expect(läst.atgardade).toEqual([])
      expect(läst.queues.every((q) => !q.pausedGlobally)).toBe(true)
      // Två av elva köer begärdes: helhetsbedömningen MÅSTE vara ofullständig,
      // annars kunde ett avgränsat svep redovisas som full avskärmning.
      expect(läst.inventeringKomplett).toBe(false)
      expect(läst.bullVersion).toMatch(/^4\./)

      // ÅTGÄRD — med måltexten ur läsläget, alltså precis det handgrepp
      // avskärmningsordningen beskriver.
      const pausat = await runQueueOps({
        redisUrl: REDIS_URL,
        prefix: VERKTYGSPREFIX,
        action: 'pause',
        queues: [KO_A, KO_B],
        confirm: läst.target,
      })
      expect(pausat.atgardade.sort()).toEqual([KO_A, KO_B].sort())
      expect(pausat.queues.every((q) => q.pausedGlobally)).toBe(true)

      // Jobben finns kvar. Ingen är klarmarkerad, ingen är borta.
      const a = pausat.queues.find((q) => q.name === KO_A)!
      const b = pausat.queues.find((q) => q.name === KO_B)!
      expect((a.counts.waiting ?? 0) + (a.counts.paused ?? 0)).toBe(1)
      expect(b.counts.delayed).toBe(1)
      expect(a.counts.completed).toBe(0)
      expect(b.counts.failed).toBe(0)

      // Och ingen konsument i den här processen förbrukade något.
      expect(konsumerat).not.toContain('verktyg-1')
      expect(konsumerat).not.toContain('verktyg-2')

      // ÅTERÖPPNING är ett eget, lika uttryckligt handgrepp.
      const återöppnat = await runQueueOps({
        redisUrl: REDIS_URL,
        prefix: VERKTYGSPREFIX,
        action: 'resume',
        queues: [KO_A, KO_B],
        confirm: läst.target,
      })
      expect(återöppnat.queues.every((q) => !q.pausedGlobally)).toBe(true)
    } finally {
      await Promise.all([köA.close(), köB.close()])
    }
  })

  it('en kö i Redis som koden INTE känner till fäller inventeringen', async () => {
    // Den farliga riktningen: en konsument inventeringen missat, eller en gammal
    // generation mot samma Redis. Ett sådant fynd gör utfallet obrukbart som
    // avskärmningsbevis, och verktyget ska säga det själv.
    const okänd = new Bull('en-ko-koden-inte-kanner', REDIS_URL, { prefix: VERKTYGSPREFIX })
    try {
      await okänd.isReady()
      await okänd.add({ id: 'okänd-1' })

      const resultat = await runQueueOps({
        redisUrl: REDIS_URL,
        prefix: VERKTYGSPREFIX,
        action: 'inspect',
      })
      expect(resultat.okandaIRedis).toContain('en-ko-koden-inte-kanner')
      expect(resultat.inventeringKomplett).toBe(false)
    } finally {
      await okänd.close()
    }
  })
})
