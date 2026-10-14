import { NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  assertNoIncompleteOpening,
  IncompleteOpeningException,
  INCOMPLETE_OPENING_REASON,
} from './incomplete-opening'

describe('ofärdigt öppningspaket: fel och begränsning', () => {
  it('NULL-brytdatum inför ingen ny paket- eller aktiveringsregel', async () => {
    const packages = jest.fn()
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ billingCutoverDate: null }]),
      openingPackage: { findFirst: packages },
    }
    await assertNoIncompleteOpening(tx as unknown as Prisma.TransactionClient, 'org')
    expect(packages).not.toHaveBeenCalled()
  })

  it('saknad organisation ger ett synligt fel', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) }
    await expect(
      assertNoIncompleteOpening(tx as unknown as Prisma.TransactionClient, 'saknas'),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it('ofärdigt paket ger fast409 utan privata identiteter', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ billingCutoverDate: new Date('2026-11-01') }]),
      openingPackage: { findFirst: jest.fn().mockResolvedValue({ id: 'privat-paket-id' }) },
    }
    const error = await assertNoIncompleteOpening(
      tx as unknown as Prisma.TransactionClient,
      'privat-org-id',
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(IncompleteOpeningException)
    expect((error as IncompleteOpeningException).getStatus()).toBe(409)
    expect((error as IncompleteOpeningException).getResponse()).toEqual({
      code: 'OPENING_PACKAGE_INCOMPLETE',
      message: INCOMPLETE_OPENING_REASON,
    })
  })

  it('DB-fel blir inte ett falskt kundstartsstopp', async () => {
    const error = new Error('DB-fel')
    const tx = { $queryRaw: jest.fn().mockRejectedValue(error) }
    await expect(
      assertNoIncompleteOpening(tx as unknown as Prisma.TransactionClient, 'org'),
    ).rejects.toBe(error)
  })
})
