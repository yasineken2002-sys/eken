import { describe, expect, it } from 'vitest'
import {
  CreateExpenseSchema,
  CreateJournalEntrySchema,
  CreateSupplierInvoiceSchema,
} from '@eken/shared'
import { kontraktsfel } from './contract-gate'

describe('kontraktsfel — sista grinden mot det delade schemat', () => {
  it('en komplett leverantörsfaktura släpps igenom', () => {
    expect(
      kontraktsfel(CreateSupplierInvoiceSchema, {
        supplierName: 'Rörjouren AB',
        description: 'Stambyte',
        invoiceDate: '2026-09-01',
        dueDate: '2026-10-01',
        expenseAccount: 5070,
        amount: 1250,
        vatRate: 25,
        vatAmount: 250,
      }),
    ).toBeNull()
  })

  it('DEN AVGÖRANDE: ett saknat obligatoriskt fält stoppas här', () => {
    // Precis den form som i #795 blev ett 400-svar i produktion i stället för
    // ett fel i webbläsaren: nyttolasten saknade ett fält servern krävde.
    const fel = kontraktsfel(CreateSupplierInvoiceSchema, {
      description: 'Stambyte',
      invoiceDate: '2026-09-01',
      dueDate: '2026-10-01',
      expenseAccount: 5070,
      amount: 1250,
      vatRate: 25,
    })
    expect(fel).toContain('supplierName')
  })

  it('felet NAMNGER fältet — annars vet man inte vad som är fel', () => {
    const fel = kontraktsfel(CreateExpenseSchema, {
      date: '2026-09-01',
      description: 'Kaffe',
      amount: 0,
      accountNumber: 5070,
    })
    expect(fel).toContain('amount')
  })

  it('ett konto utanför BAS-intervallet stoppas', () => {
    const fel = kontraktsfel(CreateExpenseSchema, {
      date: '2026-09-01',
      description: 'Kaffe',
      amount: 10,
      accountNumber: 42,
    })
    expect(fel).toContain('accountNumber')
  })

  it('ett verifikat med EN rad stoppas — minst två krävs', () => {
    const fel = kontraktsfel(CreateJournalEntrySchema, {
      date: '2026-09-01',
      description: 'Enbent verifikat',
      lines: [{ accountNumber: 1930, debit: 100 }],
    })
    expect(fel).toContain('två')
  })

  it('ett giltigt verifikat släpps igenom', () => {
    expect(
      kontraktsfel(CreateJournalEntrySchema, {
        date: '2026-09-01',
        description: 'Omföring',
        lines: [
          { accountNumber: 1930, debit: 100 },
          { accountNumber: 1510, credit: 100 },
        ],
      }),
    ).toBeNull()
  })
})
