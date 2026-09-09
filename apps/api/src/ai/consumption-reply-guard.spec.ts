import { getConsumptionReview } from './tools/consumption-review'
import {
  applyConsumptionVerdict,
  consumptionReadsFromRound,
  consumptionJudgePrompt,
  consumptionReviewFallback,
  needsConsumptionGuard,
  CONSUMPTION_REPLY_NOTICE,
} from './consumption-reply-guard'

it.each([
  'null',
  'true',
  '[true]',
  '[[0,"UNKNOWN"]]',
  '[[-1,"SUPPORTED"]]',
  '[[1,"SUPPORTED"]]',
  '[1]',
  '[[0,"SUPPORTED"],[1,"SUPPORTED"]]',
  '```json\n[[0,"SUPPORTED"]]\n``` extra prosa',
  '{"keep":[true]}',
  '',
])('ogiltig dom %s släpper inte igenom texten', (verdict) => {
  expect(applyConsumptionVerdict('Allt godkänt.', verdict, [])).toEqual({
    text: CONSUMPTION_REPLY_NOTICE,
    outcome: 'unavailable',
  })
})

it('behåller giltigt svar byte för byte inklusive styckeavstånd', () => {
  const draft = ' Två fastigheter.\n\n\nStatusen är inte läst. '
  expect(applyConsumptionVerdict(draft, '[[0,"SUPPORTED"],[1,"SUPPORTED"]]', [])).toEqual({
    text: draft,
    outcome: 'allowed',
  })
})

it('visar bara godkända hela stycken, utan nya modellskrivna ersättningar', () => {
  const answer = applyConsumptionVerdict(
    'Två hus.\n\nAllt godkänt.\n\nÖppna listan.',
    '[[0,"OTHER"],[1,"UNSUPPORTED"],[2,"OTHER"]]',
    [],
  )
  expect(answer.text).toBe('Två hus.\n\nÖppna listan.\n\n' + CONSUMPTION_REPLY_NOTICE)
})

it('binder domen till id även vid annan ordning och avvisar dubbla id:n', () => {
  const draft = 'Ett korrekt stycke.\n\nEtt felaktigt stycke.'
  const answer = applyConsumptionVerdict(draft, '[[1,"UNSUPPORTED"],[0,"OTHER"]]', [])
  expect(answer.text).toContain('Ett korrekt stycke.')
  expect(answer.text).not.toContain('Ett felaktigt stycke.')
  expect(applyConsumptionVerdict(draft, '[[0,"SUPPORTED"],[0,"SUPPORTED"]]', []).outcome).toBe(
    'unavailable',
  )
})

it('väljer ingen godtycklig granskningsläsning när parallella resultat skiljer sig', () => {
  expect(
    consumptionReviewFallback([
      { name: 'get_consumption_review', result: { success: true }, round: 2 },
      { name: 'get_consumption_review', result: { success: false }, round: 2 },
    ]),
  ).toContain('parallella granskningsläsningar')
})

it('binder läsningar till anrop och röjer inte feltext eller data ur andra verktyg', () => {
  expect(
    consumptionReadsFromRound(
      [
        { id: '1', name: 'get_consumption_review' },
        { id: '2', name: 'get_properties' },
        { id: '3', name: 'get_consumption_follow_up' },
      ],
      [
        { tool_use_id: '2', content: '{"success":true,"secret":"fel källa"}' },
        { tool_use_id: '1', content: '{"success":false,"message":"intern hemlighet"}' },
        { tool_use_id: '3', content: 'trasig json' },
      ],
    ),
  ).toEqual([
    { name: 'get_consumption_review', result: { success: false }, round: 0 },
    { name: 'get_consumption_follow_up', result: { success: false }, round: 0 },
  ])
})

it('avvisar för stort underlag utan tyst trunkering', () => {
  expect(
    consumptionJudgePrompt({ question: 'Förbrukning', draft: 'x'.repeat(48_001), reads: [] }),
  ).toBeNull()
  expect(
    consumptionJudgePrompt({ question: '', draft: Array(81).fill('x').join('\n\n'), reads: [] }),
  ).toBeNull()
})

it('fångar verktyg, aktuell fråga, svar och en elliptisk följdfråga i historiken', () => {
  const base = { question: 'Är den på?', draft: 'Ja.', reads: [] }
  expect(needsConsumptionGuard(base, [])).toBe(false) // dokumenterad heuristisk begränsning
  expect(needsConsumptionGuard(base, [{ content: 'Förbrukningsuppföljningen är på.' }])).toBe(true)
  expect(needsConsumptionGuard({ ...base, question: 'Kontrollera mina avläsningar.' }, [])).toBe(
    true,
  )
  expect(needsConsumptionGuard({ ...base, draft: 'Förbrukningen är godkänd.' }, [])).toBe(true)
  expect(
    needsConsumptionGuard(
      {
        ...base,
        reads: [{ name: 'get_consumption_review', result: { success: false }, round: 1 }],
      },
      [],
    ),
  ).toBe(true)
})

it('reservsvaret bygger på produktionens granskningsverktyg inklusive sidgräns och ofullständig trend', async () => {
  const readings = [10, 10, 10, 40, 160].map((value, i) => ({
    id: `r${i}`,
    organizationId: 'org',
    meterId: 'm',
    value,
    readingType: 'PERIOD_VOLUME',
    periodStart: new Date(Date.UTC(2026, 0, i + 1)),
    periodEnd: new Date(Date.UTC(2026, 0, i + 1)),
  }))
  const db = {
    meterReading: { findMany: jest.fn().mockResolvedValue(readings) },
    meterReadingReview: { findMany: jest.fn().mockResolvedValue([]) },
    meter: { findMany: jest.fn().mockResolvedValue([]) },
  }
  const result = await getConsumptionReview(db as never, 'org', 'VIEWER', { limit: 1 })
  const reads = [{ name: 'get_consumption_review', result, round: 0 }]
  const text = consumptionReviewFallback(reads)
  expect(text).toContain('5 avläsningar, 2 varningar')
  expect(text).toContain('Trendbedömda: 2. Inte trendbedömda: 3.')
  expect(text).toContain('1 av 2 varningar')
  expect(text).toContain('Fler sidor finns')
  expect(text).toContain('godkänner inte avläsningar eller debitering')
  expect(
    consumptionReviewFallback([
      ...reads,
      { name: 'get_consumption_review', result: { success: false }, round: 1 },
    ]),
  ).toContain('kunde inte läsas')
})

it('läser ett helt JSON-kodblock med samma strikta typer och antal', () => {
  expect(applyConsumptionVerdict('Giltigt.', '```json\n[[0,"SUPPORTED"]]\n```', []).outcome).toBe(
    'allowed',
  )
  expect(
    applyConsumptionVerdict('Ogiltigt.', '```json\n[[0,"UNSUPPORTED"]]\n```', []).outcome,
  ).toBe('filtered')
})
