import { Injectable, NotFoundException } from '@nestjs/common'
import { IsString, IsOptional, IsBoolean, IsUUID } from 'class-validator'
import { PrismaService } from '../common/prisma/prisma.service'

export class CreateNewsPostDto {
  @IsString()
  title!: string

  @IsString()
  content!: string

  @IsBoolean()
  @IsOptional()
  targetAll?: boolean

  @IsUUID()
  @IsOptional()
  propertyId?: string
}

export class UpdateNewsPostDto {
  @IsString()
  @IsOptional()
  title?: string

  @IsString()
  @IsOptional()
  content?: string

  @IsBoolean()
  @IsOptional()
  targetAll?: boolean

  @IsUUID()
  @IsOptional()
  propertyId?: string
}

@Injectable()
export class NewsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(organizationId: string, published?: boolean) {
    return this.prisma.newsPost.findMany({
      where: {
        organizationId,
        ...(published === true ? { publishedAt: { not: null } } : {}),
        ...(published === false ? { publishedAt: null } : {}),
      },
      include: {
        createdBy: { select: { firstName: true, lastName: true } },
        property: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  async findOne(id: string, organizationId: string) {
    const post = await this.prisma.newsPost.findFirst({
      where: { id, organizationId },
      include: {
        createdBy: { select: { firstName: true, lastName: true } },
        property: { select: { id: true, name: true } },
      },
    })
    if (!post) throw new NotFoundException('Nyheten hittades inte')
    return post
  }

  // IDOR-spärr: ett klient-skickat propertyId måste tillhöra anropande org INNAN
  // det skrivs. Annars kan org A rikta en nyhet mot org B:s fastighet. Validerar
  // bara icke-tomma id:n (null = medveten avriktning). (Launch-readiness #5-klassen.)
  private async assertPropertyInOrg(
    organizationId: string,
    propertyId?: string | null | undefined,
  ): Promise<void> {
    if (!propertyId) return
    const p = await this.prisma.property.findFirst({
      where: { id: propertyId, organizationId },
      select: { id: true },
    })
    if (!p) throw new NotFoundException('Fastigheten hittades inte')
  }

  async create(dto: CreateNewsPostDto, organizationId: string, userId: string) {
    await this.assertPropertyInOrg(organizationId, dto.propertyId)
    return this.prisma.newsPost.create({
      data: {
        organizationId,
        title: dto.title,
        content: dto.content,
        targetAll: dto.targetAll ?? true,
        createdById: userId,
        ...(dto.propertyId ? { propertyId: dto.propertyId } : {}),
      },
      include: {
        createdBy: { select: { firstName: true, lastName: true } },
        property: { select: { id: true, name: true } },
      },
    })
  }

  async update(id: string, dto: UpdateNewsPostDto, organizationId: string) {
    await this.findOne(id, organizationId)
    await this.assertPropertyInOrg(organizationId, dto.propertyId)
    return this.prisma.newsPost.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.content !== undefined ? { content: dto.content } : {}),
        ...(dto.targetAll !== undefined ? { targetAll: dto.targetAll } : {}),
        ...(dto.propertyId !== undefined ? { propertyId: dto.propertyId } : {}),
      },
      include: {
        createdBy: { select: { firstName: true, lastName: true } },
        property: { select: { id: true, name: true } },
      },
    })
  }

  async publish(id: string, organizationId: string) {
    await this.findOne(id, organizationId)
    return this.prisma.newsPost.update({
      where: { id },
      data: { publishedAt: new Date() },
    })
  }

  async remove(id: string, organizationId: string): Promise<void> {
    await this.findOne(id, organizationId)
    await this.prisma.newsPost.delete({ where: { id } })
  }
}
