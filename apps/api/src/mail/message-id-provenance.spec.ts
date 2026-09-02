/**
 * HÄRKOMST, INTE FORM: vilket id som hamnar i webhookens korrelationsnycklar (#651).
 *
 * ── DEFEKTEN DE HÄR PROVEN FINNS FÖR ────────────────────────────────────────
 *
 * `RentNotice.reminderMessageId` skrevs av anropsstället med returvärdet från
 * `MailService.sendRentNoticeReminder`. Det värdet är `MailQueue.enqueue`:s
 * returvärde, alltså **Bulls jobId** — som dessutom är idempotensnyckeln,
 * `rent-reminder-<noticeId>`. Webhooken frågar på **Resends `email_id`**.
 *
 * Två skilda namnrymder. De kunde aldrig matcha, `EMAIL_DELIVERED` skrevs
 * ALDRIG, och INV-B-grinden kunde därför aldrig släppa fram en avi till
 * inkasso. Mätt i prod: 2 av 2 avier bar jobId, 0 leverans-event någonsin.
 *
 * ── VARFÖR FORMEN ALDRIG FÅR VARA ASSERTIONEN ───────────────────────────────
 *
 * Det fanns ett prov. Det var grönt. Det såg ut så här:
 *
 *     sendRentNoticeReminder: jest.fn().mockResolvedValue('resend-msg-1')
 *     expect(datas).toContainEqual({ reminderMessageId: 'resend-msg-1' })
 *
 * Mocken returnerade ett värde som EFTERLIKNADE formen på ett Resend-id, och
 * provet bevisade att tjänsten lagrar vad mejltjänsten returnerade. Sant, och
 * utan värde: det prövade aldrig VILKEN NAMNRYMD värdet kom ur. Ett prov som
 * kräver att värdet "ser ut som ett Resend-id" hade varit grönt under hela
 * defektens livstid.
 *
 * Därför INVERTERAR proven nedan formerna: Resend får returnera något som ser
 * ut som ett jobId, och jobbet får ett id som ser ut som ett Resend-id. Ett
 * formbaserat prov skulle då ge fel svar. Kravet är HÄRKOMST — att det lagrade
 * värdet är exakt det workern fick TILLBAKA från `resend.emails.send()`.
 *
 * ── VAD DE HÄR PROVEN INTE SER ──────────────────────────────────────────────
 *
 * De mäter att workern skriver rätt VÄRDE till rätt FÄLT. De säger ingenting om
 * att webhooken sedan hittar avin (det äger `resend-webhook.service.spec.ts`),
 * eller att ett riktigt Resend-anrop returnerar det id vi tror (det kan bara
 * driften visa).
 */
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { MailWorkerNormal } from './mail.worker'
import type { MailJobPayload } from './mail.types'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { Resend } from 'resend'
import type { Job } from 'bull'

const NOTICE = 'rn-651'

// ── DE TVÅ SENTINELVÄRDENA, MED FLIT FORMINVERTERADE ────────────────────────
//
// Resend-id:t bär jobId-formen, jobbets id bär UUID-formen. Byter någon
// tillbaka till att lagra köns returvärde faller proven — oavsett hur värdena
// SER UT.
const RESEND_GAV_TILLBAKA = 'rent-reminder-ser-ut-som-ett-jobid'
const KÖN_GAV_VID_ENQUEUE = '2e064da1-59d8-4c34-b1de-943f9621a365'

function fejkPrisma(): {
  prisma: PrismaService
  rentNoticeUpdate: jest.Mock
  tenantUpdate: jest.Mock
  failedEmailCreate: jest.Mock
} {
  const rentNoticeUpdate = jest.fn().mockResolvedValue({})
  const tenantUpdate = jest.fn().mockResolvedValue({})
  const failedEmailCreate = jest.fn().mockResolvedValue({})
  return {
    rentNoticeUpdate,
    tenantUpdate,
    failedEmailCreate,
    prisma: {
      organization: {
        findUnique: jest.fn().mockResolvedValue({ transactionalEmailsDisabled: false }),
      },
      rentNotice: { update: rentNoticeUpdate },
      tenant: { update: tenantUpdate },
      failedEmail: { create: failedEmailCreate },
    } as unknown as PrismaService,
  }
}

