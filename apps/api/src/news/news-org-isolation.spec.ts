/**
 * IDOR-svep (#5-klassen): news.create OCH .update applicerade klient-skickat
 * propertyId RÅTT → org A kunde rikta en nyhet mot org B:s fastighet. Fix: org-
 * scopad validering innan skrivning. (Ingen PII-läcka här, men samma isolations-
 * klass + datakorruption/felriktning.)
 *
 * Bevisar per metod: främmande orgs propertyId → 404 + skriv-metoden anropas
 * ALDRIG; egen orgs propertyId → funkar.
 */

import { NotFoundException } from '@nestjs/common'
import { NewsService } from './news.service'

function make() {
  const prisma = {
    property: { findFirst: jest.fn() },
    newsPost: {
      create: jest.fn().mockResolvedValue({ id: 'n1' }),
      update: jest.fn().mockResolvedValue({ id: 'n1' }),
    },
  }
  const service = new NewsService(prisma as never)
  return { service, prisma }
}

describe('NewsService — org-isolation av propertyId (#5)', () => {
  it('create: främmande orgs propertyId → 404, INGEN newsPost.create', async () => {
    const { service, prisma } = make()
    prisma.property.findFirst.mockResolvedValue(null)
    await expect(
      service.create({ title: 't', content: 'c', propertyId: 'p-B' } as never, 'org-A', 'u1'),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(prisma.newsPost.create).not.toHaveBeenCalled()
  })

  it('create: egen orgs propertyId → nyhet skapas', async () => {
    const { service, prisma } = make()
    prisma.property.findFirst.mockResolvedValue({ id: 'p-A' })
    await service.create({ title: 't', content: 'c', propertyId: 'p-A' } as never, 'org-A', 'u1')
    expect(prisma.newsPost.create).toHaveBeenCalledTimes(1)
  })

  it('update: främmande orgs propertyId → 404, INGEN newsPost.update', async () => {
    const { service, prisma } = make()
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'n1' } as never)
    prisma.property.findFirst.mockResolvedValue(null)
    await expect(
      service.update('n1', { propertyId: 'p-B' } as never, 'org-A'),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(prisma.newsPost.update).not.toHaveBeenCalled()
  })

  it('update: egen orgs propertyId → update sker', async () => {
    const { service, prisma } = make()
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'n1' } as never)
    prisma.property.findFirst.mockResolvedValue({ id: 'p-A' })
    await service.update('n1', { propertyId: 'p-A' } as never, 'org-A')
    expect(prisma.newsPost.update).toHaveBeenCalledTimes(1)
  })
})
