/**
 * Compliance-tester för Hyreslagen JB 12 kap 54 a § 2 st:
 *  - 2-månadersfristen för invändning beräknas korrekt
 *  - sendNotice() avvisar avtal där effectiveDate är för nära idag
 *  - sendNotice() kräver komplett hyresvärdsadress
 *  - sendNotice() bygger payload med alla tvingande fält till mejlmallen
 */

// NotificationsService → MonthlyReportService → den brandade shellen drar in
// storage.service (AWS SDK, ESM) som jest inte kan parsa. Stubbas — samma
// mönster som övriga specar som transitivt rör storage. (Steg 3, PR 3a.)
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException } from '@nestjs/common'
import { RentIncreasesService, computeObjectionDeadline } from './rent-increases.service'

describe('Hyreslagen-compliance: rent-increases (JB 12 kap 54 a §)', () => {
  // ─── Helper ────────────────────────────────────────────────────────────────

  describe('computeObjectionDeadline()', () => {
    it('lägger till exakt 2 månader från meddelandedag', () => {
      const noticeDate = new Date('2026-05-29T00:00:00Z')
      const deadline = computeObjectionDeadline(noticeDate)
      expect(deadline.toISOString().slice(0, 10)).toBe('2026-07-29')
    })

    it('hanterar månadsdrift 31 jan → 31 mars (inte april)', () => {
      // 31 jan + 2 mån = 31 mars (mars har 31 dagar — naturlig matchning)
      const noticeDate = new Date('2026-01-31T00:00:00Z')
      const deadline = computeObjectionDeadline(noticeDate)
      expect(deadline.toISOString().slice(0, 10)).toBe('2026-03-31')
    })

    it('rullar tillbaka från 31 dec → 28/29 feb (inte mars)', () => {
      // 31 dec 2025 + 2 mån måste landa på sista dagen i februari, inte 3 mars
      const noticeDate = new Date('2025-12-31T00:00:00Z')
      const deadline = computeObjectionDeadline(noticeDate)
      // 2026 är inte skottår → 28 feb 2026
      expect(deadline.toISOString().slice(0, 10)).toBe('2026-02-28')
    })
  })

  // ─── Service-flöde med mockad Prisma + Mail ────────────────────────────────

  type OrgOverrides = Partial<{
    name: string
    street: string | null
    city: string | null
    postalCode: string | null
    email: string | null
    phone: string | null
    billingEmail: string | null
  }>

  function makeService(opts: {
    effectiveDate: string
    org?: OrgOverrides
    riStatus?: string
    noticeDate?: string | null
  }) {
    const ri = {
      id: 'ri-1',
      status: opts.riStatus ?? 'DRAFT',
      organizationId: 'org-1',
      leaseId: 'lease-1',
      currentRent: 10_000,
      newRent: 11_000,
      increasePercent: 10,
      reason: 'Underhåll och uppgradering',
      effectiveDate: new Date(opts.effectiveDate),
      noticeDate:
        opts.noticeDate !== undefined ? (opts.noticeDate ? new Date(opts.noticeDate) : null) : null,
      lease: {
        tenant: {
          type: 'INDIVIDUAL',
          firstName: 'Anna',
          lastName: 'Andersson',
          companyName: null,
          email: 'anna@example.se',
        },
        unit: {
          name: 'Lgh 1204',
          property: { name: 'Storgatan 12' },
        },
      },
    }

    const org = {
      name: 'Eken Fastigheter AB',
      street: 'Drottninggatan 1',
      city: 'Stockholm',
      postalCode: '11151',
      email: 'kontakt@eken.se',
      phone: '08-123 45 67',
      billingEmail: 'fakturor@eken.se',
      invoiceColor: null,
      ...(opts.org ?? {}),
    }

    const prisma = {
      rentIncrease: {
        findFirst: jest.fn().mockResolvedValue(ri),
        update: jest.fn().mockResolvedValue({ ...ri, status: 'NOTICE_SENT' }),
      },
      organization: {
        findUnique: jest.fn().mockResolvedValue(org),
      },
    }

    const mail = {
      sendRentIncreaseNotice: jest.fn().mockResolvedValue('queued-id'),
    }

    const notifications = {
      createForAllOrgUsers: jest.fn().mockResolvedValue(undefined),
    }

    const service = new RentIncreasesService(prisma as never, mail as never, notifications as never)
    return { service, prisma, mail, ri }
  }

  // ── sendNotice: validering av effectiveDate mot 2 mån + 1 dag ─────────────

  describe('sendNotice() — invändningsfrist (54 a § 2 st)', () => {
    beforeAll(() => {
      jest.useFakeTimers()
      jest.setSystemTime(new Date('2026-05-29T10:00:00Z'))
    })
    afterAll(() => {
      jest.useRealTimers()
    })

    it('avvisar när effectiveDate ligger inom invändningsfristen (idag + 2 mån)', async () => {
      // 2026-05-29 + 2 mån = 2026-07-29; effective måste vara minst 2026-07-30
      const { service } = makeService({ effectiveDate: '2026-07-15' })
      await expect(service.sendNotice('ri-1', 'org-1')).rejects.toThrow(BadRequestException)
      await expect(service.sendNotice('ri-1', 'org-1')).rejects.toThrow(/54 a §/)
    })

    it('avvisar exakt på invändningsdeadline (samma dag som deadline)', async () => {
      // Deadline = 2026-07-29; effective får inte vara samma dag → måste vara minst 2026-07-30
      const { service } = makeService({ effectiveDate: '2026-07-29' })
      await expect(service.sendNotice('ri-1', 'org-1')).rejects.toThrow(/54 a §/)
    })

    it('accepterar när effectiveDate är dagen efter invändningsdeadline', async () => {
      // Deadline = 2026-07-29 → effective = 2026-07-30 är OK
      const { service, mail, prisma } = makeService({ effectiveDate: '2026-07-30' })
      await service.sendNotice('ri-1', 'org-1')
      expect(mail.sendRentIncreaseNotice).toHaveBeenCalledTimes(1)
      expect(prisma.rentIncrease.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'NOTICE_SENT' }),
        }),
      )
    })
  })

  // ── accept(): hård fristkontroll (54 a § 3 st, väg A) — #30 ───────────────

  describe('accept() — invändningsfrist (54 a § 3 st, #30)', () => {
    beforeAll(() => {
      jest.useFakeTimers()
      // "Idag" = 2026-07-29 (exakt på deadline för noticeDate 2026-05-29).
      jest.setSystemTime(new Date('2026-07-29T10:00:00Z'))
    })
    afterAll(() => {
      jest.useRealTimers()
    })

    it('blockerar accept FÖRE fristens utgång (idag = deadline, strikt >)', async () => {
      // noticeDate 2026-05-29 → deadline 2026-07-29 = idag → får inte godkännas än.
      const { service, prisma } = makeService({
        effectiveDate: '2026-09-01',
        riStatus: 'NOTICE_SENT',
        noticeDate: '2026-05-29',
      })
      await expect(service.accept('ri-1', 'org-1')).rejects.toThrow(/54 a §/)
      // Ingen status-uppdatering fick ske.
      expect(prisma.rentIncrease.update).not.toHaveBeenCalled()
    })

    it('felmeddelandet anger exakt tidigaste godkännandedatum (deadline + 1)', async () => {
      const { service } = makeService({
        effectiveDate: '2026-09-01',
        riStatus: 'NOTICE_SENT',
        noticeDate: '2026-05-29',
      })
      await expect(service.accept('ri-1', 'org-1')).rejects.toThrow(/2026-07-30/)
    })

    it('tillåter accept dagen EFTER fristens utgång', async () => {
      // noticeDate 2026-05-27 → deadline 2026-07-27 → idag 2026-07-29 > deadline → OK.
      const { service, prisma } = makeService({
        effectiveDate: '2026-09-01',
        riStatus: 'NOTICE_SENT',
        noticeDate: '2026-05-27',
      })
      await service.accept('ri-1', 'org-1')
      expect(prisma.rentIncrease.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED' }) }),
      )
    })

    it('avvisar accept när noticeDate saknas (ingen krasch/felberäkning)', async () => {
      const { service, prisma } = makeService({
        effectiveDate: '2026-09-01',
        riStatus: 'NOTICE_SENT',
        noticeDate: null,
      })
      await expect(service.accept('ri-1', 'org-1')).rejects.toThrow(/meddelandedatum/)
      expect(prisma.rentIncrease.update).not.toHaveBeenCalled()
    })

    it('avvisar accept för icke-aviserade höjningar (status != NOTICE_SENT)', async () => {
      const { service } = makeService({
        effectiveDate: '2026-09-01',
        riStatus: 'DRAFT',
        noticeDate: '2026-05-27',
      })
      await expect(service.accept('ri-1', 'org-1')).rejects.toThrow(/aviserade/)
    })
  })

  // ── sendNotice: kräver komplett hyresvärdsadress (54 a § 2 st) ────────────

  describe('sendNotice() — krav på hyresvärdsadress', () => {
    beforeAll(() => {
      jest.useFakeTimers()
      jest.setSystemTime(new Date('2026-05-29T10:00:00Z'))
    })
    afterAll(() => {
      jest.useRealTimers()
    })

    it.each([
      { field: 'street', overrides: { street: null } },
      { field: 'city', overrides: { city: null } },
      { field: 'postalCode', overrides: { postalCode: null } },
    ])('avvisar när hyresvärdens $field saknas', async ({ overrides }) => {
      const { service } = makeService({
        effectiveDate: '2026-09-01',
        org: overrides as OrgOverrides,
      })
      await expect(service.sendNotice('ri-1', 'org-1')).rejects.toThrow(/postadress/)
    })
  })

  // ── sendNotice: payload till mejl innehåller alla 54 a §-fält ─────────────

  describe('sendNotice() — tvingande fält i mejlpayloaden', () => {
    beforeAll(() => {
      jest.useFakeTimers()
      jest.setSystemTime(new Date('2026-05-29T10:00:00Z'))
    })
    afterAll(() => {
      jest.useRealTimers()
    })

    it('skickar objectionDeadline, landlordAddress och hyresnamndContact till mejlmallen', async () => {
      const { service, mail } = makeService({ effectiveDate: '2026-09-01' })
      await service.sendNotice('ri-1', 'org-1')

      const payload = mail.sendRentIncreaseNotice.mock.calls[0]?.[0] as Record<string, unknown>
      expect(payload).toMatchObject({
        objectionDeadline: '2026-07-29',
        landlordAddress: 'Drottninggatan 1\n11151 Stockholm',
        hyresnamndContact: expect.stringContaining('domstol.se') as unknown as string,
      })
      // Hyresnämnds-texten ska innehålla konkret vägledning, inte bara hänvisning
      expect(payload['hyresnamndContact']).toEqual(expect.stringContaining('ansökan'))
    })
  })

  // ── sendNotice: status-skydd (bara DRAFT) ──────────────────────────────────

  describe('sendNotice() — status-guards', () => {
    it('avvisar när hyreshöjningen redan har skickats (status NOTICE_SENT)', async () => {
      const { service } = makeService({ effectiveDate: '2026-09-01', riStatus: 'NOTICE_SENT' })
      await expect(service.sendNotice('ri-1', 'org-1')).rejects.toThrow(/utkast/)
    })
  })
})
