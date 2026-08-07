# Eveno (Eken) – Datamodell-karta & domänanalys

**Datum:** 2026-06-16
**Källa:** Fullständig läsning av `apps/api/prisma/schema.prisma` (3075 rader)
**Omfattning:** 69 modeller, 71 enums, 155 `@@index`, ~16 `@@unique`. Read-only analys. Ingen kod, migration eller modell ändrad.

---

## 1. Sammanfattning

Datamodellen är **mogen, domändriven och regulatoriskt genomtänkt**. Den bärs av fyra principer som syns konsekvent genom hela schemat:

1. **Multi-tenant via `organizationId`** på i princip varje domänmodell (men _applikationsenforced_, inte DB-enforced – ingen global scoping-middleware).
2. **Append-only revisionsspår** för allt bokföringsrelevant (`InvoiceEvent`, `RentNoticeEvent`, `JournalEntryLine`, `MeterReading`, `AiToolExecution`) med `onDelete: Restrict` mot org → BFL:s 7-årskrav är inbyggt i grafen, inte bara i kod.
3. **Skuld/betalning som beräknat tillstånd** – `RentNoticePayment` är sanningskälla, `paidAmount` är härledd spegel. Race-säkra nummerserier via separata sequence-tabeller.
4. **Källagnostik för framtiden** – `Meter.provider/externalId`, `Organization.paymentDataThrough` (PSD2-redo), `BankStatementImport.fileType` är medvetet förberedda för integrationer som ännu inte finns.

**Stödjer den "Sveriges bästa AI-drivna fastighetssystem"?** I grunden ja – relationsgrafen Fastighet→Enhet→Avtal→Hyresgäst→Ekonomi är komplett och korrekt, vilket gör att en AI-agent kan traversera hela beståndet. Men fem strukturella luckor begränsar både AI-resonemang och enterprise-skala: **ingen byggnadsnivå**, **ingen leverantörs-/arbetsordermodell**, **parallella Tenant/Customer- och Invoice/RentNotice-modeller (dubbellagring)**, **danglande aktörsfält utan FK**, och **ingen partitionerings-/arkiveringsstrategi för de tabeller som växer mot 100k-skala**.

| Dimension             | Bedömning                                               |
| --------------------- | ------------------------------------------------------- |
| Domäntäckning         | ★★★★★ förvaltning + ekonomi; ★★☆☆☆ underhåll/leverantör |
| Relationsintegritet   | ★★★★☆ (svaga punkter: plain-string-aktörsfält)          |
| AI-traverserbarhet    | ★★★★☆                                                   |
| Skala 100 enheter     | ★★★★★                                                   |
| Skala 100 000 enheter | ★★★☆☆ (kräver partition + arkiv + paginering)           |
| Multi-kund-isolering  | ★★★★☆ (saknar central enforcement)                      |
| GDPR-modellering      | ★★☆☆☆ (PII i klartext)                                  |

---

## 2. Alla Prisma-modeller

Grupperade per domän. Kardinalitet anges från den listade modellen. **AI-kontext = Hög** markerar modeller en agent behöver för att resonera om beståndet.

### A. Organisation / SaaS / Auth (10 modeller)

| Modell                   | Syfte                                                                                                                   | Viktiga fält                                                                                                                                                                                              | Relationer (kardinalitet)                                                             | AI-kontext |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------- |
| **Organization**         | Tenant-roten i multi-tenant. Bär SaaS-plan, fakturering, bokförings-/inkassoinställningar, branding, betaldata-färskhet | `name`, `orgNumber`, `customerNumber` (K-100001, global unik), `companyForm`, `fiscalYearStartMonth`, `subscriptionPlan`, `status`, `paymentDataThrough` (PSD2-redo), `maxBankTxAmount`, kravtrappe-dagar | 1→N till ~40 modeller (allt org-scopat)                                               | Hög        |
| **User**                 | Operatörskonto (hyresvärd/personal)                                                                                     | `email` (global unik), `passwordHash` (nullable för invite), `role` (UserRole), `loginAttempts`/`lockedUntil` (brute-force), `acceptedTermsAt`                                                            | N→1 Organization; 1→N journalEntries, documents, aiConversations, notifications m.fl. | Medel      |
| **PasswordResetToken**   | Engångstoken glömt-lösenord                                                                                             | `token` (unik), `expiresAt`, `usedAt`                                                                                                                                                                     | N→1 User (Cascade)                                                                    | Nej        |
| **UserInvitation**       | Engångstoken bjud-in-användare                                                                                          | `token`, `expiresAt`, `usedAt`                                                                                                                                                                            | N→1 User (Cascade)                                                                    | Nej        |
| **RefreshToken**         | JWT-refresh (SHA-256-hash)                                                                                              | `token` (unik), `expiresAt`, `revokedAt`                                                                                                                                                                  | N→1 User (Cascade)                                                                    | Nej        |
| **PlatformUser**         | Superadmin (Eveno-plattform), egen auth + TOTP                                                                          | `email`, `passwordHash`, `totpSecret`/`totpEnabled`                                                                                                                                                       | 1→N impersonationLogs, refreshTokens                                                  | Nej        |
| **PlatformRefreshToken** | Superadmins refresh                                                                                                     | `token`, `expiresAt`, `revokedAt`                                                                                                                                                                         | N→1 PlatformUser (Cascade)                                                            | Nej        |
| **PlatformInvoice**      | Plattformens fakturering MOT kunden (plan/credits)                                                                      | `invoiceNumber` (global unik), `amount`, `status`, `type`, `voidedAt`                                                                                                                                     | N→1 Organization (Restrict)                                                           | Nej        |
| **ImpersonationLog**     | Audit: superadmin loggar in som kund                                                                                    | `startedAt`/`endedAt`, `ipAddress`, `reason`                                                                                                                                                              | N→1 PlatformUser, Organization (Restrict), targetUser                                 | Nej        |
| **ErrorLog**             | Global fellogg                                                                                                          | `severity`, `source`, `message`, `stack`, `resolved`                                                                                                                                                      | N→1 Organization? (Restrict)                                                          | Nej        |

