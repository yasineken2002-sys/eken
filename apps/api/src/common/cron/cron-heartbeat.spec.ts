import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LASTA_CRON_JOBB, TYSTNAD_FAKTOR, maxIntervallSek, tröskelSek } from './cron-heartbeat'

/**
 * HÄRLEDNINGEN AV DE TIO, OCH TRÖSKELN PER JOBB (#710).
 *
 * `LASTA_CRON_JOBB` är en avskrift: nycklarna kommer ur ack-filens A-klass,
 * uttrycken ur `@Cron`-dekoratorerna i källan. En avskrift som ingen prövar är
 * en andra uppräkning som glider isär tyst — och den skulle glida åt det
 * farliga hållet: ett jobb som försvinner ur kartan slutar bevakas utan att
 * något blir rött.
 *
 * Proven nedan HÄRLEDER båda mängderna ur källan och kräver identitet.
 */

const API_ROOT = join(__dirname, '..', '..', '..')
const ACK = join(API_ROOT, 'scripts', 'cron-classification.ack.json')

/** A-klassade jobb ur ack-filen: lockKey → filsökväg::metod. */
function aJobbUrAck(text: string): Record<string, string> {
  const d = JSON.parse(text) as {
    jobs: Record<string, { class: string; lockKey?: string }>
  }
  const ut: Record<string, string> = {}
  for (const [plats, v] of Object.entries(d.jobs)) {
    if (v.class !== 'A') continue
    if (!v.lockKey) throw new Error(`A-jobbet ${plats} saknar lockKey i ack-filen`)
    ut[v.lockKey] = plats
  }
  return ut
}

/** `@Cron(...)`-uttrycket närmast FÖRE metoden, ur källfilen. */
function cronUttryck(plats: string): string {
  const [fil, metod] = plats.split('::') as [string, string]
  const källa = readFileSync(join(API_ROOT, 'src', fil), 'utf8')
  const i = källa.indexOf(`${metod}(`)
  if (i === -1) throw new Error(`hittade inte metoden ${metod} i ${fil}`)
  const träffar = [...källa.slice(0, i).matchAll(/@Cron\(\s*([^,)]*)/g)]
  const sista = träffar[träffar.length - 1]
  if (!sista) throw new Error(`hittade inget @Cron före ${metod} i ${fil}`)
  const rå = (sista[1] ?? '').trim()
  // `CronExpression.EVERY_MINUTE` och namngivna konstanter löses upp mot sitt
  // värde; allt annat är en literal med citattecken.
  if (rå === 'CronExpression.EVERY_MINUTE') return '* * * * *'
  const literal = /^'([^']+)'$/.exec(rå)
  if (literal) return literal[1] as string
  // Namngiven konstant i samma fil, t.ex. `KADENS`.
  const konst = new RegExp(`const\\s+${rå}\\s*=\\s*'([^']+)'`).exec(källa)
  if (konst) return konst[1] as string
  throw new Error(`kunde inte lösa upp @Cron-argumentet "${rå}" i ${fil}`)
}

describe('LASTA_CRON_JOBB — härledd, inte listad', () => {
  const aJobb = aJobbUrAck(readFileSync(ACK, 'utf8'))

  it('täcker EXAKT ack-filens A-klassade jobb', () => {
    // Åt båda hållen: ett nytt A-jobb som saknas i kartan är lika rött som en
    // nyckel i kartan som inte längre är A-klassad.
    expect(Object.keys(LASTA_CRON_JOBB).sort()).toEqual(Object.keys(aJobb).sort())
  })

  it('mängden är elva — och talet står i provet, inte bara i prosan', () => {
    // Tio till 2026-09-05, då skuggsvepet (etapp 6) blev det elfte låsta jobbet.
    // Talet står här och inte bara i prosan därför att ett tolfte jobb ska fälla
    // provet tills kartan följt med — det är hela poängen med härledningen.
    expect(Object.keys(aJobb)).toHaveLength(11)
  })

  it('varje uttryck är en korrekt avskrift av källans @Cron', () => {
    for (const [key, plats] of Object.entries(aJobb)) {
      expect(`${key} → ${LASTA_CRON_JOBB[key]}`).toBe(`${key} → ${cronUttryck(plats)}`)
    }
  })

  it('KANARIEFÅGEL: ett elfte A-jobb gör härledningen röd', () => {
    // Utan det här provet kan man inte skilja "kartan stämmer" från "provet
    // jämför två kopior av samma lista". Fixturen lägger till ett A-jobb och
    // kräver att mängden VÄXER — alltså att härledningen läser ack-filen och
    // inte kartan.
    const fixtur = JSON.stringify({
      jobs: {
        ...Object.fromEntries(
          Object.entries(aJobb).map(([k, v]) => [v, { class: 'A', lockKey: k }]),
        ),
        'zz/sond.service.ts::elfte': { class: 'A', lockKey: 'cron:zz-sond' },
      },
    })
    const utökad = aJobbUrAck(fixtur)
    expect(Object.keys(utökad)).toHaveLength(Object.keys(aJobb).length + 1)
    expect(Object.keys(LASTA_CRON_JOBB).sort()).not.toEqual(Object.keys(utökad).sort())
  })
})

describe('maxIntervallSek — MAX, inte medel', () => {
  it('varje minut och var N:e minut', () => {
    expect(maxIntervallSek('* * * * *')).toBe(60)
    expect(maxIntervallSek('*/15 * * * *')).toBe(900)
  })

  it('dagligen', () => {
    expect(maxIntervallSek('0 3 * * *')).toBe(86_400)
  })

  it('vardagar ger TRE dygn — gapet fredag→måndag, inte medelvärdet', () => {
    // Det här är hela skälet att funktionen räknar max. Medelintervallet för
    // 1-5 är ~1,4 dygn; en tröskel satt efter det hade larmat varje helg.
    expect(maxIntervallSek('0 7 * * 1-5')).toBe(3 * 86_400)
  })

  it('en veckodag ger en vecka', () => {
    expect(maxIntervallSek('0 18 * * 0')).toBe(7 * 86_400)
  })

  it('en dag i månaden ger längsta månaden', () => {
    expect(maxIntervallSek('0 8 1 * *')).toBe(31 * 86_400)
  })

  it('FAIL-CLOSED: okända former kastar i stället för att gissa', () => {
    // Ett tyst felaktigt intervall ger en tröskel som antingen larmar jämt
    // eller aldrig — och båda ser ut som att fältet fungerar.
    for (const dåligt of ['* * * *', '0 9 * 3 *', '0 9 1 * 1', '0-30 9 * * *', '0 9 * * 5-1']) {
      expect(() => maxIntervallSek(dåligt)).toThrow()
    }
  })

  it('alla tio jobbens uttryck går att härleda', () => {
    for (const [key, uttryck] of Object.entries(LASTA_CRON_JOBB)) {
      expect(`${key}:${maxIntervallSek(uttryck) > 0}`).toBe(`${key}:true`)
    }
  })
})

describe('tröskelSek', () => {
  it('är intervallet gånger faktorn', () => {
    expect(tröskelSek('0 3 * * *')).toBe(Math.round(86_400 * TYSTNAD_FAKTOR))
  })

  it('tolererar EN missad körning men inte två', () => {
    // Det är vad 2,25 betyder. Ett jobb som missar en körning är inte tyst;
    // ett som missar två är det.
    const intervall = maxIntervallSek('0 3 * * *')
    const tröskel = tröskelSek('0 3 * * *')
    expect(tröskel).toBeGreaterThan(2 * intervall)
    expect(tröskel).toBeLessThan(3 * intervall)
  })
})
