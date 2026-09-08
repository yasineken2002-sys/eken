import { IsEmail, IsString, IsOptional, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { IsStrongPassword } from '../../../auth/dto/password.decorators'
import { StrictString } from '../../../common/contract/strict-string.decorator'

export class PlatformLoginDto {
  @ApiProperty() @IsEmail() email!: string
  @ApiProperty()
  @IsString()
  @MinLength(8)
  @StrictString()
  password!: string
  @ApiProperty({ required: false, description: 'TOTP-kod om 2FA är aktiverat' })
  @IsOptional()
  @IsString()
  @StrictString()
  totpCode?: string
}

export class PlatformRefreshDto {
  @ApiProperty()
  @IsString()
  @StrictString()
  refreshToken!: string
}

export class PlatformChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @StrictString()
  currentPassword!: string
  @ApiProperty({ minLength: 10 })
  @IsStrongPassword()
  @StrictString()
  newPassword!: string
}

export class PlatformTotpVerifyDto {
  @ApiProperty()
  @IsString()
  @StrictString()
  code!: string
}
