/**
 * DRIFTPAUSENS TOLKNING — tre värden, och det fjärde är hela poängen.
 *
 * Den här filen mäter BARA tolkningen. Att grinden faktiskt sitter i
 * startförloppet mäts av `automation-pause-startup.spec.ts` (ScheduleModule +
 * AppModule) och `automation-pause-queue.db.spec.ts` (Bull mot riktig Redis) —
 * och den uppdelningen är avsiktlig: ett prov som bara visar att en hjälpfunktion
 * returnerar `false` är exakt den sortens bevis som inte duger här.
 */

import {
  AUTOMATION_PAUSE_VAR,
  AUTOMATION_PAUSE_VALUES,
  InvalidAutomationPauseError,
  automationPaused,
  pausedUnless,
} from './automation-pause'

class Konsument {}

describe('automationPaused', () => {
  it("'true' pausar", () => {
    expect(automationPaused({ [AUTOMATION_PAUSE_VAR]: 'true' })).toBe(true)
  })

  it("'false' pausar inte", () => {
    expect(automationPaused({ [AUTOMATION_PAUSE_VAR]: 'false' })).toBe(false)
  })

  it.each([
    ['saknad', {}],
    ['tom sträng', { [AUTOMATION_PAUSE_VAR]: '' }],
  ])('%s = normal drift — dagens beteende är oförändrat', (_namn, env) => {
    // Det här är den dokumenterade kompatibiliteten: ingen befintlig miljö
    // behöver röras för att fortsätta bete sig som före ändringen.
    expect(automationPaused(env as NodeJS.ProcessEnv)).toBe(false)
  })

  it.each([
    ['felstavat', 'ture'],
    ['versaler', 'TRUE'],
    ['inledande versal', 'True'],
    ['ett-siffra', '1'],
    ['noll-siffra', '0'],
    ['ja', 'yes'],
    ['ord', 'paused'],
    ['blanksteg runt', ' true '],
  ])('%s KASTAR — ett okänt värde får aldrig tyst betyda "kör på"', (_namn, varde) => {
    // FELRIKTNINGEN ÄR HELA SKÄLET. Ett tyst `false` hade gett full automatisk
    // drift i exakt det ögonblick operatören trodde sig ha pausat.
    expect(() => automationPaused({ [AUTOMATION_PAUSE_VAR]: varde })).toThrow(
      InvalidAutomationPauseError,
    )
  })

  it('felmeddelandet namnger variabeln, det avvisade värdet OCH de giltiga', () => {
    // Ett kast vid boot som inte säger vad som ska rättas kostar ett
    // underhållsfönster. Alla tre delarna måste stå där.
    try {
      automationPaused({ [AUTOMATION_PAUSE_VAR]: 'ture' })
      throw new Error('förväntade ett kast')
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      expect(text).toContain(AUTOMATION_PAUSE_VAR)
      expect(text).toContain('ture')
      for (const v of AUTOMATION_PAUSE_VALUES) expect(text).toContain(v)
    }
  })

  it('läser default ur process.env när env inte anges', () => {
    const sparat = process.env[AUTOMATION_PAUSE_VAR]
    try {
      process.env[AUTOMATION_PAUSE_VAR] = 'true'
      expect(automationPaused()).toBe(true)
    } finally {
      if (sparat === undefined) delete process.env[AUTOMATION_PAUSE_VAR]
      else process.env[AUTOMATION_PAUSE_VAR] = sparat
    }
  })
})

describe('pausedUnless', () => {
  it('släpper igenom providern i normalt läge', () => {
    expect(pausedUnless(Konsument, { [AUTOMATION_PAUSE_VAR]: 'false' })).toEqual([Konsument])
  })

  it('UTELÄMNAR providern i pausat läge', () => {
    expect(pausedUnless(Konsument, { [AUTOMATION_PAUSE_VAR]: 'true' })).toEqual([])
  })

  it('kastar vidare på ogiltigt värde — grinden får inte ha en mildare tolkning än validateEnv', () => {
    // Skulle hjälparen svälja felet hade en felstavad variabel gett en
    // registrerad konsument, alltså motsatsen till avsikten, på ett ställe där
    // ingen tittar.
    expect(() => pausedUnless(Konsument, { [AUTOMATION_PAUSE_VAR]: 'ture' })).toThrow(
      InvalidAutomationPauseError,
    )
  })
})
