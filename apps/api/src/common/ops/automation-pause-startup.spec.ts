/**
 * DRIFTPAUSEN I DET FAKTISKA STARTFÖRLOPPET — inte "en hjälpfunktion returnerar
 * false".
 *
 * ── TVÅ HALVOR, OCH VARFÖR BÅDA BEHÖVS ──────────────────────────────────────
 *
 * A. BESLUTET. `schedulerShouldRegister` är den funktion `app.module.ts`
 *    FAKTISKT anropar — inte en avskrift av dess villkor. Halvan mäter matrisen
 *    production/dev × paus/ej paus, inklusive det led som är hela skälet till
 *    att pausen behövs: `CRON_ENABLED=false` pausar INTE produktion.
 *
 * B. EFFEKTEN. Samma funktion driver ett RIKTIGT Nest-startförlopp med
 *    `ScheduleModule.forRoot()`, en riktig `@Cron` och riktiga timrar, och
 *    provet väntar FÖRBI jobbets förfallotid. Halva A kan visa att modulen
 *    utelämnas; bara halva B kan visa att ingen körning sker ändå — inte heller
 *    den allra första.
 *
 * Att `app.module.ts` verkligen går genom `schedulerShouldRegister` (och inte
 * genom en återinförd inline-variant) kan den här filen INTE se: modulen går
 * inte att importera i jest, eftersom grafen drar in `@aws-sdk/client-s3` vars
 * beroende levereras som ESM. Den riktningen bärs av
 * `apps/api/scripts/check-automation-pause.mjs`, och det står utskrivet här så
 * att nästa läsare inte tror att den här filen täcker den.
 *
 * ── KANARIEFÅGELN ───────────────────────────────────────────────────────────
 *
 * Varje pausat påstående har ett OPAUSAT motstycke, mätt med samma instrument.
 * Ett prov som bara kan säga "ingenting hände" skiljer inte en fungerande paus
 * från en trasig rigg: en @Cron som aldrig fyrar av ens i normalt läge hade gett
 * grönt på båda raderna.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigModule } from '@nestjs/config'
import { Injectable } from '@nestjs/common'
import { Cron, ScheduleModule, SchedulerRegistry } from '@nestjs/schedule'
import { Test } from '@nestjs/testing'
import { validateEnv } from '../../config/env.validation'
import { AUTOMATION_PAUSE_VAR, schedulerShouldRegister } from './automation-pause'

/** Väntar i väggklocktid. Cron-timrarna är riktiga, så tiden måste vara det. */
const vanta = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * En riktig @Cron med sekundkadens (`'* * * * * *'`, sex fält). Räknaren ÄR den
 * verksamhetseffekt provet mäter; kroppen gör med flit inget annat, så ett
 * utslag kan inte komma från något annat än schemaläggaren.
 */
@Injectable()
class ProvCron {
  korningar = 0

  @Cron('* * * * * *', { name: 'driftpaus-prov' })
  utfor(): void {
    this.korningar++
  }
}

/**
 * Bygger ett riktigt Nest-startförlopp och låter PRODUKTIONSFUNKTIONEN avgöra
 * om schemaläggaren registreras. Villkoret är alltså inte avskrivet här.
 */
async function bootaMedSchema(env: NodeJS.ProcessEnv) {
  const mod = await Test.createTestingModule({
    imports: schedulerShouldRegister(env) ? [ScheduleModule.forRoot()] : [],
    providers: [ProvCron],
  }).compile()

  // init() är det som kör @nestjs/schedules explorer och STARTAR timrarna.
  // Utan den mäter provet en modul som aldrig bootat.
  await mod.init()
  return { mod, cron: mod.get(ProvCron) }
}

