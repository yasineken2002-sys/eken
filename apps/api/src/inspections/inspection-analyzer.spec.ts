/**
 * AI-hål #2 — besiktnings-AI:ns vision-output validateras med Zod + rimlighetsgrind
 * INNAN den får bli ett underlag för depositionsavdrag mot en hyresgäst.
 *
 * Verifierar att InspectionAnalyzerService.analyzeImages():
 *   • giltig output → normaliseras och returneras (siffror behålls, fält trimmas)
 *   • hallucinerad/orimligt hög repairCost → repairCost null + FLAGGAS i notes (tyst aldrig)
 *   • negativ repairCost → null + flagga (aldrig ett negativt "avdrag")
 *   • kostnad på GOOD/ACCEPTABLE → null (ingen kostnad utan skada)
 *   • ogiltig struktur (items ej array) → BadRequestException (kasseras, manuell hantering)
 *   • icke-JSON-svar → BadRequestException (gissar aldrig ett belopp)
 */

import { BadRequestException } from '@nestjs/common'
import { InspectionAnalyzerService } from './inspection-analyzer.service'

function makeService(aiText: string | { nonText: true }) {
  const config = { get: jest.fn().mockReturnValue('') }
  const usage = { logUsage: jest.fn().mockResolvedValue(undefined) }
  const quota = {}
  const service = new InspectionAnalyzerService(config as never, usage as never, quota as never)

  const content =
    typeof aiText === 'string'
      ? [{ type: 'text', text: aiText }]
      : [{ type: 'tool_use', id: 'x', name: 'y', input: {} }] // inget textblock
  const create = jest
    .fn()
    .mockResolvedValue({ content, usage: { input_tokens: 1, output_tokens: 1 } })
  ;(service as unknown as { client: unknown }).client = { messages: { create } }
  return { service, create }
}

const img = [{ buffer: Buffer.from('x'), mimeType: 'image/jpeg' as const }]

function aiJson(items: unknown[], over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    overallCondition: 'Generellt gott skick',
    notes: 'Inga anmärkningar',
    urgentIssues: [],
    estimatedTotalCost: 5000,
    items,
    ...over,
  })
}

describe('InspectionAnalyzerService — output-validering', () => {
  it('giltig output normaliseras och returneras (rimlig repairCost behålls)', async () => {
    const { service } = makeService(
      aiJson([
        { room: 'Badrum', item: 'Golv', condition: 'DAMAGED', notes: 'Spricka', repairCost: 8000 },
        { room: 'Kök', item: 'Bänkskiva', condition: 'GOOD', notes: null, repairCost: null },
      ]),
    )
    const res = await service.analyzeImages(img, 'org-1', 'user-1')
    expect(res.items).toHaveLength(2)
    expect(res.items[0]!).toMatchObject({ room: 'Badrum', condition: 'DAMAGED', repairCost: 8000 })
    expect(res.items[1]!.repairCost).toBeNull()
    // Total härleds från VALIDERADE poster (8000 + 0), inte AI:ns råa 5000.
    expect(res.estimatedTotalCost).toBe(8000)
  })

  it('estimatedTotalCost härleds från validerade poster — AI:s råa total ignoreras när poster nollställts', async () => {
    const { service } = makeService(
      aiJson(
        [{ room: 'Hall', item: 'Vägg', condition: 'DAMAGED', notes: 'Hål', repairCost: 999999999 }],
        { estimatedTotalCost: 999999999 },
      ),
    )
    const res = await service.analyzeImages(img, 'org-1', 'user-1')
    expect(res.items[0]!.repairCost).toBeNull()
    expect(res.estimatedTotalCost).toBe(0) // posten nollställd → total 0, inte hallucinationen
  })

  it('HALLUCINERAD orimligt hög repairCost → null + flagga i notes (aldrig tyst)', async () => {
    const { service } = makeService(
      aiJson([
        { room: 'Hall', item: 'Vägg', condition: 'DAMAGED', notes: 'Hål', repairCost: 999999999 },
      ]),
    )
    const res = await service.analyzeImages(img, 'org-1', 'user-1')
    expect(res.items[0]!.repairCost).toBeNull() // INTE persisterat som belopp
    expect(res.items[0]!.notes).toContain('orimlig reparationskostnad')
    expect(res.items[0]!.notes).toContain('manuell granskning')
  })

  it('NEGATIV repairCost → null + flagga (aldrig ett negativt avdrag)', async () => {
    const { service } = makeService(
      aiJson([
        { room: 'Sovrum', item: 'Dörr', condition: 'DAMAGED', notes: null, repairCost: -500 },
      ]),
    )
    const res = await service.analyzeImages(img, 'org-1', 'user-1')
    expect(res.items[0]!.repairCost).toBeNull()
    expect(res.items[0]!.notes).toContain('orimlig reparationskostnad')
  })

  it('kostnad på GOOD/ACCEPTABLE-post → null (ingen kostnad utan skada)', async () => {
    const { service } = makeService(
      aiJson([{ room: 'Kök', item: 'Golv', condition: 'GOOD', notes: null, repairCost: 4000 }]),
    )
    const res = await service.analyzeImages(img, 'org-1', 'user-1')
    expect(res.items[0]!.repairCost).toBeNull()
  })

  it('fel typ på repairCost (sträng-skräp) → null', async () => {
    const { service } = makeService(
      aiJson([
        { room: 'Badrum', item: 'Handfat', condition: 'DAMAGED', notes: null, repairCost: 'dyrt' },
      ]),
    )
    const res = await service.analyzeImages(img, 'org-1', 'user-1')
    expect(res.items[0]!.repairCost).toBeNull()
  })

  it('ogiltig struktur (items ej array) → BadRequestException, kasseras', async () => {
    const { service } = makeService(
      JSON.stringify({ overallCondition: 'x', items: 'inte en array' }),
    )
    await expect(service.analyzeImages(img, 'org-1', 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('icke-JSON-svar → BadRequestException (gissar aldrig ett belopp)', async () => {
    const { service } = makeService('Tyvärr kan jag inte analysera detta.')
    await expect(service.analyzeImages(img, 'org-1', 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('okänt condition-värde → faller tillbaka till GOOD (konservativt: inget avdrag)', async () => {
    const { service } = makeService(
      aiJson([{ room: 'Hall', item: 'Tak', condition: 'KAPUTT', notes: null, repairCost: 3000 }]),
    )
    const res = await service.analyzeImages(img, 'org-1', 'user-1')
    expect(res.items[0]!.condition).toBe('GOOD')
    expect(res.items[0]!.repairCost).toBeNull() // GOOD → ingen kostnad
    // Okänt skick får inte tyst dölja en möjlig skada — flaggas.
    expect(res.items[0]!.notes).toContain('okänt skick')
  })
})
