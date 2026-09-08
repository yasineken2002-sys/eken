import { IsString, IsOptional, IsBoolean, IsUUID } from 'class-validator'
import type { UpdateNewsPostInput, SammaNycklar } from '@eken/shared'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class UpdateNewsPostDto implements UpdateNewsPostInput {
  @IsString()
  @IsOptional()
  @StrictString()
  title?: string

  @IsString()
  @IsOptional()
  @StrictString()
  content?: string

  @StrictBoolean()
  @IsBoolean()
  @IsOptional()
  targetAll?: boolean

  @IsUUID()
  @IsOptional()
  propertyId?: string | null
}

const _kontrakt: SammaNycklar<UpdateNewsPostDto, UpdateNewsPostInput> = true
void _kontrakt
