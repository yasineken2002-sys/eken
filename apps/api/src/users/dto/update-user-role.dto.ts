import { IsIn } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { ASSIGNABLE_ROLES } from '@eken/shared'

/**
 * Rollerna som kan tilldelas — vid rollbyte OCH vid inbjudan (R3).
 * Historiken, OWNER-uteslutningen och beslutet står vid `ASSIGNABLE_ROLES`
 * i @eken/shared.
 */
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]

export class UpdateUserRoleDto {
  @ApiProperty({ enum: ASSIGNABLE_ROLES })
  @IsIn(ASSIGNABLE_ROLES)
  role!: AssignableRole
}