function fejkWorker(prisma: PrismaService): MailWorkerNormal {
  const renderer = { render: jest.fn().mockResolvedValue({ html: '<p>x</p>', text: 'x' }) }
  const config = { get: jest.fn().mockReturnValue(undefined) }
  const worker = new MailWorkerNormal(
    renderer as never,
    prisma,
    config as never,
    new RentNoticeEventsService(prisma),
  )
  ;(worker as unknown as { resend: Resend }).resend = {
    emails: {
      send: jest.fn().mockResolvedValue({ data: { id: RESEND_GAV_TILLBAKA }, error: null }),
    },
  } as unknown as Resend
  return worker
}

function fejkJobb(correlation: MailJobPayload['correlation']): Job<MailJobPayload> {
  return {
    id: KÖN_GAV_VID_ENQUEUE,
    queue: { name: 'mail:normal' },
    attemptsMade: 0,
    opts: { attempts: 5 },
    data: {
      template: 'custom',
      organizationId: 'org-1',
      to: 'mottagare@exempel.invalid',
      subject: 'Ämne',
      props: {
        preview: 'p',
        tenantName: 'n',
        organizationName: 'o',
        whyReceived: 'w',
        bodyHtml: '<p>x</p>',
      },
      ...(correlation ? { correlation } : {}),
    },
  } as unknown as Job<MailJobPayload>
}

const kör = async (worker: MailWorkerNormal, job: Job<MailJobPayload>): Promise<void> =>
  (worker as unknown as { processJob: (j: Job<MailJobPayload>) => Promise<void> }).processJob(job)

describe('korrelationsnycklarnas HÄRKOMST (#651)', () => {
  it('påminnelsen: reminderMessageId får det RESEND gav tillbaka — inte köns jobId', async () => {
    const { prisma, rentNoticeUpdate } = fejkPrisma()
    await kör(fejkWorker(prisma), fejkJobb({ kind: 'rent-notice-reminder', rentNoticeId: NOTICE }))

    expect(rentNoticeUpdate).toHaveBeenCalledTimes(1)
    const anrop = rentNoticeUpdate.mock.calls[0]?.[0] as {
      where: { id: string }
      data: { reminderMessageId?: string }
    }
    expect(anrop.where.id).toBe(NOTICE)
    expect(anrop.data.reminderMessageId).toBe(RESEND_GAV_TILLBAKA)

    // ASSERTIONEN SOM FÄLLER ÅTERFALLET. Skriver någon tillbaka enqueue:s
    // returvärde blir det här jobbets id — och det ska aldrig hamna i fältet.
    expect(anrop.data.reminderMessageId).not.toBe(KÖN_GAV_VID_ENQUEUE)
  })

  it('avin: noticeMessageId får det RESEND gav tillbaka — inte köns jobId', async () => {
    const { prisma, rentNoticeUpdate } = fejkPrisma()
    await kör(fejkWorker(prisma), fejkJobb({ kind: 'rent-notice', rentNoticeId: NOTICE }))

    const anrop = rentNoticeUpdate.mock.calls[0]?.[0] as {
      where: { id: string }
      data: { noticeMessageId?: string }
    }
    expect(anrop.where.id).toBe(NOTICE)
    expect(anrop.data.noticeMessageId).toBe(RESEND_GAV_TILLBAKA)
    expect(anrop.data.noticeMessageId).not.toBe(KÖN_GAV_VID_ENQUEUE)
  })

  it('de två fälten blandas ALDRIG ihop — avins korrelation rör inte påminnelsens', async () => {
    const { prisma, rentNoticeUpdate } = fejkPrisma()
    await kör(fejkWorker(prisma), fejkJobb({ kind: 'rent-notice', rentNoticeId: NOTICE }))
    const data = rentNoticeUpdate.mock.calls[0]?.[0]?.data as Record<string, unknown>
    expect(Object.keys(data)).toEqual(['noticeMessageId'])
  })

  it('KANARIEFÅGEL: formen får inte vara assertionen', () => {
    // Det här provet påstår ingenting om koden. Det bevakar de andra provens
    // SKÄRPA: så länge sentinelvärdena är forminverterade kan ingen ersätta en
    // härkomst-assertion med en form-assertion utan att märka det.
    expect(RESEND_GAV_TILLBAKA).toMatch(/^rent-reminder-/) // ser ut som ett jobId
    expect(KÖN_GAV_VID_ENQUEUE).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/) // ser ut som ett Resend-id
    expect(RESEND_GAV_TILLBAKA).not.toBe(KÖN_GAV_VID_ENQUEUE)
  })

  it('utan korrelation skrivs INGEN nyckel — tystnad, inte en gissning', async () => {
    const { prisma, rentNoticeUpdate, tenantUpdate } = fejkPrisma()
    await kör(fejkWorker(prisma), fejkJobb(undefined))
    expect(rentNoticeUpdate).not.toHaveBeenCalled()
    expect(tenantUpdate).not.toHaveBeenCalled()
  })

  it('tenant-invite är oförändrad — den vägen var den enda som redan var rätt', async () => {
    const { prisma, tenantUpdate } = fejkPrisma()
    await kör(fejkWorker(prisma), fejkJobb({ kind: 'tenant-invite', tenantId: 't-1' }))
    const anrop = tenantUpdate.mock.calls[0]?.[0] as { data: { lastInviteMessageId?: string } }
    expect(anrop.data.lastInviteMessageId).toBe(RESEND_GAV_TILLBAKA)
    expect(anrop.data.lastInviteMessageId).not.toBe(KÖN_GAV_VID_ENQUEUE)
  })
})

