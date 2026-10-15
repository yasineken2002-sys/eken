import { noticeRecipientHash } from '../avisering/notice-dispatch'
import { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'

/**
 * Ett äldre köjobb kan bära beloppet före ett nytt tillgodoavdrag. Markera
 * därför att just det jobbet får börja skickas under samma avilås som
 * prepareNoticeForSend. Antingen vinner den gamla instruktionen eller den
 * nya reservationen; de får aldrig skickas med två olika belopp.
 *
 * Raden är ett utskicksanspråk, inte ett leverantörskvitto. Samma köjobb får
 * försöka igen med sin befintliga idempotensnyckel; ett annat jobb får inte
 * ta över ett försök vars utfall fortfarande kan vara okänt.
 */
export async function claimLegacyNoticeDispatch(
  prisma: PrismaService,
  organizationId: string,
  noticeId: string,
  to: string,
  jobId: string,
): Promise<boolean> {
  if (!jobId.trim()) throw new Error('Avimejlet saknar en stabil jobbidentifierare')
  const toHash = noticeRecipientHash(to)
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "RentNotice" WHERE id = ${noticeId} AND "organizationId" = ${organizationId} FOR UPDATE`
    const notice = await tx.rentNotice.findFirst({
      where: { id: noticeId, organizationId },
      select: {
        status: true,
        sends: {
          where: { kind: 'NOTICE' },
          select: { id: true, dispatchKey: true, jobId: true, toHash: true },
        },
      },
    })
    if (!notice || ['PAID', 'CANCELLED', 'OPENING'].includes(notice.status)) return false
    if (notice.sends.some((send) => send.dispatchKey !== null)) return false
    if (notice.sends.length > 0) {
      return (
        notice.sends.length === 1 &&
        notice.sends[0]!.jobId === jobId &&
        notice.sends[0]!.toHash === toHash
      )
    }
    await tx.rentNoticeSend.create({
      data: { rentNoticeId: noticeId, kind: 'NOTICE', jobId, toHash },
    })
    return true
  }, PRISMA_DEFAULT_TX_LIMITS)
}
