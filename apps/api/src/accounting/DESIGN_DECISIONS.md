# Bokföring – designbeslut

Levande dokument för redovisningsmodulens icke-uppenbara designval. Granskas av
auktoriserad redovisningskonsult (bokforings-expert) vid varje ändring.

---

## FIX 9 · PR 4 — Gap-free, race-säker verifikationsnummer (LAGBROTT 6)

**Lagrum:** BFL 1999:1078 5 kap 6 § (verifikationsnummer i obruten följd),
5 kap 7 § (verifikationens innehåll), 4 kap 2 § (god redovisningssed),
ML 11 kap 8 § (fakturanummer i fortlöpande serie).

### Beslut

1. **Verifikationsnummer på JournalEntry.** `JournalEntry` saknade tidigare
   nummer helt (endast UUID), vilket bröt BFL 5 kap 6 §. Nya fält:
   `fiscalYear` (räkenskapsår), `series` (default `"A"`), `verNumber`
   (löpnummer 1..N). Unikt per `(organizationId, series, fiscalYear, verNumber)`.

2. **En enda serie "A" för alla poster i denna PR.** Automatverifikat har serie
   `A` enligt SIE4-konventionen (SIE Gruppen 4B). Alla poster — fakturering,
   betalning, hyresavi, manuella AI-poster, påminnelseavgift — använder serie
   `A`. Detta ger EN obruten nummerserie per (org, räkenskapsår), vilket är den
   enklaste och mest revisor-vänliga modellen. `"M"` är reserverad för framtida
   manuella justeringsserier (kräver då separat sekvensrad).

3. **Gap-free via allokering inuti transaktionen.** `JournalEntrySequence`
   (PK `(org, fiscalYear, series)`) räknas upp atomiskt med en UPSERT-increment
   inuti SAMMA `$transaction` som posten skapas. Postgres row-lock serialiserar
   samtidiga allokeringar; en rollback återställer även increment:en → serien
   blir obruten. Empiriskt verifierat: 50 samtidiga allokeringar gav exakt 1..50,
   noll dubbletter, noll hål.

4. **Räkenskapsår = kalenderår som default, men brutet räkenskapsår stöds.**
   `Organization.fiscalYearStartMonth Int @default(1)` (1 = januari = kalenderår,
   tvingande för enskild firma/HB enligt BFL 3 kap 1 §). AB med brutet
   räkenskapsår (t.ex. maj–april, startmånad 5) hanteras av
   `VerifikationsnummerService.fiscalYearFor()`: en post före startmånaden hör
   till föregående kalenderårs räkenskapsår. Räkenskapsåret härleds ur postens
   `date` (affärshändelsens datum, BFL 5 kap 7 §), inte ur skapelsedatum.
   **Begränsning:** det finns ännu inget UI för att sätta `fiscalYearStartMonth`
   — fältet defaultar till 1. Brutet räkenskapsår kräver i nuläget en manuell
   DB-ändring tills inställnings-UI byggs.

5. **Idempotens hårdgjord på DB-nivå.** Unikt index på
   `(organizationId, source, sourceId)`. Postgres behandlar NULL som distinkt, så
   manuella poster (`sourceId = NULL`) tillåts i flera exemplar medan automatiska
   poster (faktura, betalning, avi, reversal, påminnelseavgift) bara kan bokföras
   en gång. Idempotenskontrollen körs dessutom inuti transaktionen
   (TOCTOU-säkert).

6. **Stängd-period-spärr.** `VerifikationsnummerService.allocate()` vägrar
   tilldela nummer om postens datum ligger i en `ClosedAccountingPeriod`
   (ConflictException) — ett stängt räkenskapsår får inte öppnas implicit av en
   efterhandsbokförd post.

7. **Fakturanummer via `InvoiceNumberSequence` (global per org).** Ersätter
   `count()+1` (race- och gap-känsligt) med atomär UPSERT-increment inuti
   faktura-transaktionen. Numret nollställs INTE per år — `F-{år}-{nr}` har
   kosmetiskt år men global obruten sekvens. Detta är medvetet: OCR-numret
   härleds ur sekvensen och måste vara unikt över alla år. Backfill satte
   `lastNumber = COUNT(*)` per org så att nästa nummer fortsätter sömlöst.

8. **SIE4-export använder verkligt verifikationsnummer.** `#VER "A" {verNumber}`
   i stället för tidigare `#VER "AI" {arrayindex+1}` (flyktigt, icke-deterministiskt).
   Exporten hämtar nu ALLA verifikationer i perioden kronologiskt — den gamla
   `getJournalEntries(take:100)` fick aldrig användas för SIE (ofullständig
   räkenskapsinformation).

9. **Konteringsrader oraderbara.** `JournalEntryLine.onDelete` ändrad
   `Cascade → Restrict` — konteringsrader är räkenskapsinformation (BFL 1 kap 2 §
   p.9) och får inte raderas. Append-only: rättelse sker via motverifikat.

### Backfill

Befintliga poster fick retroaktiva verifikationsnummer via
`ROW_NUMBER() OVER (PARTITION BY org, fiscalYear, series ORDER BY date, createdAt, id)`.
Godkänd som retroaktiv tilldelning enligt BFL 5 kap 7 § — systemet saknade
verifikationsnummer före denna migration, så det finns inga lagstadgade nummer
att korrigera mot. Verifierat gap-free per (org, räkenskapsår).

### Öppna följdpunkter (ej i PR 4)

- **UI för `fiscalYearStartMonth`** så att AB-kunder kan välja brutet
  räkenskapsår utan DB-åtgärd.
- **`#RAR`-raden i SIE** bör spegla faktiskt räkenskapsår (start/slut) när
  brutet räkenskapsår stöds fullt ut.
- **Separat serie för manuella justeringsposter** (`"M"`) om revisor vill skilja
  dem från automatverifikat.
- **Backfill av prod-orgens saknade verifikationer** (2 fakturor + 52 hyresavier
  som skapades innan kontoplan fanns) — separat åtgärd.
- **Integrationstest för samtidig allokering.** Gap-free-egenskapen är verifierad
  empiriskt (50 samtidiga allokeringar → 1..50, noll dubbletter/hål) men har inget
  committat test. Enhetstesterna mockar `$transaction` och kan inte fånga
  Postgres-serialisering. CI kör i nuläget inte jest (endast Lint + Typecheck +
  Vercel), så ett DB-beroende test ger ingen CI-signal och skulle bryta lokala
  jest-körningar utan test-DB. Lägg till ett gated integrationstest när en
  test-DB finns i CI.

---

## FIX 9 · PR 5 — Soft-delete av fakturor (LAGBROTT 1)

**Lagrum:** BFL 1999:1078 7 kap 2 § (räkenskapsinformation bevaras 7 år),
5 kap 11 § (behandlingshistorik), 4 kap 2 § (god redovisningssed), ML 11 kap 8 §.

### Beslut

1. **Hård radering ersatt med makulering (VOID).** `InvoicesService.remove()`
   raderade tidigare ett DRAFT-utkast OCH dess append-only `InvoiceEvent`-logg
   hårt (kringgick `onDelete: Restrict`). Nu makuleras utkastet i stället
   (DRAFT → VOID) via `transitionStatus()` — fakturan och hela händelseloggen
   bevaras, och en `VOIDED`-händelse loggas med aktör + `reason: 'draft_voided'`.
   Controllern skickar nu `@CurrentUser().sub` som aktör (BFL 5 kap 7 §).

