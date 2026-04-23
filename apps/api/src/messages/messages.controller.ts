import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { MessagesService } from './messages.service'
import { SendMessageDto } from './dto/send-message.dto'
import type { JwtPayload } from '@eken/shared'

@Controller('messages')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private readonly service: MessagesService) {}

  @Post('send')
  @HttpCode(HttpStatus.CREATED)
  async send(
    @Body() dto: SendMessageDto,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    if (dto.sendToAll) {
      return this.service.sendToAll(organizationId, dto.subject, dto.content, user.sub)
    }
    if (dto.tenantId) {
      return this.service.sendToTenant(
        dto.tenantId,
        organizationId,
        dto.subject,
        dto.content,
        user.sub,
      )
    }
    throw new BadRequestException('Ange tenantId eller sendToAll: true')
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.CREATED)
  async retry(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.retryFailed(id, organizationId, user.sub)
  }

  @Get('stats')
  async stats(@OrgId() organizationId: string) {
    return this.service.getStats(organizationId)
  }

  @Get()
  async findAll(@OrgId() organizationId: string) {
    return this.service.findAll(organizationId)
  }
}
