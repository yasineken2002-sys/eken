import { BadRequestException, ValidationPipe } from '@nestjs/common'
import {
  fortnoxAccountMappingDraftInputSchema,
  type FortnoxAccountMappingDraftInput,
} from '@eken/shared'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { FortnoxAccountMappingDraftDto } from './dto/fortnox-account-mapping.dto'
import {
  godkannandeHinder,
  iKontoklass,
  LASTA_MAL,
  teknik,
  type Malfakta,
} from './fortnox-kontomappning'

const role = 'KUNDTILLGODOSKULD'
const fakta: Malfakta = {
  exists: true,
  name: 'Syntetiskt skuldkonto',
  active: true,
  vatCode: null,
  vatCodePresent: true,
  year: 1,
}
const input: FortnoxAccountMappingDraftInput = {
  financialYearId: 1,
  rows: [
    {
      role,
      vatTreatment: 'EJ_TILLAMPLIG',
      sourceAccountNumber: 2998,
      targetAccountNumber: 2997,
    },
  ],
}
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS)
const throughPipe = (body: unknown) =>
  pipe.transform(body, {
    type: 'body',
    metatype: FortnoxAccountMappingDraftDto,
  })

describe('Kundtillgodoskuld som egen Fortnox-roll', () => {
  it('bevarar den uttryckliga rollen och kontovalet genom både delat schema och produktionspipe', async () => {
    expect(fortnoxAccountMappingDraftInputSchema.parse(input)).toEqual(input)
    await expect(throughPipe(input)).resolves.toMatchObject(input)
    expect(LASTA_MAL[role]).toBeUndefined()
  })

  it.each(['MOMSFRI', 'AVDRAGSGILL'] as const)(
    'schema och pipe avvisar behandlingen %s',
    async (vatTreatment) => {
      const body = { ...input, rows: input.rows.map((row) => ({ ...row, vatTreatment })) }
      expect(fortnoxAccountMappingDraftInputSchema.safeParse(body).success).toBe(false)
      await expect(throughPipe(body)).rejects.toBeInstanceOf(BadRequestException)
    },
  )

  it('schema och pipe kräver kundens målkonto och fyller inte i ett standardkonto', async () => {
    const body = {
      financialYearId: 1,
      rows: [{ role, vatTreatment: 'EJ_TILLAMPLIG', sourceAccountNumber: 2998 }],
    }
    expect(fortnoxAccountMappingDraftInputSchema.safeParse(body).success).toBe(false)
    await expect(throughPipe(body)).rejects.toBeInstanceOf(BadRequestException)
  })

  it.each([2300, 2420, 2999])(
    'konto %s kan prövas för uttryckligt godkännande inom den tekniska skuldklassen',
    (number) => {
      expect(iKontoklass(role, number)).toBe(true)
      const assessment = teknik(role, 'EJ_TILLAMPLIG', fakta, 1, number)
      expect(assessment.teknik).toBe('FORENLIG')
      expect(
        godkannandeHinder({
          role,
          targetAccountNumber: number,
          technical: assessment.teknik,
          technicalReason: assessment.skal,
        }),
      ).toBeNull()
    },
  )

  it.each([1510, 1930, 2000, 2099, 2200, 2299, 3000, 3911, 4010])(
    'konto %s kan inte godkännas utanför skuldklassen',
    (number) => {
      expect(iKontoklass(role, number)).toBe(false)
      expect(teknik(role, 'EJ_TILLAMPLIG', fakta, 1, number).teknik).toBe('KONFLIKT')
      // Även en äldre sparad teknikbedömning får inte kringgå kontoklassen.
      expect(
        godkannandeHinder({
          role,
          targetAccountNumber: number,
          technical: 'FORENLIG',
          technicalReason: 'Äldre sparad bedömning',
        }),
      ).toContain('2300–2999')
    },
  )

  it.each(['MF', 'HFS', 'I'])('momskod %s är inte förenlig med kundtillgodoskulden', (vatCode) => {
    expect(teknik(role, 'EJ_TILLAMPLIG', { ...fakta, vatCode }, 1, 2998).teknik).toBe('KONFLIKT')
  })

  it('saknad momskodsuppgift, inaktivt konto eller fel år blir aldrig automatiskt förenligt', () => {
    expect(teknik(role, 'EJ_TILLAMPLIG', { ...fakta, vatCodePresent: false }, 1, 2998).teknik).toBe(
      'EJ_BELAGD',
    )
    expect(teknik(role, 'EJ_TILLAMPLIG', { ...fakta, active: false }, 1, 2998).teknik).toBe(
      'KONFLIKT',
    )
    expect(teknik(role, 'EJ_TILLAMPLIG', { ...fakta, year: 2 }, 1, 2998).teknik).toBe('KONFLIKT')
  })
})
