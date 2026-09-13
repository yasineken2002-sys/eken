/**
 * DRIFTVERKTYGETS SPÄRRAR — de delar som måste hålla INNAN verktyget rör Redis.
 *
 * Bulls faktiska beteende (global paus, bevarade jobb, återöppning) mäts mot en
 * riktig server i `common/ops/automation-pause-queue.db.spec.ts`, som också kör
 * `runQueueOps` skarpt. Den här filen mäter det som ska stoppa en körning innan
 * en enda anslutning öppnas — alltså de tre spärrar som avgör om verktyget kan
 * riktas mot fel system.
 */

import { describeTarget, redactRedisUrl, runQueueOps, scanQueueNames } from './queue-ops'
import { ALLA_KONAMN } from '../common/ops/queue-inventory'

describe('redactRedisUrl', () => {
  it('klipper bort lösenord OCH användarnamn', () => {
    const ut = redactRedisUrl('redis://default:s3cr3t@redis.internal:6379/2')
    expect(ut).not.toContain('s3cr3t')
    expect(ut).not.toContain('default')
    expect(ut).toContain('redis.internal')
  })

  it('en URL utan credentials lämnas läsbar', () => {
    expect(redactRedisUrl('redis://127.0.0.1:6379')).toContain('127.0.0.1:6379')
  })

  it('en OPARSERBAR sträng skrivs inte ut alls', () => {
    // Felriktningen: en sträng vi inte kan tolka kan mycket väl VARA en hel
    // credential. Att gissa och skriva ut den är värre än att utelämna den.
    const ut = redactRedisUrl('detta-ar-inte-en-url-men-kanske-en-hemlighet')
    expect(ut).not.toContain('hemlighet')
  })
})

describe('describeTarget', () => {
  it('bär värd, port, databasindex och prefix', () => {
    expect(describeTarget('redis://h.example:6380/3', 'bull')).toBe(
      'h.example:6380/db3 prefix=bull',
    )
  })

  it('saknad port och saknat db-index blir Redis default, inte tomt', () => {
    expect(describeTarget('redis://h.example', 'p')).toBe('h.example:6379/db0 prefix=p')
  })

  it('måltexten skiljer två prefix åt — annars vore --confirm meningslös', () => {
    expect(describeTarget('redis://h:6379', 'bull')).not.toBe(describeTarget('redis://h:6379', 'x'))
  })

  it('måltexten bär ALDRIG lösenordet — den skrivs ut och upprepas av en operatör', () => {
    expect(describeTarget('redis://u:hemlig@h:6379/1', 'bull')).not.toContain('hemlig')
  })
})

describe('confirm-spärren', () => {
  const url = 'redis://127.0.0.1:1/0' // pekar ingenstans; spärren ska slå före anslutning

  it.each([
    ['utan confirm', undefined],
    ['med fel confirm', 'något annat'],
    ['med confirm som bara liknar', '127.0.0.1:1/db0 prefix=fel'],
  ])('pause %s avbryts', async (_namn, confirm) => {
    await expect(
      runQueueOps({
        redisUrl: url,
        prefix: 'bull',
        action: 'pause',
        ...(confirm !== undefined ? { confirm } : {}),
      }),
    ).rejects.toThrow('--confirm')
  })

  it('resume bär SAMMA spärr — en återöppning är lika mycket en åtgärd som en paus', async () => {
    await expect(runQueueOps({ redisUrl: url, prefix: 'bull', action: 'resume' })).rejects.toThrow(
      '--confirm',
    )
  })

  it('felmeddelandet visar den förväntade måltexten så operatören kan läsa den', async () => {
    await expect(runQueueOps({ redisUrl: url, prefix: 'bull', action: 'pause' })).rejects.toThrow(
      '127.0.0.1:1/db0 prefix=bull',
    )
  })
})

describe('scanQueueNames', () => {
  /** Minimal SCAN-attrapp: svarar på MATCH-mönstret och avslutar med cursor 0. */
  function fakeClient(keys: readonly string[]) {
    return {
      scan: async (...a: unknown[]): Promise<[string, string[]]> => {
        const pattern = String(a[2])
        const regex = new RegExp(
          '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
        )
        return ['0', keys.filter((k) => regex.test(k))]
      },
    }
  }

  it('läser ut könamnet ur nyckeln', async () => {
    const namn = await scanQueueNames(fakeClient(['bull:psd2-sync:id', 'bull:pdf:wait']), 'bull')
    expect(namn).toEqual(['pdf', 'psd2-sync'])
  })

  it('KOLON I KÖNAMNET överlever — mail:high får inte bli "mail"', async () => {
    // Den formen är verklig (`mail:high`, `mail:normal`, `mail:low`) och är
    // skälet att namnet skalas fram från ändarna i stället för att splittas.
    const namn = await scanQueueNames(
      fakeClient(['bull:mail:high:id', 'bull:mail:low:wait']),
      'bull',
    )
    expect(namn).toEqual(['mail:high', 'mail:low'])
  })

  it('en TOM men PAUSAD kö syns via meta-paused — den har inga jobbnycklar alls', async () => {
    // Utan det suffixet hade en kö försvunnit ur inventeringen precis när den är
    // som mest intressant: pausad, tömd på väntande jobb, men fortfarande där.
    const namn = await scanQueueNames(fakeClient(['bull:ai-shadow:meta-paused']), 'bull')
    expect(namn).toEqual(['ai-shadow'])
  })

  it('namn under ETT ANNAT prefix plockas inte upp', async () => {
    const namn = await scanQueueNames(fakeClient(['annat:pdf:id', 'bull:pdf:id']), 'bull')
    expect(namn).toEqual(['pdf'])
  })
})

describe('köinventeringen', () => {
  it('bär alla elva köer appen registrerar', () => {
    // Talet står här som en KANARIEFÅGEL, inte som sanningskälla: mängden
    // härleds i queue-inventory.ts ur könamnens egna konstanter, och att koden
    // och den filen inte glidit isär bevakas av check-automation-pause.mjs.
    // Ändras antalet ska någon behöva titta.
    expect(ALLA_KONAMN).toHaveLength(11)
    expect(new Set(ALLA_KONAMN).size).toBe(ALLA_KONAMN.length)
  })

  it('innehåller de fyra som avskärmningsordningen namnger vid namn', () => {
    for (const namn of ['psd2-sync', 'mail:high', 'mail:normal', 'mail:low']) {
      expect(ALLA_KONAMN).toContain(namn)
    }
  })
})
