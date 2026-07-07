/**
 * redactSensitive får ALDRIG rekursera in i en Prisma Decimal och platta ut den
 * till {s,e,d}-internaler — då matas bokförings-AI:n med decimal.js-interndata i
 * stället för belopp (tyst hallucinationskälla). Belopp ska komma ut som number.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { Prisma } from '@prisma/client'
import { redactSensitive } from './tool-executor.service'

describe('redactSensitive — Prisma Decimal', () => {
  it('konverterar en Decimal till number i stället för att platta ut den', () => {
    const out = redactSensitive({ total: new Prisma.Decimal('1500.50') })
    expect(out.total).toBe(1500.5)
    expect(typeof out.total).toBe('number')
  })

  it('hanterar Decimals nästlade i arrayer/objekt (t.ex. faktura-rader)', () => {
    const out = redactSensitive({
      invoiceNumber: 'F-2026-0001',
      lines: [
        { description: 'Hyra', amount: new Prisma.Decimal('10000') },
        { description: 'IMD el', amount: new Prisma.Decimal('342.75') },
      ],
    })
    expect(out.lines[0]!.amount).toBe(10000)
    expect(out.lines[1]!.amount).toBe(342.75)
    // Inga decimal.js-internaler kvar
    expect(JSON.stringify(out)).not.toMatch(/"s":|"e":|"d":\[/)
  })

  it('rör inte vanliga number/string-fält', () => {
    const out = redactSensitive({ count: 5, status: 'PAID' })
    expect(out.count).toBe(5)
    expect(out.status).toBe('PAID')
  })
})
