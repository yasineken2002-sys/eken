/**
 * requiresDoubleConfirmation — dubbelbekräftelse för högriskåtgärder. pause_reminders
 * och mark_invoice_paid lyftes hit (defense-in-depth mot indirekt prompt injection —
 * de är exakt vad OWNER_INJECTION_PATTERN bevakar).
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('@anthropic-ai/sdk', () => ({ __esModule: true, default: class {} }))

import { requiresDoubleConfirmation } from './ai-assistant.service'

describe('requiresDoubleConfirmation', () => {
  it('kräver dubbelbekräftelse för pause_reminders (injektions-måltavla)', () => {
    expect(requiresDoubleConfirmation('pause_reminders', {})).toBe(true)
  })

  it('kräver dubbelbekräftelse för mark_invoice_paid (injektions-måltavla)', () => {
    expect(requiresDoubleConfirmation('mark_invoice_paid', { invoiceId: 'i1' })).toBe(true)
  })

  it('kräver dubbelbekräftelse för close_period och export_for_collection', () => {
    expect(requiresDoubleConfirmation('close_period', {})).toBe(true)
    expect(requiresDoubleConfirmation('export_for_collection', {})).toBe(true)
  })

  it('kräver INTE dubbelbekräftelse för en vanlig läs-/lågriskåtgärd', () => {
    expect(requiresDoubleConfirmation('get_invoices', {})).toBe(false)
    expect(requiresDoubleConfirmation('resume_reminders', {})).toBe(false)
  })

  it('create_invoice kräver dubbelbekräftelse endast över 50 000 kr', () => {
    expect(requiresDoubleConfirmation('create_invoice', { amount: 40000 })).toBe(false)
    expect(requiresDoubleConfirmation('create_invoice', { amount: 60000 })).toBe(true)
  })
})
