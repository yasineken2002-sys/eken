/**
 * #378/#482 — ÖVERBETALNING SKA VARA SYNLIG, UTAN ATT KRAVTRAPPAN ÄNDRAS.
 *
 * `computeInvoiceDebt` klampade `outstanding = max(0, claim)`. Klampningen är
 * RÄTT för sin fråga — "hur mycket är obetalt" — och är kvar. Defekten var att
 * den negativa signalen bara överlevde som ett TECKEN på `claim`, och att exakt
 * EN konsument i hela kodbasen läste det tecknet
 * (`collections/collection-export.service.ts`). För varje svarsyta och varje vy
 * var pengarna osynliga.
 *
 * ── VAD VAKTEN KAN OCH INTE KAN UTTRYCKA ───────────────────────────────────
 *
 * Att mekaniskt fälla "en ny konsument som klampar bort signalen" går INTE i
 * allmänhet: ett `Math.max(0, …)` är korrekt på de flesta ställen det står i
 * dag (`outstanding`, `ocrOutstanding`, `payable`), och att skilja ett riktigt
 * klamp från ett som tappar information kräver dataflödesanalys. Ett svepande
 * förbud hade varit rött från dag ett och därmed avstängt.
 *
 * Det som DÄREMOT går att uttrycka, och som är den defekt ärendet beskriver: en
 * SVARSYTA som bär `outstanding` men tappar `overpaid`. Det är den mekaniska
 * kontrollen nedan. Utöver den fastnaglas beräkningens form, så att en framtida
 * ändring som tar bort ett av talen faller.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma } from '@prisma/client'
import { computeInvoiceDebt, invoiceOutstanding, invoiceOverpaid } from './invoice-debt'
import { computeRentDebt } from '../avisering/rent-debt.service'
import { RentNoticeType } from '@prisma/client'

const D = (n: number | string) => new Prisma.Decimal(n)

/** Svarsytor som bär restskulden. Bär de den, ska de bära överbetalningen med. */
export function svarsytorUtanOverpaid(källa: string): number[] {
  const rader = källa.split('\n')
  const brister: number[] = []
  rader.forEach((rad, i) => {
    if (!/outstanding:\s*invoiceOutstanding\(/.test(rad)) return
    // Samma objektliteral: leta inom ett litet fönster efter syskonfältet.
    const fönster = rader.slice(i, i + 8).join('\n')
    if (!/overpaid:\s*invoiceOverpaid\(/.test(fönster)) brister.push(i + 1)
  })
  return brister
}

describe('#378 — beräkningen exponerar BÅDA talen', () => {
  it('överbetalning: outstanding klampas till 0, overpaid bär beloppet', () => {
    const d = computeInvoiceDebt({ total: D(10_000), allocations: [D(10_000.5)], credits: [] })
    expect(d.outstanding.toNumber()).toBe(0)
    expect(d.overpaid.toNumber()).toBe(0.5)
    expect(d.claim.toNumber()).toBe(-0.5)
    expect(d.isSettled).toBe(true)
  })

  it('underbetalning: overpaid är 0, outstanding bär restskulden', () => {
    const d = computeInvoiceDebt({ total: D(10_000), allocations: [D(4_000)], credits: [] })
    expect(d.outstanding.toNumber()).toBe(6_000)
    expect(d.overpaid.toNumber()).toBe(0)
  })

  it('exakt ett av outstanding/overpaid är skilt från noll — aldrig båda', () => {
    for (const [total, betalt] of [
      [100, 0],
      [100, 40],
      [100, 100],
      [100, 140],
    ] as const) {
      const d = computeInvoiceDebt({ total: D(total), allocations: [D(betalt)], credits: [] })
      const båda = d.outstanding.isZero() === false && d.overpaid.isZero() === false
      expect(båda).toBe(false)
    }
  })

  it('hjälparna speglar varandra och kräver payments (typspärren)', () => {
    const rad = { total: D(500), payments: [{ amount: D(800) }], creditNotes: [] }
    expect(invoiceOutstanding(rad)).toBe(0)
    expect(invoiceOverpaid(rad)).toBe(300)
  })

  it('KANARIEFÅGEL: en beräkning utan overpaid skulle inte klara det här', () => {
    // Fastnaglar formen. Tas fältet bort faller detta, inte bara en vy.
    const d = computeInvoiceDebt({ total: D(1), allocations: [D(2)], credits: [] })
    expect(Object.keys(d).sort()).toEqual(
      ['claim', 'credited', 'isSettled', 'outstanding', 'overpaid', 'paid', 'total'].sort(),
    )
  })
})

describe('#378 — svarsytan tappar inte signalen', () => {
  const src = readFileSync(join(__dirname, 'invoices.service.ts'), 'utf8')

  it('varje svarsyta som bär outstanding bär också overpaid', () => {
    expect(svarsytorUtanOverpaid(src)).toEqual([])
  })

  it('det finns faktiskt svarsytor att granska (annars mäter kontrollen inget)', () => {
    expect((src.match(/outstanding:\s*invoiceOutstanding\(/g) ?? []).length).toBeGreaterThanOrEqual(
      2,
    )
  })

  it('KANARIEFÅGEL: skanningen fäller en yta som bara bär outstanding', () => {
    const dålig = `return { ...inv, outstanding: invoiceOutstanding({ total, payments }) }`
    expect(svarsytorUtanOverpaid(dålig)).toEqual([1])
    const bra = `return { ...inv,\n outstanding: invoiceOutstanding(x),\n overpaid: invoiceOverpaid(x) }`
    expect(svarsytorUtanOverpaid(bra)).toEqual([])
  })
})

describe('#378 — KRAVTRAPPAN ÄNDRAR INTE BETEENDE', () => {
  const bas = {
    type: RentNoticeType.RENT,
    totalAmount: 10_000,
    consumptionAmount: 0,
    miscChargeAmount: 0,
    reminderFeeAmount: 0,
    interestAccruedAmount: 0,
  }

  it('ÖVERBETALD avi kan inte eskalera: ocrOutstanding = 0 (grindens fält)', () => {
    const d = computeRentDebt({ ...bas, allocations: [10_500], credits: [] })
    expect(d.ocrOutstanding).toBe(0)
    expect(d.outstanding).toBe(0)
    // ... och signalen finns kvar, bredvid.
    expect(d.overpaid).toBe(500)
  })

  it('OBETALD avi eskalerar precis som förut: ocrOutstanding > 0', () => {
    const d = computeRentDebt({ ...bas, allocations: [], credits: [] })
    expect(d.ocrOutstanding).toBe(10_000)
    expect(d.outstanding).toBe(10_000)
    expect(d.overpaid).toBe(0)
  })

  it('DELBETALD avi eskalerar på restskulden, inte på bruttot', () => {
    const d = computeRentDebt({ ...bas, allocations: [4_000], credits: [] })
    expect(d.ocrOutstanding).toBe(6_000)
    expect(d.overpaid).toBe(0)
  })

  it('grinden läser fortfarande det KLAMPADE fältet, inte claim', () => {
    // Mekanisk pinne: byter någon grinden till `claim <= 0` skulle en
    // överbetald avi fortfarande inte eskalera, men en avi med claim exakt 0
    // och en framtida signerad variant kan bete sig annorlunda. Kravet är att
    // grinden läser den klampade storheten.
    const gate = readFileSync(
      join(__dirname, '..', 'avisering', 'rent-reminder.service.ts'),
      'utf8',
    )
    expect(gate).toMatch(/ocrOutstanding\s*<=\s*0/)
    expect(gate).not.toMatch(/debt\.claim\s*<=\s*0/)
  })
})
