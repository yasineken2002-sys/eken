import { describe, expect, it } from 'vitest'
import type { FortnoxExportRow } from '@/features/settings/api/fortnox-export.api'
import { ordnaForAvstamning } from './overforing-ordning'

const rad = (id: string, state: FortnoxExportRow['state']): FortnoxExportRow => ({
  id,
  journalEntryId: `je-${id}`,
  state,
  blockReason: null,
  updatedAt: '2026-10-14T12:00:00.000Z',
})

describe('M6: ordnaForAvstamning', () => {
  it('lägger UNKNOWN, REJECTED och RECEIPT_* först, behåller serverordningen och tappar ingen rad', () => {
    const rows = [
      rad('1', 'CONFIRMED'),
      rad('2', 'UNKNOWN'),
      rad('3', 'DRY_RUN_READY'),
      rad('4', 'REJECTED'),
      rad('5', 'BLOCKED'),
      rad('6', 'RECEIPT_MISMATCH'),
      rad('7', 'SENDING'),
      rad('8', 'RECEIPT_IDENTIFIED'),
    ]
    const { attStammaAv, ovriga } = ordnaForAvstamning(rows)
    expect(attStammaAv.map((r) => r.id)).toEqual(['2', '4', '6', '8'])
    expect(ovriga.map((r) => r.id)).toEqual(['1', '3', '5', '7'])
    expect(attStammaAv.length + ovriga.length).toBe(rows.length)
  })

  it('har ingen gräns: 30 okända rader visas alla', () => {
    const rows = Array.from({ length: 30 }, (_, i) => rad(String(i), 'UNKNOWN'))
    expect(ordnaForAvstamning(rows).attStammaAv).toHaveLength(30)
  })
})
