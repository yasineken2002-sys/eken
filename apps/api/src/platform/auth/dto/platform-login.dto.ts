import { IsEmail, IsString, IsOptional, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { IsStrongPassword } from '../../../auth/dto/password.decorators'

export class PlatformLoginDto {
  @ApiProperty() @IsEmail() email!: string
  @ApiProperty() @IsString() @MinLength(8) password!: string
  @ApiProperty({ required: false, description: 'TOTP-kod om 2FA är aktiverat' })
  @IsOptional()
  @IsString()
  totpCode?: string
}

export class PlatformRefreshDto {
  @ApiProperty() @IsString() refreshToken!: string
}

export class PlatformChangePasswordDto {
  @ApiProperty() @IsString() @MinLength(1) currentPassword!: string
  @ApiProperty({ minLength: 10 }) @IsStrongPassword() newPassword!: string
}

export class PlatformTotpVerifyDto {
  @ApiProperty() @IsString() code!: string
}
