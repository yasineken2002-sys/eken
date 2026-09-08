import { ApiProperty } from '@nestjs/swagger'
import { IsString, MinLength } from 'class-validator'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class AcceptTermsDto {
  // Versionen klienten just bekräftat. Backend jämför med
  // CURRENT_TERMS_VERSION och avvisar om versionerna inte matchar — det
  // skyddar mot situationer där modalen visat en gammal cachad version
  // medan backend redan rullat fram en ny.
  @ApiProperty({ example: '1.0' })
  @IsString()
  @MinLength(1)
  @StrictString()
  version!: string
}
