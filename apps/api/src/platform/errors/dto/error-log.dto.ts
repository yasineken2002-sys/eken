import { IsEnum, IsObject, IsOptional, IsString } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

/**
 * #612: `organizationId` är BORTTAGET ur kontraktet.
 *
 * Fältet var klientvalt och obekräftat. En rapport kunde alltså skrivas in på
 * vilken organisation som helst, vilket gör org-kolumnen — som admin-vyn
 * filtrerar på — till ett påstående från avsändaren i stället för ett faktum.
 * Det enda anropsstället (admins ErrorBoundary) skickade det aldrig.
 *
 * Behöver en framtida rapport org-tillhörighet ska den HÄRLEDAS på servern,
 * inte tas emot. Att lägga tillbaka fältet som indata är att återinföra
 * defekten.
 */
export class CreateFrontendErrorDto {
  @ApiProperty({ enum: ['CRITICAL', 'ERROR', 'WARNING'] })
  @IsEnum(['CRITICAL', 'ERROR', 'WARNING'])
  severity!: 'CRITICAL' | 'ERROR' | 'WARNING'

  @ApiProperty({ enum: ['WEB', 'PORTAL', 'ADMIN'] })
  @IsEnum(['WEB', 'PORTAL', 'ADMIN'])
  source!: 'WEB' | 'PORTAL' | 'ADMIN'

  @ApiProperty() @IsString() message!: string
  @ApiProperty({ required: false }) @IsString() @IsOptional() stack?: string
  @ApiProperty({ required: false }) @IsObject() @IsOptional() context?: Record<string, unknown>
}
