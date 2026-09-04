/**
 * VAD ORGANISATIONSRADEN FÅR BÄRA UT PÅ EN ÖPPEN ENDPOINT.
 *
 * `GET /organizations/me` är öppen för varje roll och måste vara det: namn,
 * logotyp, adress och fakturabranding behövs i praktiskt taget varje vy. Men
 * servicen gjorde `findUnique({ where: { id } })` utan `select` och utan `omit`,
 * alltså HELA raden — inklusive organisationens prenumerations- och
 * faktureringsblock: `subscriptionPlan`, `planMonthlyFee`, `aiCreditsBalance`,
 * `trialEndsAt`, `billingEmail`, `suspendedAt`, `cancellationReason`,
 * `excludeFromBilling`.
 *
 * Det blocket är avgjort som ACCOUNTANT/ADMIN/OWNER (#441). Att grinda
 * `/ai-usage/current` utan att täppa den här hade varit en gräns bara på
 * pappret — org-raden lämnade ut ett superset av samma fält, till samma roll.
 * Gränsen kan alltså inte sitta på endpointen. Den sitter på fälten.
 *
 * ── SELECT, INTE OMIT — och varför riktningen spelar roll ────────────────────
 *
 * Ett `omit` av de elva hade varit kortare att skriva. Det är också FAIL-OPEN:
 * en ny känslig kolumn på modellen flödar ut tills någon minns att lägga till
 * den i listan. Ett `select` är FAIL-CLOSED — en ny kolumn syns inte förrän
 * någon aktivt tar in den. För en konstant vars enda uppgift är att hindra
 * läckor är den riktningen inte en smaksak.
 *
 * Priset är att listan är lång och att ett bortglömt fält bryter en vy. Det
 * priset betalas av `organization-select.spec.ts`, som partitionerar HELA
 * modellen mot schema.prisma: varje kolumn måste stå antingen här eller i
 * testets `MEDVETET_UTELÄMNADE` med ett skäl. Ett missat fält är därför ett rött
 * test, inte en trasig inställningssida.
 *
 * ── Första tillämpningen av #445:s allowlist-regel ───────────────────────────
 *
 * #445 slog fast att kravet ska vara en allowlist PER MODELL — `Organization`,
 * `Tenant`, `Customer`, `BankTransaction`, `User` måste ha explicit select eller
 * en godkänd SAFE_*_SELECT — i stället för en analys per läsning, som blir en
 * taint-analys och därmed antingen brus eller tyst. Det här är den tolfte
 * SAFE_*_SELECT i kodbasen och den första som läggs enligt den regeln.
 *
 * INGA RELATIONER. `maintenanceTicketSequence` och `invoiceNumberSequence` ser ut
 * som kolumner i schemat men är 1:1-RELATIONER till sekvenstabellerna. De stod i
 * ett tidigare utkast av den här konstanten, och typspärren visade då att de kom
 * ut som OBJEKT i svaret — alltså två relaterade rader som den bara `findUnique`
 * ALDRIG returnerade. Åtgärden hade infört sin egen läcka, i miniatyr. Behöver en
 * relation följa med får den sin egen SAFE_*_SELECT.
 */
export const SAFE_ORGANIZATION_SELECT = {
  // Identitet
  id: true,
  name: true,
  orgNumber: true,
  customerNumber: true,
  accountType: true,
  companyForm: true,

  // Skatt och redovisning
  fiscalYearStartMonth: true,
  vatNumber: true,
  vatReportingPeriod: true,
  hasFSkatt: true,
  fSkattApprovedDate: true,

  // Kontaktuppgifter
  email: true,
  phone: true,
  street: true,
  city: true,
  postalCode: true,
  country: true,

  // Varumärke och fakturautseende
  logoStorageKey: true,
  logoStorageUrl: true,
  bankgiro: true,
  paymentTermsDays: true,
  invoiceColor: true,
  invoiceTemplate: true,
  brandFont: true,
  brandSecondaryColor: true,

  // Driftinställningar organisationen själv styr
  morningReportEnabled: true,
  maxBankTxAmount: true,
  maxContractBatchFiles: true,
  maxContractBatchCostSek: true,
  daysBeforeMoveInForFirstPayment: true,
  remindersEnabled: true,
  reminderFeeSek: true,
  reminderFormalDay: true,
  reminderCollectionDay: true,
  collectionAgencyName: true,
  rentReminderDay: true,
  rentInkassoDaysAfterReminder: true,
  paymentDataThrough: true,
  paymentDataStaleDays: true,
  paymentDataStaleAlertedAt: true,

  // Villkorsacceptans — läses av re-acceptance-modalen i frontend
  termsAcceptedAt: true,
  termsVersion: true,
  // #577: speglar termsVersion. Inställningssidan kan visa vilken
  // policyversion organisationen godkänt, precis som för villkoren.
  privacyVersion: true,

  createdAt: true,
  updatedAt: true,
} as const
