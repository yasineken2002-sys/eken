import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common'
import type { JwtPayload } from '@eken/shared'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { UpdateReadingReviewFollowUpDto } from './dto/update-reading-review-follow-up.dto'
import { ReadingReviewFollowUpService } from './reading-review-follow-up.service'

@Controller('consumption/reading-review/follow-up')
@UseGuards(JwtAuthGuard)
export class ReadingReviewFollowUpController {
  constructor(private readonly followUp: ReadingReviewFollowUpService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER')
  getStatus(@OrgId() organizationId: string) {
    return this.followUp.getStatus(organizationId)
  }

  @Patch()
  @Roles('OWNER')
  update(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateReadingReviewFollowUpDto,
  ) {
    return this.followUp.update(organizationId, user.sub, dto)
  }
}
