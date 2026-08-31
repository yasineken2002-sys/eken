import { NotFoundException } from '@nestjs/common'
import type { PrismaClient } from '@prisma/client'

/**
 * HISTORIKENS TRE DIMENSIONER — samma register, tre ingångar.
 *
 * Planens Del 8: hyresgäst (allt som rör personen), lägenhet (allt som rört
 * objektet, över alla hyresgäster), fastighet. Dimensionen är en PARAMETER in i
 * det befintliga registret — inte ett andra register. En källa deklarerar per
 * dimension vilken relation den täcker, och vakten prövar alla tre modellerna
 * mot samma fil.
 */
export type HistoryDimension = 'TENANT' | 'UNIT' | 'PROPERTY'

export interface HistorySubjectRef {
  kind: HistoryDimension
  id: string
}

/**
 * Org-scopad existenskontroll för subjektet. Kastar 404 om det inte finns i
 * organisationen — samma svar som för ett id som inte finns alls, så att en
 * annan organisations id inte går att skilja från ett påhittat.
 *
 * `Unit` bär ingen egen `organizationId` — den scopas via sin fastighet, och
 * det är därför villkoret går genom `property` där.
 */
export async function assertSubjectInOrg(
  prisma: PrismaClient,
  organizationId: string,
  subject: HistorySubjectRef,
): Promise<void> {
  const finns =
    subject.kind === 'TENANT'
      ? await prisma.tenant.findFirst({
          where: { id: subject.id, organizationId },
          select: { id: true },
        })
      : subject.kind === 'UNIT'
        ? await prisma.unit.findFirst({
            where: { id: subject.id, property: { organizationId } },
            select: { id: true },
          })
        : await prisma.property.findFirst({
            where: { id: subject.id, organizationId },
            select: { id: true },
          })
  if (!finns) {
    const namn =
      subject.kind === 'TENANT' ? 'Hyresgäst' : subject.kind === 'UNIT' ? 'Lägenhet' : 'Fastighet'
    throw new NotFoundException(`${namn} hittades inte`)
  }
}