### B. Fastigheter (2 modeller)

| Modell       | Syfte                                 | Viktiga fält                                                                                                                      | Relationer                                                                                                  | AI-kontext |
| ------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------- |
| **Property** | Fastighet/byggnad (sammanslagen nivå) | `name`, `propertyDesignation`, `type`, adress, `totalArea`, `yearBuilt`, `consumptionBillingMode`, generiska kontraktsnoter       | N→1 Organization; **1→N Unit**, Document, MaintenanceTicket, Inspection, MaintenancePlan, NewsPost          | Hög        |
| **Unit**     | Lägenhet/lokal/p-plats/förråd         | `unitNumber` (unik per property), `type`, `status`, `area`, `floor`, `rooms`, `monthlyRent`, `voluntaryTaxLiability` (moms lokal) | N→1 Property; **1→N Lease**, Document, MaintenanceTicket, Inspection, KeyHandover, Meter, ContractImportRow | Hög        |

> **Ingen `Building`-modell.** Property→Unit är direkt; ingen byggnads-/uppgångs-/blocknivå finns trots att användarens egen domänbild förutsätter Building.

### C. Hyresgäster / motparter (2 modeller)

| Modell       | Syfte                                                 | Viktiga fält                                                                                                                                                                                        | Relationer                                                                                                                                                | AI-kontext |
| ------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Tenant**   | Hyresgäst med avtalsförhållande + portal              | `type`, `firstName/lastName/companyName/orgNumber`, `personalNumber` (**klartext**), `email` (unik per org), portal-auth (`passwordHash`, token-hashar), inbjudan-fält (`lastInviteMessageId` unik) | N→1 Organization; 1→N Lease, Invoice, RentNotice, Document, Inspection, Deposit, KeyHandover, ConsumptionCharge, TerminationRequest, AiTenantConversation | Hög        |
| **Customer** | Extern motpart (leverantör/mäklare) utan portal/avtal | `type`, namn/orgnr, `personalNumber`, `reference`, `isActive`                                                                                                                                       | N→1 Organization; 1→N Invoice                                                                                                                             | Medel      |

> **Tenant och Customer är nästan identiska fältmässigt** (parallella modeller, dubbellagring av personmodellen). Ingen delad `Party`/`Person`-bas.

### D. Avtal & uppsägning (3 modeller)

| Modell                 | Syfte                                      | Viktiga fält                                                                                                                                                                                                                                                                                      | Relationer                                                                                                                                     | AI-kontext |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Lease**              | Hyresavtal – domänens rikaste modell       | `status`, `leaseType`, `startDate/endDate`, `monthlyRent`, `monthlyRentExcludingVat`, `depositAmount`, `includes*` (9 booleska), tilläggshyror, `petsAllowed`, `sublettingAllowed`, indexklausul (`indexClauseType`, bas-år, tak/golv), `contractNumber` (unik per org), `consumptionBillingMode` | N→1 Unit, Tenant; 1→N Invoice, RentNotice, Document, Inspection, RentIncrease, TerminationRequest, KeyHandover, ConsumptionCharge; 1→1 Deposit | Hög        |
| **TerminationRequest** | Uppsägningsbegäran (hyresgäst→godkännande) | `requestedEndDate`, `reason`, `status`, `reviewedAt`                                                                                                                                                                                                                                              | N→1 Organization, Tenant, Lease (alla Cascade)                                                                                                 | Medel      |
| **RentIncrease**       | Hyreshöjning (KPI/förhandlad/marknad)      | `currentRent`, `newRent`, `increasePercent`, `noticeDate`, `effectiveDate`, `status`                                                                                                                                                                                                              | N→1 Organization (Restrict), Lease (Cascade)                                                                                                   | Medel      |

