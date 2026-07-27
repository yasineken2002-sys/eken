/**
 * Backfillen som flyttar befintliga klartext-personnummer till kolumnparet.
 *
 * Den här körs i produktion mot rader som redan finns — den får inte kunna
 * lämna en rad halvmigrerad, tömma en rad utan att först kunna läsa tillbaka
 * chiffertexten, eller tyst hoppa över rader när nycklarna saknas.
 */

import * as crypto from 'crypto'
import { backfillPersonalNumbers } from './backfill-personal-numbers'
import { TEST_PII_KEY, TEST_PII_PEPPER } from '../common/crypto/personal-number.testing'

const ENV = { SIGNING_PII_KEY: TEST_PII_KEY, SIGNING_PII_PEPPER: TEST_PII_PEPPER }

type Row = {
  id: string
  personalNumberLegacy: string | null
  personalNumberEnc?: string | null
  personalNumberHash?: string | null
}

/** Minimal Prisma-attrapp med riktig tabellsemantik (rader muteras på plats). */
function fakePrisma(tenants: Row[], customers: Row[] = []) {
  const delegate = (rows: Row[]) => ({
    count: jest.fn(async () => rows.filter((r) => r.personalNumberLegacy !== null).length),
    findMany: jest.fn(async (args: { take: number }) =>
      rows
        .filter((r) => r.personalNumberLegacy !== null)
        .slice(0, args.take)
        .map((r) => ({ id: r.id, personalNumberLegacy: r.personalNumberLegacy })),
    ),
    update: jest.fn(async (args: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === args.where.id)!
      Object.assign(row, args.data)
      return row
    }),
  })
  return { tenant: delegate(tenants), customer: delegate(customers), _tenants: tenants }
}

function decrypt(enc: string): string {
  const raw = Buffer.from(enc, 'base64')
  const d = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(TEST_PII_KEY, 'hex'),
    raw.subarray(0, 12),
  )
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
}

describe('backfill — klartext ersätts av chiffertext + blind-index', () => {
  it('krypterar varje rad och nollar klartexten i samma svep', async () => {
    const tenants: Row[] = [
      { id: 't1', personalNumberLegacy: '19850101-1234' },
      { id: 't2', personalNumberLegacy: '19900202-5678' },
    ]
    const prisma = fakePrisma(tenants)

    const res = await backfillPersonalNumbers(prisma as never, ENV as never)

    expect(res).toEqual({ migrated: 2, skipped: false })
    for (const row of tenants) {
      expect(row.personalNumberLegacy).toBeNull() // klartexten borta
      expect(row.personalNumberEnc).toEqual(expect.any(String))
      expect(row.personalNumberHash).toMatch(/^[0-9a-f]{64}$/)
    }
    // …och värdena är oförändrade efter varvet.
    expect(decrypt(tenants[0]!.personalNumberEnc!)).toBe('19850101-1234')
    expect(decrypt(tenants[1]!.personalNumberEnc!)).toBe('19900202-5678')
  })

  it('blind-indexet är samma HMAC som körtidskoden räknar fram', async () => {
    const tenants: Row[] = [{ id: 't1', personalNumberLegacy: '19850101-1234' }]
    await backfillPersonalNumbers(fakePrisma(tenants) as never, ENV as never)

    // Annars hittar inte uppslagen de backfillade raderna — den värsta sortens
    // fel, eftersom allt ser rätt ut tills någon söker.
    const expected = crypto
      .createHmac('sha256', TEST_PII_PEPPER)
      .update('198501011234')
      .digest('hex')
    expect(tenants[0]!.personalNumberHash).toBe(expected)
  })

  it('tar både Tenant och Customer', async () => {
    const tenants: Row[] = [{ id: 't1', personalNumberLegacy: '19850101-1234' }]
    const customers: Row[] = [{ id: 'c1', personalNumberLegacy: '19900202-5678' }]

    const res = await backfillPersonalNumbers(fakePrisma(tenants, customers) as never, ENV as never)

    expect(res.migrated).toBe(2)
    expect(customers[0]!.personalNumberLegacy).toBeNull()
    expect(decrypt(customers[0]!.personalNumberEnc!)).toBe('19900202-5678')
  })

  it('är idempotent — andra körningen rör ingenting', async () => {
    const tenants: Row[] = [{ id: 't1', personalNumberLegacy: '19850101-1234' }]
    const prisma = fakePrisma(tenants)

    await backfillPersonalNumbers(prisma as never, ENV as never)
    const encAfterFirst = tenants[0]!.personalNumberEnc

    const second = await backfillPersonalNumbers(prisma as never, ENV as never)

    expect(second).toEqual({ migrated: 0, skipped: true })
    // Chiffertexten får inte skrivas om — då hade varje deploy roterat IV:n i
    // onödan och gjort det omöjligt att se vad som faktiskt ändrats.
    expect(tenants[0]!.personalNumberEnc).toBe(encAfterFirst)
  })

  it('rör inte rader som redan är krypterade', async () => {
    const tenants: Row[] = [
      {
        id: 't1',
        personalNumberLegacy: null,
        personalNumberEnc: 'redan-krypterad',
        personalNumberHash: 'x',
      },
      { id: 't2', personalNumberLegacy: '19900202-5678' },
    ]
    await backfillPersonalNumbers(fakePrisma(tenants) as never, ENV as never)

    expect(tenants[0]!.personalNumberEnc).toBe('redan-krypterad')
    expect(tenants[0]!.personalNumberHash).toBe('x')
  })

  it('tom databas → no-op, ingen nyckel krävs', async () => {
    // En helt ny miljö ska kunna deploya innan nycklarna hunnit sättas.
    const res = await backfillPersonalNumbers(fakePrisma([]) as never, {} as never)
    expect(res).toEqual({ migrated: 0, skipped: true })
  })
})