2. **Varför VOID och inte radering, även för ett aldrig-skickat utkast?** Ett rent
   utkast är i sig knappast räkenskapsinformation (ingen affärshändelse ännu), men
   det har redan **förbrukat ett fakturanummer** ur `InvoiceNumberSequence` (PR 4).
   En hård radering lämnar då ett **oförklarat hål** i den gap-free serien
   `F-{år}-{nr}`. Makulering bevarar fakturan som VOID så att hålet är spårbart
   och förklarat (behandlingshistorik, BFL 5 kap 11 §). Fakturanumret återanvänds
   aldrig. Inget ML-brott uppstår (numret utfärdades aldrig externt).

3. **VOID är terminal.** `INVOICE_TRANSITIONS` har `VOID: []`, och `update()`
   blockerar icke-DRAFT — en makulerad faktura kan inte ändras eller återupplivas.

4. **Plattformsfakturor.** `PlatformInvoicesService.remove()` makulerar nu
   (status VOID) i stället för `delete()`. Nya fält `voidedAt`/`voidedReason` ger
   behandlingshistorik (BFL 5 kap 11 §); den befintliga `voidInvoice()` sätter
   dem också. Liten migration (nullable, ingen backfill).

5. **UI.** Makulerade fakturor döljs i "Alla"-vyn men visas i en egen flik
   "Makulerade" — ett makulerat utkast känns "borttaget" men förblir granskbart,
   vilket krävs för att en revisor ska kunna förklara hål i nummerserien.

### Öppna följdpunkter (ej i PR 5)

- **`invoice.update()` på VOID-fakturor** i reconciliation/collections/
  payment-reminder kontrollerar inte status — en makulerad faktura bör inte kunna
  få nya påminnelser/inkassoflagg. Separat ärende (metadata, ej bokföring).
- **`PlatformInvoiceEvent`-logg** (fullständig audit-tabell) i stället för enbart
  `voidedAt`/`voidedReason`.
- **Hårdkodad `VAT_RATE = 25`** i platform-invoices.service.ts bör flyttas till
  `@eken/shared`.

---

## FIX 9 · PR 6 — Sluten intäktscykel: betalningsbokföring vid markAsPaid

**Lagrum:** BFL 1999:1078 5 kap 6 § (verifikation per affärshändelse),
5 kap 1 § (rättvisande bild av ställning/resultat), 4 kap 2 § (god redovisningssed),
5 kap 7 § (aktör/identifieringstecken). BAS 2024.

### Problemet

PR 2 bokförde hyresfordran vid avisering (`1510 D / 39xx K`), men `markAsPaid`
satte bara status PAID utan motpost. Kundfordran 1510 växte därför obegränsat och
manuella betalningar (kontant/Swish) saknades helt i bokföringen — intäktscykelns
andra halva fattades.

### Beslut

1. **Ny bokföringsmetod `createJournalEntryForRentNoticeManualPayment`** bokför
   `likvidkonto D / 1510 K` med **faktiskt inbetalt belopp** (`paidAmount`, ej
   totalen — delbetalning reglerar fordran delvis). Idempotent via
   `sourceId = "rent-notice-payment:<id>"`, dateras betalningsdatumet. Egen metod
   (inte återanvänd `createJournalEntryForRentNoticePayment`) eftersom den senare
   är knuten till en `BankTransaction` (sourceId = transaktion.id) vid
   bankavstämning — skild idempotensnyckel och ingen banktransaktion här.

2. **Likvidkonto per betalningssätt:** BANK/MANUAL → 1930, CASH → 1910,
   **SWISH → 1930**. Swish bokförs mot företagskontot (medlen landar där inom
   sekunder) i stället för ett eget 1934 — ett separat Swish-konto blir ett
   "fantasikonto" som aldrig kan stämmas av mot ett kontoutdrag (granskat av
   auktoriserad redovisningskonsult). Att betalningen var Swish spåras via
   `RentNotice.paymentMethod` (ny enum `PaymentMethod`) + verifikatets radtext.
   Endast 1910 (Kassa) saknades i kontoplanen och backfillas + seedas.

3. **Atomisk, race-säker statusövergång FÖRE bokföring.** `markAsPaid` tar avin
   obetald → PAID med `updateMany` + status-guard (`PENDING/SENT/OVERDUE/FAILED`) —
   samma mönster som bankavstämningens `applyMatchToRentNotice`. Därmed utesluter
   en manuell markering och en parallell bankavstämning av samma avi varandra
   (claim.count === 0 → 409) och kan **aldrig skapa två betalningsverifikat mot
   1510** (BFL 5 kap 1 §).

4. **Invarianten "ingen PAID-avi utan verifikat".** Misslyckas bokföringen — vare
   sig den kastar ELLER returnerar `null` (saknat likvidkonto för en RENT-avi) —
   **ångras statusövergången** och felet propageras, så avin kan regleras på nytt
   när orsaken är åtgärdad (BFL 5 kap 6 §). `DEPOSIT`-avier returnerar `null`
   avsiktligt (deposits-modulen äger 1510/2890-flödet) och behåller PAID.

5. **`@Min(0.01)` på `paidAmount`** — en nollbetalning är ingen affärshändelse.

6. **Aktör loggas** (`@CurrentUser().sub` → `createdById` på verifikatet, BFL 5 kap 7 §).

### Öppna följdpunkter (ej i PR 6)

- **Reversering av manuellt betalningsverifikat.** `reverseJournalEntryForPayment`
  söker på `sourceId = transactionId` och hittar inte manuella verifikat
  (`sourceId = "rent-notice-payment:<id>"`). Att ångra en manuell betalning ger
  i nuläget inget motverifikat — separat ärende.
- **`MANUAL` bokförs mot 1930.** En kontantbetalning som av misstag registreras
  som MANUAL hamnar på 1930 i stället för 1910 (kassa). Överväg att ta bort MANUAL
  eller varna i UI.
- **`RentNotice`/`PaymentMethod`-typer dupliceras** i `apps/web/.../avisering.api.ts`
  i stället för `@eken/shared` (gäller hela avisering-featuren) — tech-debt.
- **Invariantkontroll:** schemalagd avstämning som larmar om 1510-saldo per avi
  avviker från summan av tillhörande verifikat.

---

## Inkasso · PR 1 — kontoplan + referensränta + kravtrappa + förfalloövervakning

**Lagrum (hänvisning, fastställt av jurist/bokföringsexpert — se
`docs/legal/46`):** lag (1981:739) om ersättning för inkassokostnader
(påminnelseavgift), räntelagen (1975:635) 6 § + 9 § (dröjsmålsränta =
referensränta + 8 pp, halvårsvis fastställd referensränta), BFL (1999:1078)
(räkenskapsinformation + append-only spår).

**Avgränsning:** Eveno bygger skuld-sidan fram till "inkasso-ready" och inte
längre. Förverkande/uppsägning/avhysning byggs aldrig.

### Två invarianter som hela serien gjuts kring

- **INV‑A — ingen avgift/ränta utan verifikat.** En påminnelseavgift (PR 2)
  eller dröjsmålsränta (PR 3) markeras som uttagen i SAMMA transaktion som sitt
  verifikat skapas. PR 1 inför inget av detta — men lägger kontona som
  posteringen kräver.
