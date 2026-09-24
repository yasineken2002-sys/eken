jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'

describe('avilistans datumtext i AI-verktyget', () => {
  it.each(['2026-07-01T00:00:00Z', '2026-06-30T22:00:00Z'])(
    '%s presenteras som 1 juli utan ändring av data, belopp eller urval',
    async (dueDate) => {
      const notices = [
        {
          noticeNumber: 'AVI-2026-07-0001',
          ocrNumber: '123456',
          totalAmount: 9000,
          dueDate: new Date(dueDate),
          status: 'SENT',
          tenant: { type: 'INDIVIDUAL', firstName: 'Alva', lastName: 'Test' },
        },
      ]
      const before = JSON.stringify(notices)
      const findAll = jest.fn().mockResolvedValue(notices)
      const executor = Object.assign(Object.create(ToolExecutorService.prototype), {
        aviseringService: { findAll },
        audit: { logToolExecution: jest.fn().mockResolvedValue(undefined) },
        logger: { warn: jest.fn(), error: jest.fn() },
      }) as ToolExecutorService
      // Riktig verktygsmetod, mockad aviläsning/audit. Ingen modell eller leverantör.
      const result = await executor.executeTool(
        'get_rent_notices',
        { month: 7, year: 2026, status: 'SENT' },
        'own-org',
        { kind: 'USER', id: 'synthetic-owner' },
        'OWNER',
      )
      expect(result.success).toBe(true)
      expect(findAll).toHaveBeenCalledWith('own-org', { month: 7, year: 2026, status: 'SENT' })
      expect(result.message).toContain('Förfaller: 2026-07-01, Status: Skickad')
      expect(result.message).toMatch(/9\s000 kr/)
      // Befintlig inramning av extern namntext ska också bestå. JSON-jämförelsen
      // motsvarar verktygssvaret över tråden och undviker Date-objekt mellan realms.
      expect(JSON.parse(JSON.stringify(result.data))).toEqual([
        {
          ...notices[0],
          dueDate: new Date(dueDate).toISOString(),
          tenant: {
            type: 'INDIVIDUAL',
            firstName: '⟦OSÄKER⟧Alva⟦/OSÄKER⟧',
            lastName: '⟦OSÄKER⟧Test⟦/OSÄKER⟧',
          },
        },
      ])
      expect(JSON.stringify(notices)).toBe(before)
    },
  )
})