> Digital signering modelleras i **Document** (signaturmetadata + SHA-256 + versionskedja), inte på Lease. Ingen separat `Signature`-modell, ingen BankID-koppling.

### E. Ekonomi (15 modeller)

| Modell                     | Syfte                                              | Viktiga fält                                                                                                                                                                                                                | Relationer                                                                                                                                      | AI-kontext |
| -------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Invoice**                | Kommersiell faktura (hyra/deposit/service/utility) | `invoiceNumber` (unik per org), `type`, `status`, `total`, `dueDate`, `ocrNumber`, `trackingToken`, inkassofält                                                                                                             | N→1 Org (Restrict), Tenant?, Customer?, Lease?; 1→N InvoiceLine, InvoiceEvent, BankTransaction, PaymentReminder, ConsumptionCharge; 1→1 Deposit | Hög        |
| **InvoiceLine**            | Fakturarad                                         | `description`, `quantity`, `unitPrice`, `vatRate`, `total`                                                                                                                                                                  | N→1 Invoice (Cascade)                                                                                                                           | Medel      |
| **InvoiceEvent**           | Append-only fakturahistorik (21 typer)             | `type`, `actorType`, `payload` (Json), ingen `updatedAt`                                                                                                                                                                    | N→1 Invoice (Restrict)                                                                                                                          | Medel      |
| **PaymentReminder**        | Idempotent påminnelse-spärr                        | `type`, `feeAmount`, unik (invoiceId,type)                                                                                                                                                                                  | N→1 Invoice (Cascade)                                                                                                                           | Nej        |
| **RentNotice**             | Hyresavi (parallellt fakturasystem för hyra)       | `noticeNumber`/`ocrNumber`, `month/year`, `amount/vatAmount/totalAmount`, `consumptionAmount`, kravtrappa (`collectionStage`, `remindedAt`, `writtenOffAt`, `probableLossAt`), `reminderFeeAmount`, `interestAccruedAmount` | N→1 Org (Restrict), Tenant, Lease; 1→N RentNoticeLine, RentNoticeEvent, RentNoticePayment, BankTransaction                                      | Hög        |
| **RentNoticeLine**         | Avirad (hyra/el på samma avi)                      | `description`, `quantity`, `vatRate`, `total`, `consumptionChargeId` (unik)                                                                                                                                                 | N→1 RentNotice (Cascade); 1→1 ConsumptionCharge                                                                                                 | Medel      |
| **RentNoticeEvent**        | Append-only avi-/kravlogg                          | `type`, `actorType`, `payload`                                                                                                                                                                                              | N→1 RentNotice (Restrict)                                                                                                                       | Medel      |
| **RentNoticePayment**      | **Granulär betalningsallokering (sanningskälla)**  | `bankTransactionId` (unik, dubbel-allok-skydd), `amount`, `paidAt`, `source`                                                                                                                                                | N→1 RentNotice (Cascade); 1→1 BankTransaction (SetNull)                                                                                         | Hög        |
| **Account**                | BAS-konto (hierarkiskt)                            | `number`, `name`, `type`, `parentId`                                                                                                                                                                                        | N→1 Org (Restrict), self (hierarki); 1→N JournalEntryLine                                                                                       | Medel      |
| **JournalEntry**           | Verifikation (BFL 5:6)                             | `date`, `source`, `sourceId` (idempotens), `fiscalYear`, `series`, `verNumber`; unik (org,series,fiscalYear,verNumber) + (org,source,sourceId)                                                                              | N→1 Org (Restrict), User?; 1→N JournalEntryLine                                                                                                 | Hög        |
| **JournalEntryLine**       | Konteringsrad (debet/kredit)                       | `debit?`, `credit?`, `description?`                                                                                                                                                                                         | N→1 JournalEntry (Restrict), Account                                                                                                            | Medel      |
| **ClosedAccountingPeriod** | Periodlås                                          | `month`, `year`, `summary`; unik (org,year,month)                                                                                                                                                                           | N→1 Org (Restrict), User?                                                                                                                       | Nej        |
| **BankTransaction**        | Banktransaktion (avstämning)                       | `date`, `amount`, `rawOcr`, `status`, XOR-match `invoiceId`/`matchedRentNoticeId`                                                                                                                                           | N→1 Org (Restrict), Invoice?, RentNotice?; 1→1 RentNoticePayment                                                                                | Hög        |
| **BankStatementImport**    | AI-tolkat kontoutdrag (PDF)                        | `fileType`, `status`, AI-metadata, `originalParsedData`/`parsedData`/`confirmedData` (Json, BFL behandlingshistorik)                                                                                                        | N→1 Org (Restrict)                                                                                                                              | Medel      |
| **Deposit**                | Deposition (2890-flöde)                            | `amount`, `status`, `refundAmount`, `deductions` (Json); unik leaseId + invoiceId                                                                                                                                           | N→1 Org (Restrict), Tenant; 1→1 Lease (Cascade), Invoice?                                                                                       | Medel      |

