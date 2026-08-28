/**
 * IDEMPOTENSNYCKELN FÖR AI-VERIFIKAT — mekaniken.
 *
 * ARBETSFÖRDELNING: den här specen äger MEKANIKEN (nyckeln är deterministisk,
 * innehållsberoende och prefixad). PÅKOPPLINGEN — att skrivvägarna faktiskt
 * använder den — ägs av `check-ai-journal-source.mjs`. En spec kan inte se att
 * någon slutat anropa funktionen; en vakt kan.
 */
import { aiJournalSourceId, AI_JOURNAL_SOURCE_PREFIX } from './ai-journal-source'
import { hashPendingAction } from '../pending-action-hash'

describe('aiJournalSourceId', () => {
  const indata = { date: '2026-08-28', description: 'Parkering', amount: 250 }

  it('är deterministisk — samma åtgärd ger samma nyckel', () => {
    expect(aiJournalSourceId('record_expense', indata)).toBe(
      aiJournalSourceId('record_expense', indata),
    )
  })

  it('är OBEROENDE av fältordning — annars vore ett omtag inte idempotent', () => {
    // Kanoniseringen är hela skälet till att nyckeln överlever ett omtag: en
    // klient som serialiserar fälten i annan ordning ska inte få ett nytt
    // verifikat.
    expect(
      aiJournalSourceId('record_expense', {
        amount: 250,
        description: 'Parkering',
        date: '2026-08-28',
      }),
    ).toBe(aiJournalSourceId('record_expense', indata))
  })

  it('skiljer på OLIKA åtgärder — spärren får inte blockera riktigt arbete', () => {
    expect(aiJournalSourceId('record_expense', { ...indata, amount: 251 })).not.toBe(
      aiJournalSourceId('record_expense', indata),
    )
    expect(aiJournalSourceId('record_expense', { ...indata, description: 'Parkering 2' })).not.toBe(
      aiJournalSourceId('record_expense', indata),
    )
    expect(aiJournalSourceId('record_expense', { ...indata, date: '2026-08-29' })).not.toBe(
      aiJournalSourceId('record_expense', indata),
    )
  })

  it('skiljer på VERKTYG — samma indata till två verktyg är två åtgärder', () => {
    expect(aiJournalSourceId('create_journal_entry', indata)).not.toBe(
      aiJournalSourceId('record_expense', indata),
    )
  })

  it('bygger på SAMMA hash som bekräftelsen binds med', () => {
    // Att det är samma är inte en optimering utan poängen: bekräftelsen och
    // verifikatet ska handla om exakt samma åtgärd. Två definitioner av "samma
    // åtgärd" kan glida isär utan att något blir rött.
    expect(aiJournalSourceId('record_expense', indata)).toBe(
      `${AI_JOURNAL_SOURCE_PREFIX}${hashPendingAction('record_expense', indata)}`,
    )
  })

  it('bär ett prefix som inte kan kollidera med de befintliga namnrymderna', () => {
    const nyckel = aiJournalSourceId('record_expense', indata)
    expect(nyckel.startsWith('ai:')).toBe(true)
    for (const befintlig of [
      'invoice-',
      'rent-notice-',
      'credit-note:',
      'entry-reversal:',
      'misc-charge:',
      'reminder-fee-reversal:',
    ]) {
      expect(nyckel.startsWith(befintlig)).toBe(false)
    }
  })

  it('är stabil över tid — nyckeln är hårdkodad här med flit', () => {
    // En ändring av kanoniseringen eller prefixet skulle göra ALLA befintliga
    // AI-verifikat oåtkomliga för idempotenskontrollen, tyst. Faller den här
    // raden är det en migrationsfråga, inte en testfråga.
    // Värdet är HÄRLETT OBEROENDE av koden, inte kopierat ur ett testutfall:
    //   payload = {"toolName":"record_expense","toolInput":{"a":1}}
    //   sha256(payload) = 1c12b856…  (räknat i python, inte i den här modulen)
    // Ett pinnat värde som kopierats ur koden mäter bara att koden är sig själv lik.
    expect(aiJournalSourceId('record_expense', { a: 1 })).toBe(
      'ai:1c12b8562dbf9de223e37bf449fecb659b1fc752cb4a442c6328c7cbf6f7c656',
    )
  })
})
