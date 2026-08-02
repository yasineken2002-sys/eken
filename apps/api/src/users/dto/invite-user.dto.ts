import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { ASSIGNABLE_ROLES } from '@eken/shared'
import type { AssignableRole } from './update-user-role.dto'

/**
 * Inbjudan tilldelar en roll — därför samma lista som rollbytet (R3).
 * Historiken och beslutet står vid `ASSIGNABLE_ROLES` i @eken/shared.
 */
export class InviteUserDto {
  @ApiProperty()
  @IsEmail({}, { message: 'Ogiltig e-postadress' })
  email!: string

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string

  @ApiProperty({ enum: ASSIGNABLE_ROLES })
  @IsIn(ASSIGNABLE_ROLES)
  role!: AssignableRole
}
