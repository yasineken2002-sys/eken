/**
 * VAD EN ANVÄNDARRAD FÅR BÄRA UT.
 *
 * Konstanten hette `PUBLIC_USER_FIELDS`, låg icke-exporterad i
 * `users.service.ts` och saknade helt bevakning: en sökning över samtliga
 * specar efter `passwordHash` gav fyra träffar, alla på hyresgäst-/portalsidan.
 * `User` var den enda av #445:s fem känsliga modeller utan någon `SAFE_*_SELECT`
 * — och den enda utan ett test som säger att lösenordshashen inte får ut.
 *
 * Namnet och platsen följer nu idiomet (`SAFE_TENANT_SELECT`,
 * `SAFE_CUSTOMER_SELECT`, `SAFE_ORGANIZATION_SELECT`, …). Egen modul så att
 * `user-select.spec.ts` kan importera den utan att dra in tjänstens beroenden.
 *
 * ── Vad den INTE löser ───────────────────────────────────────────────────────
 *
 * `auth/`-modulen läser medvetet förbi den här selecten: `passwordHash` krävs
 * för bcrypt-jämförelsen i login. De läsningarna handprojicerar sina svar
 * (`AuthService.me` bygger fyra fält; impersonation bygger fem). Det är
 * Tenant-mönstret, och det bärs där av `readTenantWithCredentials` +
 * mönsterkontroll (#455). Motsvarigheten för `User` är inte byggd — se #445.
 */
export const SAFE_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
} as const
