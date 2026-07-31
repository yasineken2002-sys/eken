/**
 * T5 C2a / #58 — aktiveringens enqueue-lager.
 *
 * Före: `dispatchActivationJobs` sväljde ett kö-fel i `.catch(logger.error)`.
 * Redis nere → avtalet blev ACTIVE, deposition + första hyresavi köades aldrig,
 * hyresgästen fakturerades aldrig, och enda spåret var en lograd. Workerns
 * SYSTEM-notis nås aldrig i det läget: den sitter i @OnQueueFailed, och ett jobb
 * som aldrig kom in i kön kan inte misslyckas i den.
 *
 * Bevisar:
 *   A) Kö-fel på initial-avierna → SYSTEM-notis till org:ens användare.
 *   B) Notisen bär SAMMA titel som workerns permanent-fail-notis (en signalväg).
 *   C) Notistexten är MJUK ("kunde inte bekräftas") — sann även när jobbet
 *      landade ändå efter vår timeout (falsklarm-ärlighet).
 *   D) Kö-fel fäller ALDRIG aktiveringen — avtalet är redan committat ACTIVE.
 *   E) PDF-/välkomst-fel larmar men skapar INGEN notis (de har manuella vägar:
 *      contracts/generate/:leaseId respektive tenant-portal/resend-activation).
 *   F) Normalfallet: inget larm, ingen notis.
 */

jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn(), addBreadcrumb: jest.fn() }))

import * as Sentry from '@sentry/nestjs'
import { LeasesService } from './leases.service'
import { INITIAL_NOTICES_FAILED_TITLE } from './lease-activation.queue'
import { testPersonalNumberService } from '../common/crypto/personal-number.testing'

const captureException = Sentry.captureException as jest.MockedFunction<
  typeof Sentry.captureException
>

type QueueOverrides = {
  contract?: () => Promise<string>
  welcome?: () => Promise<string>
  notices?: () => Promise<string>
}

function makeService(overrides: QueueOverrides = {}) {
  const activationQueue = {
    enqueueGenerateContract: jest.fn(overrides.contract ?? (async () => 'job-pdf')),
    enqueueWelcomeMail: jest.fn(overrides.welcome ?? (async () => 'job-mail')),
    enqueueInitialNotices: jest.fn(overrides.notices ?? (async () => 'job-notices')),
  }
  const notifications = { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) }

  const tx = {
    lease: {
      update: jest.fn().mockResolvedValue({
        id: 'lease-1',
        organizationId: 'org-1',
        tenantId: 'tenant-1',
        unit: { type: 'APARTMENT' },
      }),
      count: jest.fn().mockResolvedValue(1),
    },
    unit: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  }
  const prisma = {
    lease: {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce({
          id: 'lease-1',
          status: 'DRAFT',
          organizationId: 'org-1',
          unitId: 'unit-1',
          tenantId: 'tenant-1',
          contractNumber: null,
          unit: { type: 'APARTMENT', name: 'A1', property: { name: 'F1' } },
        })
        .mockResolvedValueOnce(null),
      update: jest
        .fn()
        .mockResolvedValue({ id: 'lease-1', organizationId: 'org-1', tenantId: 'tenant-1' }),
    },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }
  const contractNumbers = { allocate: jest.fn().mockResolvedValue('KONT-2026-0001') }
  const noop = {} as never

  const service = new LeasesService(
    prisma as never,
    testPersonalNumberService(),
    notifications as never,
    noop, // deposits
    noop, // rentIncreases
    noop, // tenantAuth
    noop, // contracts
    contractNumbers as never,
    activationQueue as never,
  )
  return { service, activationQueue, notifications }
}

const redisDown = () =>
  Promise.reject(
    new Error(
      'MaxRetriesPerRequestError: Reached the max retries per request limit (which is 20).',
    ),
  )

