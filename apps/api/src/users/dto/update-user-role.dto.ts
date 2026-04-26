import { IsIn } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import type { UserRole } from '@eken/shared'

// OWNER kan ej tilldelas via UI — det är ett unikt rollskifte som kräver
// särskild "transfer ownership"-flow (utanför scopet för denna iteration).
export const ASSIGNABLE_ROLES = [
  'ADMIN',
  'MANAGER',
  'ACCOUNTANT',
  'VIEWER',
] as const satisfies readonly UserRole[]
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]

export class UpdateUserRoleDto {
  @ApiProperty({ enum: ASSIGNABLE_ROLES })
  @IsIn(ASSIGNABLE_ROLES)
  role!: AssignableRole
}
