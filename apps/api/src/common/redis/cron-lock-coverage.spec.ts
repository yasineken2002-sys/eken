/**
 * VAKT: de replik-känsliga cron-jobben ska faktiskt vara låsta.
 *
 * Testet ovanför (`cron-lock.spec.ts`) bevisar att MEKANIKEN fungerar. Det säger
 * ingenting om att den är PÅKOPPLAD. Ett lås som finns men inte används är
 * precis den sorts åtgärd som ser klar ut i backloggen.
 *
 * ── VARFÖR EN LISTA OCH INTE ETT SVEP ÖVER ALLA @Cron ───────────────────────
 *
 * Kodbasen har ett tjugotal cron-jobb, och de flesta behöver inget lås: de
 * arbetar mot en databasmarkör som gör en andra körning till en no-op
 * (`markOverdueInvoices` flippar redan flippade rader till samma värde), eller
 * mot ett tidsfönster som ger samma resultat oavsett hur många gånger det körs
 * (gallringen, sessionsstädningen).
 *
 * De fyra nedan är de som INTE har den egenskapen, och listan är därför en
 * medveten uppräkning — inte ett svep. Den som lägger till ett femte jobb med
 * en yttre biverkning som inte är idempotent ska lägga till det här.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', '..')

interface Guarded {
  file: string
  method: string
  lockKey: string
  why: string
}

const GUARDED_CRONS: Guarded[] = [
  {
    file: 'notifications/notifications.service.ts',
    method: 'sendMorningInsights',
    lockKey: 'cron:morning-insights',
    why: 'AI-anropet ligger före utskicket och är oskyddat av idempotensnyckeln',
  },
  {
    file: 'notifications/notifications.service.ts',
    method: 'sendWeeklySummary',
    lockKey: 'cron:weekly-summary',
    why: 'samma — dubbel körning ger dubbel AI-kostnad',
  },
  {
    file: 'notifications/notifications.service.ts',
    method: 'sendMonthlyReport',
    lockKey: 'cron:monthly-report',
    why: 'samma',
  },
  {
    file: 'tenant-portal/tenant-auth.service.ts',
    method: 'sendActivationReminders',
    lockKey: 'cron:tenant-activation-reminders',
    why: 'token roteras per körning → olika idempotensnycklar → TVÅ mejl och en död länk',
  },
]

describe('replik-känsliga cron-jobb är låsta', () => {
  it.each(GUARDED_CRONS)('$method tar cron-låset ($lockKey)', ({ file, method, lockKey }) => {
    const source = readFileSync(join(SRC, file), 'utf8')

    // Metoden finns kvar under sitt namn …
    expect(source).toContain(`async ${method}(): Promise<void> {`)
    // … den delegerar till runIfUnlocked med rätt nyckel …
    expect(source).toMatch(new RegExp(`runIfUnlocked\\(\\s*'${lockKey}'`))
    // … och det verkliga arbetet ligger i en egen metod, så låset inte går att
    // kringgå genom att anropa jobbet direkt.
    expect(source).toContain(`private async ${method}Unsafe(): Promise<void> {`)
  })

  it('varje låst jobb loggar när det hoppar över', () => {
    // Ett tyst överhopp är oskiljbart från "cronen kördes aldrig", och det är
    // exakt den tvetydighet låset annars inför.
    for (const { file, lockKey } of GUARDED_CRONS) {
      const source = readFileSync(join(SRC, file), 'utf8')
      expect(source).toContain(`[${lockKey}]`)
    }
  })

  it('parsern läser faktiskt filerna (rimlighetsgolv)', () => {
    // Utan detta kan en felstavad sökväg ge tom sträng och varje toContain
    // ovan bli grön genom att inte mäta något.
    for (const { file } of GUARDED_CRONS) {
      expect(readFileSync(join(SRC, file), 'utf8').length).toBeGreaterThan(1000)
    }
  })
})

describe('KANARIEFÅGEL — vakten faller när ett lås tas bort', () => {
  it('en påhittad låsnyckel finns inte i källan', () => {
    // Samma jämförelse som testerna ovan, men med en nyckel som bevisligen inte
    // finns. Ger den träff mäter kontrollen inte det den påstår.
    const source = readFileSync(join(SRC, 'notifications/notifications.service.ts'), 'utf8')
    expect(source).not.toMatch(/runIfUnlocked\(\s*'cron:gdpr-canary-job'/)
  })
})
