import { z } from 'zod'

// Resend-webhookens payload kommer UTIFRÅN — den valideras strikt efter att
// signaturen verifierats. Vi modellerar bara de fält vi faktiskt använder och
// låter Zod strippa resten (Resend lägger till fält över tid; okända fält ska
// inte få payloaden att avvisas så länge signaturen stämmer).
//
// email_id är Resends message-id och vår korrelationsnyckel mot rätt hyresgäst
// (Tenant.lastInviteMessageId, @unique) eller, för en hyresavi-påminnelse, mot
// rätt avi (RentNotice.reminderMessageId, @unique).
//
// Event-typer vi agerar på: email.delivered, email.bounced, email.complained.
// Övriga (sent, opened, clicked …) parsar men ignoreras i service-switchen.

export const ResendEventSchema = z.object({
  // type valideras som en begränsad sträng — inte ett strikt enum, så att
  // okända/nya event-typer ändå parsar (och sedan ignoreras i hanteraren).
  type: z.string().min(1).max(100),
  created_at: z.string().min(1).max(64).optional(),
  data: z.object({
    email_id: z.string().min(1).max(200),
    to: z.union([z.string().max(320), z.array(z.string().max(320)).max(100)]).optional(),
    subject: z.string().max(2000).optional(),
    // Bounce-detaljer finns på nyare Resend-event. message blir bounce-orsaken.
    bounce: z
      .object({
        message: z.string().max(2000).optional(),
        type: z.string().max(200).optional(),
        subType: z.string().max(200).optional(),
      })
      .optional(),
  }),
})

export type ResendEvent = z.infer<typeof ResendEventSchema>