- **INV‑B — inget ärende blir inkasso-ready utan komplett dokumentation.**
  Övergången till `INKASSO_READY` (PR 4) grindas på fullständig dokumentation.
  PR 1 inför `RentNoticeEvent` (append-only) som är dokumentationsstommen.

### Beslut (PR 1)

1. **Tre nya konton, seedade + backfillade, men oposterade.** `6352`
   (Konstaterade förluster på kundfordringar, EXPENSE), `8131` (Dröjsmålsränta,
   kundfordringar, REVENUE) och `8313` (Ränteintäkter från kundfordringar,
   REVENUE) läggs i `bas-chart.ts` och backfillas idempotent för alla 138 orgs
   med seedad kontoplan (samma mönster som FIX 9 PR 1). Gamla konton raderas
   aldrig (BFL 7 kap 2 §). PR 1 bokför ingenting.

2. **8131 vs 8313 lämnas öppen för revisor.** Fastställd regel säger 8131 för
   dröjsmålsränta; BAS standardkonto är 8313. Båda seedas — vilket PR 3 posterar
   mot bekräftas av revisor (`docs/legal/46`, fråga 2). Ofarligt i PR 1.

3. **Referensräntan är data, aldrig kod.** Ny plattformsglobal tabell
   `ReferenceInterestRate` (nationell ränta, INGEN org-scoping, ingen
   tenant-data). En rad seedas (gäller fr.o.m. 2026-01-01) med **preliminärt**
   värde och en `source` som flaggar att det ska verifieras mot Riksbankens
   publicering INNAN PR 3 läser tabellen. Ingen kod läser den i PR 1.

4. **Kravtrappan är skild från betalnings-statusen.** `RentNotice.collectionStage`
   (`NONE → REMINDED → INKASSO_READY → WRITTEN_OFF`, default `NONE`) lever vid
   sidan av `status` (`…/OVERDUE/PAID/…`). En avi kan alltså bli PAID mitt i
   trappan utan att spåret tappas. Tidsstämplar (`remindedAt`,
   `collectionReadyAt`, `writtenOffAt`) är additiva och nullbara; respektive PR
   sätter sin. PR 1 skriver ingen — befintlig avi-generering är opåverkad.

5. **Förfalloövervakning är penganeutral och tenant-säker.**
   `markOverdueRentNotices` (daglig cron) speglar `markOverdueInvoices`: bulk
   `updateMany` flippar SENT + förfallen → OVERDUE. Endast SENT eskaleras (en
   avi som aldrig nått hyresgästen startar ingen kravtrappa). Bulk-updaten är
   tenant-säker — varje rad flippas enbart på sin egen `dueDate`, ingen orgs
   data läses eller korsas. `collectionStage` rörs inte här.

### Öppna följdpunkter (ej i PR 1)

- **Momsåterkrav vid kundförlust på lokalhyra** — öppen revisorfråga
  (`docs/legal/46`, fråga 1). Avgör konteringen i PR 5; spikas inte i kod förrän
  besvarad.
- **OVERDUE som händelse i loggen.** PR 1:s bulk-cron skriver ingen
  `RentNoticeEvent` (kan inte per rad i en `updateMany`). PR 2 loggar
  kravhändelserna när trappan aktiveras.
- **Verifiera gällande referensränta** mot Riksbankens publicering innan PR 3.
- **RentNoticeEvent-queries måste org-verifieras (PR 2).** Loggen scopas via
  `rentNotice.organizationId` (ingen egen kolumn, som InvoiceEvent). Varje
  läsväg i PR 2–5 MÅSTE först verifiera ägarskap på avin
  (`rentNotice.findFirst({ where: { id, organizationId } })`) innan events
  returneras — annars cross-tenant-läsrisk via ett läckt `rentNoticeId`
  (security-auditor, LOW). Skriv ett isolationstest (org A ↛ org B:s logg).

---

## Inkasso · PR 2 — hyrespåminnelse (dag 7, momsfri avgift bokförd 1510/3593)

**Lagrum:** lag (1981:739) om ersättning för inkassokostnader (påminnelseavgift,
momsfri); BFL 1999:1078 (verifikat + append-only spår).

### Beslut

1. **Delad bokföringskärna.** `AccountingService.bookReminderFee` (via
   `createNumberedEntry`) bokför 1510 D / 3593 K och används av BÅDE
   faktura-flödet (`PaymentReminderService`) och hyresavi-flödet
   (`RentReminderService`). Momsfri: slår bara upp 1510/3593, rör aldrig 26xx.

2. **INV-A atomisk på hyresvägen.** `escalateNoticeToReminded` kör claim
   (NONE→REMINDED + `reminderFeeAmount`) + `bookReminderFee(tx)` +
   `RentNoticeEvent` i SAMMA `$transaction`. Bokföring misslyckas → throw →
   hela transaktionen rullas tillbaka. Idempotent via race-säker `updateMany`-
   claim + `source=RENT_NOTICE, sourceId=reminder-fee:{id}`.

3. **Avgiften ingår i betalbar total.** `RentNotice.reminderFeeAmount` (default 0)
   adderas i `rentNoticePayableTotal` + samtliga FEM payable-beräkningar i
   bankavstämningen (OCR, referens, fuzzy, manuell, kandidatfilter) — så
   1510-fordran och avins OCR-belopp är konsistenta (bokföringsexpert HIGH,
   åtgärdad: fuzzy + manuell saknade avgiften initialt).

4. **PDF-formkrav.** Påminnelse-PDF visar fordringsägarens namn + adress (lag
   1981:739 5 §) och bankgiro endast om det finns (aldrig `0000-0000`)
   (hyresjurist HIGH + MEDIUM, åtgärdade).

### Öppna följdpunkter (backlog, ej i PR 2)

- **Faktura-flödets svagare INV-A.** `PaymentReminderService.sendFormalReminder`
  lägger fakturarad + total i en transaktion men anropar `bookReminderFee`
  EFTER den (utanför) → om bokföringen fallerar finns avgiftsraden kvar utan
  verifikat. Hyresvägen är atomisk; faktura-vägen bör hårdnas likadant
  (bokföringsexpert LOW). **Städnings-PR.**
- **Lagra påminnelse-PDF.** PDF:en genereras, bifogas mejlet och kastas. Lägg
  `RentNotice.reminderPdfStorageKey` + ladda upp till `StorageService` så
  dokumentkopian kan rekonstrueras inför inkassoöverlämning (hyresjurist LOW).
  **Inför PR 4.**

---

## Inkasso · PR 3 — dröjsmålsränta (referensränta + 8 pp, bokförd 1510/8131)

**Lagrum:** räntelagen (1975:635) 3 § (ränta från förfallodagen), 6 §
(referensränta + 8 pp), 9 § (referensräntan fastställd halvårsvis); BFL.

### Beslut

1. **Ränta bokförs 1510 D / 8131 K — ALDRIG 3593.** Dröjsmålsränta är en
   FINANSIELL intäkt (8131), inte en rörelseintäkt/påminnelseavgift (3593).
   `AccountingService.bookInterest` speglar `bookReminderFee` men krediterar 8131.

2. **Referensräntan är data, +8 är lagkonstant.** Räntan läses dynamiskt ur
   `ReferenceInterestRate` (raden vars `effectiveFrom ≤ förfallodagen`); +8 pp är
   en hårdkodad lagkonstant (6 §). Saknas referensränta → ingen gissad ränta.