### F. Förbrukning / IMD (4 modeller)

| Modell                | Syfte                            | Viktiga fält                                                                                                                            | Relationer                                                                                          | AI-kontext |
| --------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------- |
| **Meter**             | Fysisk mätare på enheten         | `type`, `unitOfMeasure`, `serialNumber`, `provider`/`externalId` (API-redo), `status`                                                   | N→1 Org (Restrict), Unit (Restrict); 1→N MeterReading                                               | Medel      |
| **MeterReading**      | Append-only avläsning (BFL 7 år) | `value`, `readingType` (CUMULATIVE/PERIOD_VOLUME), `periodStart/End`, `source`, `externalId` (idempotens); unik (meterId,externalId)    | N→1 Org (Restrict), Meter (Restrict); 1→N ConsumptionCharge. **`leaseId` = plain string, ingen FK** | Medel      |
| **ConsumptionTariff** | Prismodell med historik          | `scope` (ORG/PROPERTY/UNIT), `pricePerUnit`, `fixedMonthlyFee`, `validFrom/validTo`. **`propertyId`/`unitId` = plain string, ingen FK** | N→1 Org (Restrict)                                                                                  | Låg        |
| **ConsumptionCharge** | Debiterbar, moms-snapshotad post | `quantity`, `pricePerUnit`, `netAmount`, `vatStatus`, `kind`, `status`, `deliveryMode`, `invoiceId?`                                    | N→1 Org (Restrict), Lease (Restrict), Tenant, MeterReading (Restrict), Invoice?; 1→1 RentNoticeLine | Medel      |

### G. Underhåll & besiktning (6 modeller)

| Modell                 | Syfte                               | Viktiga fält                                                                                                                                                             | Relationer                                                                    | AI-kontext |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------- |
| **MaintenanceTicket**  | Felanmälan/ärende                   | `ticketNumber` (unik per org), `category`, `priority`, `status`, `estimatedCost`/`actualCost`, `tenantToken`. **`reportedById`/`assignedToId` = plain string, ingen FK** | N→1 Org, Property, Unit?, Tenant?; 1→N MaintenanceImage, MaintenanceComment   | Hög        |
| **MaintenanceImage**   | Ärendebild                          | `storageKey`, `storageUrl`, `size`                                                                                                                                       | N→1 Ticket (Cascade)                                                          | Nej        |
| **MaintenanceComment** | Ärendekommentar                     | `content`, `isInternal`                                                                                                                                                  | N→1 Ticket (Cascade). **`userId` = plain string, ingen FK**                   | Nej        |
| **MaintenancePlan**    | Långsiktig underhållsplan (5–10 år) | `category`, `status`, `plannedYear`, `estimatedCost`/`actualCost`, `interval`, `lastDoneYear`                                                                            | N→1 Org, Property                                                             | Hög        |
| **Inspection**         | Besiktning (in/ut/periodisk/skada)  | `type`, `status`, `scheduledDate`, signaturer. **`inspectedById` = plain string, ingen FK**                                                                              | N→1 Org, Property, Unit, Lease?, Tenant?; 1→N InspectionItem, InspectionImage | Medel      |
| **InspectionItem**     | Besiktningspunkt per rum            | `room`, `item`, `condition`, `repairCost`                                                                                                                                | N→1 Inspection (Cascade)                                                      | Medel      |
| **InspectionImage**    | Besiktningsbild                     | `storageKey`, `caption`, `room`                                                                                                                                          | N→1 Inspection (Cascade)                                                      | Nej        |

### H. Dokument, kommunikation, nycklar (6 modeller)

| Modell           | Syfte                                      | Viktiga fält                                                                                                           | Relationer                                                                                          | AI-kontext |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------- |
| **Document**     | Dokumentarkiv + signering + versionskedja  | `category`, `storageKey`, `contentHash`, signaturfält, `locked`, `previousVersionId`, `templateInputHash`, bilage-fält | N→1 Org, **polymorf**: Property?/Unit?/Lease?/Tenant?, User?, signedByTenant?; self (versionskedja) | Medel      |
| **Notification** | In-app-notis (13 typer inkl. AI-rapporter) | `type`, `title`, `message`, `link`, `read`                                                                             | N→1 Org, User                                                                                       | Låg        |
| **NewsPost**     | Nyhet till hyresgäster                     | `title`, `content`, `publishedAt`, `targetAll`, `propertyId?`                                                          | N→1 Org, Property?, User                                                                            | Låg        |
| **SentMessage**  | Massutskick-historik                       | `subject`, `content`, `recipientCount`, `successCount`, `status`                                                       | N→1 Org, Tenant?, User                                                                              | Låg        |
| **KeyHandover**  | Nyckelkvittens (append-only)               | `type`, `label`, `status`, `issuedAt`/`returnedAt`                                                                     | N→1 Org (Restrict), Lease (Cascade), Unit, Tenant                                                   | Medel      |
| **FailedEmail**  | DLQ för mejljobb                           | `template`, `to`, `payload`, `error`, `attempts`                                                                       | (fristående, ingen relation)                                                                        | Nej        |

