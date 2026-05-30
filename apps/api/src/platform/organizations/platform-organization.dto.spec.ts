/**
 * C1 — DTO-validering fungerar. Controllers value-importerar DTO:erna så
 * ValidationPipe har sin class-validator-metadata. Testet låser fast att
 * CreateOrganizationDto faktiskt validerar (annars passerar ovaliderad input
 * tyst, t.ex. email: null in i Nodemailer/Prisma).
 */

import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateOrganizationDto } from './dto/platform-organization.dto'

const VALID = {
  name: 'Test AB',
  email: 'kund@test.se',
  street: 'Gata 1',
  city: 'Stockholm',
  postalCode: '11122',
  adminEmail: 'admin@test.se',
  adminFirstName: 'Test',
  adminLastName: 'User',
}

async function errorsFor(payload: Record<string, unknown>) {
  return validate(plainToInstance(CreateOrganizationDto, payload))
}

describe('CreateOrganizationDto-validering (C1)', () => {
  it('accepterar en komplett, giltig payload', async () => {
    expect(await errorsFor(VALID)).toHaveLength(0)
  })

  it('avvisar ogiltig e-post (constraints är inte borttvättade av import type)', async () => {
    const errors = await errorsFor({ ...VALID, email: 'inte-en-epost' })
    expect(errors.find((e) => e.property === 'email')?.constraints).toHaveProperty('isEmail')
  })

  it('avvisar saknade obligatoriska fält', async () => {
    const errors = await errorsFor({ email: 'kund@test.se' })
    const props = errors.map((e) => e.property)
    expect(props).toEqual(
      expect.arrayContaining(['name', 'street', 'city', 'postalCode', 'adminEmail']),
    )
  })
})
