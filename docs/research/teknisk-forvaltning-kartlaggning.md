# Teknisk förvaltning — kartläggning & plan

> Kartläggning inför nytt område: TEKNISK FÖRVALTNING (ikapp-bygge mot Hogia).
> Status: endast läsning + analys av befintlig kod. Ingen kod byggd.
> Datum: 2026-06-24.

## 1. Vad finns redan? (verifierat mot koden)

Alla fyra områden har redan BÅDE backend-CRUD OCH frontend. Det som saknas är
uniformt det samma: kopplingen till bokföring/fakturering.

| Område                                  | Backend                                                                                                          | Frontend                                                                               | Bokförings-/fakturakoppling                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Felanmälan** (`maintenance`)          | Full CRUD, kommentarer, bilder (R2), notifieringar, stats, `UND-nnnnn`-nummerserie                               | `MaintenancePage` (lista + side panel) + portal-vy (hyresgäst kan anmäla + kommentera) | ❌ `estimatedCost`/`actualCost` är rena informationsfält — bokförs aldrig             |
| **Besiktning** (`inspections`)          | Full CRUD, AI-bildanalys (Claude Sonnet vision) med härdad kostnadsvalidering, brandat PDF-protokoll, IDOR-skydd | `InspectionsPage` (lista + side panel + AI-analys)                                     | ❌ `InspectionItem.repairCost` finns men kopplas inte till deposits/faktura/bokföring |
| **Underhållsplan** (`maintenance-plan`) | Full CRUD, årssammanfattning, status                                                                             | `MaintenancePlanPage`                                                                  | ❌ `estimatedCost`/`actualCost` bokförs aldrig                                        |
| **Nyckel** (`keys`)                     | Full livscykel (bulk-utlämning, återlämning, LOST/REPLACED), append-only kvittens                                | Endast `KeysSection` inbäddad i lease-detaljen — ingen egen sida/nav                   | ❌ Nyckelförlust → ingen ersättningsdebitering                                        |

**Helt saknat (grönfält):**

- Lagkravs-besiktningar (OVK/SBA/energideklaration/hiss) — `InspectionType` har bara `MOVE_IN/MOVE_OUT/PERIODIC/DAMAGE`. Ingen intervall-/påminnelselogik, inga lagtyper.
- Komponent-/utrustningsregister — ingen modell existerar.
- Åldersreducering — ingen logik, ingen reduktionstabell. `MOVE_OUT` skapar bara samma default-items som `MOVE_IN`.
- Tidrapportering — ingen modell, ingen modul.

## 2. Bokföringsmotorn — det återanvändbara mönstret

Kärnan är en privat atomär metod som allt går igenom:

```
AccountingService.createNumberedEntry({ organizationId, date, description,
  source, sourceId, lines[], idempotencyWhere, tx? })
```

`apps/api/src/accounting/accounting.service.ts:156`

- **Idempotens** hårdgjord på DB-nivå: `@@unique(organizationId, source, sourceId)` på `JournalEntry`. Samma affärshändelse bokförs exakt en gång → "self-heal" vid retry.
- **Gap-fritt verifikationsnummer** allokeras i samma transaktion (`VerifikationsnummerService.allocate`, serie "A").
- **Anropsmönster** (consumption som mall): `confirmCharge()` flippar status atomärt → anropar `accounting.createJournalEntryForConsumptionCharge(charge, orgId, userId)` → bokföringsfel loggas men fäller inte källoperationen.

**Konteringen för consumption (intäktsmönstret):**

```
1510 D (Kundfordran)             totalAmount
3920|3970 K (Förbrukningsintäkt)  netAmount
2611 K (Utgående moms 25%)        vatAmount   ← endast om TAXABLE_25
sourceId = "consumption-charge:<id>", date = periodEnd
```

⚠️ **Kritisk observation:** alla befintliga bokföringsmetoder är intäkter (1510 D) eller
betalningar (1930 D) eller kundförlust. Det finns INGEN leverantörs-/kostnadsbokföring
(4xxx/5xxx D mot 2440 leverantörsskuld eller 1930 K). Detta styr vägvalet i avsnitt 6.

## 3. Faktureringskedjan — kan en ny "charge" pluggas in?

Ja. `ConsumptionCharge` är referensmönstret och har två redan generiska insticksplatser:

