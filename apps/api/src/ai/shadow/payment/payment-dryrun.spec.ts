import { Logger } from '@nestjs/common'
import { PaymentShadowService } from './payment-shadow.service'
import { AiExecutionDryRunService } from '../../execution-dryrun/execution-dryrun.service'
import { DelegationService } from '../../delegation/delegation.service'

jest.mock('@anthropic-ai/sdk', () => jest.fn())
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn(), addBreadcrumb: jest.fn() }))

function setup() {
  const prisma = {
    organization: { findUnique: jest.fn().mockResolvedValue({ shadowPaymentAgentEnabled: true }) },
    aiAssignment: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'forslag' }),
    },
    bankTransaction: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'bankrad',
        date: new Date('2026-09-01'),
        description: 'Okänd betalare',
        amount: { toNumber: () => 123 },
        rawOcr: null,
        status: 'UNMATCHED',
        autoMatchExcludedAt: null,
      }),
    },
    rentNotice: { findMany: jest.fn().mockResolvedValue([]) },
    invoice: { findMany: jest.fn().mockResolvedValue([]) },
  }
  const queue = { enqueue: jest.fn().mockResolvedValue('jobb') }
  const service = new PaymentShadowService(
    prisma as never,
    {} as never,
    {} as never,
    queue as never,
  )
  return { prisma, queue, service }
}

describe('betalningsförslag ansluts till torrläget', () => {
  afterEach(() => jest.restoreAllMocks())

  it('köar organisation och sparat förslag först efter lyckad skrivning', async () => {
    const { prisma, queue, service } = setup()
    queue.enqueue.mockImplementation(async () => {
      expect(prisma.aiAssignment.create).toHaveBeenCalledTimes(1)
      return 'jobb'
    })
    expect(await service.korForBankrad('org', 'bankrad')).toEqual({
      utfall: 'SKAPAD',
      assignmentId: 'forslag',
    })
    expect(queue.enqueue).toHaveBeenCalledWith({ organizationId: 'org', assignmentId: 'forslag' })
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
  })

  it('behåller förslaget vid köfel så att befintligt svep kan fånga det', async () => {
    const { prisma, queue, service } = setup()
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    queue.enqueue.mockRejectedValue(new Error('test: Redis nere'))
    expect(await service.korForBankrad('org', 'bankrad')).toEqual({
      utfall: 'SKAPAD',
      assignmentId: 'forslag',
    })
    expect(prisma.aiAssignment.create).toHaveBeenCalledTimes(1)
    expect(prisma.aiAssignment.create.mock.calls[0]?.[0].data.executionVerdict).toBeUndefined()
  })

  it('köar inget om skrivningen misslyckas', async () => {
    const { prisma, queue, service } = setup()
    prisma.aiAssignment.create.mockRejectedValue(new Error('DB nere'))
    await expect(service.korForBankrad('org', 'bankrad')).rejects.toThrow('DB nere')
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('köar inte om en dubblett redan finns', async () => {
    const { prisma, queue, service } = setup()
    prisma.aiAssignment.findFirst.mockResolvedValue({ id: 'befintligt' })
    expect(await service.korForBankrad('org', 'bankrad')).toEqual({
      utfall: 'REDAN_FINNS',
      assignmentId: 'befintligt',
    })
    expect(prisma.aiAssignment.create).not.toHaveBeenCalled()
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('en avstängd betalningsagent skapar inget jobb', async () => {
    const { prisma, queue, service } = setup()
    prisma.organization.findUnique.mockResolvedValue({ shadowPaymentAgentEnabled: false })
    expect(await service.korForBankrad('org', 'bankrad')).toEqual({ utfall: 'AVSTANGD' })
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('riktiga delegationsgrinden blockerar automatisk matchning och skriver bara domen', async () => {
    const prisma = {
      aiAssignment: {
        findFirst: jest
          .fn()
          .mockResolvedValue({
            id: 'forslag',
            toolName: 'match_bank_transaction',
            prediction: { avi: 'avi', belopp: 'FULL', motpart: 'person' },
            propertyId: null,
            unitId: null,
            executionVerdict: null,
          }),
        update: jest.fn().mockResolvedValue({}),
      },
      aiDelegation: { findMany: jest.fn() },
    }
    const delegation = new DelegationService(prisma as never, {} as never)
    const dryrun = new AiExecutionDryRunService(prisma as never, delegation)
    const utfall = await dryrun.bedöm('org', 'forslag')
    expect(utfall).toMatchObject({ utfall: 'DOM', dom: 'BLOCKED' })
    expect(prisma.aiDelegation.findMany).not.toHaveBeenCalled()
    expect(prisma.aiAssignment.update).toHaveBeenCalledWith({
      where: { id: 'forslag' },
      data: {
        executionVerdict: 'BLOCKED',
        verdictAt: expect.any(Date),
        verdictDelegationId: null,
        verdictReason: expect.any(String),
      },
    })
    expect(prisma.aiAssignment.update).toHaveBeenCalledTimes(1)
    expect(prisma.aiAssignment.findFirst.mock.calls[0]?.[0].where).toEqual({
      id: 'forslag',
      organizationId: 'org',
    })
  })
})
