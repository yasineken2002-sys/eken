import { Controller, Post, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import type { NotificationsService } from './notifications.service'

@Controller()
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Post('notifications/send-overdue-reminders')
  async triggerReminders(@OrgId() organizationId: string) {
    await this.service.sendOverdueRemindersForOrg(organizationId)
    return { message: 'Påminnelser skickade' }
  }
}