1. **`attachRentNoticeLineCharges()`** (`consumption.service.ts:544`) → lägger charge som rad på hyresavin (`RentNoticeLine.consumptionChargeId`), samma OCR som hyran, 2-mån-lag.
2. **`invoiceSeparateCharges()`** (`consumption.service.ts:605`) → skapar separat `Invoice` (type=UTILITY).

Statusmaskinen `DRAFT → CONFIRMED (bokförs) → ATTACHED (avi/faktura)` är mall. En ny
intäkts-charge (skada debiterad hyresgäst, nyckelersättning) kan återanvända exakt detta.

## 4. Datamodell — var hör de hemma?

Alla fyra sitter redan korrekt i hierarkin `Org → Property → Unit → Lease → Tenant`:

- `MaintenanceTicket`: → Property (krav), Unit?/Tenant? (valfri)
- `Inspection`: → Property + Unit (krav), Lease?/Tenant? (valfri) + `InspectionItem` (har `repairCost Decimal?`)
- `KeyHandover`: → Lease + Unit + Tenant (krav, append-only kvittens)
- `MaintenancePlan`: → Property

Det enda som saknas på alla fyra: `invoiceId`/`chargeId`/`journalEntryId`. Det är där integrationen sätts in.

## 5. Frontend-mönster

Consumption-mönstret (per-subdomän `api/`+`hooks/`, disjunkta query-nycklar
`['x',filters]` vs `['x',id]`, en route med interna flikar, "Bekräfta och bokför"-knapp)
är väletablerat. Men maintenance/inspections/maintenance-plan byggdes tidigare med
side panel + gemensamt query-prefix — alltså redan kompletta UI:n, fast i ett äldre
mönster. Nya fakturerings-delar bör följa consumption-mönstret ("Debitera & bokför"),
men man behöver inte skriva om de befintliga sidorna.

## 6. Förslag — och det avgörande vägvalet

Avgörande insikt: "intäkt" och "kostnad" är två helt olika bokföringsriktningar.
Att debitera en hyresgäst (skada, nyckel) återanvänder det bevisade intäktsmönstret
(1510 D). Att bokföra en leverantörskostnad (hantverkaren) är en NY motor-riktning
som inte finns.

## 7. Låst plan (beslut 2026-06-24)

**Beslut:** (1) Felanmälan byggs som INTÄKT mot hyresgäst först. (2) Lagkravs-besiktningar
körs som oberoende parallellt spår.

### Spår A — Pengakopplingen (VIKTIGAST), sekventiellt

Bygger en generisk debiterbar post-ryggrad (intäkt mot hyresgäst) som senare områden ärver.

1. **Felanmälan → debitering av hyresgäst** _(först)_
2. **Avflyttningsbesiktning → åldersreducering → depositionsavdrag** — ärver charge-spine:ns _flöde/UI_ (DRAFT → bekräfta → bokför) men **bokför via deposits-modulen (2890 D / 3040 K), INTE via charge-spine:n** (annars dubbelkreditering av 3040 + svävande 1510-fordran — se specialist-granskningen 2026-06-24). Reduktionstabellen producerar ett `Deposit.deductions[]`-belopp, inte en charge. AI-skadeanalysen finns. Tillkommer reduktionstabell + `MOVE_OUT`-specifika items + `installedAt`/`materialCategory` på `InspectionItem`.
3. **Nyckel — egen sida + förlustdebitering** — liten; ärver spine. Snabb vinst.

> Leverantörs-/kostnadsbokföringen (hantverkaren) är medvetet uppskjuten — kräver nytt
> motorspår (4xxx/5xxx D mot 2440/1930, ev. leverantörsregister) och är inte "först".

### Spår B — Compliance/register (Hogia-paritet), oberoende parallellt

4. **Lagkravs-besiktningar (OVK/SBA/energideklaration/hiss) + komponent-/utrustningsregister + underhållshistorik** — rör inte bokföringen. Nya `InspectionType`-värden + intervall/påminnelselogik + ny `ComponentRegister`-modell.

### Sist

5. **Tidrapportering** — matar en debiterbar/kostnadspost; behöver spine (och ev. kostnadsspåret) först.

### Grov PR-uppdelning för felanmälan→debitering (Spår A, område 1)

