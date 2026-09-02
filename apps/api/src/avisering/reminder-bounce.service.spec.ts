/**
 * STUDSAD PÅMINNELSE → ÅTERFÖRD AVGIFT (#654), och gränserna för när den INTE
 * återförs.
 *
 * ── VARFÖR BÅDA HÅLLEN ──────────────────────────────────────────────────────
 *
 * Ett prov som bara visar att avgiften återförs vid studs skiljer inte en
 * STEGMEDVETEN återföring från en som återför allt den ser. Den farliga
 * riktningen är att ett ärende som redan är REDO FÖR INKASSO — eller avskrivet —
 * tyst får sin huvudbok ändrad under sig, efter att det överlämnats.
 *
 * Därför prövas de nekande grenarna lika hårt som den bekräftande, och varje
 * sådan gren MÅSTE gå att se falla: den lyfts som notis, inte som tystnad.
 *
 * ── VAD PROVEN INTE SER ─────────────────────────────────────────────────────
 *
 * Att webhooken anropar tjänsten på RÄTT händelsetyp ägs av
 * `resend-webhook.service.spec.ts`. Att motverifikatet balanserar ägs av
 * bokföringsspecarna. Här mäts BESLUTET.
 */
import { ReminderBounceService } from './reminder-bounce.service'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { ReminderFeeReversal } from './reminder-bounce.service'
import type { NotificationFanout } from './reminder-bounce.service'

const NOTICE = 'rn-654'
const ORG = 'org-1'
const EVENT = 'ev-bounce-1'
const NÄR = new Date('2026-09-02T14:33:07.000Z')

type Avi = {
  collectionStage: 'NONE' | 'REMINDED' | 'INKASSO_READY'
  reminderFeeAmount: number
  probableLossAt?: Date | null
  writtenOffAt?: Date | null
}

function rigg(avi: Avi | null, opts: { reverseKastar?: Error } = {}) {
  const findUnique = jest.fn().mockResolvedValue(
    avi === null
      ? null
      : {
          id: NOTICE,
          organizationId: ORG,
          noticeNumber: 'RN-2026-0042',
          probableLossAt: null,
          writtenOffAt: null,
          ...avi,
        },
  )
  const reverseReminderFee = opts.reverseKastar
    ? jest.fn().mockRejectedValue(opts.reverseKastar)
    : jest.fn().mockResolvedValue(undefined)
  const createForAllOrgUsers = jest.fn().mockResolvedValue(undefined)

  const service = new ReminderBounceService(
    { rentNotice: { findUnique } } as unknown as PrismaService,
    { reverseReminderFee } as unknown as ReminderFeeReversal,
    { createForAllOrgUsers } as unknown as NotificationFanout,
  )
  return { service, reverseReminderFee, createForAllOrgUsers }
}

const kör = (r: ReturnType<typeof rigg>) => r.service.handleBouncedReminder(NOTICE, EVENT, NÄR)

