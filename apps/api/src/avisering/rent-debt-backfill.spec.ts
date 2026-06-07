/**
 * Bankavstämnings-härdning PR 1 — KATEGORI B: backfill + inbyggd verifikation.
 *
 * Backfillen lever i migrations-SQL:en (körs av migrate deploy mot riktig DB).
 * Den här guarden låser de KRITISKA egenskaperna så att de inte tyst kan
 * försvinna i en framtida refaktor av migrationsfilen:
 *   • Förlustfri: en allokering per PAID-avi med amount = paidAmount.
 *   • Idempotent: NOT EXISTS-guard (kör om utan att dubblera).
 *   • Källhärledning: BANK_RECONCILIATION när matchad bank-tx finns, annars MANUAL.
 *   • INBYGGD verifikation: ett DO-block som RAISE EXCEPTION vid Σ alloc != paidAmount.
 *   • @unique lyfts (DROP unik, CREATE vanligt index) — spegel, inte unik längre.
 *
 * (Den faktiska invariant-körningen mot data bevisades vid migrate deploy:
 *  36 PAID-avier → 36 allokeringar, noll avvikelser.)
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const MIGRATION = readFileSync(
  join(
    __dirname,
    '../../prisma/migrations/20260607020000_bank_hardening_pr1_rentnotice_payment/migration.sql',
  ),
  'utf8',
)

describe('PR1 · B — backfill-migration', () => {
  it('lyfter @unique på matchedRentNoticeId men behåller ett vanligt index', () => {
    expect(MIGRATION).toMatch(/DROP INDEX "BankTransaction_matchedRentNoticeId_key"/)
    expect(MIGRATION).toMatch(
      /CREATE INDEX "BankTransaction_matchedRentNoticeId_idx" ON "BankTransaction"/,
    )
  })

  it('flyttar dubbel-allokeringsskyddet till RentNoticePayment.bankTransactionId UNIQUE', () => {
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX "RentNoticePayment_bankTransactionId_key" ON "RentNoticePayment"/,
    )
  })

  it('backfillar amount = paidAmount och datum = paidAt (förlustfritt)', () => {
    expect(MIGRATION).toMatch(/INSERT INTO "RentNoticePayment"/)
    expect(MIGRATION).toMatch(/rn\."paidAmount"/)
    expect(MIGRATION).toMatch(/COALESCE\(rn\."paidAt", rn\."updatedAt"\)/)
    expect(MIGRATION).toMatch(/rn\."status" = 'PAID'/)
  })

  it('härleder källan: BANK_RECONCILIATION när bank-tx finns, annars MANUAL', () => {
    expect(MIGRATION).toMatch(/'BANK_RECONCILIATION'::"RentNoticePaymentSource"/)
    expect(MIGRATION).toMatch(/'MANUAL'::"RentNoticePaymentSource"/)
    expect(MIGRATION).toMatch(/b\."matchedRentNoticeId" = rn\."id"/)
  })

  it('är idempotent via NOT EXISTS-guard', () => {
    expect(MIGRATION).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM "RentNoticePayment"/)
  })

  it('har en INBYGGD verifikation som RAISE EXCEPTION vid avvikelse', () => {
    expect(MIGRATION).toMatch(/DO \$\$/)
    expect(MIGRATION).toMatch(/RAISE EXCEPTION/)
    // Asserten jämför Σ allokeringar mot paidAmount.
    expect(MIGRATION).toMatch(/sum\("amount"\)/)
    expect(MIGRATION).toMatch(/<> rn\."paidAmount"/)
  })
})