- **PR 1 — datamodell:** `chargeId`/`invoiceId` på `MaintenanceTicket` + beslut Väg 1 vs Väg 2 (se nedan) + ev. BAS-konto (t.ex. 3950/3990 övr. intäkt).
- **PR 2 — bokföringsmetod:** `createJournalEntryForMiscCharge()` i `AccountingService` (intäktskontering, idempotent `sourceId="misc-charge:<id>"`), granskad av bokförings-experten.
- **PR 3 — debiterings-service:** "skapa debiterbar post från ärende" → `DRAFT`, `confirmCharge` (bokför), `attach` till hyresavi/separat faktura (återanvänd `attach…`/`invoiceSeparate…`).
- **PR 4 — frontend:** "Debitera hyresgäst & bokför"-knapp på ärendet (consumption-mönstret), amber-bokföringsnot, läser belopp aldrig om. _(Scope delad 2026-06-26: avi-/penga-integrationen utbruten till PR 4b.)_
- **PR 4b — MiscCharge på avi (penga-integration):** `miscChargeAmount`-fält + migration, `attachMiscChargesToRentNotice` (claim-mönster + `assertRentNoticeLineChargeXor`), trådas genom `rent-notice-total.util` + alla skuld-/ränte-/påminnelse-/reconciliation-läsare. `ATTACHED` + `invoiceId` sätts här. **Inkluderar `clearCharge`-flödet:** en CANCELLED `MiscCharge` rensar inte `MaintenanceTicket.chargeId` idag → ärendet kan inte om-debiteras. Rensningen hör ihop med attach/ATTACHED-livscykeln och byggs här (TODO-kommentar finns vid `cancelMiscCharge`). Granskas av bokförings-expert + bank-härdnings-rigor.
- **PR 5 — portal/PDF:** posten syns på hyresgästens avi/portal.

### Öppen designdetalj (avgörs när PR 1 startar)

Väg 1 (utöka `ConsumptionChargeKind` med `MAINTENANCE`/`DAMAGE`/`KEY` + gör `meterReadingId`
nullable) vs Väg 2 (ny `MiscCharge`-modell).

> **AVGJORT 2026-06-24: Väg 2 (ny `MiscCharge`-modell).** Enhälligt av specialist-granskningen
> (bokföring, code-reviewer, ai-architect, arkitektur). Se avsnittet
> "Specialist-granskning & arkitekturbeslut (2026-06-24)" nedan för motivering.

## Specialist-granskning & arkitekturbeslut (2026-06-24)

HUVUDBESLUT: Väg 2 — ny MiscCharge-modell. Enhälligt (bokföring, code-reviewer, ai-architect, arkitektur). Inga avvikande röster.
Motivering: ConsumptionCharge är ett prissatt mätresultat; meterReadingId är NOT NULL onDelete:Restrict (underlaget får ej försvinna) → nullable bryter invariant (BFL 5:6, verifikation mot null-underlag). Consumption väljer intäktskonto via meterType (3920/3970); skada/nyckel ska mot 3990/3040 → meterType=ELECTRICITY vore felkontering. exactOptionalPropertyTypes:true → enum-gren med halva fält "ej applicerbara". Migrationskostnaden är samma ändå (RentNoticeLine får ny FK oavsett) — Väg 1 sparar inget men förorenar källmodellen.

VIKTIGASTE FYNDET (ai-architect, HIGH): Planens rad 96 är FEL. Avflyttningsbesiktning får INTE bokföras via charge-spine (1510 D/3040 K) samtidigt som depositionsavdrag (2890 D/3040 K via createJournalEntryForDepositRefund) → 3040 krediteras dubbelt + svävande 1510-fordran. PLANÄNDRING: område 2 ärver flöde/UI från spine:n (DRAFT → bekräfta → bokför) men bokför via deposits-modulen. Reduktionstabell → Deposit.deductions[], INTE charge. Spine:n rörs ej för område 2.

PER AGENT — bokforings-expert: Väg 2. Konto 3990 (skada+nyckel) — 3950 finns EJ i BAS 2024, stryk; 3040 finns redan, 3990 läggs till i bas-chart.ts. Moms: skadeersättning=skadestånd→momsfri; nyckel=underordnat bostad→momsfri; lokal m. frivillig skattskyldighet=25% (manuell bedömning). MiscCharge bär vatStatus-snapshot; aldrig hårdkoda. Idempotens: sourceId="misc-charge:<id>" + @@unique(org,source,sourceId). Lägg MISC_CHARGE i JournalEntrySource (PR1).

