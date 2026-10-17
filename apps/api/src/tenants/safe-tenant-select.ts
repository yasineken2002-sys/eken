import type { Prisma } from '@prisma/client'

/**
 * Safe Prisma SELECT for tenant data exposed via API.
 *
 * Innehåller ALLA icke-känsliga Tenant-kolumner men ALDRIG portal-credentials
 * (passwordHash, *TokenHash, *TokenExpiresAt — se TENANT_CREDENTIAL_KEYS i tenants.service.ts).
 * Använd detta istället för `include: { tenant: true }` överallt en hyresgäst
 * returneras till ett hyresvärds-vänt endpoint — det är samma skydd som
 * mapTenant ger, fast på databas-nivå så hashen aldrig ens lämnar Postgres.
 *
 * PERSONNUMMER INGÅR INTE. Selecten delas av ett tjugotal ställen (fakturor,
 * depositioner, nycklar, besiktningar, dashboard, avisering …) där personnumret
 * aldrig behövdes — det åkte bara med. Den som verkligen ska visa numret väljer
 * `personalNumberEnc` explicit och dekrypterar vid användningstillfället.
 *
 * Behöver du fler icke-känsliga fält: LÄGG TILL dem här. Använd aldrig rå
 * `include: { tenant: true }` för Tenant. (Audit HIGH #2 — uppföljning PR #10.)
 */
export const SAFE_TENANT_SELECT = {
  id: true,
  organizationId: true,
  type: true,
  firstName: true,
  lastName: true,
  companyName: true,
  orgNumber: true,
  contactPerson: true,
  email: true,
  phone: true,
  street: true,
  city: true,
  postalCode: true,
  country: true,
  ocrNumber: true,

  // Portal-status (icke-känsligt — inga hemligheter)
  portalActivated: true,
  portalActivatedAt: true,
  activationReminderSentAt: true,

  // Tidsstämplar
  createdAt: true,
  updatedAt: true,

  // GDPR-tillstånd. Icke-känsligt i sig, och operatörens UI behöver kunna visa
  // att raden redan är avidentifierad i stället för att erbjuda åtgärden igen.
  anonymizedAt: true,

  // EXPLICIT EXKLUDERADE (LÄGG ALDRIG TILL — se TENANT_CREDENTIAL_KEYS):
  // - passwordHash
  // - activationTokenHash
  // - activationTokenExpiresAt
  // - passwordResetTokenHash
  // - passwordResetTokenExpiresAt
} as const satisfies Prisma.TenantSelect
