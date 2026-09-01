/**
 * GRUPPERINGEN AV PER-MOTTAGARRADER — den rena logiken bakom meddelandevyn.
 *
 * ── VARFÖR PROVET LIGGER I apps/api ─────────────────────────────────────────
 *
 * Funktionen bor i `@eken/shared` (den är ren logik över en delad domänform,
 * och `@eken/shared` är enda källan till sanning för sådant). Varken
 * `apps/web` eller `packages/shared` har någon testkörare; `apps/api`:s jest
 * når `@eken/shared`, och det finns redan prejudikat — `shared-bas-constants.spec.ts`
 * prövar delade konstanter härifrån. Att lägga provet där körningen finns är
 * bättre än att lägga det där det ser snyggast ut och aldrig köras.
 *
 * ── VAD DET MÄTER ───────────────────────────────────────────────────────────
 *
 * Att ett MASSUTSKICK och ett ENSKILT utskick i samma lista båda renderas rätt,
 * och att grupperingen aldrig kastar bort en rad. Det kan INTE se hur React
 * ritar ut grupperna — det ägs av MessagesPage — men allt som avgör VAD som
 * ritas ligger här.
 */
import { groupSentMessages, aggregateStatus } from '@eken/shared'
import type { GroupableMessage } from '@eken/shared'

const rad = (over: Partial<GroupableMessage> & { id: string }): GroupableMessage => ({
  batchId: null,
  subject: 'Ämne',
  status: 'SENT',
  createdAt: '2026-09-02T10:00:00Z',
  recipientCount: 1,
  successCount: 1,
  failedCount: 0,
  ...over,
})

describe('groupSentMessages — massutskick och enskilt utskick i samma lista', () => {
  // Den bärande riggen: EN grupp om fem från ett massutskick, plus ETT enskilt
  // utskick, plus EN gammal rad utan batchId. Alla tre formerna samtidigt —
  // ett prov med bara massutskicket hade inte sett att de andra går sönder.
  const lista: GroupableMessage[] = [
    ...Array.from({ length: 5 }, (_, i) =>
      rad({ id: `b${i}`, batchId: 'batch-1', subject: 'Trapphuset målas' }),
    ),
    rad({ id: 'enskilt', batchId: 'batch-2', subject: 'Ditt kontrakt' }),
    rad({ id: 'gammal', batchId: null, subject: 'Före batchId fanns' }),
  ]

  it('massutskottet blir EN grupp, de andra två blir varsin', () => {
    const grupper = groupSentMessages(lista)
    expect(grupper).toHaveLength(3)
    expect(grupper.map((g) => g.key)).toEqual(['batch-1', 'batch-2', 'single:gammal'])
  })

  it('bara flerradsgruppen är ett massutskick', () => {
    const grupper = groupSentMessages(lista)
    // MOTPROVET ÄR POÄNGEN: ett enskilt utskick HAR ett batchId men ska ändå
    // inte renderas som en grupp. `isBatch` följer antalet rader, inte fältet.
    expect(grupper.map((g) => g.isBatch)).toEqual([true, false, false])
  })

  it('INGEN rad försvinner — grupperingen döljer, den kastar inte', () => {
    const grupper = groupSentMessages(lista)
    const ids = grupper.flatMap((g) => g.messages.map((m) => m.id)).sort()
    expect(ids).toEqual(lista.map((m) => m.id).sort())
    // Och detaljerna går att fälla ut: gruppen BÄR sina rader.
    expect(grupper[0]!.messages).toHaveLength(5)
  })

  it('summorna räknas över gruppens rader', () => {
    const grupper = groupSentMessages([
      rad({ id: 'a', batchId: 'b', successCount: 1, failedCount: 0 }),
      rad({ id: 'c', batchId: 'b', status: 'FAILED', successCount: 0, failedCount: 1 }),
    ])
    expect(grupper).toHaveLength(1)
    expect(grupper[0]).toMatchObject({ recipientCount: 2, successCount: 1, failedCount: 1 })
  })

  it('ordningen bevaras — funktionen sorterar aldrig om anroparens lista', () => {
    const grupper = groupSentMessages(lista)
    expect(grupper[0]!.subject).toBe('Trapphuset målas')
    expect(grupper[2]!.subject).toBe('Före batchId fanns')
  })

  it('tom sträng som batchId räknas som SAKNAT, inte som en gemensam grupp', () => {
    // Utan den regeln hade två obesläktade rader med '' slagits ihop till en
    // jättegrupp — och det är precis den sortens fel som ser ut som data.
    const grupper = groupSentMessages([
      rad({ id: 'x', batchId: '' }),
      rad({ id: 'y', batchId: '' }),
    ])
    expect(grupper).toHaveLength(2)
    expect(grupper.every((g) => g.isBatch)).toBe(false)
  })

  it('tom lista ger inga grupper', () => {
    expect(groupSentMessages([])).toEqual([])
  })
})

describe('aggregateStatus — PENDING vinner', () => {
  it('allt lyckat → SENT, allt misslyckat → FAILED, blandat → PARTIAL', () => {
    expect(aggregateStatus(['SENT', 'SENT'])).toBe('SENT')
    expect(aggregateStatus(['FAILED', 'FAILED'])).toBe('FAILED')
    expect(aggregateStatus(['SENT', 'FAILED'])).toBe('PARTIAL')
  })

  it('EN påbörjad rad gör hela gruppen påbörjad', () => {
    // Ordningen är inte godtycklig: en grupp där någon rad är påbörjad-men-
    // obekräftad är inte avslutad, och att visa den som "Skickat" hade dolt
    // exakt det fall en människa behöver titta på.
    expect(aggregateStatus(['SENT', 'SENT', 'PENDING'])).toBe('PENDING')
    expect(aggregateStatus(['FAILED', 'PENDING'])).toBe('PENDING')
  })
})
