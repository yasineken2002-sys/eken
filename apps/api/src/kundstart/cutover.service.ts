/**
 * KUNDSTART-001 §5: brytdatum per organisation. Sätts bara av OWNER, alltid den 1:a i
 * en månad. Flytt (i båda riktningarna, även första sättning och borttagning) är spärrad
 * när organisationen har ekonomiska effekter: en EVENO-avi för en period på eller efter
 * gällande brytdatum (saknas brytdatum: vilken EVENO-avi som helst) eller ett verkställt
 * öppningspaket. Kontrollen sker under FOR UPDATE på organisationen — samma lås som
 * öppningspaketets verkställning tar.
 *
 * Ett ändrat brytdatum ogiltigförklarar beständigt alla ACTIVE kundaktiveringar och
 * godkännandet av ej verkställda paket (§11, §12.8).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { brytAr, brytdatumIso, tolkaBrytdatum } from './cutover'
import { ogiltigforklaraAktiveringar } from './activation-invalidation'
import type { Prisma } from '@prisma/client'

@Injectable()
export class CutoverService {
  constructor(private readonly prisma: PrismaService) {}

  async get(organizationId: string) {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { billingCutoverDate: true, billingCutoverSetAt: true, billingCutoverSetById: true },
    })
    const spärr = await this.flyttsparr(this.prisma, organizationId, org.billingCutoverDate)
    return {
      cutoverDate: org.billingCutoverDate ? brytdatumIso(org.billingCutoverDate) : null,
      setAt: org.billingCutoverSetAt,
      setById: org.billingCutoverSetById,
      locked: spärr !== null,
      lockReason: spärr,
    }
  }

  private async flyttsparr(
    db: Prisma.TransactionClient,
    organizationId: string,
    nuvarande: Date | null,
  ): Promise<string | null> {
    const verkstallt = await db.openingPackage.count({
      where: { organizationId, status: 'EXECUTED' },
    })
    if (verkstallt > 0) return 'Ett öppningspaket är verkställt — brytdatumet kan inte flyttas.'
    const where: Prisma.RentNoticeWhereInput = { organizationId, origin: 'EVENO' }
    if (nuvarande) {
      const b = brytAr(nuvarande)
      where.OR = [{ year: { gt: b.year } }, { year: b.year, month: { gte: b.month } }]
    }
    const avi = await db.rentNotice.findFirst({ where, select: { noticeNumber: true } })
    if (avi)
      return (
        `Eveno har redan skapat avier ${nuvarande ? 'från och med brytdatum' : ''} ` +
        `(t.ex. ${avi.noticeNumber}) — brytdatumet kan inte flyttas.`
      ).replace(/\s+/g, ' ')
    return null
  }

  async set(organizationId: string, user: { sub: string; role: string }, iso: string | null) {
    if (user.role !== 'OWNER') throw new ForbiddenException('Bara OWNER får sätta brytdatum.')
    let nytt: Date | null = null
    if (iso !== null) {
      const t = tolkaBrytdatum(iso)
      if (!t.ok) throw new BadRequestException(t.skal)
      nytt = t.datum
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { billingCutoverDate: true },
      })
      const fore = org.billingCutoverDate?.getTime() ?? null
      if (fore === (nytt?.getTime() ?? null)) return this.get(organizationId)
      const spärr = await this.flyttsparr(tx, organizationId, org.billingCutoverDate)
      if (spärr) throw new ConflictException(spärr)
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          billingCutoverDate: nytt,
          billingCutoverSetAt: new Date(),
          billingCutoverSetById: user.sub,
        },
      })
      const skal = `Brytdatum ändrat till ${nytt ? brytdatumIso(nytt) : 'inget'} — kräver ny prövning.`
      await tx.openingPackage.updateMany({
        where: { organizationId, status: { in: ['VALIDATED', 'APPROVED'] } },
        data: {
          status: 'DRAFT',
          validatedAt: null,
          approvedAt: null,
          approvedById: null,
          approvedSha256: null,
          approvedVersion: null,
          approvedWatermark: null,
          approvedCutoverDate: null,
          approvedReadRunId: null,
          invalidatedReason: skal,
        },
      })
      await ogiltigforklaraAktiveringar(tx, organizationId, skal)
      return {
        cutoverDate: nytt ? brytdatumIso(nytt) : null,
        setAt: new Date(),
        setById: user.sub,
        locked: false,
        lockReason: null,
      }
    })
  }
}