describe('A. Registreringsbeslutet — produktionens egen funktion', () => {
  it('production UTAN paus registrerar — kanariefågeln', () => {
    expect(schedulerShouldRegister({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true)
  })

  it('production MED paus registrerar INTE', () => {
    expect(
      schedulerShouldRegister({
        NODE_ENV: 'production',
        [AUTOMATION_PAUSE_VAR]: 'true',
      } as NodeJS.ProcessEnv),
    ).toBe(false)
  })

  it('CRON_ENABLED=true kan INTE öppna en pausad process — grinden är omslutande', () => {
    // Den omvända formen hade varit den farliga: ett tredje ELLER-led som gjorde
    // pausen möjlig att kringgå med en dev-variabel.
    expect(
      schedulerShouldRegister({
        NODE_ENV: 'development',
        CRON_ENABLED: 'true',
        [AUTOMATION_PAUSE_VAR]: 'true',
      } as NodeJS.ProcessEnv),
    ).toBe(false)
  })

  it('CRON_ENABLED=false pausar INTE produktion — defekten som gör pausen nödvändig', () => {
    // Dokumenterar premissen. Blir raden `false` har någon ändrat
    // produktionsvillkoret, och pausens motivering måste skrivas om.
    expect(
      schedulerShouldRegister({
        NODE_ENV: 'production',
        CRON_ENABLED: 'false',
      } as NodeJS.ProcessEnv),
    ).toBe(true)
  })

  it('dev utan flaggor registrerar inte — befintligt beteende är oförändrat', () => {
    expect(schedulerShouldRegister({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false)
  })

  it('saknad variabel i produktion = oförändrad drift', () => {
    const env = { NODE_ENV: 'production' } as NodeJS.ProcessEnv
    expect(AUTOMATION_PAUSE_VAR in env).toBe(false)
    expect(schedulerShouldRegister(env)).toBe(true)
  })

  it('ett OGILTIGT värde KASTAR — boot avbryts i stället för att tyst registrera', () => {
    expect(() =>
      schedulerShouldRegister({
        NODE_ENV: 'production',
        [AUTOMATION_PAUSE_VAR]: 'ture',
      } as NodeJS.ProcessEnv),
    ).toThrow(AUTOMATION_PAUSE_VAR)
  })
})

describe('B. Effekten i ett riktigt Nest-startförlopp (riktiga timrar)', () => {
  jest.setTimeout(30_000)

  it('production UTAN paus: jobbet fyrar av inom sin kadens — kanariefågeln', async () => {
    const { mod, cron } = await bootaMedSchema({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    try {
      // Sekundkadens; 2,5 s är gott om marginal för minst en avfyrning.
      await vanta(2_500)
      expect(cron.korningar).toBeGreaterThan(0)
    } finally {
      await mod.close()
    }
  })

  it('production MED paus: INGEN körning, inte ens en, förbi förfallotiden', async () => {
    const { mod, cron } = await bootaMedSchema({
      NODE_ENV: 'production',
      [AUTOMATION_PAUSE_VAR]: 'true',
    } as NodeJS.ProcessEnv)
    try {
      // Samma väntan som kanariefågeln, alltså förbi flera förfallotider.
      await vanta(2_500)
      expect(cron.korningar).toBe(0)
    } finally {
      await mod.close()
    }
  })

  it('pausat läge ger ingen SchedulerRegistry alls — det finns ingen timer att väcka', async () => {
    const { mod } = await bootaMedSchema({
      NODE_ENV: 'production',
      [AUTOMATION_PAUSE_VAR]: 'true',
    } as NodeJS.ProcessEnv)
    try {
      expect(() => mod.get(SchedulerRegistry, { strict: false })).toThrow()
    } finally {
      await mod.close()
    }
  })

  it('normalt läge: registret bär jobbet, och en FRAMTVINGAD avfyrning har effekt', async () => {
    const { mod, cron } = await bootaMedSchema({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    try {
      const registry = mod.get(SchedulerRegistry, { strict: false })
      expect(registry.getCronJobs().size).toBeGreaterThan(0)

      // FRAMTVINGAD FÖRFALLOTID utan att vänta på klockan. I pausat läge finns
      // varken registret eller jobbet (testet ovanför), så samma väg kan då
      // per konstruktion inte ge någon verksamhetseffekt.
      const innan = cron.korningar
      await registry.getCronJob('driftpaus-prov').fireOnTick()
      expect(cron.korningar).toBeGreaterThan(innan)
    } finally {
      await mod.close()
    }
  })
})

describe('C. En HALV paus ska vara omöjlig — .env-värdet fäller boot', () => {
  /**
   * ── DEFEKTEN, OCH VARFÖR DEN INTE SYNTES I NÅGOT ANNAT PROV ────────────────
   *
   * `pausedUnless` anropas när varje kömodulfil EVALUERAS, alltså före
   * `ConfigModule.forRoot()` hunnit lägga `.env`-filens värden i `process.env`.
   * `schedulerShouldRegister`, uppstarts-backfillen och `/v1/health` läser
   * efteråt. Ett värde som bara står i `apps/api/.env` gav därför:
   *
   *     cron pausad · backfill pausad · health "paused": true
   *     ELVA BULL-KONSUMENTER REGISTRERADE OCH KONSUMERANDE
   *
   * Två oberoende granskare reproducerade det var för sig. Provet nedan kör den
   * RIKTIGA `validateEnv` genom en RIKTIG `ConfigModule.forRoot` med en riktig
   * env-fil på disk — alltså exakt den väg defekten kom in — och kräver att
   * boot faller.
   *
   * Riktningen är hela poängen: att låta `.env`-värdet tyst betyda "inte pausad"
   * hade gett en operatör som TROR att pausen gäller.
   */
  const kat = mkdtempSync(join(tmpdir(), 'driftpaus-env-'))
  const envFil = join(kat, '.env.prov')

  afterAll(() => {
    rmSync(kat, { recursive: true, force: true })
  })

  async function bootaMedEnvFil(rader: string) {
    writeFileSync(envFil, rader, 'utf8')
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: envFil,
          ignoreEnvFile: false,
          validate: validateEnv,
        }),
      ],
    }).compile()
    await mod.close()
  }

  it('KANARIEFÅGELN: en env-fil UTAN pausvariabeln bootar', async () => {
    // Utan den här raden kan nästa test inte skilja "kontrollen håller" från
    // "riggen kan inte boota alls" — fixturen saknar ju alla kritiska variabler,
    // men de är bara varningar utanför produktion.
    await expect(bootaMedEnvFil('NAGOT_ANNAT=1\n')).resolves.toBeUndefined()
  })

  it.each([['true'], ['false']])(
    "OPS_AUTOMATION_PAUSED='%s' ENBART i env-filen FÄLLER boot",
    async (varde) => {
      await expect(bootaMedEnvFil(`${AUTOMATION_PAUSE_VAR}=${varde}\n`)).rejects.toThrow(
        AUTOMATION_PAUSE_VAR,
      )
    },
  )

  it('felet pekar ut .env som orsaken, så operatören vet vad som ska rättas', async () => {
    await expect(bootaMedEnvFil(`${AUTOMATION_PAUSE_VAR}=true\n`)).rejects.toThrow('.env')
  })
})
