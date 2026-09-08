import type { JwtPayload } from '@eken/shared'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { SaveReadingReviewDto } from './dto/save-reading-review.dto'
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { ReadingReviewService } from './reading-review.service'

@Controller('consumption/reading-review')
@UseGuards(JwtAuthGuard)
export class ReadingReviewController {
  constructor(private readonly review: ReadingReviewService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER')
  getReview(@OrgId() organizationId: string) {
    return this.review.getReview(organizationId)
  }
  @Post('decisions')
  @Roles('OWNER', 'ADMIN', 'MANAGER')
  saveReview(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: SaveReadingReviewDto,
  ) {
    return this.review.saveReview(organizationId, user.sub, dto)
  }
}
