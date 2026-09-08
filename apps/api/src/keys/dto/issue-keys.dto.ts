import { KeyType } from '@prisma/client'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { StrictIsoDatum } from '../../common/contract/strict-iso-datum.decorator'
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator'

export class IssueKeysDto {
  @IsUUID()
  leaseId!: string

  @IsEnum(KeyType)
  type!: KeyType

  // Bulk-utlämning: skapar N rader (en per fysisk nyckel) i EN transaktion.
  @IsInt()
  @Min(1)
  @Max(50)
  quantity!: number

  // Märkning/serienr som sätts på samtliga rader i satsen (valfritt).
  @IsString()
  @IsOptional()
  @MaxLength(120)
  @StrictString()
  label?: string

  // Om någon annan än hyresgästen fysiskt kvitterade (sambo/firma).
  @IsString()
  @IsOptional()
  @MaxLength(120)
  @StrictString()
  issuedToName?: string

  // Frivilligt utlämningsdatum — annars sätts now() i servicen.
  @StrictIsoDatum()
  @IsOptional()
  issuedAt?: string

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  @StrictString()
  notes?: string
}