### I. AI (8 modeller)

| Modell                   | Syfte                                                       | Viktiga fält                                                                                                            | Relationer                                    | AI-kontext |
| ------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------- |
| **AiConversation**       | Operatörens chattsession                                    | `title`, `summary` (sliding-window-cache), `summarizedUpToMessageId`                                                    | N→1 Org, User; 1→N AiMessage, AiPendingAction | Hög        |
| **AiMessage**            | Chattmeddelande                                             | `role`, `content`, `blocks` (Json, Anthropic ContentBlock[])                                                            | N→1 AiConversation (Cascade)                  | Hög        |
| **AiPendingAction**      | Server-lagrad bekräftelse-bindning (säkerhet)               | `toolName`, `toolInputHash` (SHA-256), `expiresAt` (5 min), `consumedAt`                                                | N→1 AiConversation (Cascade)                  | Medel      |
| **AiMemory**             | Per-användarminne                                           | `key`, `value`, `type` (preference/fact/relationship/convention); unik (org,user,key)                                   | N→1 Org, User                                 | Hög        |
| **AiUsageLog**           | Token-/kostnadsspårning                                     | `endpoint`, `model`, token-fält, `costSek`, `isAutomated`, `source`                                                     | N→1 Org (Restrict), User?, Tenant?            | Låg        |
| **AiToolExecution**      | Audit av verktygskörning (PII-maskad)                       | `toolName`, `toolInput`/`toolResult` (Json), `success`, `durationMs`, `requiredConfirmation`                            | N→1 Org (Restrict), User?, Tenant?            | Medel      |
| **AiTenantConversation** | Hyresgäst-AI-session (isolerad)                             | `pendingActionHash`, `pendingActionExpiresAt`                                                                           | N→1 Tenant (Cascade); 1→N AiTenantMessage     | Medel      |
| **AiTenantMessage**      | Hyresgäst-AI-meddelande                                     | `role`, `content`                                                                                                       | N→1 AiTenantConversation (Cascade)            | Medel      |
| **LegalChunkEmbedding**  | **Knowledge base / RAG** – Voyage-embedding per lagparagraf | `id` (`lawId:paragraph`), `sfs`, `contentHash`, `embedding` vector(1024), `model`. **GLOBAL, ej org-scopad, ingen PII** | (fristående, global)                          | Hög        |

### J. Sekvenser & referensdata (6 modeller)

| Modell                        | Syfte                                          | Nyckel                                       |
| ----------------------------- | ---------------------------------------------- | -------------------------------------------- |
| **ContractNumberSequence**    | Kontraktsnr per org+år                         | `@@id([organizationId, year])`               |
| **MaintenanceTicketSequence** | Ärendenr per org                               | `organizationId @id`                         |
| **JournalEntrySequence**      | Verifikationsnr per org+räkenskapsår+serie     | `@@id([organizationId, fiscalYear, series])` |
| **InvoiceNumberSequence**     | Fakturanr per org                              | `organizationId @id`                         |
| **CustomerNumberSequence**    | **Global** kundnr (K-100001)                   | `id @default("GLOBAL")`                      |
| **ReferenceInterestRate**     | Riksbankens referensränta (global, halvårsvis) | `effectiveFrom` unik                         |

### K. Import (2 modeller)

| Modell                                  | Syfte                                        | Relationer                                                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ImportJob**                           | CSV-import (properties/units/tenants/leases) | N→1 Org, User                                                                                                                                                                              |
| **ContractImportBatch**                 | Batch-kontraktsskanning (AI)                 | N→1 Org; 1→N ContractImportRow                                                                                                                                                             |
| **ContractImportRow**                   | Skannad kontraktsrad                         | `fileData` (Bytes, transient i DB!), `originalScanData`/`reviewedData`/`confirmedData` (Json), `matchStatus`, `createdLeaseId` (plain string). N→1 Batch (Cascade), matchedUnit? (SetNull) |
| **TenantMagicLink** / **TenantSession** | Hyresgästportalens magic-link-auth           | N→1 Tenant (Cascade)                                                                                                                                                                       |

---

## 3. Relationer (kardinalitetskarta)

**Centrala 1→N-kedjor:**

