import type { Job, Queue } from 'bull'
import type { PrismaService } from '../common/prisma/prisma.service'
import { MailQueue } from './mail.queue'
import type { EnqueueMailOptions, MailJobPayload } from './mail.types'

const options: EnqueueMailOptions<'custom'> = {
  template: 'custom',
  organizationId: 'org',
  to: 'tenant@example.invalid',
  subject: 'Avi',
  props: {
    preview: 'Avi',
    tenantName: 'Test',
    organizationName: 'Test',
    bodyHtml: 'Sparat underlag',
  },
  idempotencyKey: 'rent-notice-send-one',
  correlation: { kind: 'rent-notice', rentNoticeId: 'notice', sendId: 'one' },
}

function rig(state: string | null) {
  const retry = jest.fn().mockResolvedValue(undefined)
  const remove = jest.fn().mockResolvedValue(undefined)
  const job = { id: options.idempotencyKey, getState: async () => state, retry, remove }
  const add = jest.fn().mockResolvedValue({ id: options.idempotencyKey })
  const getJob = jest.fn(async () =>
    state === null ? null : (job as unknown as Job<MailJobPayload>),
  )
  const queue = { add, getJob } as unknown as Queue<MailJobPayload>
  const prisma = {
    organization: { findUnique: async () => ({ transactionalEmailsDisabled: false }) },
  } as unknown as PrismaService
  return { service: new MailQueue(queue, queue, queue, prisma), add, retry, remove }
}

describe('återhämtning av samma frysta avimejl', () => {
  it('återstartar ett misslyckat jobb med samma identitet', async () => {
    const r = rig('failed')
    expect(await r.service.enqueue(options)).toBe(options.idempotencyKey)
    expect(r.retry).toHaveBeenCalledTimes(1)
    expect(r.add).not.toHaveBeenCalled()
  })
  it('köar om ett avslutat men ej kvitterat jobb med samma leverantörsnyckel', async () => {
    const r = rig('completed')
    await r.service.enqueue(options)
    expect(r.remove).toHaveBeenCalledTimes(1)
    expect(r.add).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: options.idempotencyKey,
        correlation: options.correlation,
      }),
      expect.objectContaining({ jobId: options.idempotencyKey }),
    )
  })
  it.each(['active', 'waiting', 'delayed'])('lämnar ett %s jobb i fred', async (state) => {
    const r = rig(state)
    await r.service.enqueue(options)
    expect(r.retry).not.toHaveBeenCalled()
    expect(r.remove).not.toHaveBeenCalled()
    expect(r.add).not.toHaveBeenCalled()
  })
  it('återskapar ett förlorat Redisjobb med samma nyckel', async () => {
    const r = rig(null)
    await r.service.enqueue(options)
    expect(r.add).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: options.idempotencyKey }),
      expect.objectContaining({ jobId: options.idempotencyKey }),
    )
  })
})
