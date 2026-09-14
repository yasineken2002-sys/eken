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
  AutomationPauseSourceError,
  InvalidAutomationPauseError,
  assertAutomationPauseSource,
  automationGateEntries,
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

describe('assertAutomationPauseSource', () => {
  /**
   * Snapshoten togs när modulen laddades, alltså med den miljö jest startade i.
   * Provsviten sätter inte OPS_AUTOMATION_PAUSED, så snapshoten är `undefined` —
   * och det är precis det läge kontrollen ska mäta mot.
   */
  it('tyst när konfigurationen är lika tom som processmiljön', () => {
    expect(() => assertAutomationPauseSource({})).not.toThrow()
    expect(() => assertAutomationPauseSource({ [AUTOMATION_PAUSE_VAR]: '' })).not.toThrow()
  })

  it('KASTAR när värdet bara finns i konfigurationen (.env) och inte i processmiljön', () => {
    // DET HÄR ÄR DEFEKTEN, i sin exakta form: `.env` säger 'true', processmiljön
    // säger ingenting. Konsumentgrinden läste processmiljön vid modulimport och
    // registrerade alltså elva konsumenter, medan schemaläggaren och
    // /v1/health läser konfigurationen och rapporterar full paus.
    expect(() => assertAutomationPauseSource({ [AUTOMATION_PAUSE_VAR]: 'true' })).toThrow(
      AutomationPauseSourceError,
    )
  })

  it('felmeddelandet säger VAD som ska rättas, inte bara att något är fel', () => {
    try {
      assertAutomationPauseSource({ [AUTOMATION_PAUSE_VAR]: 'true' })
      throw new Error('förväntade ett kast')
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      expect(text).toContain(AUTOMATION_PAUSE_VAR)
      expect(text).toContain('.env')
      expect(text).toContain('HALV paus')
    }
  })

  it("kastar också åt ANDRA hållet — 'false' i .env över en tom processmiljö", () => {
    // Mildare i sak, men samma klass av fel: två källor som säger olika saker om
    // samma spärr. Att släppa igenom den riktningen hade gjort kontrollen till en
    // halv kontroll.
    expect(() => assertAutomationPauseSource({ [AUTOMATION_PAUSE_VAR]: 'false' })).toThrow(
      AutomationPauseSourceError,
    )
  })
})

describe('grindens register', () => {
  it('dedupar per klassnamn — en dubbelladdad modulfil får inte dubblera talen', () => {
    class DubblettWorker {}
    const fore = automationGateEntries().length
    pausedUnless(DubblettWorker, { [AUTOMATION_PAUSE_VAR]: 'false' })
    const efterForsta = automationGateEntries().length
    pausedUnless(DubblettWorker, { [AUTOMATION_PAUSE_VAR]: 'false' })
    expect(efterForsta).toBe(fore + 1)
    expect(automationGateEntries().length).toBe(efterForsta)
  })

  it('registret bär vad grinden GJORDE, inte vad den ombads göra', () => {
    class HallenWorker {}
    pausedUnless(HallenWorker, { [AUTOMATION_PAUSE_VAR]: 'true' })
    const post = automationGateEntries().find((e) => e.name === 'HallenWorker')
    expect(post).toEqual({ name: 'HallenWorker', withheld: true })
  })
})
