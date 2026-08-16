/**
 * `isP2002From` — vilket unikhetsbrott var det, egentligen?
 *
 * Aviseringens aktiveringsväg fångade tidigare VARJE P2002 som benign idempotens.
 * En kollision på `@@unique(organizationId, noticeNumber)` maskerades därför som
 * "någon annan hann skapa avin", `findFirst` hittade ingenting, och aktiveringen
 * returnerade `{ firstRent: null, mailed: false }` som om allt gått bra.
 *
 * Maskineriet fanns redan i två kopior (plattformsfakturor, avtalsaktivering).
 * Den här specen äger det gemensamma beteendet; anroparna äger bara vilken
 * constraint som är deras.
 */

import { Prisma } from '@prisma/client'
import { isP2002From } from './p2002-constraint'

const PERIODNYCKELN = {
  column: 'leaseId',
  indexName: 'RentNotice_leaseId_year_month_type_key',
}

function p2002(target: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.19.0',
    meta: { target },
  })
}

describe('isP2002From — binder felet till EN bestämd constraint', () => {
  it('kolumn-array från rätt index → true', () => {
    expect(isP2002From(p2002(['leaseId', 'year', 'month', 'type']), PERIODNYCKELN)).toBe(true)
  })

  it('KÄRNAN: kolumn-array från AVINUMMER-indexet → false', () => {
    // Det här är hela defekten. Före ändringen räknades den som benign.
    expect(isP2002From(p2002(['organizationId', 'noticeNumber']), PERIODNYCKELN)).toBe(false)
  })

  it('indexnamn som sträng → true för rätt index, false för fel', () => {
    expect(isP2002From(p2002('RentNotice_leaseId_year_month_type_key'), PERIODNYCKELN)).toBe(true)
    expect(isP2002From(p2002('RentNotice_organizationId_noticeNumber_key'), PERIODNYCKELN)).toBe(
      false,
    )
  })

  it('FAIL-CLOSED: okänd, saknad eller tom target → false', () => {
    // Defaulten är det som gör hjälparen säker i en idempotens-gren: kan vi inte
    // avgöra vilket index det var, låter vi felet gå vidare i stället för att
    // tysta det.
    expect(isP2002From(p2002(undefined), PERIODNYCKELN)).toBe(false)
    expect(isP2002From(p2002([]), PERIODNYCKELN)).toBe(false)
    expect(isP2002From(p2002(42), PERIODNYCKELN)).toBe(false)
    expect(isP2002From(p2002(['någon', 'annan', 'kolumn']), PERIODNYCKELN)).toBe(false)
  })

  it('en ANNAN Prisma-felkod är aldrig träff', () => {
    const p2025 = new Prisma.PrismaClientKnownRequestError('Not found', {
      code: 'P2025',
      clientVersion: '5.19.0',
      meta: { target: ['leaseId'] },
    })
    expect(isP2002From(p2025, PERIODNYCKELN)).toBe(false)
  })

  it('ett vanligt Error är aldrig träff', () => {
    expect(isP2002From(new Error('boom'), PERIODNYCKELN)).toBe(false)
    expect(isP2002From(null, PERIODNYCKELN)).toBe(false)
    expect(isP2002From(undefined, PERIODNYCKELN)).toBe(false)
  })

  it('plattformens constraint fungerar likadant — samma maskineri, annan identitet', () => {
    const PERIOD = { column: 'planPeriodStart', indexName: 'platform_invoice_unique_period' }
    expect(isP2002From(p2002(['organizationId', 'type', 'planPeriodStart']), PERIOD)).toBe(true)
    // Ett nummer-race får ALDRIG maskeras som "fakturan fanns redan".
    expect(isP2002From(p2002(['invoiceNumber']), PERIOD)).toBe(false)
  })
})