```
Organization 1──N User
Organization 1──N Property 1──N Unit 1──N Lease ──┬─ N──1 Tenant
                                                  ├─ 1──N Invoice / RentNotice
                                                  ├─ 1──1 Deposit
                                                  ├─ 1──N RentIncrease / TerminationRequest
                                                  ├─ 1──N KeyHandover
                                                  └─ 1──N ConsumptionCharge
Unit 1──N Meter 1──N MeterReading 1──N ConsumptionCharge
Invoice    1──N InvoiceLine / InvoiceEvent / PaymentReminder
RentNotice 1──N RentNoticeLine / RentNoticeEvent / RentNoticePayment
JournalEntry 1──N JournalEntryLine N──1 Account (self-hierarki)
```

**Viktiga 1→1:**

- `Lease 1──1 Deposit`
- `BankTransaction 1──1 RentNoticePayment` (dubbel-allokeringsskydd via unik `bankTransactionId`)
- `RentNoticeLine 1──1 ConsumptionCharge` (IMD-rad på avi)
- `Document ──self` (versionskedja `previousVersionId`)
- `Account ──self` (BAS-hierarki `parentId`)

**Polymorfa/flexibla kopplingar:**

- `Invoice` → Tenant? **eller** Customer? **eller** Lease? (alla nullable – flexibel mottagare)
- `Document` → Property?/Unit?/Lease?/Tenant? (alla nullable – kan hängas på vilken nivå som helst)
- `ConsumptionCharge` → RentNoticeLine **eller** Invoice (två leveranssätt)

**Inga riktiga many-to-many.** Schemat undviker implicita M:N-join-tabeller helt; alla relationer går via explicita FK eller 1→N. (En Lease har exakt en Tenant – ingen `LeaseTenant`-koppling för flera kontraktsinnehavare/medsökande.)

**Avsiktliga "plain string, ingen FK"-fält** (denormaliserade pekare, ej DB-integritetsskyddade):
`MeterReading.leaseId`, `ConsumptionTariff.propertyId/unitId`, `ContractImportRow.createdLeaseId`, `BankStatementImport.uploadedById/confirmedById`, `BankTransaction.matchedBy`, `MaintenanceTicket.reportedById/assignedToId`, `MaintenanceComment.userId`, `Inspection.inspectedById`.

---

## 4. Textbaserat ER-diagram

```
PLATTFORM (superadmin)
  PlatformUser ──N PlatformRefreshToken
  PlatformUser ──N ImpersonationLog ──→ Organization, User
  PlatformInvoice ──→ Organization
  CustomerNumberSequence (GLOBAL)      ReferenceInterestRate (GLOBAL)
  LegalChunkEmbedding (GLOBAL, RAG)    ErrorLog / FailedEmail

Organization (TENANT-ROT)
│
├── User ──┬── RefreshToken / PasswordResetToken / UserInvitation
│          ├── AiConversation ── AiMessage / AiPendingAction
│          └── (skapar) JournalEntry, Document, Notification, NewsPost, SentMessage
│
├── Property
│     ├── Unit
│     │     ├── Lease ──────────────────┐
│     │     │     ├── Invoice ── InvoiceLine / InvoiceEvent / PaymentReminder
│     │     │     ├── RentNotice ── RentNoticeLine / RentNoticeEvent / RentNoticePayment
│     │     │     ├── Deposit (1:1)
│     │     │     ├── RentIncrease / TerminationRequest
│     │     │     ├── KeyHandover
│     │     │     └── ConsumptionCharge
│     │     ├── Meter ── MeterReading ── ConsumptionCharge
│     │     ├── Inspection ── InspectionItem / InspectionImage
│     │     ├── MaintenanceTicket ── MaintenanceImage / MaintenanceComment
│     │     └── Document / KeyHandover
│     ├── MaintenancePlan
│     └── Document / NewsPost
│
├── Tenant ───────────────────────────┘ (N:1 från Lease; äger portal-auth,
│     ├── TenantMagicLink / TenantSession    Invoice, RentNotice, Document,
│     └── AiTenantConversation ── AiTenantMessage    Deposit, KeyHandover …)
│
├── Customer ── Invoice (extern motpart, ingen portal/avtal)
│
├── EKONOMI
│     ├── Account (BAS, self-hierarki) ── JournalEntryLine ── JournalEntry
│     ├── BankTransaction ──1:1── RentNoticePayment   (XOR → Invoice / RentNotice)
│     ├── BankStatementImport (AI-PDF)
│     └── ClosedAccountingPeriod
│     Sekvenser: InvoiceNumber / ContractNumber / JournalEntry / MaintenanceTicket
│
├── AI: AiMemory, AiUsageLog, AiToolExecution
└── IMD: ConsumptionTariff (scope ORG/PROPERTY/UNIT)
```

**Saknas i diagrammet (för att de inte finns):** `Building` (mellan Property och Unit), `Supplier/Vendor` + `WorkOrder` (under MaintenanceTicket), `Party/Person` (delad bas för Tenant/Customer), `Address` (egen normaliserad nod).

---

## 5. AI-bedömning

### Kan AI:n förstå hela fastighetsbeståndet med dagens datamodell?