PER AGENT — hyresjurist: Normalt slitage debiteras ALDRIG (JB 12:15), bara skada/onormalt slitage (JB 12:24). Reduktionskurva = ålder/livslängd × 100%; ≥livslängd → 0 kr. Schablontabell (plastmatta 15 år, parkett 50, vitvaror 12–15, tapet 10 …) i @eken/shared. FLAGGA: branschschabloner verifieras mot Fastighetsägarna/Hyresgästföreningen INNAN kodning. InspectionItem saknar installedAt + materialCategory → åldersreducering ej beräkningsbar/försvarbar i hyresnämnden (in i område 2:s PR1). Nyckelförlust: åldersavdrag även lås (15–20 år), inget auto-låsbyte, preskription 2 år (JB 12:61). Lagkrav: OVK (3/6 år), SBA (LSO), energideklaration (10 år), hiss (~2 år) → egen ComplianceInspection-modell. Avdrag skriftligt specificerade per post m. åldersavdrag; inflyttningsprotokoll krävs som bevis (saknas idag = juridiskt hål); portal-delgivning + 7–14 dagars invändningsfrist.

PER AGENT — security-auditor: HIGH befintlig: getMaintenanceTickets() (tenant-portal.service.ts:328) läcker estimatedCost/actualCost + hela property (organizationId, fireSafetyNotes) → åtgärda senast PR5. Kopiera consumption 1.6:s dubbla fältskydd (Prisma select allow-list + explicit mapper). MiscCharge: denormaliserat organizationId+leaseId+tenantId som egna kolumner, aldrig scope via JOIN. PR5 = högst risk; gate: allow-list + mapper + IDOR-test (granne A↔B) + DRAFT döljs + verifiera att estimatedCost/actualCost/journalEntryId ej i svaret. PR3: confirmCharge @Roles('MANAGER','ADMIN','OWNER') + P2002-hantering. GDPR: JournalEntry.description immutable → ingen PII, använd ärendenummer UND-xxxxx. Uppdatera exportTenantData() med MiscCharges.

PER AGENT — code-reviewer: Väg 2. PR-snittet sunt men saknar: @eken/shared-typer + Zod explicit (PR1), JournalEntrySource.MISC_CHARGE + RentNoticeLine.miscChargeId i PR1 (annars kompilerar ej PR2/3), momsbeslut dokumenterat i PR2 (vatStatus=EXEMPT v1 + TODO), annullerings-/reversal-flöde i PR3. Bokföringsdatum = completedAt/incidentDate (ej createdAt → fel räkenskapsår). Fällor: DTO import som value (ej import type), query-nyckel ['misc-charge', id], @OrgId() på alla endpoints, onDelete:Restrict på bokförda charges. Skjut upp kind=TIME_BILLING.

PER AGENT — ai-architect: Väg 2 + område 2-korrigeringen ovan. Extension-points i PR1 för att slippa refaktor i område 3: (1) RentNoticeLine.miscChargeId (app-invariant "exakt en FK satt"); (2) chargeId String? Restrict på källmodeller (MaintenanceTicket nu), ej polymorf FK uppåt — MiscCharge bär källa som metadata (sourceType/sourceRefId). Spår A/B oberoende, enda delade ytan InspectionType-enum (additivt). Kostnadsmotor uppskjuten = rätt; enda skuld tidrapportering → MVP = endast intäkts-vidarefakturering.

KONSOLIDERADE PLANÄNDRINGAR:

1. Lås Väg 2 definitivt ("Öppen designdetalj" → beslut).
2. Stryk 3950, använd 3990 (lägg till i bas-chart.ts; 3040 finns).
3. Rad 96: område 2 bokförs via deposits-modulen (2890/3040), ej charge-spine. Ärver flöde/UI, ej bokföringsmetod. Reduktionstabell → deductions[].
4. PR1 utökas: MiscCharge (organizationId/leaseId/tenantId/vatStatus), JournalEntrySource.MISC_CHARGE, RentNoticeLine.miscChargeId, chargeId på MaintenanceTicket, @eken/shared-typer + Zod.
5. PR2: momsbeslut explicit (vatStatus=EXEMPT v1 + TODO), bokföringsdatum=completedAt/incidentDate, PII-fri description.
6. PR3: @Roles(MANAGER+), P2002-idempotens, annullerings-/reversal-flöde.
7. PR5: portal allow-list + mapper, IDOR-test, exportTenantData() uppdateras, åtgärda getMaintenanceTickets()-läckaget.
8. Område 2: InspectionItem får installedAt + materialCategory; reduktionstabell i @eken/shared; inflyttningsprotokoll-koppling + portal-delgivning/invändningsfrist.
9. Spår B: egen ComplianceInspection-modell.
10. Tidrapportering: MVP endast intäkts-vidarefakturering; ingen TIME_BILLING i enum v1.

