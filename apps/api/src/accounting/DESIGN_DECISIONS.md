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
