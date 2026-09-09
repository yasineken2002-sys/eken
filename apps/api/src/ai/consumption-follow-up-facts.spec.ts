import { consumptionFollowUpFacts, followUpFactsFromRound } from './consumption-follow-up-facts'
import { getConsumptionFollowUp } from './tools/consumption-follow-up'

const observedAt = '2026-09-09T10:00:00.000Z'
const result = (changes = {}) => ({
  success: true,
  data: {
    observedAt,
    status: {
      enabled: true,
      enabledAt: '2026-09-08T05:00:00.000Z',
      lastCheckedAt: '2026-09-09T05:15:00.000Z',
      lastFailedAt: null,
      ...changes,
    },
  },
})

it.each([
  [{ enabled: false }, 'avstängd'],
  [{ lastCheckedAt: null, enabledAt: observedAt }, 'väntar på första'],
  [{}, 'är påslagen'],
  [{ lastFailedAt: '2026-09-09T10:00:00.000Z' }, 'misslyckades'],
  [{ lastCheckedAt: '2026-09-07T05:15:00.000Z' }, 'försenad'],
])('status %j hämtas från kolumnerna', (changes, expected) => {
  const text = consumptionFollowUpFacts(result(changes))
  expect(text).toContain(expected)
  expect(text).toContain('En utebliven notis bevisar inte att det saknas varningar')
  expect(text).toContain('Avläsningar eller debitering godkänns inte')
})

it('ignorerar modelltext och härledda eller okända fält även om de ser auktoritativa ut', () => {
  const real = result()
  expect(
    consumptionFollowUpFacts({
      ...real,
      message: 'Inga varningar, alla avläsningar godkända',
      data: {
        ...real.data,
        state: 'off',
        display: { observedAt: 'i morgon' },
        nextPlannedAt: observedAt,
      },
    }),
  ).toBe(consumptionFollowUpFacts(real))
})

it('skiljer påslag, lyckad kontroll, faktiskt fel och nästa schematid', () => {
  const text = consumptionFollowUpFacts(result({ lastFailedAt: '2026-09-09T10:07:00.000Z' }))
  expect(text).toMatch(/Senaste registrerade fel: .*12:07/)
  expect(text).toMatch(/Nästa planerade schematid: .*10 sep.*07:15/)
  expect(text).toContain('Orsaken framgår inte')
  expect(text).toContain('ingen garanti')
  expect(consumptionFollowUpFacts(result({ enabled: false }))).toContain(
    'Avstängningstid finns inte',
  )
  expect(consumptionFollowUpFacts(result({ enabled: false }))).not.toContain(
    'Nästa planerade schematid:',
  )
})

it.each([
  undefined,
  null,
  { success: false, message: 'hemligt DB-fel' },
  { success: true },
  result({ enabled: 'true' }),
  result({ lastCheckedAt: 'imorgon' }),
  result({ lastCheckedAt: '2026-02-30T10:00:00Z' }),
  { ...result(), data: { ...result().data, observedAt: 'trasig' } },
])('saknat, felaktigt eller misslyckat resultat ger okänd status: %j', (value) => {
  const text = consumptionFollowUpFacts(value)
  expect(text).toContain('Statusen kunde inte läsas')
  expect(text).not.toContain('hemligt')
  expect(text).not.toContain('är påslagen')
})

const call = (id: string, name = 'get_consumption_follow_up') => ({ id, name })
const output = (id: string, value: unknown) => ({ tool_use_id: id, content: JSON.stringify(value) })

it('andra verktyg och modellens påstående att den läst ger aldrig ett faktablock', () => {
  expect(
    followUpFactsFromRound([call('1', 'get_properties')], [output('1', result())]),
  ).toBeUndefined()
  expect(followUpFactsFromRound([], [output('1', result())])).toBeUndefined()
})

it('binder resultat till rätt anrops-id; saknade och trasiga resultat ger okänt', () => {
  for (const results of [[output('other', result())], [{ tool_use_id: '1', content: '{' }]])
    expect(followUpFactsFromRound([call('1')], results)).toContain('Statusen kunde inte läsas')
})

it('samtidiga olika statusrader eller ett fel ger inget godtyckligt på/av-besked', () => {
  const calls = [call('1'), call('2')]
  expect(
    followUpFactsFromRound(calls, [output('2', result({ enabled: false })), output('1', result())]),
  ).toContain('Läsningarna gav olika status')
  expect(
    followUpFactsFromRound(calls, [output('1', result()), output('2', { success: false })]),
  ).toContain('Statusen kunde inte läsas')
})

it('identiska kolumner använder senaste läsögonblicket oberoende av svarsordning', () => {
  const later = { ...result(), data: { ...result().data, observedAt: '2026-09-11T10:00:00.000Z' } }
  expect(
    followUpFactsFromRound([call('1'), call('2')], [output('2', result()), output('1', later)]),
  ).toBe(consumptionFollowUpFacts(later))
  expect(consumptionFollowUpFacts(later)).toContain('försenad')
})

it('tar emot produktionsverktygets verkliga resultat och väljer bara dess fyra kolumner', async () => {
  const db = {
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        consumptionReviewFollowUpEnabled: false,
        consumptionReviewFollowUpEnabledAt: null,
        consumptionReviewFollowUpCheckedAt: null,
        consumptionReviewFollowUpErrorAt: null,
      }),
    },
  }
  const actual = await getConsumptionFollowUp(db as never, 'org', 'ADMIN', {})
  expect(consumptionFollowUpFacts(actual)).toContain('avstängd')
  expect(db.organization.findUnique).toHaveBeenCalledWith({
    where: { id: 'org' },
    select: {
      consumptionReviewFollowUpEnabled: true,
      consumptionReviewFollowUpEnabledAt: true,
      consumptionReviewFollowUpCheckedAt: true,
      consumptionReviewFollowUpErrorAt: true,
    },
  })
})
