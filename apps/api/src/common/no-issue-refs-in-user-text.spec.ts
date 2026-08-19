/**
 * VAKT: INTERNA ÄRENDENUMMER HÖR INTE HEMMA I TEXT SOM ANVÄNDAREN SER.
 *
 * Två felmeddelanden skrev "(se ärende #378)" rakt ut till hyresvärden. Numret
 * säger ingenting för den som läser det och läcker vår arbetslista in i
 * produkten. Meddelandena är omskrivna så att de förklarar SAKEN; spåret till
 * ärendet ligger kvar i en kodkommentar bredvid, där det gör nytta.
 *
 * ── VARFÖR EN SVEPANDE VAKT OCH INTE TVÅ NAMNGIVNA KONTROLLER ──────────────
 *
 * En kontroll som bara hävdar att just de två strängarna är rena skyddar mot
 * återfall på två rader och märker aldrig att ett tredje meddelande föds med
 * samma fel. Vakten läser därför VARJE NestJS-exception i `apps/api/src` —
 * mängden växer av sig själv när någon lägger till en ny.
 *
 * ── AVGRÄNSNINGEN ÄR AVSIKTLIG ─────────────────────────────────────────────
 *
 * Bara `*Exception(...)` granskas, alltså det som `HttpExceptionFilter` skickar
 * ut i svaret. `throw new Error(...)` vid uppstart går till drift och inte till
 * hyresvärden — `env.validation.ts` hänvisar med rätta till en fil i repot, och
 * ska få fortsätta göra det. Samma sak för `reason:`-fälten i behörighetsytans
 * och gallringens dokumentation: de är skrivna FÖR utvecklare.
 *
 * ── VAD SOM SKULLE FÅ DEN HÄR VAKTEN ATT FALLA ─────────────────────────────
 *
 * Ett `#123` i ett exception-meddelande. Kanariefågeln nedan kräver att
 * mönstret bevisligen träffar den gamla texten och bevisligen INTE träffar en
 * hexfärg — annars kan uttrycket sluta mäta något och vakten bli grön av fel
 * skäl.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')

/**
 * `\b` efter siffrorna är det som skiljer ett ärendenummer från en hexfärg:
 * `#218F52` har inget ordgränssnitt mellan `8` och `F`, så den matchar inte.
 */
const ARENDENUMMER = /#\d+\b/

function tsFiles(dir: string): string[] {
  const ut: string[] = []
  for (const namn of readdirSync(dir)) {
    const full = join(dir, namn)
    if (statSync(full).isDirectory()) {
      if (namn === 'generated' || namn === 'node_modules') continue
      ut.push(...tsFiles(full))
    } else if (namn.endsWith('.ts') && !namn.endsWith('.spec.ts')) {
      ut.push(full)
    }
  }
  return ut
}

/**
 * Plockar ut strängliteralerna ur varje `new *Exception( … )`.
 *
 * Parentesräkning i stället för ett reguljäruttryck: ett meddelande som
 * innehåller `(${belopp} kr)` skulle annars kapas mitt i, och vakten hade
 * granskat en halv sträng utan att säga ifrån.
 */
function exceptionStrings(källa: string): string[] {
  const ut: string[] = []
  const start = /new\s+\w*Exception\s*\(/g
  let m: RegExpExecArray | null
  while ((m = start.exec(källa)) !== null) {
    let i = m.index + m[0].length
    let djup = 1
    const från = i
    while (i < källa.length && djup > 0) {
      const c = källa[i]
      if (c === '(') djup++
      else if (c === ')') djup--
      i++
    }
    const kropp = källa.slice(från, i - 1)
    for (const lit of kropp.match(/'[^']*'|"[^"]*"|`[^`]*`/g) ?? []) {
      ut.push(lit.slice(1, -1))
    }
  }
  return ut
}

describe('vakt: inga interna ärendenummer i användarvänd text', () => {
  const filer = tsFiles(SRC)

  it('hittar faktiskt exception-meddelanden att granska (annars mäter vakten inget)', () => {
    const antal = filer.reduce((n, f) => n + exceptionStrings(readFileSync(f, 'utf8')).length, 0)
    // Ett golv, inte ett exakt tal: mängden ska få växa utan att vakten faller.
    expect(filer.length).toBeGreaterThan(100)
    expect(antal).toBeGreaterThan(200)
  })

  it('inget NestJS-exception-meddelande innehåller ett ärendenummer', () => {
    const träffar: string[] = []
    for (const fil of filer) {
      for (const s of exceptionStrings(readFileSync(fil, 'utf8'))) {
        if (ARENDENUMMER.test(s)) {
          träffar.push(`${fil.replace(SRC, 'src')}: ${s.slice(0, 90)}`)
        }
      }
    }
    expect(träffar).toEqual([])
  })

  it('kanariefågel: mönstret träffar ett ärendenummer men inte en hexfärg', () => {
    // Den gamla texten MÅSTE fällas — annars mäter kontrollen ovan ingenting.
    expect(ARENDENUMMER.test('Överbetalning kan i dag inte visas (se ärende #378)')).toBe(true)
    expect(ARENDENUMMER.test('se #1')).toBe(true)
    // ... och en färg får INTE fällas, annars blir vakten obrukbar i UI-nära kod.
    expect(ARENDENUMMER.test('border-[#218F52] bg-blue-600/5')).toBe(false)
    expect(ARENDENUMMER.test('#EAEDF0')).toBe(false)
  })

  it('kanariefågel: uttunnaren hittar strängar även när meddelandet har parenteser', () => {
    const prov = "throw new BadRequestException(`Belopp (${x} kr) för högt. ` + 'Se #42.')"
    const funna = exceptionStrings(prov)
    expect(funna).toHaveLength(2)
    expect(funna.some((s) => ARENDENUMMER.test(s))).toBe(true)
  })
})
