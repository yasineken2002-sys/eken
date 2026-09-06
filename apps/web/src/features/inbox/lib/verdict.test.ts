import { describe, expect, it } from 'vitest'

import { verdiktVisning } from './verdict'

import type { InboxItem } from '../api/inbox.api'

/**
 * TORRLÄGETS DOM I LÄSYTAN.
 *
 * Proven mäter att de FYRA tillstånden hålls isär — tre enumvärden plus `null`,
 * som betyder "ingen dom ännu". Att den fjärde finns är hela poängen: en lucka i
 * kön får inte renderas som ett påstående om delegationsläget.
 *
 * Vad de INTE mäter: att domen är rätt. Den räknas i API:t och ägs av
 * `execution-dryrun.db.spec.ts` mot riktig Postgres.
 */
const item = (over: Partial<InboxItem>): InboxItem =>
  ({
    id: 'a1',
    executionVerdict: null,
    verdictReason: null,
    verdictAt: null,
    verdictDelegationId: null,
    verdictDelegation: null,
    ...over,
  }) as InboxItem

describe('verdiktVisning', () => {
  it('INGEN DOM ger null — inte "hade väntat på dig"', () => {
    // Regressionen: renderas frånvaron som ett nej säger facit att hyresvärden
    // delegerat mindre än hen gjort, och siffran hen fattar beslut på blir fel
    // åt det håll som ser tryggt ut.
    expect(verdiktVisning(item({ executionVerdict: null }))).toBeNull()
  })

  it('WOULD_EXECUTE utan känd delegation säger ändå att det hade utförts', () => {
    const v = verdiktVisning(item({ executionVerdict: 'WOULD_EXECUTE' }))
    expect(v?.variant).toBe('success')
    expect(v?.mening).toContain('Hade utförts automatiskt')
  })

  it('WOULD_EXECUTE med delegation skriver ut AVGRÄNSNINGEN i klartext', () => {
    const v = verdiktVisning(
      item({
        executionVerdict: 'WOULD_EXECUTE',
        verdictDelegationId: 'd1',
        verdictDelegation: {
          id: 'd1',
          villkor: { kategori: 'PLUMBING' },
          expiresAt: '2026-12-01T00:00:00.000Z',
        },
      }),
    )
    // Samma karta som inkorgens bekräftelse och /delegationer läser — en egen
    // formulering här hade beskrivit samma rätt med andra ord.
    expect(v?.mening).toContain('Typ av ärende: PLUMBING')
  })

  it('EN TOM avgränsning sägs i klartext, den lämnas inte tom', () => {
    const v = verdiktVisning(
      item({
        executionVerdict: 'WOULD_EXECUTE',
        verdictDelegation: { id: 'd1', villkor: null, expiresAt: '2026-12-01T00:00:00.000Z' },
      }),
    )
    expect(v?.mening).toContain('Utan avgränsning')
  })

  it('NO_DELEGATION säger att rätten inte givits — inte att något stoppades', () => {
    const v = verdiktVisning(item({ executionVerdict: 'NO_DELEGATION' }))
    expect(v?.variant).toBe('default')
    expect(v?.mening).toContain('inte gett agenten rätten')
  })

  it('BLOCKED bär SERVERNS EGEN text, ordagrant', () => {
    const v = verdiktVisning(
      item({
        executionVerdict: 'BLOCKED',
        verdictReason: 'Delegationen för update_maintenance_status har nått sitt tak för perioden.',
      }),
    )
    expect(v?.variant).toBe('warning')
    expect(v?.mening).toBe(
      'Hade stoppats: Delegationen för update_maintenance_status har nått sitt tak för perioden.',
    )
  })

  it('BLOCKED utan skäl blir inte en tom mening', () => {
    const v = verdiktVisning(item({ executionVerdict: 'BLOCKED' }))
    expect(v?.mening).toContain('bar inte det här fallet')
  })

  it('de tre domarna ger TRE OLIKA etiketter — annars mäter kortet ingenting', () => {
    const etiketter = (['WOULD_EXECUTE', 'NO_DELEGATION', 'BLOCKED'] as const).map(
      (d) => verdiktVisning(item({ executionVerdict: d }))?.etikett,
    )
    expect(new Set(etiketter).size).toBe(3)
  })
})
