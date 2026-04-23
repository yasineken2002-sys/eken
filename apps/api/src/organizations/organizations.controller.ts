import { Controller, Get, Patch, Body, BadRequestException, UseGuards, Req } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import type { OrganizationsService } from './organizations.service'
import type { UpdateOrganizationDto } from './dto/update-organization.dto'

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get('me')
  async findMyOrganization(@OrgId() organizationId: string) {
    return this.organizationsService.findMyOrganization(organizationId)
  }

  @Patch('me')
  async update(@OrgId() organizationId: string, @Body() dto: UpdateOrganizationDto) {
    return this.organizationsService.update(organizationId, dto)
  }

  @Patch('me/logo')
  async uploadLogo(@OrgId() organizationId: string, @Req() req: FastifyRequest) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const file = await (req as any).file()
    if (!file) throw new BadRequestException('Ingen fil bifogad')

    const ALLOWED_LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
    const MAX_LOGO_SIZE = 2 * 1024 * 1024

    if (!ALLOWED_LOGO_TYPES.includes(file.mimetype as string)) {
      throw new BadRequestException('Filtyp inte tillåten (JPEG, PNG eller WebP)')
    }
    const bytesRead = (file.file as { bytesRead?: number }).bytesRead
    if (bytesRead != null && bytesRead > MAX_LOGO_SIZE) {
      throw new BadRequestException('Logotypen är för stor (max 2MB)')
    }

    return this.organizationsService.uploadLogo(organizationId, file)
  }
}
