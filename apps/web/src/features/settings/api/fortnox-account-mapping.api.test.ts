import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FortnoxAccountMappingDraftInput } from '@eken/shared'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('@/lib/api', () => mocks)

import {
  createFortnoxAccountMappingDraft,
  getFortnoxAccountMapping,
} from './fortnox-account-mapping.api'

const input: FortnoxAccountMappingDraftInput = {
  financialYearId: 1,
  rows: [
    {
      role: 'KUNDTILLGODOSKULD',
      vatTreatment: 'EJ_TILLAMPLIG',
      sourceAccountNumber: 2998,
      targetAccountNumber: 2997,
    },
  ],
}

beforeEach(() => vi.clearAllMocks())

describe('Kundtillgodoskuld över webbens Fortnox-kontrakt', () => {
  it('läser den nya rollen och skickar exakt det uttryckliga kontovalet', async () => {
    const behov = [
      {
        role: 'KUNDTILLGODOSKULD',
        vatTreatment: 'EJ_TILLAMPLIG',
        sourceAccountNumber: 2998,
        sourceAccountName: 'Syntetiskt skuldkonto',
        varfor: 'mottaget kundtillgodo',
      },
    ]
    mocks.get.mockResolvedValue({ behov, ejStodda: [], revisioner: [] })
    expect((await getFortnoxAccountMapping()).behov).toEqual(behov)
    mocks.post.mockResolvedValue({ id: 'revision-1', revision: 1, contentSha256: 'a'.repeat(64) })
    await createFortnoxAccountMappingDraft(input)
    expect(mocks.post).toHaveBeenCalledWith(
      '/integrations/fortnox/account-mapping/revisions',
      input,
    )
  })

  it.each(['MOMSFRI', 'AVDRAGSGILL'] as const)(
    'stoppar momsbehandlingen %s före POST',
    async (vatTreatment) => {
      await expect(
        createFortnoxAccountMappingDraft({
          ...input,
          rows: input.rows.map((row) => ({ ...row, vatTreatment })),
        }),
      ).rejects.toThrow()
      expect(mocks.post).not.toHaveBeenCalled()
    },
  )

  it('ersätter inte ett ogiltigt målkonto med ett förvalt konto', async () => {
    await expect(
      createFortnoxAccountMappingDraft({
        ...input,
        rows: input.rows.map((row) => ({ ...row, targetAccountNumber: 0 })),
      }),
    ).rejects.toThrow()
    expect(mocks.post).not.toHaveBeenCalled()
  })
})
