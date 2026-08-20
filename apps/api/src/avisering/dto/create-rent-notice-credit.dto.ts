import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator'

/**
 * En post att kreditera på hyresavin (#518).
 *
 * `rentNoticeLineId` UTELÄMNAD BETYDER HYRESKAPITALET, och det är inte en
 * bekvämlighet utan en följd av datamodellen: avins hyra bor i
 * `RentNotice.totalAmount` och är ingen `RentNoticeLine` — rader finns bara för
 * förbruknings- (IMD) och övriga debiteringsposter. Att uppfinna en
 * "kapitalrad" hade ändrat betydelsen av en tabell som andra vägar redan läser.
 *
 * MOMSSATSEN GÅR INTE ATT ANGE, till skillnad från belopp. Momsbärande poster
 * är spärrade i sin helhet tills momsfrågan är besvarad (#370, #535) — och även
 * när den är det ska satsen ärvas från originalet, aldrig komma från klienten.
 * En klientstyrd sats kan kreditera bort utgående moms som aldrig bokförts: ett
 * fel som lämnar huvudboken balanserad och momsredovisningen fel, alltså precis
 * den sorten en balanskontroll inte upptäcker.
 */
export class RentNoticeCreditLineDto {
  @ApiProperty({
    required: false,
    description: 'Avi-raden som krediteras. Utelämnad = hyreskapitalet.',
  })
  @IsOptional()
  @IsUUID('4', { message: 'rentNoticeLineId måste vara ett giltigt UUID' })
  rentNoticeLineId?: string

  @ApiProperty({ description: 'Belopp som krediteras (brutto, kronor)' })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Belopp anges med högst två decimaler' })
  @Min(0.01, { message: 'Belopp måste vara större än noll' })
  amount!: number
}

export class CreateRentNoticeCreditDto {
  @ApiProperty({ type: [RentNoticeCreditLineDto] })
  @IsArray()
  @ArrayMinSize(1, { message: 'En kreditering måste innehålla minst en post' })
  @ValidateNested({ each: true })
  @Type(() => RentNoticeCreditLineDto)
  lines!: RentNoticeCreditLineDto[]

  /**
   * Skälet är OBLIGATORISKT, och det är den enda egenskap som skiljer en
   * nedsättning från en annullering i historiken. `CANCELLED` säger "avin skulle
   * aldrig ha funnits"; en kreditering säger "beloppet var för högt" — utan ett
   * skrivet skäl går det inte att se vilken av dem som skedde, vilket är precis
   * varför D1 höll isär dem.
   */
  @ApiProperty({ description: 'Varför avin krediteras' })
  @IsString()
  @MinLength(5, { message: 'Ange ett skäl till krediteringen (minst 5 tecken)' })
  reason!: string
}
