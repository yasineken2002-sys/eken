/**
 * #326 D — bankbetalningens idempotensnyckel.
 *
 * Nyckeln var `transaction.id`. Det höll så länge en banktransaktion kunde
 * bokföras exakt en gång — vilket den kunde, av en slump: efter en avmatchning
 * låg allokeringen kvar och dess `bankTransactionId @unique` gav P2002 på varje
 * ommatchningsförsök. #326 B städar allokeringen, och därmed föll den spärren
 * bort. Utan D återanvänder ommatchningen det gamla, redan reverserade
 * verifikatet: allokering skrivs, ingen bokföring sker.
 *
 * Här testas nyckelns FORM och att de tre användningarna (skrivare, reversering,
 * test) har en enda källa. Att böckerna faktiskt stämmer efter en ommatchning
 * bevisas mot riktig Postgres i bevisriggen.
 */

import { bankPaymentSourceId } from './accounting.service'

describe('bankPaymentSourceId', () => {
  it('nycklar på ALLOKERINGEN, inte på banktransaktionen', () => {
    expect(bankPaymentSourceId('invoice', 'alloc-1')).toBe('invoice-bank-payment:alloc-1')
    expect(bankPaymentSourceId('rent-notice', 'alloc-1')).toBe('rent-notice-bank-payment:alloc-1')
  })

  it('faktura och avi har SKILDA namnrymder', () => {
    // Båda är UUID:n ur olika tabeller. Delade de prefix kunde en avi-allokering
    // och en faktura-allokering i teorin kollidera på (org, source, sourceId),
    // som är ett UNIKT index — och kollisionen hade yttrat sig som en utebliven
    // bokföring, inte som ett fel.
    expect(bankPaymentSourceId('invoice', 'x')).not.toBe(bankPaymentSourceId('rent-notice', 'x'))
  })

  it('krockar inte med de manuella vägarnas nycklar (#290 / PR 3b)', () => {
    // `invoice-manual-payment:<id>` och `rent-notice-payment:<id>` är tagna.
    // Prefixen får inte vara varandras prefix heller — en `startsWith`-baserad
    // sökning någonstans skulle annars träffa fel post.
    const keys = [
      bankPaymentSourceId('invoice', 'a'),
      bankPaymentSourceId('rent-notice', 'a'),
      'invoice-manual-payment:a',
      'rent-notice-payment:a',
    ]
    expect(new Set(keys).size).toBe(4)
    for (const a of keys) {
      for (const b of keys) {
        if (a !== b) expect(a.startsWith(b)).toBe(false)
      }
    }
  })
})
