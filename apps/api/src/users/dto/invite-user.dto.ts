import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import type { UserRole } from '@eken/shared'

// OWNER kan ej bjudas in — OWNER är organisationens skapare. ACCOUNTANT/VIEWER
// är inte exponerade i den första iterationen för att hålla UI:t enkelt.
export const INVITABLE_ROLES = ['ADMIN', 'MANAGER'] as const satisfies readonly UserRole[]
export type InvitableRole = (typeof INVITABLE_ROLES)[number]

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

  @ApiProperty({ enum: INVITABLE_ROLES })
  @IsIn(INVITABLE_ROLES)
  role!: InvitableRole
}
