import { IsEmail, IsString, IsOptional, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

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
  @ApiProperty() @IsString() @MinLength(8) currentPassword!: string
  @ApiProperty() @IsString() @MinLength(8) newPassword!: string
}

export class PlatformTotpVerifyDto {
  @ApiProperty() @IsString() code!: string
}
