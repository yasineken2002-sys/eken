import { IsEmail, IsString, MinLength, Matches, MaxLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class RegisterDto {
  @ApiProperty() @IsEmail() email!: string
  @ApiProperty() @IsString() @MinLength(8) @Matches(/[A-Z]/) @Matches(/[0-9]/) password!: string
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) firstName!: string
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) lastName!: string
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) organizationName!: string
  @ApiProperty({ example: '556123-4567' }) @IsString() @Matches(/^\d{6}-\d{4}$/) orgNumber!: string
}
