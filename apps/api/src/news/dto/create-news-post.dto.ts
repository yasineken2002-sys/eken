import { IsString, IsOptional, IsBoolean, IsUUID } from 'class-validator'
import type { CreateNewsPostInput, SammaNycklar } from '@eken/shared'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class CreateNewsPostDto implements CreateNewsPostInput {
  @IsString()
  @StrictString()
  title!: string

  @IsString()
  @StrictString()
  content!: string

  @StrictBoolean()
  @IsBoolean()
  @IsOptional()
  targetAll?: boolean

  @IsUUID()
  @IsOptional()
  propertyId?: string | null
}

const _kontrakt: SammaNycklar<CreateNewsPostDto, CreateNewsPostInput> = true
void _kontrakt
