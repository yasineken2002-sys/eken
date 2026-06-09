// ─────────────────────────────────────────────────────────────────────────────
// PDF-/dokumentvarumärke — delade konstanter (Steg 3, PR 1 — fundament)
// ─────────────────────────────────────────────────────────────────────────────
//
// Detta är DATA-underlaget för ett enhetligt varumärkessystem där alla PDF:er
// (och e-post) använder samma logga/färg/typsnitt. PR 1 skapar bara sanningen;
// inkopplingen av varje renderare sker i senare PR:er.
//
// VIKTIGT: ingenting här byter ut någon befintlig hårdkodning ännu. Att importera
// dessa konstanter ändrar inte hur en enda PDF eller ett enda mejl ser ut.

/**
 * EN sanning för organisationens default-varumärkesfärg (primär).
 *
 * Idag är defaulten inkonsekvent hårdkodad på 8+ ställen — dokument/PDF använder
 * grönt `#1a6b3c`, e-post använder blått `#2563EB`. Den här konstanten är värdet
 * som ska ersätta BÅDA när varje renderare kopplas in (vi enar på dokumentgrönt,
 * eftersom PDF-varumärket är målet). Tills dess är den oanvänd i renderingsvägen.
 *
 * Karta över de gamla hårdkodningarna som ska bytas mot `DEFAULT_BRAND_COLOR`
 * (alla med mönstret `org.invoiceColor ?? '<hårdkod>'`). [x] = inkopplad i shellen.
 *
 *   Dokument/PDF — default `#1a6b3c`:
 *     • apps/api/src/invoices/pdf.service.ts
 *     • apps/api/src/invoices/invoices.service.ts
 *     • apps/api/src/invoices/templates/invoice-pdf.template.ts
 *     • apps/api/src/contracts/residential-contract.template.ts
 *     • apps/api/src/contracts/commercial-contract.template.ts
 *     • [x] apps/api/src/avisering/avisering.service.ts    (primaryColor, PDF — Steg 3 PR 3c, brandad shell)
 *     • apps/api/src/notifications/notifications.service.ts
 *     • apps/api/src/avisering/rent-reminder.service.ts    (accent, PDF)
 *
 *   E-post — default `#2563EB`:
 *     • apps/api/src/mail/mail.service.ts
 *     • apps/api/src/avisering/avisering.service.ts        (e-post-accent)
 *     • apps/api/src/avisering/rent-reminder.service.ts    (e-post-accent)
 *     • [x] apps/api/src/notifications/templates/monthly-report.template.ts  (Steg 3 PR 3a — brandad shell)
 *     • apps/api/src/messages/messages.service.ts
 *     • [x] apps/api/src/inspections/inspections.service.ts  (Steg 3 PR 3b — brandad shell)
 *
 *   Transaktionsmejl med egen blå (utanför org-färgvägen, lägre prioritet):
 *     • apps/api/src/mail/templates/users/UserInvite.tsx
 *     • apps/api/src/mail/templates/users/PasswordReset.tsx
 *     • apps/api/src/auth/auth.service.ts
 */
export const DEFAULT_BRAND_COLOR = '#1a6b3c'

/**
 * Den tidigare e-post-defaulten, bevarad som namngiven konstant så att
 * inkopplings-PR:erna kan referera den explicit (och ta ett medvetet beslut
 * att ena mot DEFAULT_BRAND_COLOR) i stället för att jaga magiska strängar.
 */
export const LEGACY_EMAIL_BRAND_COLOR = '#2563EB'

// ── Typsnitt ─────────────────────────────────────────────────────────────────

/**
 * Kontrollerad lista av PDF-säkra typsnittsval. Speglar Prisma-enumet
 * `BrandFont` exakt (ordning + namn). Fritext tillåts ALDRIG — en ogiltig
 * font-sträng skulle kunna bryta PDF-renderingen.
 */
export const BRAND_FONTS = ['SYSTEM_SANS', 'HELVETICA', 'GEORGIA', 'INTER'] as const
export type BrandFontValue = (typeof BRAND_FONTS)[number]

/** Default = nuvarande hårdkodade typsnitt → befintliga orgs renderar oförändrat. */
export const DEFAULT_BRAND_FONT: BrandFontValue = 'SYSTEM_SANS'

/**
 * Konkreta `font-family`-stackar per val, med säkra generiska fallbacks så att
 * Chromium/Puppeteer alltid har något att rendera även om det namngivna
 * typsnittet saknas i container-imagen. Läses av renderarna i senare PR:er.
 */
export const BRAND_FONT_STACKS: Record<BrandFontValue, string> = {
  SYSTEM_SANS: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  HELVETICA: 'Helvetica, Arial, sans-serif',
  GEORGIA: 'Georgia, "Times New Roman", serif',
  INTER: 'Inter, system-ui, -apple-system, sans-serif',
}

/** Människovänliga etiketter (svenska) för inställnings-UI:t. */
export const BRAND_FONT_LABELS: Record<BrandFontValue, string> = {
  SYSTEM_SANS: 'System (sans-serif)',
  HELVETICA: 'Helvetica',
  GEORGIA: 'Georgia (serif)',
  INTER: 'Inter',
}

/**
 * Hjälpare: löser ut den slutgiltiga font-family-stacken för ett (möjligen
 * null/okänt) brandFont-värde. Okänt/saknat → default-stacken. Pure.
 */
export function resolveBrandFontStack(font?: string | null): string {
  return (
    BRAND_FONT_STACKS[(font as BrandFontValue) ?? DEFAULT_BRAND_FONT] ??
    BRAND_FONT_STACKS[DEFAULT_BRAND_FONT]
  )
}
