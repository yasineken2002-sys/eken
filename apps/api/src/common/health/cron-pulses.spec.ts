import { Logger } from '@nestjs/common'
import { LASTA_CRON_JOBB, tröskelSek } from '../cron/cron-heartbeat'

/**
 * `/v1/health`-fältet `cron` (#710).
 *
 * ── VARFÖR MODULEN LADDAS OM PER PROV ───────────────────────────────────────
 *
 * `BOOT_AT` fångas vid MODULLADDNING. Ett prov som vill mäta "jobbet har aldrig
 * kört, men vi bootade nyss" måste därför styra tiden INNAN modulen läses in —
 * annars är boot-tiden provsvitens start och inte den vi valde. `isolateModules`
 * plus fejkad systemtid ger den kontrollen.
 */

type Rad = { key: string; lastRunAt: Date; lastOutcome: string }

const NU = new Date('2026-09-04T12:00:00.000Z')

/** Bygger controllern med en Prisma-stubb, med modulen laddad vid `bootAt`. */
async function pulser(bootAt: Date, nu: Date, rader: Rad[] | Error) {
  jest.useFakeTimers()
  jest.setSystemTime(bootAt)
  let resultat: unknown
  await jest.isolateModulesAsync(async () => {
    const { HealthController } = (await import('./health.controller')) as {
      HealthController: new (...a: never[]) => unknown
    }
    const ctrl = Object.create(HealthController.prototype) as {
      prisma: unknown
      logger: Logger
      readCronPulses: () => Promise<unknown>
    }
    ctrl.logger = new Logger('test')
    ctrl.prisma = {
      cronHeartbeat: {
        findMany: () => (rader instanceof Error ? Promise.reject(rader) : Promise.resolve(rader)),
      },
    }
    jest.setSystemTime(nu)
    resultat = await ctrl.readCronPulses()
  })
  jest.useRealTimers()
  return resultat as {
    bootAt: string
    staleCount: number
    jobs: Record<
      string,
      {
        lastRunAt: string | null
        ageSec: number | null
        thresholdSec: number
        stale: boolean
        lastOutcome: string | null
      }
    >
  }
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('cron-fältet', () => {
  it('rapporterar EXAKT de tio låsta jobben — mängden är kartans, inte tabellens', async () => {
    // Kärnan: läste vi tabellen och listade det vi hittade hade ett jobb som
    // slutat köra FÖRSVUNNIT ur fältet i stället för att bli rött. Det är
    // precis den tystnad ärendet handlar om.
    const p = await pulser(NU, NU, [])
    expect(Object.keys(p.jobs).sort()).toEqual(Object.keys(LASTA_CRON_JOBB).sort())
    expect(Object.keys(p.jobs)).toHaveLength(10)
  })

  it('ALDRIG KÖRT är inte stale under första intervallet efter boot', async () => {
    // Ett dagligt jobb är inte tyst fem minuter efter en deploy — det har bara
    // inte hunnit. Utan det här hade varje omstart gett tio falsklarm.
    // Tiden HÄRLEDS ur den MINSTA tröskeln, inte gissas: minutjobben har
    // tröskel 135 s, så "fem minuter efter boot" hade gjort dem tysta och
    // provet hade fällt på rätt beteende. Halva minsta tröskeln är inom
    // första intervallet för samtliga tio.
    const minstaTröskel = Math.min(...Object.values(LASTA_CRON_JOBB).map((u) => tröskelSek(u)))
    const strax = new Date(NU.getTime() + (minstaTröskel / 2) * 1000)
    const p = await pulser(NU, strax, [])
    const dagligt = p.jobs['cron:daily-backup']
    expect(dagligt?.lastRunAt).toBeNull()
    expect(dagligt?.ageSec).toBeNull()
    expect(dagligt?.lastOutcome).toBeNull()
    expect(dagligt?.stale).toBe(false)
    expect(p.staleCount).toBe(0)
  })

  it('ALDRIG KÖRT blir stale när boot-åldern passerat tröskeln', async () => {
    // Den omvända riktningen: "aldrig kört" får inte vara en evig frikort.
    // Och här härleds tiden ur den STÖRSTA tröskeln: månadsjobbet tål 31 × 2,25
    // dygn, så en tid satt efter dygnströskeln hade gett 7 av 10 — vilket är
    // rätt beteende men fel prov.
    const störstaTröskel = Math.max(...Object.values(LASTA_CRON_JOBB).map((u) => tröskelSek(u)))
    const långtEfter = new Date(NU.getTime() + (störstaTröskel + 60) * 1000)
    const p = await pulser(NU, långtEfter, [])
    expect(p.jobs['cron:daily-backup']?.stale).toBe(true)
    // NU är alla tio tysta — ingen har någonsin skrivit, och även det
    // tåligaste jobbets tröskel har passerats.
    expect(p.staleCount).toBe(10)
  })

  it('beräknar ageSec och stale mot den injicerade tiden', async () => {
    const tröskel = tröskelSek('0 3 * * *')
    const färsk = new Date(NU.getTime() - 3600 * 1000)
    const gammal = new Date(NU.getTime() - (tröskel + 60) * 1000)
    const p = await pulser(new Date(NU.getTime() - 30 * 86_400_000), NU, [
      { key: 'cron:daily-backup', lastRunAt: färsk, lastOutcome: 'success' },
      { key: 'cron:leases-lifecycle', lastRunAt: gammal, lastOutcome: 'success' },
    ])
    expect(p.jobs['cron:daily-backup']?.ageSec).toBe(3600)
    expect(p.jobs['cron:daily-backup']?.stale).toBe(false)
    expect(p.jobs['cron:leases-lifecycle']?.stale).toBe(true)
  })

  it('bär utfallet — ett jobb som kastar är inte tyst, men inte friskt heller', async () => {
    const p = await pulser(NU, NU, [
      { key: 'cron:daily-backup', lastRunAt: NU, lastOutcome: 'failed' },
    ])
    expect(p.jobs['cron:daily-backup']?.lastOutcome).toBe('failed')
    // Färskt OCH failed: `stale` är falskt, och det är rätt — de svarar på
    // olika frågor. Utfallet är det som skiljer dem åt.
    expect(p.jobs['cron:daily-backup']?.stale).toBe(false)
  })

  it('staleCount räknar bara de tysta', async () => {
    const tröskel = tröskelSek('0 3 * * *')
    const gammal = new Date(NU.getTime() - (tröskel + 60) * 1000)
    const p = await pulser(new Date(NU.getTime() - 400 * 86_400_000), NU, [
      ...Object.keys(LASTA_CRON_JOBB).map((key) => ({
        key,
        lastRunAt: NU,
        lastOutcome: 'success',
      })),
    ])
    expect(p.staleCount).toBe(0)
    const p2 = await pulser(new Date(NU.getTime() - 400 * 86_400_000), NU, [
      ...Object.keys(LASTA_CRON_JOBB).map((key, i) => ({
        key,
        lastRunAt: i === 0 ? gammal : NU,
        lastOutcome: 'success',
      })),
    ])
    expect(p2.staleCount).toBe(1)
  })

  it('en läsning som kastar ger inget FRISKINTYG', async () => {
    // Fail-open på läsningen, inte på bedömningen: utan rader vet vi inget, och
    // att då påstå stale:false vore ett intyg vi saknar täckning för.
    const långtEfter = new Date(NU.getTime() + 400 * 86_400_000)
    const p = await pulser(NU, långtEfter, new Error('db nere'))
    expect(p.staleCount).toBe(10)
  })
})