## Öppna reversal-/bokföringsfrågor (för beslut med bokförings-expert/revisor)

Samlade öppna frågor om motverifikat och kontering som inte gatar pågående PR:er men
ska avgöras tillsammans med revisorn innan de stängs.

- **ÖPPEN (cancelMiscCharge reversal-ordning, sedan PR 4c #155):** CONFIRMED-grenen kör
  `reverseJournalEntryForMiscCharge` FÖRE den villkorade statusflippen (`updateMany` count).
  Vid samtidigt attach (CONFIRMED→ATTACHED) kan ett motverifikat skapas för en post som
  förblir ATTACHED — motverifikat utan motsvarande annullering. Pre-existerande sedan PR 3,
  idempotent (ingen dubblett), inte akut. Möjlig fix: flytta reversal-anropet till EFTER den
  villkorade flippen, eller gör hela CONFIRMED-cancel till en enda gated transaktion där
  reversal bara körs om flippen lyckas. Beslut tillsammans med bokförings-expert/revisor.

- **ÖPPEN (dröjsmålsränta på MiscCharge, RL 6 §):** när en `MiscCharge` är ATTACHED på en avi
  (PR 4b) och ingår i den betalbara totalen — ska kumulativ dröjsmålsränta (referensränta + 8
  procentenheter, 6 § räntelagen) löpa även på misc-charge-delen vid utebliven betalning, eller
  endast på hyresdelen? Räntemotorn (`RentInterestService`) beräknar idag på avins skuld;
  konteringen mot 8131 är dokumenterad för hyresskuld i `docs/legal/46-inkasso-hyra-pamminnelse.md`.
  Beslut tillsammans med bokförings-expert/revisor.

## Öppna portal-fynd (ej denna klass)

Hyresgästportalens fält-läckor av select/omit-klassen stängdes i PR 5a (MaintenanceTicket/
Lease/Document/Image) + RentNotice-följd-PR:en (allow-list-select + mapper på getNotices/
getRentNotices/exportTenantData). Security-auditorns granskningar lyfte tre kvarvarande
punkter som INTE tillhör den stängda klassen — egna tickets, ingen gatar pågående arbete:

- **getInvoices / getDashboard.upcomingInvoice — Invoice defense-in-depth (INFO):**
  båda använder fortfarande `include: { unit: { include: { property: true } } }`. Ingen
  runtime-läcka idag eftersom `mapInvoice` (lager 2) strippar svaret till säkra fält — men
  lager 1 (DB-allow-list) saknas, så hela property-raden (`fireSafetyNotes`,
  `consumptionBillingMode`, `organizationId`) hämtas till minnet. Åtgärd: byt till explicit
  `select` med `SAFE_PORTAL_UNIT_SELECT` + `SAFE_PORTAL_PROPERTY_SELECT` (samma lager-1-mönster
  som RentNotice/getActiveLease). Egen ticket.

- **getMe — rå Tenant från `@CurrentTenant` (INFO):** endpointen returnerar `request.tenant`
  typad som `Tenant`, men runtime-objektet kommer från `validateSession` som redan använder
  `SAFE_PORTAL_TENANT_SELECT` (inga credentials/token-hashar). Runtime-säkert; TypeScript-typen
  är vilseledande för framtida devs. Pre-existerande sedan portal-auth-fixen. Egen ticket.

- **PortalLease typ-mismatch — EJ läcka (klargör):** `getLease`/`getActiveLease` returnerar
  `property` nästlad under `unit` (`lease.unit.property`), medan `PortalLease`-typen i
  `apps/portal` deklarerar `property` på toppnivå. Pre-existerande shape-mismatch, ingen
  säkerhetsläcka — klargör om typen ska rättas eller om frontenden läser `unit.property` trots
  typen. (Relaterat: `PortalRentNotice`-typen saknar `consumptionAmount`/`miscChargeAmount`/
  `payableTotal` som backend redan returnerar — risk att portalen visar fel betalbelopp.)
