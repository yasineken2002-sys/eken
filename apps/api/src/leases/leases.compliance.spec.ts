/**
 * Compliance-tester för Hyreslagen (Jordabalken 12 kap):
 *  - JB 12 kap 4 § 1 st — uppsägningstid (bostad 3 mån / lokal 9 mån)
 *  - Praxis — depositionstak (bostad: 3 månadshyror)
 *
 * Testar de exporterade rena helper-funktionerna och den sammansatta
 * `assertLeaseLegalLimits()` som kastar BadRequestException vid lagstridig
 * indata. Service-laget anropar dessa direkt (se leases.service.ts).
 *
 * Service-integrationstester (med mockad Prisma) ligger separat eftersom
 * import av LeasesService transitivt drar in AWS SDK som har ESM-deps
 * Jest inte kan parsa utan extra transform-config.
 */

import { BadRequestException } from '@nestjs/common'
import type { UnitType } from '@prisma/client'
import {
  minNoticePeriodMonths,
  maxDepositAmount,
  noticePeriodErrorMessage,
  depositErrorMessage,
  assertLeaseLegalLimits,
} from './leases.compliance'

describe('Hyreslagen-compliance: leases', () => {
  // ─── Helpers (pure math) ───────────────────────────────────────────────────

  describe('minNoticePeriodMonths() — JB 12 kap 4 § 1 st', () => {
    it('returnerar 3 månader för bostad (APARTMENT)', () => {
      expect(minNoticePeriodMonths('APARTMENT')).toBe(3)
    })

    it.each<UnitType>(['OFFICE', 'RETAIL', 'STORAGE', 'PARKING', 'OTHER'])(
      'returnerar 9 månader för lokal (%s)',
      (type) => {
        expect(minNoticePeriodMonths(type)).toBe(9)
      },
    )
  })

  describe('maxDepositAmount() — praxis (hyresnämnden)', () => {
    it('returnerar 3 × månadshyran för bostad (APARTMENT)', () => {
      expect(maxDepositAmount(10_000, 'APARTMENT')).toBe(30_000)
      expect(maxDepositAmount(8_500, 'APARTMENT')).toBe(25_500)
    })

    it.each<UnitType>(['OFFICE', 'RETAIL', 'STORAGE', 'PARKING', 'OTHER'])(
      'returnerar null (fri deposition) för lokal (%s)',
      (type) => {
        expect(maxDepositAmount(50_000, type)).toBeNull()
      },
    )
  })

  describe('noticePeriodErrorMessage()', () => {
    it('citerar JB 12 kap 4 § 1 st p 1 för bostad', () => {
      expect(noticePeriodErrorMessage('APARTMENT')).toMatch(/JB 12 kap 4 § 1 st p 1/)
      expect(noticePeriodErrorMessage('APARTMENT')).toMatch(/3 månader/)
    })

    it('citerar JB 12 kap 4 § 1 st p 2 för lokal', () => {
      expect(noticePeriodErrorMessage('OFFICE')).toMatch(/JB 12 kap 4 § 1 st p 2/)
      expect(noticePeriodErrorMessage('OFFICE')).toMatch(/9 månader/)
    })
  })

  describe('depositErrorMessage()', () => {
    it('innehåller beloppsgränsen i SEK-format', () => {
      // sv-SE formaterar 30 000 med non-breaking space, så vi matchar med \D?
      expect(depositErrorMessage(30_000)).toMatch(/30\D?000 kr/)
    })

    it('förklarar varför taket finns (otillåten förskottshyra)', () => {
      expect(depositErrorMessage(30_000)).toMatch(/förskottshyra/)
    })

    it('hänvisar till 3 månadshyror', () => {
      expect(depositErrorMessage(30_000)).toMatch(/3 månadshyror/)
    })
  })

  // ─── Sammansatt validator ──────────────────────────────────────────────────

  describe('assertLeaseLegalLimits() — kombinerad validering', () => {
    // ── FIX 1: Uppsägningstid (JB 12 kap 4 §) ───────────────────────────────

    it('avvisar bostad med noticePeriodMonths=2 → BadRequestException', () => {
      expect(() =>
        assertLeaseLegalLimits({
          unitType: 'APARTMENT',
          monthlyRent: 10_000,
          noticePeriodMonths: 2,
          depositAmount: 0,
        }),
      ).toThrow(BadRequestException)
      expect(() =>
        assertLeaseLegalLimits({
          unitType: 'APARTMENT',
          monthlyRent: 10_000,
          noticePeriodMonths: 2,
          depositAmount: 0,
        }),
      ).toThrow(/JB 12 kap 4 § 1 st p 1/)
    })

    it('avvisar bostad med noticePeriodMonths=0 → BadRequestException', () => {
      expect(() =>
        assertLeaseLegalLimits({
          unitType: 'APARTMENT',
          monthlyRent: 10_000,
          noticePeriodMonths: 0,
          depositAmount: 0,
        }),
      ).toThrow(BadRequestException)
    })

    it('accepterar bostad med noticePeriodMonths=3', () => {
      expect(() =>
        assertLeaseLegalLimits({
          unitType: 'APARTMENT',
          monthlyRent: 10_000,
          noticePeriodMonths: 3,
          depositAmount: 0,
        }),
      ).not.toThrow()
    })

    it('accepterar bostad med längre noticePeriodMonths (6 mån)', () => {
      // JB 12 kap 4 § sätter MINIMUM — längre uppsägningstid är tillåten.
      expect(() =>
        assertLeaseLegalLimits({
          unitType: 'APARTMENT',
          monthlyRent: 10_000,
          noticePeriodMonths: 6,
          depositAmount: 0,
        }),
      ).not.toThrow()
    })

    it('avvisar lokal (OFFICE) med noticePeriodMonths=3 → JB 12 kap 4 § 1 st p 2', () => {
      expect(() =>
        assertLeaseLegalLimits({
          unitType: 'OFFICE',
          monthlyRent: 25_000,
          noticePeriodMonths: 3,
          depositAmount: 0,
        }),
      ).toThrow(/JB 12 kap 4 § 1 st p 2/)
    })

    it.each<UnitType>(['OFFICE', 'RETAIL', 'STORAGE', 'PARKING', 'OTHER'])(
      'accepterar lokal (%s) med noticePeriodMonths=9',
      (type) => {
        expect(() =>
          assertLeaseLegalLimits({
            unitType: type,
            monthlyRent: 25_000,
            noticePeriodMonths: 9,
            depositAmount: 0,
          }),
        ).not.toThrow()
      },
    )

    // ── FIX 2: Depositionstak (praxis 3 månadshyror för bostad) ─────────────

    it('avvisar bostad med deposition > 3 × månadshyran (10000 × 3 = 30000 → 30001 nekas)', () => {
      expect(() =>
        assertLeaseLegalLimits({
          unitType: 'APARTMENT',
          monthlyRent: 10_000,
          noticePeriodMonths: 3,
          depositAmount: 30_001,
        }),
      ).toThrow(/3 månadshyror/)
    })

    it('accepterar bostad med deposition = exakt 3 × månadshyran', () => {
      expect(() =>
        assertLeaseLegalLimits({
          unitType: 'APARTMENT',
          monthlyRent: 10_000,
          noticePeriodMonths: 3,
          depositAmount: 30_000,
        }),
      ).not.toThrow()
    })

    it('accepterar bostad med deposition = 0 (ingen säkerhet krävd)', () => {
      expect(() =>
        assertLeaseLegalLimits({
          unitType: 'APARTMENT',
          monthlyRent: 10_000,
          noticePeriodMonths: 3,
          depositAmount: 0,
        }),
      ).not.toThrow()
    })

    it('tillåter fri deposition för lokal (OFFICE 200000 kr på 10000 hyra)', () => {
      expect(() =>
        assertLeaseLegalLimits({
          unitType: 'OFFICE',
          monthlyRent: 10_000,
          noticePeriodMonths: 9,
          depositAmount: 200_000,
        }),
      ).not.toThrow()
    })

    it('avvisar med uppsägnings-felmeddelande FÖRE depositions-felmeddelande (notice valideras först)', () => {
      // Båda är överträdelser — verifiera att notice-fel rapporteras
      // (deterministisk ordning så användaren får konsistent UX).
      expect(() =>
        assertLeaseLegalLimits({
          unitType: 'APARTMENT',
          monthlyRent: 10_000,
          noticePeriodMonths: 1,
          depositAmount: 50_000,
        }),
      ).toThrow(/JB 12 kap 4 §/)
    })
  })
})