describe('backfill — fail-closed', () => {
  it('VÄGRAR köra när det finns klartext men nycklarna saknas', async () => {
    const tenants: Row[] = [{ id: 't1', personalNumberLegacy: '19850101-1234' }]

    await expect(
      backfillPersonalNumbers(fakePrisma(tenants) as never, {} as never),
    ).rejects.toThrow(/SIGNING_PII_KEY/)
    // Raden ska vara helt orörd — inte tömd, inte halvskriven.
    expect(tenants[0]!.personalNumberLegacy).toBe('19850101-1234')
    expect(tenants[0]!.personalNumberEnc).toBeUndefined()
  })

  it('VÄGRAR köra på en nyckel med fel längd', async () => {
    const tenants: Row[] = [{ id: 't1', personalNumberLegacy: '19850101-1234' }]
    await expect(
      backfillPersonalNumbers(
        fakePrisma(tenants) as never,
        {
          SIGNING_PII_KEY: 'kort',
          SIGNING_PII_PEPPER: TEST_PII_PEPPER,
        } as never,
      ),
    ).rejects.toThrow(/SIGNING_PII_KEY/)
    expect(tenants[0]!.personalNumberLegacy).toBe('19850101-1234')
  })

  it('VÄGRAR köra på en för kort pepper', async () => {
    const tenants: Row[] = [{ id: 't1', personalNumberLegacy: '19850101-1234' }]
    await expect(
      backfillPersonalNumbers(
        fakePrisma(tenants) as never,
        {
          SIGNING_PII_KEY: TEST_PII_KEY,
          SIGNING_PII_PEPPER: 'kort',
        } as never,
      ),
    ).rejects.toThrow(/SIGNING_PII_KEY/)
    expect(tenants[0]!.personalNumberLegacy).toBe('19850101-1234')
  })

  it('tom klartextsträng nollas utan att skriva chiffertext', async () => {
    const tenants: Row[] = [{ id: 't1', personalNumberLegacy: '   ' }]
    await backfillPersonalNumbers(fakePrisma(tenants) as never, ENV as never)

    expect(tenants[0]!.personalNumberLegacy).toBeNull()
    expect(tenants[0]!.personalNumberEnc).toBeUndefined()
  })

  it('loggar aldrig ett personnummer', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tenants: Row[] = [{ id: 't1', personalNumberLegacy: '19850101-1234' }]
    await backfillPersonalNumbers(fakePrisma(tenants) as never, ENV as never)

    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).not.toContain('19850101')
    expect(logged).not.toContain('1234')
    expect(logged).not.toContain(tenants[0]!.personalNumberEnc)
    expect(logged).not.toContain(tenants[0]!.personalNumberHash)
    warn.mockRestore()
  })
})
