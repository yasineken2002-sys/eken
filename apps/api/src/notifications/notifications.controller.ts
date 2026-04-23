import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { NotificationsService } from './notifications.service'
import { QueryNotificationsDto } from './dto/query-notifications.dto'
import type { JwtPayload } from '@eken/shared'

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get('count')
  async getCount(@OrgId() organizationId: string, @CurrentUser() user: JwtPayload) {
    const unread = await this.service.getUnreadCount(organizationId, user.sub)
    return { unread }
  }

  @Get()
  async findAll(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryNotificationsDto,
  ) {
    return this.service.findAll(organizationId, user.sub, query.unread)
  }

  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  async markAll(@OrgId() organizationId: string, @CurrentUser() user: JwtPayload) {
    return this.service.markAllAsRead(organizationId, user.sub)
  }

  @Patch(':id/read')
  async markOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.markAsRead(id, user.sub)
  }

  @Delete('old')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteOld() {
    await this.service.deleteOld()
  }

  @Post('send-overdue-reminders')
  async triggerReminders(@OrgId() organizationId: string) {
    await this.service.sendOverdueRemindersForOrg(organizationId)
    return { message: 'Påminnelser skickade' }
  }
}
