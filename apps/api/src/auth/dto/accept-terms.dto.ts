import { ApiProperty } from '@nestjs/swagger'
import { IsString, MinLength } from 'class-validator'

export class AcceptTermsDto {
  // Versionen klienten just bekräftat. Backend jämför med
  // CURRENT_TERMS_VERSION och avvisar om versionerna inte matchar — det
  // skyddar mot situationer där modalen visat en gammal cachad version
  // medan backend redan rullat fram en ny.
  @ApiProperty({ example: '1.0' })
  @IsString()
  @MinLength(1)
  version!: string
}
