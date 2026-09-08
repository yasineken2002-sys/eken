import { Controller, Get, UseGuards } from '@nestjs/common'
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
}