describe('FailedEmail kopplas till avin (#651)', () => {
  const körFailed = async (worker: MailWorkerNormal, job: Job<MailJobPayload>): Promise<void> =>
    (
      worker as unknown as {
        handleFailed: (j: Job<MailJobPayload>, e: Error) => Promise<void>
      }
    ).handleFailed(job, new Error('Resend rejected mail: domain not verified'))

  const sistaFörsöket = (correlation: MailJobPayload['correlation']): Job<MailJobPayload> => {
    const job = fejkJobb(correlation) as unknown as { attemptsMade: number }
    job.attemptsMade = 5 // == opts.attempts → permanent
    return job as unknown as Job<MailJobPayload>
  }

  it('ett slutgiltigt misslyckat påminnelseutskick pekar ut avin', async () => {
    const { prisma, failedEmailCreate } = fejkPrisma()
    await körFailed(
      fejkWorker(prisma),
      sistaFörsöket({ kind: 'rent-notice-reminder', rentNoticeId: NOTICE }),
    )

    expect(failedEmailCreate).toHaveBeenCalledTimes(1)
    const data = failedEmailCreate.mock.calls[0]?.[0]?.data as { rentNoticeId?: string }
    expect(data.rentNoticeId).toBe(NOTICE)
  })

  it('utan avi-korrelation lämnas fältet TOMT — inget påhittat id', async () => {
    const { prisma, failedEmailCreate } = fejkPrisma()
    await körFailed(fejkWorker(prisma), sistaFörsöket({ kind: 'tenant-invite', tenantId: 't-1' }))
    const data = failedEmailCreate.mock.calls[0]?.[0]?.data as { rentNoticeId?: string }
    expect(data.rentNoticeId).toBeUndefined()
  })

  it('ETT MELLANFÖRSÖK skriver ingen rad alls', async () => {
    const { prisma, failedEmailCreate } = fejkPrisma()
    await körFailed(
      fejkWorker(prisma),
      fejkJobb({ kind: 'rent-notice-reminder', rentNoticeId: NOTICE }),
    )
    expect(failedEmailCreate).not.toHaveBeenCalled()
  })
})
