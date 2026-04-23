import { IsEmail, IsString, IsOptional, IsIn, MinLength, Matches, MaxLength } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export class RegisterDto {
  @ApiProperty() @IsEmail() email!: string
  @ApiProperty() @IsString() @MinLength(8) @Matches(/[A-Z]/) @Matches(/[0-9]/) password!: string
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) firstName!: string
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) lastName!: string
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) organizationName!: string
  @ApiPropertyOptional({ example: '556123-4567' }) @IsOptional() @IsString() orgNumber?: string
  @ApiPropertyOptional({ enum: ['COMPANY', 'PRIVATE'], default: 'COMPANY' })
  @IsOptional()
  @IsIn(['COMPANY', 'PRIVATE'])
  accountType?: string
}
