import {
  IsEmail,
  IsString,
  IsOptional,
  IsIn,
  IsBoolean,
  MinLength,
  MaxLength,
  Equals,
} from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { CompanyForm } from '@prisma/client'
import { IsStrongPassword } from './password.decorators'
import type { SammaNycklar, RegisterInput } from '@eken/shared'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { StrictIsoDatum } from '../../common/contract/strict-iso-datum.decorator'

const COMPANY_FORM_VALUES = Object.values(CompanyForm) as string[]

export class RegisterDto implements RegisterInput {
  @ApiProperty() @IsEmail({}, { message: 'Ogiltig e-postadress' }) email!: string

  @ApiProperty({ minLength: 10 })
  @IsStrongPassword()
  @StrictString()
  password!: string

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @StrictString()
  firstName!: string
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @StrictString()
  lastName!: string
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @StrictString()
  organizationName!: string

  // ─── Företagsform och organisationsnummer ────────────────────────────────
  // Validering av att orgNumber faktiskt matchar companyForm görs i
  // AuthService.register() via validateSwedishOrgNumber — class-validator
  // kan inte uttrycka beroenden mellan fält utan en custom validator.
  @ApiPropertyOptional({ enum: CompanyForm, default: CompanyForm.AB })
  @IsOptional()
  @IsIn(COMPANY_FORM_VALUES)
  companyForm?: CompanyForm

  @ApiPropertyOptional({ example: '556123-4567 (AB) eller 198512251234 (Enskild firma)' })
  @IsOptional()
  @IsString()
  @StrictString()
  orgNumber?: string

  // ─── F-skatt och moms (frivillig uppgift resp. momsnr på faktura, #392) ──
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  @StrictBoolean()
  hasFSkatt?: boolean

  @ApiPropertyOptional({ example: '2024-06-01' })
  @IsOptional()
  @StrictIsoDatum()
  fSkattApprovedDate?: string

  @ApiPropertyOptional({ example: '556123456701' })
  @IsOptional()
  @IsString()
  @StrictString()
  vatNumber?: string

  // ─── Bakåtkompatibilitet ─────────────────────────────────────────────────
  // Gamla klienter skickar ibland bara accountType ('COMPANY'/'PRIVATE').
  // Behålls för att inte bryta tidigare frontend-versioner — backend
  // härleder companyForm från accountType om companyForm saknas (PRIVATE
  // → ENSKILD_FIRMA, COMPANY → AB).
  @ApiPropertyOptional({ enum: ['COMPANY', 'PRIVATE'], default: 'COMPANY' })
  @IsOptional()
  @IsIn(['COMPANY', 'PRIVATE'])
  // Typen är unionen, inte `string`. `@IsIn` begränsade redan i runtime medan
  // TS-typen påstod att vilken sträng som helst var giltig — en beskrivning som
  // var lösare än beteendet.
  accountType?: 'COMPANY' | 'PRIVATE'

  // ─── Acceptans av juridiska dokument ─────────────────────────────────────
  // literal(true) — avvisa allt utom exakt true. Detta är ett juridiskt krav
  // för att kunna bevisa att användaren aktivt godkänt villkoren vid signup
  // (jfr. GDPR art. 7.1 om bevisbörda för samtycke).
  @ApiProperty({ description: 'Måste vara true för att signup ska lyckas' })
  @IsBoolean()
  @Equals(true, {
    message: 'Du måste acceptera Användarvillkor och Integritetspolicy',
  })
  // Typen är `true`, inte `boolean` — samma sak som `@Equals(true)` säger i
  // runtime. Ett samtycke har ett enda giltigt värde, och typen ska inte påstå
  // att `false` är en form servern accepterar.
  // ── @StrictBoolean ÄR SPÄRREN — NÄRVARON, INTE PLACERINGEN ───────────────
  //
  // Funnet av koercionsgrinden i paritetsprovet (#830), inte av läsning.
  //
  // Fältet bar `@IngenKoercion()` fram till 2026-09-07 och bär nu
  // `@StrictBoolean()`, som är EN mekanism för alla booleska fält.
  // Skillnaden i utfall gäller bara strängformen: `@IngenKoercion` avvisade
  // `"true"`, `@StrictBoolean` godtar den och läser den som `true`. Riktningen
  // som betyder något är oförändrad — `"false"` blir `false`, aldrig `true`,
  // och `@Equals(true)` nedan avvisar den då korrekt.
  //
  // Placeringen bland fältets övriga dekoratorer saknar betydelse. Uppmätt mot
  // den riktiga pipen, tre varianter:
  //
  //     dekoratorn före validatorerna   "false" → false, sedan 400 av @Equals
  //     dekoratorn efter validatorerna  "false" → false, sedan 400 av @Equals
  //     utan dekoratorn                 "false" → true  ← samtycket kringgått
  //
  // Skälet: class-transformer kör HELA sin fas före class-validator, så var
  // transformen står bland fältets övriga dekoratorer saknar betydelse. Det
  // som avgör är att den finns.
  //
  // Den globala pipen kör `enableImplicitConversion`, så class-transformer
  // läser TS-typen och kör `Boolean(värdet)` INNAN validatorerna ser något.
  // `Boolean('false')` är `true`. Strängen "false" — som betyder NEJ — blev
  // alltså ett godkänt samtycke, och `@Equals(true)` såg bara resultatet av
  // konverteringen.
  //
  // Det här är villkorsacceptansen. Ett nej som blir ett ja är den enda
  // riktning som inte får finnas, och den fanns.
  @StrictBoolean()
  acceptTerms!: true
}

const _kontraktRegisterDto: SammaNycklar<RegisterDto, RegisterInput> = true
void _kontraktRegisterDto
