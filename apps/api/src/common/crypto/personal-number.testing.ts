import { ConfigService } from '@nestjs/config'
import { SigningCryptoService } from '../../signing/signing-crypto.service'
import { PersonalNumberService } from './personal-number.service'

/**
 * Riktig PersonalNumberService med fasta testnycklar.
 *
 * Specarna får med flit ett SKARPT krypto i stället för en `{} as never`-attrapp:
 * läck-testerna (tenant-portal.*.leak.spec.ts m.fl.) ska se exakt det svaret
 * produktionskoden producerar. En attrapp hade returnerat undefined och därmed
 * "bevisat" att personnumret inte läcker av fel anledning.
 *
 * Nycklarna är publika testvärden och skyddar ingenting.
 */
export const TEST_PII_KEY = 'a'.repeat(64)
export const TEST_PII_PEPPER = 'test-pepper-minst-16-tecken'

export function testPersonalNumberService(): PersonalNumberService {
  const config = {
    get: (k: string) => ({ SIGNING_PII_KEY: TEST_PII_KEY, SIGNING_PII_PEPPER: TEST_PII_PEPPER })[k],
  } as unknown as ConfigService
  return new PersonalNumberService(new SigningCryptoService(config))
}
