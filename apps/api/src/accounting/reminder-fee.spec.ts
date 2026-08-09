/**
 * `resolveReminderFee` — de två reglerna som avgör vad som får krävas.
 *
 * VAD TESTERNA BEVISAR: att avtalsgrunden och taket båda tillämpas, i rätt
 * ordning, och att flaggorna beskriver konfigurationen så att anroparen kan
 * larma om rätt sak.
 *
 * VAD DE INTE BEVISAR: att anroparna faktiskt använder svaret på alla sina
 * skrivningar. En ren funktion kan vara aldrig så korrekt medan reskontran
 * skrivs med ett annat tal — det var precis felet som gjorde filen nödvändig.
 * Den delen mäts i anroparnas specar och mot riktig Postgres i bevisriggen.
 */

import { REMINDER_FEE_MAX_SEK } from '@eken/shared'
import { resolveReminderFee, reminderFeeCapMessage } from './reminder-fee'
import type { DebtOriginDate } from './debt-origin'

// Skulden uppkom 2026; villkoret trädde i kraft 2020 → avtalsgrunden tillåter.
const SKULD = new Date('2026-07-01') as DebtOriginDate
const VILLKOR_FÖRE = new Date('2020-01-01')
const VILLKOR_EFTER = new Date('2026-08-01')

describe('resolveReminderFee — taket', () => {
  it('över taket klampas, och flaggan säger att konfigurationen är olaglig', () => {
    const d = resolveReminderFee(500, SKULD, VILLKOR_FÖRE)

    expect(d.amount).toBe(REMINDER_FEE_MAX_SEK)
    expect(d.cappedByLaw).toBe(true)
    // `requested` bär det konfigurerade talet vidare till loggen — utan det kan
    // ingen se VAD som var fel, bara att något klampades.
    expect(d.requested).toBe(500)
  })

  it('KLAMPAS, VÄGRAS INTE — hyresvärden får de kronor hen är berättigad till', () => {
    // Att nolla vid ett för högt belopp hade straffat hyresvärden för en
    // felkonfiguration. Bara det överskjutande är ogiltigt (6 § 1 st).
    expect(resolveReminderFee(5000, SKULD, VILLKOR_FÖRE).amount).toBe(REMINDER_FEE_MAX_SEK)
  })

  it('exakt på taket passerar utan flagga — inget är fel där', () => {
    const d = resolveReminderFee(REMINDER_FEE_MAX_SEK, SKULD, VILLKOR_FÖRE)

    expect(d.amount).toBe(REMINDER_FEE_MAX_SEK)
    expect(d.cappedByLaw).toBe(false)
  })

  it('under taket rörs inte — taket är ett tak, inte ett golv', () => {
    const d = resolveReminderFee(40, SKULD, VILLKOR_FÖRE)

    expect(d.amount).toBe(40)
    expect(d.cappedByLaw).toBe(false)
  })

  it('taket läses ur den delade konstanten, inte ur en literal här', () => {
    // En hårdkodad 60 i det här testet hade dolt en framtida glidning mellan
    // konstanten och koden. Testet ska följa med när lagen ändras.
    expect(resolveReminderFee(REMINDER_FEE_MAX_SEK + 1, SKULD, VILLKOR_FÖRE).amount).toBe(
      REMINDER_FEE_MAX_SEK,
    )
    expect(resolveReminderFee(REMINDER_FEE_MAX_SEK - 1, SKULD, VILLKOR_FÖRE).amount).toBe(
      REMINDER_FEE_MAX_SEK - 1,
    )
  })
})

describe('resolveReminderFee — avtalsgrunden', () => {
  it('utan villkorsdatum: ingen avgift, och det är inte en klampning', () => {
    const d = resolveReminderFee(60, SKULD, null)

    expect(d.amount).toBe(0)
    expect(d.contractual).toBe(false)
    // Vägran är ett NORMALT utfall och får inte larma som en felkonfiguration.
    expect(d.cappedByLaw).toBe(false)
  })

  it('villkor som trätt i kraft EFTER skulden: retroaktiv avgift vägras', () => {
    expect(resolveReminderFee(60, SKULD, VILLKOR_EFTER).amount).toBe(0)
  })

  it('skuldens uppkomst okänd (null): vägrar hellre än gissar', () => {
    expect(resolveReminderFee(60, null, VILLKOR_FÖRE).amount).toBe(0)
  })

  it('avtalsgrunden slår taket — 500 utan villkor blir 0, inte 60', () => {
    // Ordningen spelar roll: klampade vi först och glömde grunden skulle en
    // org utan avtalsvillkor ändå debitera 60 kr.
    const d = resolveReminderFee(500, SKULD, null)

    expect(d.amount).toBe(0)
    // Flaggan står ändå kvar: konfigurationen ÄR olaglig och bör rättas, även
    // om just det här kravet aldrig blir av.
    expect(d.cappedByLaw).toBe(true)
  })
})

describe('resolveReminderFee — ogiltiga belopp', () => {
  it.each([
    ['noll', 0],
    ['negativt', -60],
    ['NaN', Number.NaN],
    ['oändligt', Number.POSITIVE_INFINITY],
  ])('%s → ingen avgift', (_namn, belopp) => {
    // Ett negativt belopp hade skrivit en NEGATIV avgiftsrad och MINSKAT
    // fakturans total utan att bokföra något (FAR M2). Oändligheten hade
    // klampats till taket av Math.min och sett giltig ut.
    expect(resolveReminderFee(belopp, SKULD, VILLKOR_FÖRE).amount).toBe(0)
  })
})

describe('reminderFeeCapMessage', () => {
  it('bär org, det konfigurerade talet, taket och lagrummet', () => {
    const d = resolveReminderFee(500, SKULD, VILLKOR_FÖRE)
    const msg = reminderFeeCapMessage('org-1', d, 'avi RN-2026-000001')

    expect(msg).toContain('org-1')
    expect(msg).toContain('500')
    expect(msg).toContain(String(REMINDER_FEE_MAX_SEK))
    expect(msg).toContain('1981:739')
    // Kontexten är poängen med raden: utan avi-/fakturanummer går det inte att
    // se VILKET krav som klampades.
    expect(msg).toContain('RN-2026-000001')
  })
})
