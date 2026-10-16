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
  JOURNAL_SOURCES,
  journalPageQuerySchema,
  type JournalPageQuery,
  type SammaNycklar,
} from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'

/** Läs råvärdet före implicit konvertering, så exempelvis "01" och true avvisas. */
const CanonicalQueryInteger = (): PropertyDecorator =>
  Transform(({ obj, key }) => {
    const raw = (obj as Record<string, unknown>)[key]
    return typeof raw === 'string' && /^(0|[1-9]\d*)$/.exec(raw)?.[0] === raw ? Number(raw) : raw
  })

export class JournalPageQueryDto implements JournalPageQuery {
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
  @IsIn(JOURNAL_SOURCES)
  source?: JournalPageQuery['source']
}

/**
 * Schemat äger verkliga kalenderdatum och deras ordning. Hela objektet prövas,
 * så även metadatans syntetiska fält nekas som queryparameter. Bara undefined
 * är valfritt; null får inte tyst bli ett utelämnat filter.
 */
registerDecorator({
  name: 'journalPageContract',
  target: JournalPageQueryDto,
  propertyName: '__journalPageContract',
  validator: {
    validate(_value: unknown, args?: ValidationArguments): boolean {
      return journalPageQuerySchema.safeParse(args?.object).success
    },
    defaultMessage(): string {
      return 'Ogiltigt filter eller sidindelning för verifikationer'
    },
  },
})

const _kontrakt: SammaNycklar<JournalPageQueryDto, JournalPageQuery> = true
void _kontrakt
