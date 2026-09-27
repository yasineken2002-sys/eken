import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RentNotice } from '../api/avisering.api'
import { RentNoticeDetailModal } from './RentNoticeDetailModal'

vi.mock('../hooks/useAvisering', async (original) => ({
  ...(await original<object>()),
  useRentNoticeCreditPreview: () => ({ isLoading: true }),
  useRentNoticeCollectionStatus: () => ({}),
  useRentNoticeEvents: () => ({}),
}))
afterEach(cleanup)

it('avidetaljen visar svensk kalenderdag för en avi sparad vid svensk midnatt', () => {
  const notice = {
    id: 'synthetic-notice',
    noticeNumber: 'AVI-TEST',
    status: 'SENT',
    month: 7,
    year: 2026,
    dueDate: '2026-06-30T22:00:00Z',
    tenant: { type: 'INDIVIDUAL', firstName: 'Alva', lastName: 'Test' },
  } as RentNotice
  render(<RentNoticeDetailModal notice={notice} onClose={() => undefined} />)
  expect(screen.getByText('Förfaller 2026-07-01')).toBeDefined()
})