describe('T5 C2a · aktivering när KÖANDET fallerar (#58)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('A+D: initial-avier kan inte köas → SYSTEM-notis, och aktiveringen kastar inte', async () => {
    const { service, notifications } = makeService({ notices: redisDown })

    const lease = await service.transitionStatus('lease-1', 'ACTIVE', 'org-1', 'user-9')

    expect(lease).toMatchObject({ id: 'lease-1' })
    expect(notifications.createForAllOrgUsers).toHaveBeenCalledTimes(1)
    const [orgId, type, title] = notifications.createForAllOrgUsers.mock.calls[0] as string[]
    expect(orgId).toBe('org-1')
    expect(type).toBe('SYSTEM')
    expect(title).toBe(INITIAL_NOTICES_FAILED_TITLE)
  })

  it('B: notisens titel är identisk med workerns permanent-fail-titel', () => {
    // Strukturell garanti: båda läser samma konstant, så de kan inte glida isär.
    expect(INITIAL_NOTICES_FAILED_TITLE).toBe('Avier kunde inte genereras automatiskt')
  })

  it('C: notistexten säger "kunde inte bekräftas" — inte tvärsäkert "blev inte av"', async () => {
    const { service, notifications } = makeService({ notices: redisDown })
    await service.transitionStatus('lease-1', 'ACTIVE', 'org-1', 'user-9')

    const message = (notifications.createForAllOrgUsers.mock.calls[0] as string[])[3] as string
    expect(message).toContain('kunde inte bekräftas som köade')
    expect(message).toContain('Kontrollera avisering-sidan')
    // Får INTE påstå något som blir osant när jobbet landade efter timeouten.
    expect(message).not.toMatch(/kunde inte skapas/)
    // Åtgärden ska vara sann i dag: hyresmånader går via backfill-kön, men
    // depositionsavin har ingen egen knapp (det är C2b).
    expect(message).toContain('Att efterdebitera')
  })

  it('C: notisen bär INGEN teknisk feltext — hyresvärden är inte utvecklare', async () => {
    const { service, notifications } = makeService({
      notices: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.7:6379')),
    })
    await service.transitionStatus('lease-1', 'ACTIVE', 'org-1', 'user-9')

    const message = (notifications.createForAllOrgUsers.mock.calls[0] as string[])[3] as string
    expect(message).not.toContain('ECONNREFUSED')
    expect(message).not.toContain('10.0.0.7')
    expect(message).not.toContain('6379')
  })

  it('A: kö-felet larmas till Sentry med kö-, jobbtyp- och org-tagg', async () => {
    const { service } = makeService({ notices: redisDown })
    await service.transitionStatus('lease-1', 'ACTIVE', 'org-1', 'user-9')

    expect(captureException).toHaveBeenCalledTimes(1)
    const [captured, ctx] = captureException.mock.calls[0] as [
      Error,
      { tags: Record<string, string> },
    ]
    expect(ctx.tags).toEqual({
      queue: 'lease-activation',
      jobType: 'create-initial-notices',
      org: 'org-1',
    })
    // Skrubbat: ioredis-detaljen stannar i serverloggen.
    expect(captured.message).not.toContain('MaxRetriesPerRequestError')
  })

  it('E: PDF-/välkomstfel larmar men ger INGEN notis (de har manuella vägar)', async () => {
    const { service, notifications } = makeService({ contract: redisDown, welcome: redisDown })
    await service.transitionStatus('lease-1', 'ACTIVE', 'org-1', 'user-9')

    expect(captureException).toHaveBeenCalledTimes(2)
    expect(notifications.createForAllOrgUsers).not.toHaveBeenCalled()
  })

  it('E: ett kö-fel stoppar inte de övriga två enqueue:arna', async () => {
    const { service, activationQueue } = makeService({ contract: redisDown })
    await service.transitionStatus('lease-1', 'ACTIVE', 'org-1', 'user-9')

    expect(activationQueue.enqueueGenerateContract).toHaveBeenCalledTimes(1)
    expect(activationQueue.enqueueWelcomeMail).toHaveBeenCalledTimes(1)
    expect(activationQueue.enqueueInitialNotices).toHaveBeenCalledTimes(1)
  })

  it('F: normalfallet — inget larm, ingen notis, alla tre jobb köade', async () => {
    const { service, activationQueue, notifications } = makeService()
    await service.transitionStatus('lease-1', 'ACTIVE', 'org-1', 'user-9')

    expect(captureException).not.toHaveBeenCalled()
    expect(notifications.createForAllOrgUsers).not.toHaveBeenCalled()
    expect(activationQueue.enqueueGenerateContract).toHaveBeenCalledTimes(1)
    expect(activationQueue.enqueueWelcomeMail).toHaveBeenCalledTimes(1)
    expect(activationQueue.enqueueInitialNotices).toHaveBeenCalledTimes(1)
  })
})
