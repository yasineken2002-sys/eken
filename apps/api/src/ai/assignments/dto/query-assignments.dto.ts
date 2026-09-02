import { IsIn, IsOptional } from 'class-validator'

import type { AiAssignmentStatus } from '@prisma/client'

export class QueryAssignmentsDto {
  @IsOptional()
  @IsIn(['AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED'])
  status?: AiAssignmentStatus
}
