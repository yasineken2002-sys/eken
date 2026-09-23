import { MailService } from './mail.service'

it('avi och påminnelse visar samma svenska förfallodag även vid lokal midnatt', async () => {
  const queue = { enqueue: jest.fn().mockResolvedValue('synthetic-job') }
  const service = new MailService(queue as never)
  const common = {
    organizationId: 'synthetic-org',
    rentNoticeId: 'synthetic-notice',
    to: 'tenant@example.test',
    tenantName: 'Alva Test',
    organizationName: 'Testgård',
    noticeNumber: 'AVI-TEST',
    ocrNumber: '123456',
    dueDate: new Date('2026-06-30T22:00:00Z'),
    pdfBuffer: Buffer.from('synthetic attachment'),
  }
  await service.sendRentNotice({ ...common, amount: 9000 })
  await service.sendRentNoticeReminder({
    ...common,
    noticeAmount: 9000,
    feeAmount: 60,
    payableTotal: 9060,
    paidSoFar: 0,
    overpaidAmount: 0,
    daysOverdue: 1,
  })
  expect(queue.enqueue.mock.calls).toHaveLength(2)
  for (const [mail] of queue.enqueue.mock.calls) {
    expect(mail.props.bodyHtml).toContain('1 juli 2026')
    expect(mail.props.bodyHtml).not.toContain('30 juni 2026')
  }
})
