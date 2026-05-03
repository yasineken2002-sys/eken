import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'
import type { Tenant } from '@prisma/client'
import { Public } from '../common/decorators/public.decorator'
import { TenantAuthGuard } from '../tenant-portal/tenant-auth.guard'
import { CurrentTenant } from '../tenant-portal/current-tenant.decorator'
import { TenantAiService } from './tenant-ai.service'

class TenantChatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message!: string

  @IsOptional()
  @IsString()
  conversationId?: string
}

class TenantConfirmDto {
  @IsString()
  @MinLength(1)
  toolName!: string

  @IsObject()
  toolInput!: Record<string, unknown>

  @IsString()
  @MinLength(1)
  conversationId!: string

  @IsBoolean()
  confirmed!: boolean
}

@Controller('tenant-portal/ai')
@Public()
@UseGuards(TenantAuthGuard)
export class TenantAiController {
  constructor(private readonly tenantAiService: TenantAiService) {}

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async chat(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
    @Body() dto: TenantChatDto,
  ) {
    return this.tenantAiService.chat(
      tenant.id,
      tenant.organizationId,
      dto.message,
      dto.conversationId,
    )
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  async confirmAction(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
    @Body() dto: TenantConfirmDto,
  ) {
    return this.tenantAiService.confirmAction(
      dto.toolName,
      dto.toolInput,
      dto.conversationId,
      dto.confirmed,
      tenant.id,
      tenant.organizationId,
    )
  }

  @Get('conversations')
  async getConversations(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
  ) {
    return this.tenantAiService.getConversations(tenant.id)
  }

  @Get('conversations/:id')
  async getConversation(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
    @Param('id') id: string,
  ) {
    return this.tenantAiService.getConversation(tenant.id, id)
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConversation(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
    @Param('id') id: string,
  ) {
    return this.tenantAiService.deleteConversation(tenant.id, id)
  }
}
