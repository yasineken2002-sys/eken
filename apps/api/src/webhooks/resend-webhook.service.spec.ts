/**
 * Resend-webhook — signaturverifiering och event-korrelation.
 *
 * Fokus (per säkerhetskrav):
 *  • Giltig Svix-signatur ACCEPTERAS och eventet behandlas.
 *  • Ogiltig / manipulerad / saknad signatur AVVISAS (401) och INGEN status
 *    ändras (updateMany anropas aldrig).
 *  • Saknad webhook-hemlighet → 503, ingen behandling.
 *  • Korrelation sker via email_id → Tenant.lastInviteMessageId (org-säkert).
 *  • Signerad men okänd/missformad payload ackas (2xx) utan sidoeffekt.
 */
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common'
import { Webhook } from 'svix'
import { ResendWebhookService } from './resend-webhook.service'

// Giltig Svix-testhemlighet (whsec_ + base64). Används för att både signera i
// testet och verifiera i servicen — exakt samma kontrakt som Resend ↔ Svix.
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
const OTHER_SECRET = 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD'

function makeService(
  secret: string | null = SECRET,
  opts: { tenantCount?: number; notice?: { id: string } | null; existingEvent?: boolean } = {},
) {
  const updateMany = jest.fn().mockResolvedValue({ count: opts.tenantCount ?? 1 })
  const rentNoticeFindFirst = jest
    .fn()
    .mockResolvedValue(opts.notice === undefined ? null : opts.notice)
  const eventFindFirst = jest
    .fn()
    .mockResolvedValue(opts.existingEvent ? { id: 'ev-existing' } : null)
  const eventCreate = jest.fn().mockResolvedValue({ id: 'ev-new' })
  const prisma = {
    tenant: { updateMany },
    rentNotice: { findFirst: rentNoticeFindFirst },
    rentNoticeEvent: { findFirst: eventFindFirst, create: eventCreate },
  }
  const config = { get: jest.fn().mockReturnValue(secret) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ResendWebhookService(prisma as any, config as any)
  return { service, updateMany, rentNoticeFindFirst, eventFindFirst, eventCreate }
}

function signedRequest(payloadObj: unknown, signingSecret = SECRET) {
  const payload = JSON.stringify(payloadObj)
  const id = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W'
  const ts = Math.floor(Date.now() / 1000)
  const signature = new Webhook(signingSecret).sign(id, new Date(ts * 1000), payload)
  const headers: Record<string, string> = {
    'svix-id': id,
    'svix-timestamp': String(ts),
    'svix-signature': signature,
  }
  return { raw: Buffer.from(payload, 'utf8'), headers }
}

function deliveredEvent(emailId = 'resend-id-123') {
  return {
    type: 'email.delivered',
    created_at: '2026-06-02T10:00:00.000Z',
    data: { email_id: emailId, to: ['anna@example.se'], subject: 'Aktivera' },
  }
}

describe('ResendWebhookService', () => {
  describe('signaturverifiering', () => {
    it('accepterar en korrekt signerad request och behandlar eventet', async () => {
      const { service, updateMany } = makeService()
      const { raw, headers } = signedRequest(deliveredEvent('resend-id-abc'))

      await expect(service.handle(raw, headers)).resolves.toBeUndefined()

      expect(updateMany).toHaveBeenCalledTimes(1)
      expect(updateMany).toHaveBeenCalledWith({
        where: { lastInviteMessageId: 'resend-id-abc' },
        data: { inviteDeliveredAt: new Date('2026-06-02T10:00:00.000Z') },
      })
    })

    it('avvisar en felsignerad request (fel hemlighet) med 401 och rör ingen status', async () => {
      const { service, updateMany } = makeService(SECRET)
      // Signerad med ANNAN hemlighet än den servern verifierar mot.
      const { raw, headers } = signedRequest(deliveredEvent(), OTHER_SECRET)

      await expect(service.handle(raw, headers)).rejects.toBeInstanceOf(UnauthorizedException)
      expect(updateMany).not.toHaveBeenCalled()
    })

    it('avvisar en manipulerad body (giltig signatur för annan payload) med 401', async () => {
      const { service, updateMany } = makeService()
      const { headers } = signedRequest(deliveredEvent('original'))
      // Byt ut bodyn EFTER signering → HMAC stämmer inte längre.
      const tampered = Buffer.from(JSON.stringify(deliveredEvent('injicerad')), 'utf8')

      await expect(service.handle(tampered, headers)).rejects.toBeInstanceOf(UnauthorizedException)
      expect(updateMany).not.toHaveBeenCalled()
    })

    it('avvisar request utan signatur-headers med 401', async () => {
      const { service, updateMany } = makeService()
      const raw = Buffer.from(JSON.stringify(deliveredEvent()), 'utf8')

      await expect(service.handle(raw, {})).rejects.toBeInstanceOf(UnauthorizedException)
      expect(updateMany).not.toHaveBeenCalled()
    })

    it('avvisar tom body med 401', async () => {
      const { service, updateMany } = makeService()
      const { headers } = signedRequest(deliveredEvent())

      await expect(service.handle(Buffer.from(''), headers)).rejects.toBeInstanceOf(
        UnauthorizedException,
      )
      expect(updateMany).not.toHaveBeenCalled()
    })

    it('returnerar 503 och behandlar inget när webhook-hemlighet saknas', async () => {
      const { service, updateMany } = makeService(null)
      const { raw, headers } = signedRequest(deliveredEvent())

      await expect(service.handle(raw, headers)).rejects.toBeInstanceOf(ServiceUnavailableException)
      expect(updateMany).not.toHaveBeenCalled()
    })
  })

  describe('event-hantering (signerade payloads)', () => {
    it('email.bounced sätter inviteBouncedAt + orsak', async () => {
      const { service, updateMany } = makeService()
      const { raw, headers } = signedRequest({
        type: 'email.bounced',
        created_at: '2026-06-02T11:00:00.000Z',
        data: {
          email_id: 'rid-bounce',
          bounce: { message: 'Mailbox does not exist', type: 'Permanent' },
        },
      })

      await service.handle(raw, headers)

      expect(updateMany).toHaveBeenCalledWith({
        where: { lastInviteMessageId: 'rid-bounce' },
        data: {
          inviteBouncedAt: new Date('2026-06-02T11:00:00.000Z'),
          inviteBounceReason: 'Mailbox does not exist',
        },
      })
    })

    it('email.complained sätter inviteComplainedAt', async () => {
      const { service, updateMany } = makeService()
      const { raw, headers } = signedRequest({
        type: 'email.complained',
        created_at: '2026-06-02T12:00:00.000Z',
        data: { email_id: 'rid-spam' },
      })

      await service.handle(raw, headers)

      expect(updateMany).toHaveBeenCalledWith({
        where: { lastInviteMessageId: 'rid-spam' },
        data: { inviteComplainedAt: new Date('2026-06-02T12:00:00.000Z') },
      })
    })

    it('ackar okänd event-typ utan sidoeffekt', async () => {
      const { service, updateMany } = makeService()
      const { raw, headers } = signedRequest({
        type: 'email.opened',
        data: { email_id: 'rid-open' },
      })

      await expect(service.handle(raw, headers)).resolves.toBeUndefined()
      expect(updateMany).not.toHaveBeenCalled()
    })

    it('ackar signerad men missformad payload (saknar email_id) utan sidoeffekt', async () => {
      const { service, updateMany } = makeService()
      const { raw, headers } = signedRequest({ type: 'email.delivered', data: {} })

      await expect(service.handle(raw, headers)).resolves.toBeUndefined()
      expect(updateMany).not.toHaveBeenCalled()
    })

    it('korrelerar bara via email_id — läser aldrig någon org-uppgift ur payloaden', async () => {
      const { service, updateMany } = makeService()
      // Payload försöker smuggla in en organizationId — den ska ignoreras helt.
      const { raw, headers } = signedRequest({
        type: 'email.delivered',
        created_at: '2026-06-02T10:00:00.000Z',
        data: { email_id: 'rid-x', organizationId: 'attacker-org', to: ['x@y.se'] },
      })

      await service.handle(raw, headers)

      const callArg = updateMany.mock.calls[0][0]
      expect(callArg.where).toEqual({ lastInviteMessageId: 'rid-x' })
      expect(JSON.stringify(callArg)).not.toContain('attacker-org')
    })
  })

  // ── Inkasso PR 4b₀ — korrelation mot hyresavi-påminnelse ────────────────────
  describe('hyresavi-påminnelse-korrelation (RentNotice.reminderMessageId)', () => {
    it('email.delivered utan inbjudan-träff → loggar EMAIL_DELIVERED på rätt avi (append-only)', async () => {
      const { service, rentNoticeFindFirst, eventCreate } = makeService(SECRET, {
        tenantCount: 0,
        notice: { id: 'rn-1' },
      })
      const { raw, headers } = signedRequest(deliveredEvent('reminder-msg-1'))

      await service.handle(raw, headers)

      // Uppslaget sker BARA via @unique reminderMessageId (org kommer från avin).
      expect(rentNoticeFindFirst).toHaveBeenCalledWith({
        where: { reminderMessageId: 'reminder-msg-1' },
        select: { id: true },
      })
      expect(eventCreate).toHaveBeenCalledWith({
        data: {
          rentNoticeId: 'rn-1',
          type: 'EMAIL_DELIVERED',
          actorType: 'WEBHOOK',
          actorLabel: 'E-postleverantör',
          payload: { deliveredAt: '2026-06-02T10:00:00.000Z' },
        },
      })
    })

    it('email.bounced → loggar EMAIL_BOUNCED med STRUKTURERAD kategori, ALDRIG fri PII-text', async () => {
      const { service, eventCreate } = makeService(SECRET, {
        tenantCount: 0,
        notice: { id: 'rn-9' },
      })
      const { raw, headers } = signedRequest({
        type: 'email.bounced',
        created_at: '2026-06-02T11:00:00.000Z',
        data: {
          email_id: 'reminder-msg-9',
          // message innehåller mottagarens e-post (PII) — får ALDRIG lagras.
          bounce: {
            message: 'Mailbox does not exist: hyresgast@example.com',
            type: 'Permanent',
            subType: 'General',
          },
        },
      })

      await service.handle(raw, headers)

      expect(eventCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rentNoticeId: 'rn-9',
          type: 'EMAIL_BOUNCED',
          actorType: 'WEBHOOK',
          payload: {
            bouncedAt: '2026-06-02T11:00:00.000Z',
            bounceType: 'Permanent',
            bounceSubType: 'General',
          },
        }),
      })
      // PII från bounce.message läcker aldrig in i den append-only loggen.
      expect(JSON.stringify(eventCreate.mock.calls[0][0])).not.toContain('hyresgast@example.com')
    })

    it('idempotent: redan loggat utfall → ingen dubblett (append-only skrivs aldrig över)', async () => {
      const { service, eventFindFirst, eventCreate } = makeService(SECRET, {
        tenantCount: 0,
        notice: { id: 'rn-1' },
        existingEvent: true,
      })
      const { raw, headers } = signedRequest(deliveredEvent('reminder-msg-1'))

      await service.handle(raw, headers)

      expect(eventFindFirst).toHaveBeenCalledWith({
        where: { rentNoticeId: 'rn-1', type: 'EMAIL_DELIVERED' },
        select: { id: true },
      })
      expect(eventCreate).not.toHaveBeenCalled()
    })

    it('samtidig dubblett (P2002 från partiellt unikt index) → idempotent no-op, ingen throw', async () => {
      // findFirst hinner inte se den andra transaktionens insert (race) → create
      // körs men DB-indexet avvisar med P2002. Det ska sväljas som no-op.
      const { service, eventCreate } = makeService(SECRET, {
        tenantCount: 0,
        notice: { id: 'rn-1' },
      })
      eventCreate.mockRejectedValueOnce(
        Object.assign(new Error('unique violation'), { code: 'P2002' }),
      )
      const { raw, headers } = signedRequest(deliveredEvent('reminder-msg-1'))

      await expect(service.handle(raw, headers)).resolves.toBeUndefined()
      expect(eventCreate).toHaveBeenCalledTimes(1)
    })

    it('ingen avi matchar message-id → ingen skrivning, ingen throw', async () => {
      const { service, eventCreate } = makeService(SECRET, { tenantCount: 0, notice: null })
      const { raw, headers } = signedRequest(deliveredEvent('okänd-msg'))

      await expect(service.handle(raw, headers)).resolves.toBeUndefined()
      expect(eventCreate).not.toHaveBeenCalled()
    })

    it('inbjudan matchar (tenant count>0) → rör ALDRIG avi-loggen', async () => {
      const { service, rentNoticeFindFirst, eventCreate } = makeService(SECRET, {
        tenantCount: 1,
        notice: { id: 'rn-1' },
      })
      const { raw, headers } = signedRequest(deliveredEvent('invite-msg'))

      await service.handle(raw, headers)

      expect(rentNoticeFindFirst).not.toHaveBeenCalled()
      expect(eventCreate).not.toHaveBeenCalled()
    })

    it('cross-org omöjligt: payload-org ignoreras, avin slås upp bara via message-id', async () => {
      const { service, rentNoticeFindFirst, eventCreate } = makeService(SECRET, {
        tenantCount: 0,
        notice: { id: 'rn-1' },
      })
      const { raw, headers } = signedRequest({
        type: 'email.delivered',
        created_at: '2026-06-02T10:00:00.000Z',
        data: { email_id: 'reminder-msg-1', organizationId: 'attacker-org' },
      })

      await service.handle(raw, headers)

      expect(rentNoticeFindFirst.mock.calls[0][0].where).toEqual({
        reminderMessageId: 'reminder-msg-1',
      })
      const createArg = eventCreate.mock.calls[0][0]
      expect(JSON.stringify(createArg)).not.toContain('attacker-org')
    })
  })
})