3. **Bas = kapital (hyra + förbrukning).** Aldrig ränta på påminnelseavgiften
   (3593) eller på upplupen ränta (ingen ränta-på-ränta). Från dagen EFTER
   förfallodagen (konservativt, hyresgästens fördel). 365-dagarsbas.

4. **INV-A + inkrementell delta.** Räntemarkering (`interestAccruedAmount/Through`)
   - verifikat i samma `$transaction`; bokföring failar → allt rullas tillbaka.
     `crystallizeInterest` bokför delta mot redan bokförd ränta, idempotent per
     punkt via `sourceId=interest:{id}:{YYYY-MM-DD}`. Kristalliseras vid påminnelse
     (PR 3); PR 4 lägger till inkasso-ready-punkten.

5. **Räntan ingår INTE i `rentNoticePayableTotal`/OCR.** Till skillnad från
   påminnelseavgiften: dröjsmålsräntan löper kontinuerligt och är en separat
   fordran som regleras vid slutuppgörelse. 1510-saldot för en REMINDED-avi
   överstiger därför avi-totalen med räntedelen — avsiktligt.

### Öppna följdpunkter (backlog, ej i PR 3)

- **Period-uppdelad ränta vid halvårsskifte — HÅRD PREREQUISITE FÖR PR 4, INTE
  VALFRI.** PR 4 (inkasso-ready + export) får INTE aktivera räntekravets export
  förrän detta är implementerat. Idag ankras EN referensränta (förfallodagens) på
  hela dröjsmålsperioden. Strikt räntelagen 6 § ("den vid varje tid gällande
  referensräntan", 9 §) kräver respektive halvårs ränta per delperiod. Ett
  specificerat räntekrav som exporteras till inkassobolag/domstol med fel ränta
  kan angripas och försvaga hela fordran. Åtgärd: segmentera `[dueDate,
throughDate]` vid halvårsgränserna, beräkna delbelopp per segment med segmentets
  referensränta, summera. Konvergerande MEDIUM från BÅDE bokföringsexpert och
  hyresjurist; dokumenterat i koden (`rent-interest.service.ts`,
  `referenceRatePercentFor`-anropet).
- **Resultaträknings-bucket för 8131 (pre-existing).** `getProfitLossReport`
  buntar 8000–8399 i en bucket med kostnadstecken → 8131 (finansiell intäkt)
  presenteras under fel rubrik (totalresultatet blir ändå rätt). Dela 8000–8199
  (intäkt) / 8200–8399 (kostnad) (bokföringsexpert MEDIUM). **Separat ärende.**
- **Reglering av 1510-ränterest.** När en hyresgäst betalar kapital + avgift men
  inte räntan blir avin PAID medan räntedelen ligger kvar på 1510. Ett
  standardflöde för att reglera/skriva av ränteresten behövs (PR 4/5).
- **Larm vid saknad referensränta.** Saknas innevarande halvårs rad uteblir
  räntan tyst (loggas bara). Överväg avisering till OWNER (operativ rutin att
  mata in ny rad i juni/december).

---

## Inkasso · PR 4a — period-uppdelad dröjsmålsränta vid halvårsskifte

**Lagrum:** räntelagen (1975:635) 3 § (ränta från förfallodagen), 6 § ("den vid
varje tid gällande referensräntan" + 8 pp), 9 § (referensräntan fastställd
halvårsvis); BFL 1999:1078 (append-only, verifikat).

**Karaktär:** Ren beräkningskorrigering, penganeutral bakom befintligt flöde.
Ingen schemaändring, ingen ny endpoint, ingen ny status, ingen export. Detta är
den HÅRDA PREREQUISITEN (se PR 3:s öppna punkt ovan) som måste landa och
verifieras innan PR 4b får exportera räntekravet.

### Beslut

1. **Dröjsmålet segmenteras vid kalenderhalvårens gränser (1 jan / 1 jul).**
   `crystallizeInterest` ankrar inte längre EN referensränta (förfallodagens) på
   hela perioden. `[förfallodag+1, förfallodag+dagar]` delas i delperioder som var
   och en ligger helt inom ETT halvår; varje segment slås upp mot SITT halvårs
   referensränta (raden vars `effectiveFrom ≤ segmentets start`) + 8 pp, prorateras
   på 365 dagar. Räntelagen 6 §/9 § kräver respektive halvårs ränta per delperiod —
   ett enda ankare över en gräns är fel lag, inte en approximation.

2. **Dagräkning förankrad i förfallodagen, inte i throughDate.** Antalet
   dröjsmålsdagar (`daysBetween(dueDate, throughDate)`) är oförändrat. Segmenten
   byggs på kalenderdatum från `utcMidnight(dueDate)+1` t.o.m. `+dagar` → segmentens
   dagar summerar ALLTID exakt till totalen, oberoende av throughDates klockslag.

3. **En enda avrundning på rå summa.** `totalInterest = round2(Σ rå segmentränta)`.
   För ett dröjsmål inom ETT halvår (ett segment) är detta IDENTISKT med PR 3 → en
   oförändrad referensränta ger ingen spuriös delta. Beloppet ändras bara när en
   halvårsränta faktiskt skiljer sig över gränsen — exakt den lagstadgade skillnaden.

4. **Öresrest läggs på sista segmentet.** Varje `segment.amount` är öresavrundat,
   men restjusteringen på sista segmentet gör att `Σ segment.amount === totalInterest`
   EXAKT. Därmed kan PR 4b:s specificerade räntekalkyl summera segmenten utan att
   hamna 1 öre fel mot det bokförda beloppet/1510-fordran (konvergerande MEDIUM från
   bokföringsexpert + hyresjurist — åtgärdad i PR 4a i stället för att skjutas till
   PR 4b).

5. **INV-A oförändrad + append-only.** Markering (`interestAccruedAmount/Through`)
   och verifikat (1510 D / 8131 K) i SAMMA transaktion; bokföring null → kasta →
   rollback. Endast FRAMÅT-deltat bokförs (`round2(total − redan bokfört)`) — historik
   ombokas aldrig. En påminnelseränta bokförd under PR 3:s enkel-ankare står kvar;
   korrigeringen fångas framåt vid nästa kristalliseringspunkt (inkasso-ready, PR 4b).

6. **Saknad referensränta för NÅGOT segment → `null`, ingen gissad ränta.** Samma
   konservativa hållning som PR 3, men nu per segment: kan en delperiods ränta inte
   beräknas uteblir HELA kravet (ett delvis/gissat räntekrav är angripbart i sin
   helhet). Loggas som varning med delperiodens datum.

7. **Segment-uppdelningen lagras i `INTEREST_ACCRUED`-payloaden** (`segments[]`: per
   halvår `from/to/days/referenceRatePercent/effectiveRatePercent/amount`) så PR 4b:s
   export kan specificera räntan per halvår. De skalära `effectiveRatePercent`/
   `referenceRatePercent` i payload/retur är dagviktade genomsnitt — behållna för
   bakåtkompat, men `segments[]` är den auktoritativa specifikationen.

### Öppna följdpunkter (ej i PR 4a — hör till PR 4b)

- **Exporten ska specificera per halvår via `segments[]`** — aldrig redovisa det
  dagviktade genomsnitts-procenttalet i ett specificerat krav (räntelagen 9 § kräver
  respektive halvårs ränta). `totalInterest` är den auktoritativa totalen
  (hyresjurist + bokföringsexpert LOW/MEDIUM, hör till PR 4b).
- **`crystallizeInterest` förutsätter bestämd förfallodag** (räntelagen 3 §). Vid
  privatuthyrning utan bestämd förfallodag gäller 4 § (30-dagarsregeln). Eveno-avier
  har alltid `dueDate`, men invarianten bör dokumenteras i PR 4b:s grindlogik
  (hyresjurist LOW).
- **Larm vid saknad referensränta** kvarstår från PR 3 (operativ rutin juni/december).

---

## Inkasso · PR 4b₀ — leveransverifiering + lagrad påminnelse-PDF (INV-B-infrastruktur)

**Karaktär:** Ren infrastruktur som GÖR INV-B uppfyllbar i PR 4b. Penganeutral:
ingen statusövergång, ingen export, ingen bokföring. Stänger två gap mot
"verifierad dokumentation" inför inkasso-ready.

### Beslut

1. **Påminnelse-PDF lagras (PR 2-backlog).** `RentNotice.reminderPdfStorageKey` +
   uppladdning i `processReminderSendJob` till R2 org-scopat
   (`reminders/{orgId}/{noticeId}.pdf`, samma tenant-isolation som `documents/`).
   **Best-effort:** ett R2-fel loggas men kastas INTE — den lagstadgade påminnelsen
   (lag 1981:739) skickas oavsett; PR 4b:s grind vägrar i stället inkasso-ready om
   nyckeln saknas. Idempotent (samma nyckel skrivs över vid Bull-retry före lyckat
   utskick).

2. **Leveransverifiering för hyresavi-påminnelser.** `RentNotice.reminderMessageId`
   (@unique) sätts efter lyckad Resend-send och är `ResendWebhookService`:s
   korrelationsnyckel mot rätt avi — exakt mönstret som `Tenant.lastInviteMessageId`
   för portalinbjudan. Webhooken skriver leveransutfallet APPEND-ONLY till
   `RentNoticeEvent` (`EMAIL_DELIVERED`/`EMAIL_BOUNCED`). Org-säkert: @unique →
   exakt en avi som bär sin egen `organizationId`; ingen org-uppgift läses ur
   payloaden (ingen cross-tenant-skrivning). Webhookmodulen hålls självständig
   (direkt prisma-skrivning, ingen tung AviseringModule-import).

### Säkerhetsgranskning (security-auditor) — alla fynd åtgärdade i PR:en

- **[MEDIUM] Idempotens DB-enforce:ad.** Check-then-act-racet (Resend at-least-once)
  täcks nu av ett PARTIELLT unikt index `(rentNoticeId, type) WHERE type IN
('EMAIL_DELIVERED','EMAIL_BOUNCED')` (migration, ej uttryckbart i Prisma-schemat).
  Ett brett `@@unique([rentNoticeId, type])` gick INTE att använda — det hade brutit
  repeterbara typer (`INTEREST_ACCRUED` skapas vid både påminnelse och inkasso-ready,
  `REMINDER_SENT`, `NOTE_ADDED`). Webhooken fångar `P2002` som idempotent no-op.
- **[MEDIUM] Interna fält döljs för klienten.** `reminderPdfStorageKey`/
  `reminderMessageId` (R2-path + message-id, ej presigned URL) utelämnas i
  klient-läsvägarna (`avisering.findMany/findOne`, `tenant-portal.getNotices`) via
  Prisma `omit` (krävde preview-flaggan `omitApi` på 5.22).
- **[LOW] PII-minimering i bounce.** Hyresavi-eventet lagrar STRUKTURERAD bounce-
  kategori (`bounceType`/`bounceSubType`), aldrig Resends fria `bounce.message` som
  kan innehålla mottagarens e-post (GDPR lagringsminimering; append-only-loggen kan
  inte rensas). Invite-flödets fritext (`inviteBounceReason`) är oförändrad — samma
  systemiska mönster i `InvoiceEvent.payload` kvarstår som separat GDPR-ärende.

### Öppna följdpunkter (ej i PR 4b₀)

- **INV-B-grinden (PR 4b)** läser denna infrastruktur: avi-PDF + lagrad påminnelse-
  PDF + `EMAIL_DELIVERED`-event + utskicks-/betalningslogg + kompletta partsdata.
- **GDPR-strategi för `*Event.payload`-PII** (pseudonymisering vid radering, både
  RentNoticeEvent och InvoiceEvent) — separat systemärende (security-auditor LOW).
- **Webhook rate-limit/IP-allowlist** för Resend-callbacken — separat ärende.

## Inkasso · PR 4b — inkasso-ready-grind (INV-B) + slutkristallisering + read-only export

**Karaktär:** Steg 2 (kravtrappans sista övergång REMINDED→INKASSO_READY, med en
slutlig räntekristallisering) + steg 3 (read-only export-paket till externt
inkassobolag). Bygger på 4b₀:s infrastruktur.

### Steg 2 — INKASSO_READY-grind + slutkristallisering

1. **INV-B-grind före flippen (`checkInkassoReadiness`).** Övergången VÄGRAS
   (`ConflictException`, ingen flip) om något i underlaget saknas: avin utskickad
   (`sentAt`), lagrad påminnelse-PDF (4b₀), verifierad leverans (`EMAIL_DELIVERED`,
   ej `EMAIL_BOUNCED`), utskickslogg (`SENT`), komplett gäldenär (person-/orgnr +
   adress) OCH fordringsägare (orgnr + adress), samt utestående OCR-reglerbar skuld.
   Den saknade delen loggas append-only (`NOTE_ADDED`, `action: inkasso-ready-blocked`)
   innan undantaget. Cronen (`escalateRemindedToInkassoReady`, kl 11:00) räknar en
   grind-blockad avi som `blocked` (warn), inte fel — den omprövas nästa dygn.
2. **Race-säker claim.** `updateMany` på (OVERDUE, stage=REMINDED) speglar
   `escalateNoticeToReminded`; `claim.count === 0` ⇒ `flipped:false`. Redan
   INKASSO_READY/WRITTEN_OFF ⇒ idempotent no-op (ingen omgrindning, ingen ombokning).

3. **Slutkristallisering i SEPARAT transaktion — medvetet val (bokföringsexpert HIGH).**
   `crystallizeInterest(noticeId, orgId, now)` körs FÖRE flipp-transaktionen, i sin
   EGNA transaktion. Den är INV-A-säker internt (ränta + verifikat 1510/8131 atomiskt,
   idempotent delta via `sourceId='interest:{id}:{YYYY-MM-DD}'`, kastar vid saknat
   konto ⇒ ingen flip utan bokförd slutränta). Att nästla den i flipp-transaktionen
   är inte möjligt — `crystallizeInterest` öppnar själv `prisma.$transaction` och
   Postgres saknar nästlade interaktiva transaktioner. **Konsekvens:** misslyckas
   flipp-transaktionen EFTER en lyckad kristallisering är ränteverifikatet committat
   men avin kvar i REMINDED i upp till ett dygn. Detta är **inte** ett BFL-brott:
   verifikatet är spårbart via sourceId till avinumret, nästa cron hittar delta=0
   (ingen dubbelbokföring) och konvergerar avin till INKASSO_READY. En revisor som
   avstämmer 1510 inom fönstret kan se ett ränteöverskott som inte ännu speglas i
   avistatus — accepterat och dokumenterat här.

### Steg 3 — read-only export (INV-C)

4. **`RentCollectionExportService` speglar `CollectionExportService` men är
   RentNotice-baserad** (egen data, egna CSV-kolumner, egen PDF-mall). Återanvänder
   INTE den faktura-baserade tjänsten. Nya pdf-kinds `rent-collections-export` /
   `rent-collections-bulk-export` i `PdfQueue`/`PdfWorker`.
5. **INV-C: penganeutral.** Exporten skapar INGEN `JournalEntry`, ingen
   statusövergång, ingen kontering — bara PDF+CSV (single) / ZIP (bulk, med den
   lagrade påminnelse-PDF:en bifogad per avi) och en append-only `NOTE_ADDED`-notering.
   Räntan i underlaget tas från avins bokförda `interestAccruedAmount` (auktoritativ
   total) med per-halvår-segmenten ur senaste `INTEREST_ACCRUED`-event — aldrig ett
   dagviktat snitt. `total_skuld = kapital + påminnelseavgift + dröjsmålsränta`.
6. **Tenant-isolation.** Varje läsväg (`loadNotice`) verifierar `organizationId` i
   `findFirst` INNAN avins egen logg/relationer läses; storage-nycklar org-scopade
   (`rent-collections/{orgId}/…`).

### Granskningsfynd åtgärdade i PR:en

- **[hyresjurist BLOCKING] PDF-disclaimern** anger nu att inkassobolaget ansvarar för
  att utfärda formellt inkassokrav (inkassolagen 1974:182 5 §), skiljer 1981:739 från
  1974:182, och anger att Eveno saknar inkassotillstånd.
- **[security MEDIUM] HTML-injection** i `partyAddress` (gäldenäradress) escapas nu i
  inkasso-PDF:en.
- **[security MEDIUM] CSV formula-injection** neutraliseras i `csvCell` (inledande
  `=+-@`/tab/CR prefixas med apostrof) — filen öppnas externt i Excel.
- **[security LOW]** `reminderPdfStorageKey` utelämnas ur COLLECTION_READY-payloaden
  (en boolean `reminderPdfStored` räcker; nyckeln exponeras annars via events-endpoint).
- **[security LOW] `@ArrayMaxSize(200)`** på bulk-exportens `noticeIds`.

### Öppna följdpunkter (ej i PR 4b)

- **Manuell godkännandebarriär / cooling-off** före auto-flip (hyresjurist HIGH) —
  produktbeslut; PR 4b följer den specade cron-drivna auto-flippen (speglar REMINDED).
- **`actorId` på export-noteringen** (i dag SYSTEM i workern, ingen användarkontext) —
  spårbarhet vid PII-export; paritet med faktura-flödet (hyresjurist HIGH).
- **HTML-escaping i `buildReminderPdfHtml` + faktura-`collection-export`** (systemiskt,
  pre-existing) — separat städ-PR (security MEDIUM).
- **`EMAIL_DELIVERED` ↔ `reminderMessageId`-korrelation** i grinden (i dag säkert: bara
  webhooken skriver eventet) — hårdare koppling (hyresjurist MEDIUM).

## Inkasso · PR 5 — kundförlust (befarad 1515 → konstaterad 6352)

**Karaktär:** Serien sista PR. Sluter skuld-sidans bokföringscykel: en obetald,
inkasso-redo MOMSFRI hyresfordran skrivs ned i två steg. Inga konton tillkommer —
1515 (osäkra kundfordringar) seedades i baskontoplanen, 6352 (konstaterade
förluster) lades in i PR 1 ("posteras först i PR 5"). Endast ett nullbart
markörfält (`RentNotice.probableLossAt`) + migration.

### Bokföring (RentBadDebtService + AccountingService.bookBadDebt\*)

1. **BEFARAD kundförlust — `1515 D / 1510 K`.** Omklassning av en osäker fordran
   från kundfordringar till osäkra kundfordringar. Ren balansräkningsåtgärd, INGEN
   resultatpåverkan. Triggas av cron `reclassifyProbableLosses` (kl 12:00) för
   inkasso-redo momsfria avier, eller manuellt via `POST /avisering/:id/bad-debt/probable`.
   Markeras med `probableLossAt`.
2. **KONSTATERAD kundförlust — `6352 D / 1515 K`.** Den osäkra fordran skrivs av som
   konstaterad förlust (6352, kostnadskonto). RESULTATPÅVERKAN. Endast manuell
   (`POST /avisering/:id/bad-debt/confirm`) — en mänsklig bedömning att fordran är
   förlorad, ALDRIG cron. Kräver att avin först befarats (fordran ligger på 1515);
   avskrivningsbeloppet läses ur befarad-verifikatets debetrad så 1515 nettar till
   noll. Flippar kravsteget till `WRITTEN_OFF`.
3. **INV-A.** Markeringen/flippen och verifikatet skapas i SAMMA transaktion
   (`tx` skickas till bookBadDebt\*). Faller bokföringen (saknat 1510/1515 resp.
   1515/6352) kastas felet → allt rullas tillbaka. Race-säker via updateMany-claim
   (`probableLossAt null` resp. `writtenOffAt null`) + idempotent verifikat-sourceId
   (`bad-debt-probable:{id}` / `bad-debt-writeoff:{id}`).

### KRITISK JURIDISK AVGRÄNSNING — endast momsfri bostadshyra (docs/legal/46 fråga 1)

Momsåterkravet vid kundförlust på LOKALHYRA (momspliktig under frivillig
skattskyldighet, ML 9 kap) är en ÖPPEN revisorfråga: när en momspliktig fordran
blir konstaterad kundförlust ska tidigare redovisad utgående moms (2611) normalt
minskas/återkrävas — men mot vilket underlag/vilken period är inte bekräftat.

Därför hanterar PR 5 ENDAST MOMSFRI fordran (`vatAmount = 0`, bostadshyra m.fl.):
där finns ingen moms att korrigera, så `1515 → 6352` är komplett och säkert.
Momspliktiga avier (`vatAmount > 0`) **VÄGRAS** (`ConflictException` "kräver manuell
hantering") i båda stegen, och cronen räknar dem som `manual` + loggar. **Ingen egen
moms-återkravslogik skrivs på AI:ns gissning** — momsdelen spikas i kod först när
revisorn svarat. Detta är ett medvetet, dokumenterat val (jurist/revisorgräns).

Ingen kod för förverkande/avhysning (samma gräns som hela serien). Kundförlust är
bokföring av en förlorad fordran, inte en hyresgästprocess.

### Bokföringsgranskning (FAR) — fynd hanterade i PR:en

- **[MEDIUM] confirmLoss-claimen** låser nu på det semantiska villkoret
  `probableLossAt != null && writtenOffAt == null` (befarad men ej avskriven) i
  stället för `collectionStage = INKASSO_READY` — robustare mot framtida övergångar.
- **[HIGH] Momsgrinden skärpt.** `assertMomsfri` vägrar nu även momspliktig
  FÖRBRUKNING (en `RentNoticeLine.vatRate > 0`), inte bara momspliktig hyra
  (`vatAmount > 0`) — en momsfri-hyra-men-momspliktig-förbrukning-avi bär utgående
  moms (2611) och faller under samma öppna revisorfråga.
- **[LOW]** Befarad-beloppets invariant (verifikatet har exakt en debetrad = 1515)
  dokumenterad vid avläsningen i confirmLoss.

### Öppna följdpunkter (ej i PR 5)

- **[bokföring BLOCKING-bedömning] Ledger-rekonciliering av 1510 per avi.**
  Befarad-beloppet kommer från den KANONISKA fältsumman (`outstanding()` = samma som
  rentNoticePayableTotal + ränta), inte ur huvudboken — förbruknings-verifikat
  (charge-id) och bankbetalningar (transaktions-id) är inte avi-scopade i sourceId
  och går inte att summera per avi utan join. Fältsumman är den mest kompletta
  per-avi-siffran och förutsätter en komplett verifikatkedja (gäller en
  INKASSO_READY-avi). Ett uppströms INV-A-fel som lämnat ett fält satt utan 1510-
  debet är en systemisk integritetsfråga, inte införd av PR 5; en full
  ledger-rekonciliering (charge-/betalnings-attribuering) är noterad följdpunkt.
- **Lokalhyrans momsåterkrav (2611-reduktion)** vid konstaterad kundförlust —
  byggs när revisorfråga 1 (docs/legal/46) besvarats.
- **Återvunnen kundförlust** (en avskriven fordran betalas ändå) — återföring
  6352/1515 eller intäkt på 3950; inte aktuellt förrän det inträffar i praktiken.
- **P&L-rapportens bucket för 8131** (dröjsmålsränteintäkt i kostnadsbucket
  8000–8399) — pre-existing rapportfel, separat ärende (utanför PR 5).

---

## Bankavstämnings-härdning — granulär betalningsallokering (PR 1, INV-S)

**Mål:** en sanningskälla för "hur mycket är betalt på en avi". Idag bär `RentNotice`
bara en samlad `paidAmount`-cache + ett `@unique matchedRentNoticeId` på
`BankTransaction`. Det räcker inte för att resonera om delbetalning, timing-glapp
eller "zombie"-matchningar (se reconciliation/inkasso-riskanalysen). PR 1 inför
modellen `RentNoticePayment` (en rad per faktisk betalning) som den auktoritativa
betalt-summan; `paidAmount` + `matchedRentNoticeId` blir **härledda speglar**.
D/A/B i serien bygger ovanpå denna grund.

**Penganeutralt kontrakt (ABSOLUT).** PR 1 rör ALDRIG huvudboken: noll nya/ändrade
verifikat (`JournalEntry`), noll statusövergångar, noll utskick, ingen ändrad
matchningslogik (±1 kr/OCR/fuzzy oförändrat). `RentNoticePayment` är härledd
betalningsdata (BFL: stöd-/sidoordnad information), inte ett verifikat — verifikaten
skapas/återförs precis som förr av `AccountingService`. `RentDebtService.outstanding()`
är en ren läsare; **ingen produktionsväg anropar den än** (vaktas statiskt av
`rent-debt-money-neutrality.spec.ts`, kategori D).

**Invariant:** `Σ RentNoticePayment.amount == RentNotice.paidAmount` per avi. Backfillen
(migration `20260607020000`) är förlustfri + idempotent och har en **inbyggd
`DO $$`-verifikation** som `RAISE EXCEPTION` vid avvikelse → en korrupt backfill
bryter deployn i stället för att nå produktion tyst.

**Dubbel-allokeringsskydd:** `@unique` lyftes från `BankTransaction.matchedRentNoticeId`
och flyttades till `RentNoticePayment.bankTransactionId @unique` (en bank-transaktion →
exakt en avi; NULL = manuell betalning, flera tillåts via Postgres NULL-distinkthet).
Den gamla race-garantin "en avi claimas en gång" bärs fortsatt av den status-guardade
`updateMany`:en (`claim.count`) i `applyMatchToRentNotice`/`markAsPaid`.

### Bok- + säkerhetsgranskning — fynd hanterade i PR:en

- **[sec MEDIUM] Explicit `onDelete: SetNull`** på `RentNoticePayment.bankTransaction`-
  relationen (matchar migrationens `ON DELETE SET NULL` och Prisma-default för en
  nullbar relation — noll drift). Hygien mot framtida schema-drift.

### Öppna följdpunkter (ej i PR 1)

- **[ATOMICITETS-HÄRDNING — egen följd-PR, prioriterad]** Fuzzy-grenen i
  `matchTransaction` och `markAsPaid` wrappar inte sina skrivvägar
  (claim → bank-länk → allokering → verifikat) i en `$transaction`. Vid en
  process-krasch mitt i sekvensen kan `paidAmount` sättas utan att allokeringen/
  bank-länken skrivs → invarianten `Σ alloc == paidAmount` bryts tillfälligt.
  Detta är en **FÖRBEFINTLIG egenskap** av matchnings-/markAsPaid-vägarna —
  `paidAmount` och `matchedRentNoticeId` lever redan i exakt samma icke-atomiska
  sekvens; PR 1:s allokering speglar den riskprofilen, den inför den inte. Att
  wrappa vägarna ändrar **felväg-beteendet för förbefintlig icke-allokeringskod**
  (partiell commit → full rollback) och är därför en **beteendeändring som faller
  utanför penganeutraliteten** — den hör hemma i en egen atomicitets-härdnings-PR.
  `markAsPaid`-fixen kräver att `createJournalEntryForRentNoticeManualPayment` tar
  emot en `TransactionClient` (samma mönster som `unmatchTransaction` redan har via
  `reverseJournalEntryForPayment`, Issue #33). Mönstret för OCR-grenen
  (`applyMatchToRentNotice`) är att **callern** äger transaktionen — den kan inte
  wrappa internt eftersom `db` kan vara en redan öppen tx-klient (nästlad tx kastar).
- **[sec LOW] `findUnique` utan `organizationId`** i `applyMatchToRentNotice`/
  `applyMatchToInvoice` — förbefintligt, alla callers org-verifierar före anrop.
  Defensiv härdning (byt till `findFirst` + org-scope) noteras, ej införd av PR 1.
- **Eskaleringsgrind:** D/A väljer EXPLICIT grind när `outstanding()` kopplas in
  (t.ex. kapital+förbrukning vs. inkl. avgift+ränta). Grund-PR:n låser ingen policy;
  den uppdaterande PR:n ska samtidigt uppdatera kategori-D-vakthunden.

### Bankavstämnings-härdning PR 2 — exporten grindar på FAKTISK skuld (INV-D)

**Mål:** stäng "zombie"-läckan. Tidigare grindade inkasso-exporten på
`collectionStage = INKASSO_READY` (en VY), inte på faktisk skuld. En betald avi som
låg kvar INKASSO_READY kunde därför exporteras som ett inkassokrav fast hyresgästen
inte var skyldig något — ett ogrundat krav (inkassolagen 1974:182, god inkassosed).

**INV-D:** inget inkasso-artefakt (redo-markering, export-PDF/CSV/ZIP) får produceras
för en avi vars FAKTISKA skuld är 0 vid beslutsögonblicket. `collectionStage` är en
vy, aldrig sanning om skuld. Implementeras av en gemensam grind `exportBlockReason`
(används av `exportForNotice`, `exportBulk` OCH `listReady` → UI och export är alltid
överens). Grinden körs vid exportögonblicket (PdfWorker), efter org-verifierad
`loadNotice`. Krav: status ej PAID/CANCELLED · `collectionStage = INKASSO_READY` ·
`RentDebtService.outstanding().outstanding > 0` · ingen `RentNoticePayment` med
`createdAt > collectionReadyAt`. Penganeutral (ren läsning, inget verifikat).

**Hängslen-och-livrem:** `collectionStage` nollställs till NONE ATOMISKT (samma
status-guardade updateMany, idempotent) när en avi blir PAID på alla tre betalvägar
(`markAsPaid` + reconciliation OCR/fuzzy) OCH när den avbryts (`cancelNotice`). En
append-only `NOTE_ADDED`-trail (`action: collection-stage-reset`) dokumenterar bytet.

**Medvetet val — total-residual INKL. ränta som exportgrind.** Grinden släpper igenom
så länge `outstanding > 0`, dvs. även när bara dröjsmålsränta återstår (kapitalet
betalt). Motiv: inkassobolaget driver HELA fordran inkl. ränta (räntelagen). Detta är
ett EXPLICIT A/D-val; grund-PR 1 låste ingen policy. **Juristnotering (följdpunkt):**
för bostadshyresgäster (konsument) kan ett inkassokrav på enbart en ränterest vara
oproportionerligt (god inkassosed, IMY-praxis) — överväg ett konfigurerbart
minimibelopp för export. Ej infört i PR 2 (policy-/produktbeslut).

### Granskning PR 2 — fynd hanterade i PR:en

- **[sec + jurist MEDIUM] `cancelNotice`** nollställer nu `collectionStage = NONE` och
  org-scopar uppdateringen (`updateMany` med `organizationId` + PAID-guard i WHERE i
  stället för `update` på enbart `id`). Samma anti-zombie-princip som PAID-vägarna.
- **[sec MEDIUM] `ParseUUIDPipe`** på `POST rent-collections/export/:noticeId`
  (konsekvent med bulk-DTO:ns `@IsUUID`).
- **[jurist HIGH → dokumentation] `unmatchTransaction`** lämnar MEDVETET
  `collectionStage = NONE` vid avmatchning — re-eskalering kräver ny INV-B-granskning
  med omräknad ränta (RL 9 §). Förtydligat i kod; INV-D blockerar ändå export (stage ≠
  READY). Ingen funktionell ändring behövdes.

### Öppna följdpunkter (ej i PR 2)

- **[jurist MEDIUM] Ränteperiodisering i exportdokumentet** utgår från
  kristalliseringsdatumet (`interestAccruedThrough`), inte faktisk betalningsdag —
  förlegad om inkassot drar ut på tiden. PDF/CSV bör förtydliga att inkassobolaget
  ansvarar för omräkning till betalningsdag (RL 9 §). Rör export-dokumentets innehåll,
  inte skuld-grinden — separat ärende.
- **[jurist LOW] Audit-trail vid exportVÄGRAN** (`action: inkasso-export-blocked`) för
  spårbarhet av "varför nekades export". Får INTE skrivas från `listReady` (read-path);
  endast vid explicit export-försök. Separat ärende.
- **[jurist MEDIUM/produkt] Konfigurerbart minimibelopp** för total-residual vid export
  (konsumentproportionalitet) — se "medvetet val" ovan.
- **[sec note] `findUnique` utan org** i `applyMatchToRentNotice` — förbefintligt
  (callers org-verifierar uppströms), samma not som PR 1.

### Bankavstämnings-härdning PR 3a — eskalering på faktisk skuld (INV-A)

**Mål:** kravtrappans övergångar drivs av **faktisk utestående skuld** (allokerings-
deriverad via `RentDebtService.outstanding()`), inte av status enbart eller `paidAmount`-
cachen. En delbetald avi eskalerar bara för residualen; en fullt reglerad avi eskalerar
aldrig. **PENGANEUTRAL grund-PR:** ingen ändrad matchningslogik, inga nya verifikat,
ingen delbetalnings-bokföring (det är PR 3b). `outstanding()` är ren läsning.

**`ocrOutstanding` (nytt derivat i RentDebtBreakdown):** `max(0, (kapital+förbrukning+
avgift) − betalt)` — den OCR-reglerbara restskulden, EXKL. ränta. **Waterfall-regeln**
(en betalning reglerar OCR-delen FÖRE räntan) definieras på ETT ställe (RentDebtService):
allokeringarna är inte komponent-attribuerade, så `paid` tolkas som att den fyller OCR-
bucketen först. Konsekvens: betalar man hela OCR-beloppet blir `ocrOutstanding=0` även om
ränta återstår (`outstanding>0`).

**Explicit ränte-policy per cron (det strukturerade returvärdets syfte):**

| Cron                                             | Grind                        | Ränta?                         |
| ------------------------------------------------ | ---------------------------- | ------------------------------ |
| `markOverdueRentNotices` (SENT→OVERDUE)          | oförändrad (status-driven)   | n/a                            |
| `escalateOverdueRentNotices` (→REMINDED)         | `ocrOutstanding > 0`         | **exkl.**                      |
| `escalateRemindedToInkassoReady` (INV-B steg 10) | `ocrOutstanding > 0`         | **exkl.** (bevarar dagens val) |
| `reclassifyProbableLosses` (befarad)             | nedskrivning = `outstanding` | **inkl.** (hela 1510-fordran)  |

**[D1] Ren restränta driver ALDRIG kravtrappans framdrift.** REMINDED/INKASSO_READY gatar
på `ocrOutstanding` (exkl. ränta). Räntan ingår bara i nedskrivningsbeloppet (reclassify),
eftersom den är bokförd på 1510 (1510 D / 8131 K) och måste skrivas ned med resten.

**[D6] `markOverdueRentNotices` lämnas oförändrad** (status SENT→OVERDUE, bulk-updateMany).
Den defensiva `outstanding>0`-guarden infördes INTE i PR 3a: (a) en SENT-avi har i PR 3a
inga partiella allokeringar (partiell bankmatchning är PR 3b), så `outstanding` är alltid
full → guarden triggar aldrig; (b) den skulle kräva NotificationsModule→AviseringModule
(cykelrisk) + per-rad-query i en bulk-cron. Omprövas i PR 3b när partiella allokeringar finns.

**[D7] Bad-debts privata `outstanding()`-hjälpare BORTTAGEN** — ersatt av RentDebtService
(en sanningskälla, eliminerar namnkrocken). Nedskrivningsbeloppet är **oförändrat**: invarianten
Σ allokeringar == paidAmount (PR 1) gör fältsumman och allokeringssumman identiska.

**Kategori-D-vakthund:** export-grinden + `rent-reminder` + `rent-bad-debt` är nu de tillåtna
`outstanding()`-läsarna; `rent-interest`, faktura-export, controllers och scheduler förblir
förbjudna.

### Öppna följdpunkter (ej i PR 3a)

- **PR 3b — partiell BANKMATCHNING:** registrera en delbetalning som allokering, flippa PAID
  först när `outstanding ≤ 0`, boka RIKTIGA partialverifikat (1930/1510). Rör matchningslogiken
  och huvudboken → egen PR (inte penganeutral). Då aktiveras `markOverdive`-guarden (D6) och
  `markAsPaid`-partiell (D5) på riktiga partiella data.
- **[bokf MEDIUM → PR 3b] `reclassifyToProbableLoss` läser `outstanding()` UTANFÖR
  `$transaction`** (rent-bad-debt.service.ts) — ett race-fönster mot en delbetalning som landar
  mellan läsning och claim. I PR 3a är det en TEORETISK risk: en fullbetalning flippar PAID och
  faller ur urvalet (`status notIn PAID/CANCELLED`), och partiella allokeringar på icke-PAID-avier
  finns inte förrän PR 3b. Åtgärd i PR 3b: läs skulden INNE i transaktionen EFTER claim-låset
  (kräver en tx-medveten `outstanding`-variant). Samma claim-guard skyddar redan mot fullbetalning.