describe('ReminderBounceService — återför avgiften vid studs (#654)', () => {
  it('REMINDED med avgift → återför, och lyfter det som notis', async () => {
    const r = rigg({ collectionStage: 'REMINDED', reminderFeeAmount: 60 })
    await expect(kör(r)).resolves.toBe('reversed')

    expect(r.reverseReminderFee).toHaveBeenCalledTimes(1)
    const anrop = r.reverseReminderFee.mock.calls[0] as [string, string, string, string | null]
    expect(anrop[0]).toBe(NOTICE)
    expect(anrop[1]).toBe(ORG)
    // Systemåtgärd — ingen människa står som upphovsman i verifikatet.
    expect(anrop[3]).toBeNull()

    // Lyftet sker ÄVEN när det gick bra: operatören måste få veta att avin står
    // kvar i trappan och inte påminns igen automatiskt.
    expect(r.createForAllOrgUsers).toHaveBeenCalledTimes(1)
  })

  it('MOTVERIFIKATETS TEXT bär vad, när och på vilket bevis', async () => {
    const r = rigg({ collectionStage: 'REMINDED', reminderFeeAmount: 60 })
    await kör(r)
    const skäl = (r.reverseReminderFee.mock.calls[0] as string[])[2] as string

    expect(skäl).toContain('nådde aldrig mottagaren') // VAD
    expect(skäl).toContain('RN-2026-0042') // VILKEN avi — texten är självbärande
    expect(skäl).toContain(NÄR.toISOString()) // NÄR, exakt
    expect(skäl).toContain('EMAIL_BOUNCED') // PÅ VILKET BEVIS: typen
    expect(skäl).toContain(EVENT) // …och händelsens id
    expect(skäl.trim().length).toBeGreaterThan(10)
  })

  it('INKASSO_READY → INGEN återföring; ärendet lyfts i stället', async () => {
    const r = rigg({ collectionStage: 'INKASSO_READY', reminderFeeAmount: 60 })
    await expect(kör(r)).resolves.toBe('flagged')
    expect(r.reverseReminderFee).not.toHaveBeenCalled()
    const notis = r.createForAllOrgUsers.mock.calls[0] as string[]
    expect(notis[2]).toContain('kräver granskning')
    expect(notis[3]).toContain('redo för inkasso')
  })

  it('AVSKRIVEN avi → INGEN återföring; någon annan håller fordran', async () => {
    const r = rigg({
      collectionStage: 'REMINDED',
      reminderFeeAmount: 60,
      writtenOffAt: new Date('2026-08-01T00:00:00.000Z'),
    })
    await expect(kör(r)).resolves.toBe('flagged')
    expect(r.reverseReminderFee).not.toHaveBeenCalled()
    expect((r.createForAllOrgUsers.mock.calls[0] as string[])[3]).toContain('avskriven')
  })

  it('ingen avgift att stryka → INGEN återföring, men ändå ett lyft', async () => {
    const r = rigg({ collectionStage: 'REMINDED', reminderFeeAmount: 0 })
    await expect(kör(r)).resolves.toBe('flagged')
    expect(r.reverseReminderFee).not.toHaveBeenCalled()
    expect(r.createForAllOrgUsers).toHaveBeenCalledTimes(1)
  })

  it('reverseReminderFee KASTAR → fångas, lyfts, kastar aldrig vidare', async () => {
    // Ett kast hade gett webhooken 500, och Resend hade retryat ett event vi
    // redan hanterat. Spärrarna i reverseReminderFee är legitima nej.
    const r = rigg(
      { collectionStage: 'REMINDED', reminderFeeAmount: 60 },
      { reverseKastar: new Error('Betalning överstiger taket utan avgiften') },
    )
    await expect(kör(r)).resolves.toBe('flagged')
    expect(r.createForAllOrgUsers).toHaveBeenCalledTimes(1)
  })

  it('okänd avi → skipped, ingen notis, ingen återföring', async () => {
    const r = rigg(null)
    await expect(kör(r)).resolves.toBe('skipped')
    expect(r.reverseReminderFee).not.toHaveBeenCalled()
    expect(r.createForAllOrgUsers).not.toHaveBeenCalled()
  })

  it('RÄNTAN RÖRS ALDRIG — bara avgiften vänds', async () => {
    // Grunderna är olika: avgiften ersätter att en påminnelse SKICKADES, räntan
    // löper för att pengarna är SENA — sant oavsett om påminnelsen kom fram.
    // Tjänsten har därför ingen väg till ränteåterföringen alls, och det här
    // provet fäller den dag någon lägger dit en.
    const r = rigg({ collectionStage: 'REMINDED', reminderFeeAmount: 60 })
    await kör(r)
    const avisering = (r.service as unknown as { avisering: Record<string, unknown> }).avisering
    expect(Object.keys(avisering)).toEqual(['reverseReminderFee'])
  })
})
