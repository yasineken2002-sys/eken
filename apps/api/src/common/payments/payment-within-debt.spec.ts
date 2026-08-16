/**
 * H4 — EN regel för överbetalning, delad av båda manuella betalvägarna.
 *
 * Fakturans manuella väg (`markAsPaidManually`) hade spärren. Avins
 * (`AviseringService.markAsPaid`) saknade den helt: 20 000 kr på en
 * 10 000-kronorsavi allokerades i sin helhet, avin flippade PAID, och
 * verifikatet krediterade 1510 med 20 000 mot en fordran på 10 000 →
 * kundfordran MINUS 10 000.
 *
 * Specen bevakar två saker som är lätta att tappa var för sig:
 *   1. att regeln beter sig rätt vid gränserna
 *   2. att BÅDA vägarna faktiskt använder DEN HÄR regeln — inte var sin kopia
 */

import { BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertPaymentWithinDebt } from './payment-within-debt'

const kr = (n: number | string) => new Prisma.Decimal(n)

describe('assertPaymentWithinDebt — gränserna', () => {
  it('exakt restskuld släpps igenom', () => {
    expect(() => assertPaymentWithinDebt(kr(10_000), kr(10_000))).not.toThrow()
  })

  it('delbetalning släpps igenom', () => {
    expect(() => assertPaymentWithinDebt(kr(1), kr(10_000))).not.toThrow()
  })

  it('ETT ÖRE över restskulden avvisas — ingen tolerans på ett inskrivet belopp', () => {
    // Skillnaden mot bankvägen, med flit: där absorberas en krona åt vardera
    // hållet eftersom beloppet är ett mätt faktum ur en bankfil. Här är det
    // något en människa knappat in och kan rätta.
    expect(() => assertPaymentWithinDebt(kr('10000.01'), kr(10_000))).toThrow(BadRequestException)
  })

  it('femtio öre över avvisas också — öresfallet är inte ett undantag', () => {
    expect(() => assertPaymentWithinDebt(kr('10000.50'), kr(10_000))).toThrow(
      /överstiger restskulden/,
    )
  })

  it('meddelandet NAMNGER båda talen', () => {
    // Det är det som gör beskedet användbart för den som skrev fel: hen ser vad
    // hen skrev och vad som faktiskt är kvar att betala.
    try {
      assertPaymentWithinDebt(kr('10500'), kr('10000'))
      throw new Error('skulle ha kastat')
    } catch (err) {
      const m = (err as Error).message
      expect(m).toContain('10500.00')
      expect(m).toContain('10000.00')
      expect(m).toContain('överbetalning hanteras inte')
    }
  })

  it('noll restskuld avvisas — och FÖRE beloppskontrollen', () => {
    // Ordningen ger det mest specifika beskedet: skulden är reglerad, inte
    // "beloppet är fel".
    expect(() => assertPaymentWithinDebt(kr(1), kr(0))).toThrow(/redan fullt reglerad/)
    expect(() => assertPaymentWithinDebt(kr(0), kr(0))).toThrow(/redan fullt reglerad/)
  })

  it('negativ restskuld (överallokerad sedan tidigare) avvisas', () => {
    expect(() => assertPaymentWithinDebt(kr(1), kr(-500))).toThrow(/redan fullt reglerad/)
  })

  it('noll eller negativt belopp avvisas', () => {
    expect(() => assertPaymentWithinDebt(kr(0), kr(10_000))).toThrow(/större än noll/)
    expect(() => assertPaymentWithinDebt(kr(-1), kr(10_000))).toThrow(/större än noll/)
  })

  it('meddelandena nämner varken faktura eller avi — regeln har inget subjekt', () => {
    // En hjälpare som tar ett subjekt som parameter är en hjälpare som kan
    // konfigureras isär igen. Talen räcker.
    const meddelanden: string[] = []
    for (const [a, o] of [
      [kr(1), kr(0)],
      [kr(0), kr(10)],
      [kr(11), kr(10)],
    ] as const) {
      try {
        assertPaymentWithinDebt(a, o)
      } catch (err) {
        meddelanden.push((err as Error).message)
      }
    }
    expect(meddelanden).toHaveLength(3)
    for (const m of meddelanden) {
      expect(m.toLowerCase()).not.toContain('faktur')
      expect(m.toLowerCase()).not.toContain('avi')
    }
  })
})

describe('VAKT: båda manuella vägarna använder den delade regeln', () => {
  // Kanariefågel mot återfall. Skulle någon skriva tillbaka en egen inline-spärr
  // i endera tjänsten — eller ta bort anropet — blir det rött här, i stället för
  // att upptäckas som en divergens flera månader senare (jfr
  // TENANT_CREDENTIAL_KEYS, som fanns i två kopior som drev isär).
  const SRC = join(__dirname, '..', '..')

  it.each([
    ['fakturans manuella väg', 'invoices/invoices.service.ts'],
    ['avins manuella väg', 'avisering/avisering.service.ts'],
  ])('%s anropar assertPaymentWithinDebt', (_namn, fil) => {
    const src = readFileSync(join(SRC, fil), 'utf8')
    expect(src).toContain('assertPaymentWithinDebt(')
  })

  it('ingen av dem bär kvar en EGEN överbetalningstext', () => {
    // Formuleringen får finnas på exakt ett ställe. Dyker den upp inline igen är
    // det början på två regler som ser ut som en.
    for (const fil of ['invoices/invoices.service.ts', 'avisering/avisering.service.ts']) {
      const src = readFileSync(join(SRC, fil), 'utf8')
      expect(src).not.toContain('överbetalning hanteras inte')
    }
  })
})
