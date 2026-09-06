import type { SammaNycklar, AnonymizeTenantInput } from '@eken/shared'
import { IsOptional, IsString, MaxLength } from 'class-validator'

export class AnonymizeTenantDto implements AnonymizeTenantInput {
  /**
   * Fri anteckning om varför avidentifieringen gjordes, t.ex. ett ärendenummer.
   *
   * Frivillig, precis som `reason` på impersoneringen som den här loggen är
   * speglad på. Ett obligatoriskt fält hade bara gett tomma strängar.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string
}

/** NYCKELPARITET mot det delade schemat — se övriga DTO:er. */
const _kontraktAvidentifiera: SammaNycklar<AnonymizeTenantDto, AnonymizeTenantInput> = true
void _kontraktAvidentifiera
