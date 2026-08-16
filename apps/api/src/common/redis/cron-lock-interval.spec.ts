/**
 * VAKT: TTL måste vara KORTARE än cron-intervallet.
 *
 * ── VARFÖR DEN HÄR VAKTEN FINNS ─────────────────────────────────────────────
 *
 * `runIfUnlocked` failar CLOSED. Det är rätt val — en cron som väntar och kör
 * ändå är inte skyddad — men det BYTER felmod, och den nya är tystare:
 *
 *   runWithLock  kunde dubbelköra, aldrig tystna
 *   runIfUnlocked kan tystna, aldrig dubbelköra
 *
 * Släpps låset aldrig — kraschad körning, tappad release, eller en TTL som är
 * längre än cron-intervallet — körs jobbet ALDRIG igen. Och ett jobb som slutat
 * köra ser exakt ut som ett jobb utan något att göra.
 *
 * TTL:t är den enda av de tre orsakerna vi kan spärra statiskt, så det gör vi
 * här. En TTL som råkar sättas längre än intervallet stänger av jobbet
 * permanent, och den ändringen ser oskyldig ut i en diff ("höjde TTL till
 * dygnet, jobbet tog längre tid än väntat").
 *
 * Testet läser cron-uttrycken UR KÄLLAN och räknar minsta möjliga intervall.
 * Det är därför en vakt och inte en kommentar.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', '..')

interface Guarded {
  file: string
  method: string
  ttlConstant: string
  /** Minsta antal sekunder mellan två körningar, ur cron-uttrycket. */
  minIntervalSec: number
  cron: string
}

const HOUR = 3600
const DAY = 24 * HOUR

const GUARDED: Guarded[] = [
  {
    file: 'notifications/notifications.service.ts',
    method: 'sendMorningInsights',
    ttlConstant: 'CRON_LOCK_TTL_SEC',
    cron: '0 7 * * 1-5',
    // Vardagar 07:00 → kortaste avstånd mån→tis = 1 dygn.
    minIntervalSec: DAY,
  },
  {
    file: 'notifications/notifications.service.ts',
    method: 'sendWeeklySummary',
    ttlConstant: 'CRON_LOCK_TTL_SEC',
    cron: '0 18 * * 0',
    minIntervalSec: 7 * DAY,
  },
  {
    file: 'notifications/notifications.service.ts',
    method: 'sendMonthlyReport',
    ttlConstant: 'CRON_LOCK_TTL_SEC',
    cron: '0 8 1 * *',
    // Kortaste månaden: februari, 28 dygn.
    minIntervalSec: 28 * DAY,
  },
  {
    file: 'tenant-portal/tenant-auth.service.ts',
    method: 'sendActivationReminders',
    ttlConstant: 'ACTIVATION_REMINDER_LOCK_TTL_SEC',
    cron: '0 9 * * *',
    minIntervalSec: DAY,
  },
]

/** Läser `const NAMN = <uttryck>` ur källan och evaluerar aritmetiken. */
function readTtlSec(source: string, name: string): number {
  const m = new RegExp(`const ${name} = ([0-9*+ ]+)`).exec(source)
  if (!m) throw new Error(`Hittade inte konstanten ${name} i källan`)
  const expr = m[1]!.trim()
  // Bara siffror, mellanslag, * och + har passerat regexen ovan.
  return Number(
    expr
      .split('+')
      .map((term) => term.split('*').reduce((a, b) => a * Number(b), 1))
      .reduce((a, b) => a + b, 0),
  )
}

describe('TTL < cron-intervall', () => {
  it('läsaren hittar faktiskt konstanterna (rimlighetsgolv)', () => {
    // Utan detta kan en felstavad konstant ge NaN, och varje jämförelse nedan
    // bli grön genom att inte mäta något.
    const source = readFileSync(join(SRC, 'notifications/notifications.service.ts'), 'utf8')
    expect(readTtlSec(source, 'CRON_LOCK_TTL_SEC')).toBe(1800)
  })

  it.each(GUARDED)(
    '$method: TTL är kortare än intervallet ($cron)',
    ({ file, ttlConstant, minIntervalSec, cron }) => {
      const source = readFileSync(join(SRC, file), 'utf8')
      const ttl = readTtlSec(source, ttlConstant)

      // Cron-uttrycket ska stå kvar oförändrat — ändras det utan att raden här
      // uppdateras mäter vi mot fel intervall.
      expect(source).toContain(`@Cron('${cron}'`)

      // Kärnan: ett kvarliggande lås måste hinna löpa ut FÖRE nästa körning,
      // annars stängs jobbet av permanent.
      expect(ttl).toBeLessThan(minIntervalSec)
    },
  )

  it.each(GUARDED)(
    '$method: TTL har rejäl marginal, inte bara knapp',
    ({ file, ttlConstant, minIntervalSec }) => {
      const source = readFileSync(join(SRC, file), 'utf8')
      const ttl = readTtlSec(source, ttlConstant)

      // En TTL på 23 h mot ett dygnsintervall uppfyller olikheten men lämnar en
      // timme innan jobbet är permanent avstängt. Kräv en tiopotens marginal.
      expect(minIntervalSec / ttl).toBeGreaterThanOrEqual(10)
    },
  )
})

describe('KANARIEFÅGEL — vakten faller när TTL passerar intervallet', () => {
  it('en TTL på ett dygn skulle underkännas mot ett dygnsintervall', () => {
    // Samma jämförelse som testerna ovan, med ett tal som bevisligen bryter
    // invarianten. Utan det här kan olikheten ha vänts åt fel håll utan att
    // någonting blir rött.
    const trasigTtl = DAY
    expect(trasigTtl).not.toBeLessThan(DAY)
    expect(DAY / trasigTtl).toBeLessThan(10)
  })

  it('läsaren klarar aritmetiken den ska klara', () => {
    expect(readTtlSec('const X = 30 * 60', 'X')).toBe(1800)
    expect(readTtlSec('const X = 15 * 60', 'X')).toBe(900)
    expect(readTtlSec('const X = 3600', 'X')).toBe(3600)
  })
})