**Ja, traverseringsgrafen är komplett.** Från `Organization` kan en agent nå varje fastighet, enhet, avtal, hyresgäst, faktura/avi, betalning, verifikation, mätare, ärende och dokument via riktiga FK. De viktigaste resonemangskedjorna finns:

- **"Vem bor var och betalar de?"** → Property→Unit→Lease→Tenant→RentNotice→RentNoticePayment ✅
- **"Vad är skulden?"** → RentNotice + RentNoticePayment (beräknat, inte cache) ✅
- **"Hur går det ekonomiskt?"** → JournalEntry→JournalEntryLine→Account ✅
- **"Vad behöver underhållas?"** → Property→MaintenancePlan + MaintenanceTicket ✅
- **"Vad säger lagen?"** → LegalChunkEmbedding (RAG, global) ✅

### Finns rätt kopplingar mellan fastighet/hyresgäst/avtal/ekonomi/dokument/historik?

Ja för de fem första. **Historik** är extra stark tack vare append-only-loggarna (`InvoiceEvent`, `RentNoticeEvent`, `AiToolExecution`, `MeterReading`, `KeyHandover`) – en agent kan rekonstruera _vad som hänt över tid_, inte bara nuläget. Det är ovanligt välbyggt.

### Vad gör det svårt för AI:n att resonera?

1. **Två parallella fakturasystem.** Hyra bokförs via `RentNotice`, kommersiellt via `Invoice`. För frågan "visa allt en hyresgäst är skyldig" måste agenten slå ihop båda + `RentNoticePayment`. Det är en konstant källa till ofullständiga svar om agenten bara tittar i ena tabellen.
2. **Två parallella motpartsmodeller.** En leverantör kan ligga i `Customer`, en hyresgäst i `Tenant`. "Lista alla vi gör affärer med" kräver union över två modeller med olika fält.
3. **Danglande aktörsfält.** `assignedToId`, `reportedById`, `inspectedById`, `matchedBy` är plain strings utan relation → agenten kan inte joina "vem ansvarar för detta ärende" till ett User-namn utan extra uppslag, och kan inte lita på att ID:t ens finns kvar.
4. **Ingen byggnadsnivå.** "Jämför energiförbrukning per byggnad" går inte att uttrycka – Property är både fastighet och byggnad.
5. **Underhåll är en ekonomisk återvändsgränd.** `MaintenanceTicket.actualCost` och `InspectionItem.repairCost` är frikopplade Decimal-fält – de leder inte till någon `Invoice`/`JournalEntry`/leverantör. Agenten kan inte resonera "vad kostade underhållet faktiskt och hur bokfördes det".

### Saknat för AI-agent som agerar fastighetschef

- **Tidsserie-/mätvärdesnod för KPI:er** (beläggning, vakansgrad, NOI över tid) – idag måste allt räknas om från grunden vid varje fråga.
- **Leverantörsregister + arbetsorder** för att kunna _agera_ på underhåll, inte bara läsa.
- **Relation MaintenanceTicket→Document/Invoice** för full ärende-till-betalning-spårning.

---

## 6. Risker

| #   | Risk                                                                                                                                                                                          | Typ         | Allvar    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------- |
| 1   | **Dubbellagring Tenant/Customer** – samma personmodell i två tabeller, divergerande fält, ingen delad bas                                                                                     | Modellering | Hög       |
| 2   | **Två fakturasystem (Invoice + RentNotice)** – parallell logik, AI/rapporter måste unionera, risk för inkonsekvens                                                                            | Modellering | Hög       |
| 3   | **Saknad Building-nivå** – Property=byggnad omöjliggör flerhusfastigheter, BRF-strukturer, per-hus-analys                                                                                     | Domänlucka  | Medel-Hög |
| 4   | **Ingen Supplier/WorkOrder-modell** – underhåll kan inte tilldelas entreprenör eller kopplas till kostnad/bokföring                                                                           | Domänlucka  | Hög       |
| 5   | **Danglande aktörsfält utan FK** (`assignedToId`, `reportedById`, `inspectedById`, `matchedBy`, `MaintenanceComment.userId`) – ingen referensintegritet, svårt för AI att joina               | Integritet  | Medel     |
| 6   | **PII i klartext** (`Tenant/Customer.personalNumber`) – ingen kryptering-at-rest                                                                                                              | GDPR        | Hög       |
| 7   | **Multi-tenant enbart applikationsenforced** – ingen Prisma-middleware/RLS tvingar `organizationId`; en glömd where-klausul = cross-tenant-läcka                                              | Isolering   | Hög       |
| 8   | **`fileData Bytes` i ContractImportRow** – råa PDF:er (med personnummer) lagras i Postgres; transient men sväller stora batchar och blandar BLOB med relationsdata                            | Skala/GDPR  | Medel     |
| 9   | **Ingen partitionerings-/arkiveringsstrategi** för högvolymtabeller (`AiUsageLog`, `MeterReading`, `RentNoticeEvent`, `InvoiceEvent`, `BankTransaction`) – obegränsad tillväxt mot 100k-skala | Skala       | Hög       |
| 10  | **Saknade kompositindex** för vanliga listmönster `(organizationId, status, createdAt)` på t.ex. `BankTransaction`, `Invoice` (finns för RentNotice collectionStage men inte överallt)        | Prestanda   | Medel     |
| 11  | **Ingen flerinnehavar-modell på Lease** – en Lease har exakt en Tenant; sambo/medsökande/juridisk + fysisk person på samma kontrakt går inte att uttrycka                                     | Domänlucka  | Medel     |
| 12  | **Underhållskostnad frikopplad från ekonomi** (`actualCost`/`repairCost` är lösa Decimal)                                                                                                     | Modellering | Medel     |
| 13  | **Partiella unika index lever bara i migrationer** (lease_unit_active, RentNoticeEvent-leverans) – osynliga i schemat, måste hållas i sync manuellt                                           | Underhåll   | Låg       |
| 14  | **Avsaknad av soft-delete generellt** – allt är antingen Cascade eller Restrict; ingen `deletedAt`-modell för GDPR-radering med revisionskrav i konflikt                                      | GDPR/skala  | Medel     |

