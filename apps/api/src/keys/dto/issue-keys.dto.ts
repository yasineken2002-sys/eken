import { KeyType } from '@prisma/client'
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

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
  label?: string

  // Om någon annan än hyresgästen fysiskt kvitterade (sambo/firma).
  @IsString()
  @IsOptional()
  @MaxLength(120)
  issuedToName?: string

  // Frivilligt utlämningsdatum — annars sätts now() i servicen.
  @IsISO8601()
  @IsOptional()
  issuedAt?: string

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string
}
