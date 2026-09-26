/**
 * R2 (CODEX2 på #933) · SAMMA ACCEPTERADE VÄRDEN FÖR `voluntaryTaxLiability` I SHARED OCH DTO
 *
 * Webben prövar nyttolasten mot det delade schemat (`kontraktsfel`, contract-gate)
 * och API:t mot DTO:n genom den globala pipen. Säger de olika saker om samma
 * värde är kontraktet två kontrakt. Provet kör VARJE värde genom båda — det
 * riktiga `CreateUnitSchema`/`UpdateUnitSchema` och en riktig `ValidationPipe`
 * med appens `VALIDATION_PIPE_OPTIONS` över `CreateUnitDto`/`UpdateUnitDto` —
 * och kräver samma utfall och samma normaliserade värde.
 *
 * Kontraktet som gäller (husets `@StrictBoolean`, strict-boolean.decorator.ts):
 * booleaner och strängformerna "true"/"false" godtas och blir booleaner; allt
 * annat — null, tal, andra strängar, objekt — avvisas; utelämnat är frånvarande.
 * Bara det här fältet prövas; andra fälts kontrakt rörs inte.
 */

import { BadRequestException, ValidationPipe } from '@nestjs/common'
import { CreateUnitSchema, UpdateUnitSchema } from '@eken/shared'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { CreateUnitDto } from './dto/create-unit.dto'
import { UpdateUnitDto } from './dto/update-unit.dto'

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS)

const BAS = {
  propertyId: '11111111-2222-4333-8444-555555555555',
  name: 'Kontor 0101',
  unitNumber: '0101',
  type: 'OFFICE',
  area: 40,
  monthlyRent: 12000,
}

type Utfall = { godtas: true; varde: unknown } | { godtas: false }

async function genomPipen(
  metatype: typeof CreateUnitDto | typeof UpdateUnitDto,
  kropp: object,
): Promise<Utfall> {
  try {
    const ut = (await pipe.transform(kropp, { type: 'body', metatype })) as Record<string, unknown>
    return { godtas: true, varde: ut['voluntaryTaxLiability'] }
  } catch (e) {
    if (e instanceof BadRequestException) return { godtas: false }
    throw e
  }
}

function genomSchemat(
  schema: typeof CreateUnitSchema | typeof UpdateUnitSchema,
  kropp: object,
): Utfall {
  const r = schema.safeParse(kropp)
  return r.success
    ? { godtas: true, varde: (r.data as Record<string, unknown>)['voluntaryTaxLiability'] }
    : { godtas: false }
}

const UTELAMNAT = Symbol('utelämnat')

// [beskrivning, värde, förväntat utfall]
const FALL: Array<[string, unknown, Utfall]> = [
  ['true', true, { godtas: true, varde: true }],
  ['false', false, { godtas: true, varde: false }],
  ['strängen "true"', 'true', { godtas: true, varde: true }],
  ['strängen "false"', 'false', { godtas: true, varde: false }],
  ['utelämnat', UTELAMNAT, { godtas: true, varde: undefined }],
  ['null', null, { godtas: false }],
  ['talet 1', 1, { godtas: false }],
  ['talet 0', 0, { godtas: false }],
  ['strängen "ja"', 'ja', { godtas: false }],
  ['tomma strängen', '', { godtas: false }],
  ['strängen "TRUE"', 'TRUE', { godtas: false }],
  ['ett objekt', { v: true }, { godtas: false }],
]

const kroppMed = (bas: object, varde: unknown) =>
  varde === UTELAMNAT ? { ...bas } : { ...bas, voluntaryTaxLiability: varde }

describe('R2 · voluntaryTaxLiability: shared och POST/PATCH-pipen säger samma sak', () => {
  it.each(FALL)('POST, %s', async (_n, varde, forvantat) => {
    const kropp = kroppMed(BAS, varde)
    const pipen = await genomPipen(CreateUnitDto, kropp)
    const schemat = genomSchemat(CreateUnitSchema, kropp)
    expect(pipen).toEqual(forvantat)
    expect(schemat).toEqual(pipen)
  })

  it.each(FALL)('PATCH, %s', async (_n, varde, forvantat) => {
    const kropp = kroppMed({ name: 'Nytt namn' }, varde)
    const pipen = await genomPipen(UpdateUnitDto, kropp)
    const schemat = genomSchemat(UpdateUnitSchema, kropp)
    expect(pipen).toEqual(forvantat)
    expect(schemat).toEqual(pipen)
  })

  it('kanariefågel: pipen FÄLLER en ogiltig kropp i ett annat fält — riggen kan se ett nej', async () => {
    expect(await genomPipen(CreateUnitDto, { ...BAS, type: 'RADHUS' })).toEqual({ godtas: false })
    expect(genomSchemat(CreateUnitSchema, { ...BAS, type: 'RADHUS' })).toEqual({ godtas: false })
  })
})
