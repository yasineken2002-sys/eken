// API-sidan av orgnummer-validering. Själva algoritmen lever i
// @eken/shared så att frontend kan göra exakt samma kontroll i live-form.
// Här mappar vi bara mellan Prismas CompanyForm-enum och shared-typen
// (de använder samma strängvärden, så konverteringen är trivial).

import type { CompanyForm } from '@prisma/client'
import {
  validateSwedishOrgNumber as sharedValidate,
  type SwedishCompanyForm,
  type OrgNumberValidationResult,
} from '@eken/shared'

export type { OrgNumberValidationResult, SwedishCompanyForm }

export function validateSwedishOrgNumber(
  raw: string | null | undefined,
  companyForm?: CompanyForm,
): OrgNumberValidationResult {
  return sharedValidate(raw, companyForm as SwedishCompanyForm | undefined)
}
