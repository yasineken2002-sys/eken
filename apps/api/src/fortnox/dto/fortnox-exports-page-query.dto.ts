import { Transform } from 'class-transformer'
import {
  IsIn,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateIf,
  registerDecorator,
  type ValidationArguments,
} from 'class-validator'

import {
  FORTNOX_EXPORT_GROUPS,
  FORTNOX_EXPORT_SOURCES,
  fortnoxExportsPageQuerySchema,
  type FortnoxExportsPageQuery,
  type SammaNycklar,
} from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'

/** Råvärdet måste läsas före pipens implicita konvertering; exempelvis "01" är inte kanoniskt. */
const CanonicalQueryInteger = (): PropertyDecorator =>
  Transform(({ obj, key }) => {
    const raw = (obj as Record<string, unknown>)[key]
    return typeof raw === 'string' && /^(0|[1-9]\d*)$/.exec(raw)?.[0] === raw ? Number(raw) : raw
  })

export class FortnoxExportsPageQueryDto implements FortnoxExportsPageQuery {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @CanonicalQueryInteger()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  offset?: number

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @CanonicalQueryInteger()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @StrictString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @StrictString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @StrictString()
  @IsIn(FORTNOX_EXPORT_SOURCES)
  source?: FortnoxExportsPageQuery['source']

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @StrictString()
  @IsIn(FORTNOX_EXPORT_GROUPS)
  group?: FortnoxExportsPageQuery['group']
}

/**
 * Datumens verklighet och ordning kommer från det delade schemat. Hela utfallet kontrolleras
 * här, även okända nycklar: valideringsmetadatans syntetiska fält får inte bli en queryparameter.
 * Null är avsiktligt inte valfritt; bara undefined får hoppa över fältvalideringen.
 */
registerDecorator({
  name: 'fortnoxExportsPageContract',
  target: FortnoxExportsPageQueryDto,
  propertyName: '__fortnoxExportsPageContract',
  validator: {
    validate(_value: unknown, args?: ValidationArguments): boolean {
      return fortnoxExportsPageQuerySchema.safeParse(args?.object).success
    },
    defaultMessage(): string {
      return 'Ogiltigt filter eller sidindelning för Fortnox-exporter'
    },
  },
})

const _kontrakt: SammaNycklar<FortnoxExportsPageQueryDto, FortnoxExportsPageQuery> = true
void _kontrakt
