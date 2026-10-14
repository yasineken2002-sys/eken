jest.mock('@sentry/nestjs', () => ({ withScope: jest.fn(), captureException: jest.fn() }))

import { BadRequestException, ConflictException } from '@nestjs/common'
import { GlobalExceptionFilter } from './global-exception.filter'
import { reportFailure } from '../../ai/report-evidence'

async function render(exception: unknown) {
  const reply = { status: jest.fn().mockReturnThis(), send: jest.fn() }
  const errors = { logInternalError: jest.fn().mockResolvedValue(undefined) }
  await new GlobalExceptionFilter(errors as never).catch(exception, {
    switchToHttp: () => ({
      getRequest: () => ({ url: '/accounting/reports/profit-loss', method: 'GET' }),
      getResponse: () => reply,
    }),
  } as never)
  expect(errors.logInternalError).not.toHaveBeenCalled()
  return { status: reply.status.mock.calls[0]![0], body: reply.send.mock.calls[0]![0] }
}

describe('rapportfält i verkliga GlobalExceptionFilter', () => {
  it.each([
    'OWNER_UNVERIFIED',
    'EXTERNAL_REPORT_UNAVAILABLE',
    'PROPERTY_ALLOCATION_UNVERIFIED',
    'READ_FAILED',
  ] as const)('bara betrodda %s får domänfält', async (reason) => {
    const body = reportFailure(reason)
    const result = await render(
      new ConflictException({ ...body, amountOre: 777777, organizationId: 'OTHER-ORG' }),
    )
    expect(result.status).toBe(409)
    expect(result.body).toEqual({
      success: false,
      error: { ...body, path: '/accounting/reports/profit-loss', timestamp: expect.any(String) },
    })
    expect(JSON.stringify(result.body)).not.toContain('777777')
    expect(JSON.stringify(result.body)).not.toContain('OTHER-ORG')
  })
  it('BEFORE_CUTOVER behåller CONFLICT och oförändrat meddelande', async () => {
    const result = await render(
      new ConflictException({ code: 'BEFORE_CUTOVER', message: 'Före brytdatum' }),
    )
    expect(result.status).toBe(409)
    expect(result.body.error).toEqual({
      code: 'CONFLICT',
      message: 'Före brytdatum',
      path: '/accounting/reports/profit-loss',
      timestamp: expect.any(String),
    })
  })
  it.each([
    { status: 'KNOWN', reason: 'READ_FAILED' },
    { status: 'NOT_DETERMINABLE', reason: 'O-B 25000 intern databastext' },
    { status: 'NOT_DETERMINABLE', reason: '__proto__' },
    { status: 'NOT_DETERMINABLE', reason: 25000 },
  ])('fel status/reason får inte extra domänfält: %j', async (fields) => {
    const result = await render(
      new ConflictException({
        code: 'REPORT_NOT_DETERMINABLE',
        message: 'Kontrollerat meddelande',
        ...fields,
      }),
    )
    expect(result.body.error).toEqual({
      code: 'CONFLICT',
      message: 'Kontrollerat meddelande',
      path: '/accounting/reports/profit-loss',
      timestamp: expect.any(String),
    })
  })
  it('andra HttpException-klasser påverkas inte av liknande response', async () => {
    const result = await render(new BadRequestException(reportFailure('READ_FAILED')))
    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('BAD_REQUEST')
    expect(result.body.error).not.toHaveProperty('reason')
    expect(result.body.error).not.toHaveProperty('status')
  })
})
