/**
 * #326 B — rättelsevägens beslutsregler, isolerade.
 *
 * Reglerna testas här som rena funktioner, utan DB och utan service. Det är
 * avsiktligt: beslutet "vilken status ska fakturan tillbaka till" är den del av
 * B som är lättast att få subtilt fel, och den ska gå att läsa och bevisa utan
 * att först sätta upp en bankmatchning.
 */

import { INVOICE_TRANSITIONS } from '@eken/shared'
import {
  PAYMENT_REVERSAL_RESTORE_TARGETS,
  paymentReversalTargetStatus,
  statusBeforePartialPayment,
} from './invoice-payment-reversal'

describe('paymentReversalTargetStatus', () => {
  it('PARTIAL utan kvarvarande allokeringar → återställ till loggens utgångsstatus', () => {
    expect(
      paymentReversalTargetStatus({
        current: 'PARTIAL',
        hasRemainingAllocations: false,
        statusBeforePartial: 'SENT',
      }),
    ).toEqual({ action: 'restore', target: 'SENT' })
  })

  it('återställer till OVERDUE när det var utgångsläget — inte till SENT', () => {
    // Diskriminerande: en implementation som hårdkodar SENT ser rätt ut i testet
    // ovan och fel här. En förfallen faktura får inte bli oförfallen av att en
    // felmatchad betalning rättas bort.
    expect(
      paymentReversalTargetStatus({
        current: 'PARTIAL',
        hasRemainingAllocations: false,
        statusBeforePartial: 'OVERDUE',
      }),
    ).toEqual({ action: 'restore', target: 'OVERDUE' })
  })

  it('PARTIAL MED kvarvarande allokering → statusen står kvar (fakturan är fortfarande delbetald)', () => {
    expect(
      paymentReversalTargetStatus({
        current: 'PARTIAL',
        hasRemainingAllocations: true,
        statusBeforePartial: 'SENT',
      }),
    ).toEqual({ action: 'keep', reason: 'allocations-remain' })
  })

  it.each(['SENT', 'OVERDUE', 'DRAFT', 'PAID', 'VOID', 'SENT_TO_COLLECTION'] as const)(
    '%s är inte betalningshärledd → statusen rörs inte',
    (current) => {
      expect(
        paymentReversalTargetStatus({
          current,
          hasRemainingAllocations: false,
          statusBeforePartial: 'SENT',
        }),
      ).toEqual({ action: 'keep', reason: 'not-partial' })
    },
  )

  it('GISSAR ALDRIG: saknad utgångsstatus ger inget återställningsbeslut', () => {
    expect(
      paymentReversalTargetStatus({
        current: 'PARTIAL',
        hasRemainingAllocations: false,
        statusBeforePartial: null,
      }),
    ).not.toEqual(expect.objectContaining({ action: 'restore' }))
  })

  it.each(['PAID', 'VOID', 'SENT_TO_COLLECTION', 'DRAFT', 'PARTIAL'] as const)(
    'vägrar återställa till %s även om loggen påstår det',
    (logged) => {
      expect(
        paymentReversalTargetStatus({
          current: 'PARTIAL',
          hasRemainingAllocations: false,
          statusBeforePartial: logged,
        }),
      ).not.toEqual(expect.objectContaining({ action: 'restore' }))
    },
  )
})

describe('statusBeforePartialPayment — vilken post bär utgångsläget', () => {
  it('hoppar över självövergången PARTIAL → PARTIAL (andra delbetalningen, #307 C)', () => {
    // Nyast först: del 2 flyttade ingenting, del 1 flyttade in i PARTIAL.
    expect(
      statusBeforePartialPayment([
        { payload: { previousStatus: 'PARTIAL' } },
        { payload: { previousStatus: 'SENT' } },
      ]),
    ).toBe('SENT')
  })

  it('tar SENASTE inflyttningen, inte den äldsta — fakturan kan ha varit ur PARTIAL emellan', () => {
    // SENT → del → rättelse → SENT → cron: OVERDUE → del. Äldsta posten säger
    // SENT; rätt svar är OVERDUE. En implementation som tar `[0]` efter
    // stigande sortering faller här och bara här.
    expect(
      statusBeforePartialPayment([
        { payload: { previousStatus: 'OVERDUE' } },
        { payload: { previousStatus: 'SENT' } },
      ]),
    ).toBe('OVERDUE')
  })

  it('tom logg → null (anroparen fail-closar, gissar inte)', () => {
    expect(statusBeforePartialPayment([])).toBeNull()
  })

  it('trasig payload → null i stället för en påhittad status', () => {
    expect(statusBeforePartialPayment([{ payload: null }])).toBeNull()
    expect(statusBeforePartialPayment([{ payload: 'inte ett objekt' }])).toBeNull()
    expect(statusBeforePartialPayment([{ payload: {} }])).toBeNull()
    expect(statusBeforePartialPayment([{ payload: { previousStatus: 42 } }])).toBeNull()
    expect(statusBeforePartialPayment([{ payload: { previousStatus: 'HITTEPÅ' } }])).toBeNull()
  })
})

describe('rättelsevägen ligger UTANFÖR statusmaskinen — med flit', () => {
  it('PARTIAL → SENT är INTE en giltig kant i INVOICE_TRANSITIONS', () => {
    // Den bärande spärren för produktbeslutet. `INVOICE_TRANSITIONS` beskriver
    // affärshändelser; en avmatchning är en rättelse av ett misstag. Skulle
    // någon lägga in kanten "för att det blir enklare" faller det här testet och
    // tvingar fram beslutet i stället för att låta det glida in.
    expect(INVOICE_TRANSITIONS.PARTIAL).not.toContain('SENT')
  })

  it('återställningsmålen är exakt SENT och OVERDUE', () => {
    expect([...PAYMENT_REVERSAL_RESTORE_TARGETS].sort()).toEqual(['OVERDUE', 'SENT'])
  })
})
