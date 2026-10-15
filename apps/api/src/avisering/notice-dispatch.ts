import { createHash } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { RentNoticeSend } from '@prisma/client'
import { z } from 'zod'

const money = z
  .number()
  .finite()
  .nonnegative()
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.000001)

/** Det fastställda originalet. Senare betalningar ändrar saldot, inte denna avi. */
export const NoticeDispatchSnapshotSchema = z
  .object({
    version: z.literal(1),
    html: z.string().min(1),
    to: z.string().email(),
    tenantName: z.string(),
    organizationName: z.string(),
    noticeNumber: z.string().min(1),
    ocrNumber: z.string().min(1),
    dueDate: z.string().datetime(),
    accentColor: z.string().nullable(),
    payableAmount: money,
    customerCreditAmount: money,
  })
  .strict()
export type NoticeDispatchSnapshot = z.infer<typeof NoticeDispatchSnapshotSchema>

/** PDF och det färdigrenderade mejlet sparas före första köförsöket. */
export const PreparedNoticeMailSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.string().min(1),
    rentNoticeId: z.string().min(1),
    sendId: z.string().min(1),
    to: z.string().email(),
    subject: z.string().min(1),
    from: z.string().min(1),
    html: z.string().min(1),
    text: z.string(),
    props: z
      .object({
        preview: z.string(),
        tenantName: z.string(),
        organizationName: z.string(),
        bodyHtml: z.string(),
        whyReceived: z.string(),
      })
      .strict(),
    attachments: z
      .array(z.object({ filename: z.string().min(1), contentBase64: z.string().min(1) }).strict())
      .length(1),
    idempotencyKey: z.string().min(1),
  })
  .strict()
export type PreparedNoticeMail = z.infer<typeof PreparedNoticeMailSchema>

export function noticeRecipientHash(to: string): string {
  return createHash('sha256').update(to.trim().toLowerCase()).digest('hex')
}

export function readNoticeSnapshot(send: RentNoticeSend): NoticeDispatchSnapshot {
  const parsed = NoticeDispatchSnapshotSchema.safeParse(send.snapshot)
  if (
    !parsed.success ||
    send.kind !== 'NOTICE' ||
    send.snapshotVersion !== 1 ||
    send.dispatchKey !== `customer-credit-notice:${send.rentNoticeId}` ||
    !send.preparedAt ||
    !send.payableAmount ||
    !send.customerCreditAmount ||
    !send.payableAmount.equals(parsed.data.payableAmount) ||
    !send.customerCreditAmount.equals(parsed.data.customerCreditAmount) ||
    send.toHash !== noticeRecipientHash(parsed.data.to)
  ) {
    throw new ConflictException('Avins sparade utskicksunderlag kan inte verifieras')
  }
  return parsed.data
}

export function readPreparedNoticeMail(
  send: RentNoticeSend,
  organizationId: string,
): PreparedNoticeMail {
  const snapshot = readNoticeSnapshot(send)
  const parsed = PreparedNoticeMailSchema.safeParse(send.mailPayload)
  if (
    !parsed.success ||
    parsed.data.organizationId !== organizationId ||
    parsed.data.rentNoticeId !== send.rentNoticeId ||
    parsed.data.sendId !== send.id ||
    parsed.data.idempotencyKey !== `rent-notice-send-${send.id}` ||
    parsed.data.to !== snapshot.to
  ) {
    throw new ConflictException('Avins sparade mejl kan inte verifieras')
  }
  return parsed.data
}

export function isCreditPaidInformation(send: RentNoticeSend): boolean {
  return (
    new Prisma.Decimal(send.payableAmount ?? -1).isZero() &&
    new Prisma.Decimal(send.customerCreditAmount ?? 0).gt(0)
  )
}