---

## 7. Rekommendationer

> Ingen av dessa är genomförd – detta är en analysleverans, inte en implementationsplan.

**Strukturella (datamodell):**

1. **Inför `Building` mellan Property och Unit** (Property 1→N Building 1→N Unit). Lågkostnads-additivt; öppnar flerhus, BRF, per-hus-KPI. Gör Unit.buildingId nullable först för bakåtkompatibilitet.
2. **Extrahera en delad `Party`/`Person`-bas** (eller åtminstone en gemensam adress-/identitetsvy) så Tenant och Customer slutar divergera. Alternativt: en `role`-diskriminator på en enda part-modell.
3. **Lägg till `Supplier` + `WorkOrder`** under MaintenanceTicket, och koppla `WorkOrder→Invoice/JournalEntry`. Detta är förutsättningen för att AI ska kunna _agera_ fastighetschef på underhåll, inte bara rapportera.
4. **Konvertera danglande aktörsfält till riktiga FK** (`assignedToId`, `reportedById`, `inspectedById` → User-relation med SetNull). Förbättrar både integritet och AI-join.
5. **Överväg att ena `Invoice` och `RentNotice`** bakom en gemensam debiteringsabstraktion (eller minst en materialiserad vy/`Receivable`-modell som AI och rapporter läser) så "total skuld per hyresgäst" blir en query.

**Skala & säkerhet:** 6. **Central tenant-scoping** via Prisma-middleware/extension eller Postgres RLS – gör `organizationId` DB-enforced, inte utvecklarberoende. 7. **Kryptering-at-rest för `personalNumber`** (pgcrypto/kolumnkryptering) + en `deletedAt`-baserad anonymiseringsstrategi som respekterar BFL-retention. 8. **Partitionera/arkivera högvolymtabeller** (`AiUsageLog`, `MeterReading`, `*Event`, `BankTransaction`) per org eller tid inför 100k-skala; flytta `ContractImportRow.fileData` till R2. 9. **Komplettera kompositindex** `(organizationId, status, createdAt)` på de list-tunga tabellerna och dokumentera de partiella index som idag bara lever i migrationer.

**AI-möjliggörare:** 10. **Inför en KPI-/tidsserienod** (beläggning, vakans, NOI, förbrukning per period) så agenten kan resonera om _trender_ utan att räkna om allt; det är även grunden för prediktivt underhåll (MeterReading-trend + byggår + MaintenancePlan).

---

### Stödjer modellen framtidskraven?

| Krav                        | Stöd idag | Kommentar                                                                                                                       |
| --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 100 000 lägenheter          | ⚠️ Delvis | Grafen håller; kräver partition + arkiv + paginering + fler kompositindex                                                       |
| Flera fastighetsägare       | ✅        | Multi-tenant via `organizationId` genomgående                                                                                   |
| Enterprise-kunder           | ⚠️        | Saknar Building-nivå, leverantörsregister, RLS, central scoping                                                                 |
| AI-agent som fastighetschef | ⚠️        | Läser allt; saknar Supplier/WorkOrder + KPI-nod för att _agera_ fullt ut                                                        |
| Automatiserad ekonomi       | ✅        | BFL-korrekt, race-säkra serier, append-only, PSD2-redo fält                                                                     |
| Prediktivt underhåll        | ⚠️        | Råunderlag finns (MeterReading, MaintenancePlan, yearBuilt) men ingen tidsserie-/trendstruktur eller koppling underhåll→kostnad |

---

_Analysen är en ögonblicksbild av `schema.prisma` per 2026-06-16. Inga filer ändrades, ingen migration kördes._
