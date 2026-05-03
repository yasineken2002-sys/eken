import { IsEmail, IsString, IsOptional, IsIn, MinLength, MaxLength } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsStrongPassword } from './password.decorators'

export class RegisterDto {
  @ApiProperty() @IsEmail({}, { message: 'Ogiltig e-postadress' }) email!: string

  @ApiProperty({ minLength: 10 })
  @IsStrongPassword()
  password!: string

  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) firstName!: string
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) lastName!: string
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) organizationName!: string
  @ApiPropertyOptional({ example: '556123-4567' }) @IsOptional() @IsString() orgNumber?: string
  @ApiPropertyOptional({ enum: ['COMPANY', 'PRIVATE'], default: 'COMPANY' })
  @IsOptional()
  @IsIn(['COMPANY', 'PRIVATE'])
  accountType?: string
}
