# FÖRSLAG till beslutsunderlag: fastighetsfokus och bokföringens gräns

**Detta är ett förslag, inte ett fastställt riktningsbeslut och inte en byggorder.**
Ingen masterplan, produktkod, flagga eller PR-status ändras av det här dokumentet.

**Inramning: ARBETSINRIKTNING TILLS VIDARE, inte ett permanent val av framtida
bokföringsarkitektur.** Att avvakta med deklarations- och årsredovisningsfunktioner
bevarar det arbete som redan gjorts. Det binder inte Eveno till att alltid ha en egen
huvudbok, och det utesluter inte ett senare beslut i motsatt riktning.

**Rättelser i version 2 (2026-09-13), efter granskning:** fem formuleringar i
version 1 var för starka eller buntade ihop val som är oberoende. Var och en är
utmärkt nedan med `RÄTTAT v1→v2`.

**Granskad commit:** `3b71e905d866f461f6b07211bc89b3fa88505200` (`origin/main`, 2026-09-12).
Varje tal nedan är mätt mot den commiten. Uppskattningar är märkta UPPSKATTNING.

**Utgångspunkt som prövas:** behåll och underhåll befintlig huvudbok, prioritera
fastighetsfunktionerna, avvakta med utbyggnad till ett komplett deklarations- och
årsredovisningsprogram.

---

## 1. Vad som BEHÅLLS och vad som föreslås pausat

Den befintliga period- och årsstängningen är inte ett halvfärdigt bokslutspaket. Den
är byggd, provad och anropas av produktionskod. Den får inte buntas med det som
aldrig byggts.

### BEHÅLLS — finns i dag, mätt

| Funktion | Var | Vad den gör |
|---|---|---|
| `closePeriod` | `accounting-period.service.ts:474` | Stänger en månad, med blockerande förkontroller |
| `reopenPeriod` | `:678` | Återöppnar en stängd månad, rollgrindad |
| `precheck` | `:397` | Förkontroller innan stängning |
| `getOverview` / `getDetail` | `:332` / `:605` | Periodöversikt och detalj |
| `listFiscalYears` | `:1212` | Räkenskapsårsöversikt |
| `previewFiscalYearClose` | `:1264` | Förhandsvisning av årsavslut |
| `closeFiscalYear` | `:1356` | **Bokför resultatavräkningen**, stänger månad tolv, låser året oåterkalleligt |
| Huvudboken | `accounting.service.ts` | 27 `createNumberedEntry`-anrop, ALLA i en fil |
| BAS-kontoplan per bolagsform | `bas-chart.ts` | `YEAR_RESULT_ACCOUNT_BY_FORM` |
| Storno | `reverse-entry.dto.ts`, service | Reversering enligt BFL 5 kap 5 § |
| Periodlås och stängt-tillstånd | `closed-period.ts` (866 rader) | Härlett tillstånd, eget deriveringsprov |
| SIE4-export | `accounting.service.ts:1275-1430` | 14 posttyper inkl. `#VER`/`#TRANS`, CP437 |
| Verifikationsnummerserie | `verifikationsnummer.service.ts` | Atomär, med samtidighetsprov |
| 51 CI-vakter | `apps/api/scripts/check-*.mjs` | Måste fortsätta prövas mot ny kod |

Noterat ur koden: `2099 → 2091` (årets resultat till balanserat resultat) görs
medvetet INTE automatiskt — det är bolagsstämmans beslut (`:1178-1184`). Den
avgränsningen är riktig och ska inte "kompletteras" som en lucka.

### FÖRESLÅS PAUSAT — finns inte i dag

Ingen av posterna nedan är påbörjad i Eveno. Radantalen är mätta i
`erp-mafia/accounted` som referens för vad posten kostar att bygga.

| Post | Referensmängd hos accounted |
|---|---|
| Bokslutspaket: periodiseringar, anläggningstillgångar och avskrivning, reserver, skatteberäkning, dispositionsförslag, bokslutsbilagor, beredskapsbedömning | `lib/bokslut/` **30 079 rader** |
| Årsredovisning K2 i iXBRL mot Bolagsverkets taxonomi | del av samma `lib/bokslut/ixbrl/` |
| INK2 / INK2R mot officiell BAS-kopplingstabell | `lib/reports/ink2/` |
| NE-bilaga | `lib/reports/ne-bilaga/` |
| SRU-export med egen teckenkodning | `lib/reports/sru/`, `sru-encoding.ts` |
| Momsdeklaration SKV 4700 med eSKD-fil och inlämningsgrind | `vat-declaration*.ts`, `vat-eskd-file.ts` |
| Periodisk sammanställning (EU-försäljning) | `periodisk-sammanstallning*.ts` |
| Löner, AGI, KU10, semesterskuld | `lib/salary/`, `reports/salary-journal.ts` |
| Skattekonto-synk | `lib/skatteverket/` |
| Kassaflödesanalys | `reports/kassaflodesanalys.ts` |
| Reskontra med avstämning | `reports/{ar,supplier}-ledger.ts` |
| SIE-**import** | `lib/import/sie-import.ts` (3 406 rader) |

**Gränsen i en mening:** Eveno bokför, stänger period och stänger år. Eveno
upprättar inte bokslut och lämnar inte in deklarationer.

---

## 2. Accounted-provet: exakt vad som är bevisat

Provet kördes 2026-09-13 mot en SIE4-fil byggd i Evenos exakta utdataformat och
kodad med Evenos **egen** `encodeCp437`, genom accounteds **egen** kod.
Tre beviskrav hålls åtskilda.

### BEVISAT — läsande halvan av deras kedja

Funktioner som faktiskt kördes: `detectEncoding`, `decodeBuffer`, `parseSIEFile`,
`validateSIEFile`, `suggestMappings`, `validateMappings`, `getMappingStats`,
`mappingsToMap`, `generateImportPreview`, `isValidBASRange`, `isSystemAccount`.

```
detectEncoding                  cp437
avkodning                       29 svenska tecken intakta
parseSIEFile                    20 konton · 13 verifikat · 28 transaktionsrader · issues 0
validateSIEFile                 valid=true, 0 fel, 0 varningar
suggestMappings (full BAS)      20/20 mappade · 19 exakta · medelkonfidens 0,985
suggestMappings (TOM kontoplan) 20/20 mappade via basRange-självmappning
generateImportPreview           IB debet 360 500,00 = kredit 360 500,00 · isBalanced
                                voucherSeriesInFile A,B,C,D,E,F,G,H · issues []
```

Kanariefågel: ett obalanserat verifikat ger `valid=false`, 2 fel. Nollan är alltså
en mätning och inte blindhet. Men **elva av tolv kanariefåglar passerar** — deras
`validateSIEFile` kontrollerar i praktiken bara att verifikat balanserar. Fel
`#SIETYP`, saknat `#RAR`, saknat `#ORGNR`, 18 månaders räkenskapsår, **dubblett av
verifikationsnummer**, tomt verifikat och saknad kontoplan passerar alla. Exportens
riktighet är vårt ansvar, inte deras grind.

### INTE BEVISAT — den skrivande halvan

Dessa funktioner finns i deras kedja och kördes INTE. De kräver en
Supabase/Postgres-instans:

`importVouchers`, `syncMappedAccounts` (create-pass), `ensureFiscalPeriod`,
`precheckFiscalPeriod`, `validateIBBalance` mot verklig kontoplan,
`checkDuplicateImport`, `findOverlappingPeriodImports`, `checkDuplicatePeriodImport`,
`replaceSIEImport`, `undoSIEImport`, `computeVoucherNumberRanges`,
`resyncNextPeriodOpeningBalance`.

**RÄTTAT v1→v2, två saker.** Jag skrev "hela deras kedja" och "håller skarpt". Det
var för starkt: det som kördes är parsning, kontomappning och förhandsvisning, och en
sparad import är inte visad. Jag markerade också hela exportnivån som KLAR. Det var
också för starkt: filen byggdes i Evenos format med Evenos riktiga `encodeCp437`, men
**Evenos verkliga exportmetod kördes aldrig** — den kräver en databas med ett helt
räkenskapsår. Formatet är verifierat; metoden är det inte. Exportnivån är därför
delad i två i tabellen ovan, och bara den första är klar.

### Tre beviskrav som ska hållas åtskilda

| Nivå | Beviskrav | Läge |
|---|---|---|
| **Export, formatnivå** | en fil i vårt utdataformat, kodad med vår riktiga `encodeCp437`, läses av en oberoende parser utan fel, med kanariefågel | KLAR (ovan) |
| **Export, metodnivå** | Evenos VERKLIGA exportmetod i `accounting.service.ts` körd mot en riktig databas, och dess utdata läst av samma parser | EJ PÅBÖRJAD |
| **Engångsimport** | en sparad import i en riktig instans: verifikat skapade, IB bokförd, räkenskapsår skapat, kontoplan utökad, resultat jämfört post för post mot källan | EJ PÅBÖRJAD |
| **Löpande synk** | upprepad överföring utan dubbletter, med stabil nyckel per affärshändelse, och ett prov som visar att andra körningen inte skapar något | EJ PÅBÖRJAD, och se punkt 5 |

SIE bär bokföringen. SIE bär **inte** löpande betalningsåterkoppling: formatet har
ingen kanal tillbaka från mottagaren till Eveno.

---

## 3. Bankdata, matchning, betalningsstatus och aktualitet

Det här är den djupaste kopplingen i hela frågan, och kedjan är mätt.

```
reconciliation.service.ts:366   private advancePaymentFreshness(…)
                      :732      anropas efter import
                      :845      anropas efter matchning
                                    ↓  ENDA vägen som flyttar datumet
payment-freshness.service.ts:164   data: { paymentDataThrough: throughDay }
                            :88-99 NULL → { stale: false, ageDays: Infinity }
                            :103   stale = ageDays > thresholdDays
                                    ↓
rent-bad-debt.service.ts:159-165   evaluateAndAlert → hoppar över stale org
rent-reminder.service.ts:92        stale-flagga
```

Fyra mätta egenskaper:

1. **Bankavstämningen är ENDA skrivaren** av `paymentDataThrough`. Flyttas
   avstämningen ut ur Eveno finns det ingen som flyttar datumet.
2. **Färskhetstjänsten är penganeutral.** Den läser ett datum, pausar cron-steg och
   larmar. Inga verifikat, ingen matchningslogik (`:19-20`).
3. **Skuldberäkningen läser INTE huvudboken.** `RentDebtService` läser bara
   `prisma.rentNotice`. Färskhetsgrinden läser bara `prisma.organization`. Ett
   undantag finns: `rent-bad-debt.service.ts:407` läser `journalEntry` för en
   idempotenskoll.
4. **`paymentDataThrough = NULL` läses som FÄRSKT.** Kommentaren motiverar det med
   att en org som aldrig matat in betalningsdata inte ska pausas.

### RÄTTAT v1→v2: hålet är LIVE I DAG, inte bara under en framtida integration

Version 1 skrev att NULL-beteendet är "korrekt i dag, eftersom den andra situationen
inte kan uppstå". Båda halvorna av den satsen är fel.

**Första felet: en misslyckad första import lämnar också NULL.** Mätt på båda
importvägarna:

```
CSV-import   reconciliation.service.ts:732
             advancePaymentFreshness ligger EFTER radloopen men UTANFÖR dess
             try/catch (fångsten är per rad). Med noll giltiga rader blir
             latestCoverageDate(...) null, och advance gör då ingenting
             (payment-freshness.service.ts: if (advanced.count === 0) return).

BgMax        reconciliation.service.ts:838-845
             kastar BadRequestException FÖRE advance-anropet om varken
             imported eller duplicates är > 0. Datumet sätts aldrig.
```

En organisation som kopplat upp sig och vars **allra första import misslyckades**
har därför `paymentDataThrough = NULL`, läses som färsk, och kravtrappan körs. Det
kräver ingen extern leverantör.

**Andra felet: NULL bevisar inte att någon kontrollerat betalningarna.** Koden
uttrycker en avsikt ("en org som aldrig matat in betalningsdata ska inte pausas").
Den etablerar inget faktum om världen. Att datumet saknas är inte ett belägg för att
en människa läst banken manuellt.

Tre tillstånd är alltså i dag omöjliga att skilja åt, och alla tre läses som färska:

```
A  org bokför manuellt, har aldrig haft bankkoppling        NULL → kravtrappan KÖR
B  org kopplad, FÖRSTA importen misslyckades                NULL → kravtrappan KÖR   ← live i dag
C  extern leverantörs synk har aldrig levererat             NULL → kravtrappan KÖR   ← vid integration
```

Bara A är avsett. B är en verklig defektväg i dag och hör till `revision-status`
oavsett vad som beslutas om riktningen.

**Vad koden redan gör RÄTT, och som inte får tappas:** `reconciliation.service.ts:730`
flyttar fram datumet även för ett utdrag utan inbetalningar, med motiveringen att "ett
utdrag UTAN inbetalningar är ändå färsk data som bekräftar 'inga betalningar än'".
Det är rätt, och det är just den distinktionen som saknas i NULL-fallet: systemet
skiljer "läst, inga betalningar" från "aldrig läst" — men behandlar det andra som det
första.

### RÄTTAT v1→v2: ett anslutningsläge räcker inte

Version 1 föreslog en enum `AVVAKTAR_FÖRSTA_SYNK / KOPPLAD / EJ_KOPPLAD`. Det är
otillräckligt: **"kopplad" betyder inte "uppdaterad".** En lyckad anslutning säger
ingenting om till vilket datum betalningarna är komplett inlästa.

Det som behövs är två oberoende uppgifter, inte en:

```
1. FÖRVÄNTAS täckning?      manuellt läge · kopplad · ej kopplad
2. VERIFIERAD täckning      t.o.m. vilket datum är betalningarna komplett inlästa,
                            och när bekräftades det senast
```

Grinden måste kunna svara "täckning förväntas men har aldrig verifierats" som ett
eget utfall, skilt från både "ingen täckning förväntas" och "täckning verifierad men
gammal". Fyra fall att precisera innan lösningen beställs, och de ska namnges i
beställningen: **manuellt läge · första synk · synkfel · verifierad täckning.**

Teknisk anmärkning som står kvar: en grind över en nullbar kolumn bär ett tyst
undantag för precis de rader ingen tänkte på. Samma familj som husregeln om NOT NULL
med sentinel. Lösningen är uttryckliga tillstånd plus ett verifierat täckningsdatum,
inte NULL.

### RÄTTAT v1→v2: TRE oberoende ansvar, inte ett

Version 1 buntade ihop huvudboken med bankmatchningen och bedömde alternativ B som
om matchningen automatiskt följde med. Det är fel. Lagren är oberoende och kan
fördelas var för sig:

```
LAGER 1  BANKDATA          vem håller samtycket och levererar transaktionerna
LAGER 2  MATCHNING         vem matchar betalning mot avi och äger betalningsstatus
LAGER 3  HUVUDBOK          vem håller verifikaten
```

Ett fullt rimligt upplägg, som måste verifieras men inte får uteslutas på förhand:

```
LAGER 1  en bankleverantör (aggregator)
LAGER 2  EVENO — avier, betalningar, hyresgästens skuld hålls ihop här
LAGER 3  Fortnox, Spiris, Accounted eller annan mottagare
```

Det upplägget bevarar det som gör Eveno till Eveno: `RentDebtService` läser bara
`prisma.rentNotice`, så skuldberäkningen och kravtrappan är redan oberoende av
huvudboken. Matchningen behöver inte flytta med bokföringen.

### Vad som måste avgöras före en övergång

| Fråga | Lager | Måste besvaras av ägaren |
|---|---|---|
| Vem håller PSD2-samtycket: Eveno eller leverantören? | 1 | |
| Om leverantören: vad skriver det verifierade täckningsdatumet, och hur ofta? | 1 | |
| Vem äger matchningen avi↔betalning? Båda kan inte. | 2 | |
| Vem äger betalningsstatus som hyresgästen och kravtrappan läser? | 2 | |
| Vilken maximal synklatens tolereras innan kravtrappan pausas? | 1+2 | |
| Hur skiljs de fyra fallen manuellt läge / första synk / synkfel / verifierad täckning? | 2 | |
| Vem håller verifikaten? | 3 | |

**Teknisk anmärkning till den tredje frågan:** ett unikt villkor eller en grind över
en nullbar kolumn bär ett tyst undantag för precis de rader ingen tänkte på. Samma
familj som regeln i CLAUDE.md om NOT NULL med sentinel. Lösningen är ett uttryckligt
tillstånd (`AVVAKTAR_FÖRSTA_SYNK` / `KOPPLAD` / `EJ_KOPPLAD`), inte NULL.

---

## 4. Lanseringsberoenden: kod kontra externa avtal

### Mätt ur CLAUDE.md och koden

| Post | Blockeras av | Kodarbete som återstår |
|---|---|---|
| DB-backup | inget externt | bucket + scopad token + 4 Railway-variabler; mekanismen klar och bevisad mot riktig prod-dump (341/341 mätpunkter) |
| BankID-inloggning | **RP/broker-avtal → organisationsnummer** | endast den skarpa adaptern; allt annat byggt (#745, fyra PR:er) |
| Bankkoppling PSD2 | **aggregatoravtal → organisationsnummer** | endast P3-adaptern; frontend, samtycke, krypterade tokens, mock och E2E klara |
| Juridisk slutgenomgång | **orgnummer + extern granskning** | `PLATFORM_COMPANY.orgNumber` är platshållare (`platform.ts:14`); #576, #577 |

### Vad detta stöder och inte stöder

**Stöder:** tre av fyra poster har en extern grind som kod inte kan öppna, och
samma grind (organisationsnummer) i två av dem. Det är ett belägg för att externa
beroenden är en verklig flaskhals.

**Stöder INTE:** att utvecklingsomfattningen saknar betydelse.

**Rättelse av tidigare formulering:** jag skrev att en omprioritering flyttar
lanseringsdatumet "med noll dagar". Det var ett påstående om ett kontrafaktiskt
förlopp jag inte kan mäta, och det ska inte stå. Det som går att säga är att de två
flaskhalsarna är olika till sin natur och **båda måste bedömas**: avtalen har en
ledtid ingen kod påverkar, och kodomfånget avgör vad som är klart när avtalen
landar.

### UPPSKATTNINGAR — märkta som sådana

- UPPSKATTNING: de två adaptrarna (BankID skarp, PSD2 P3) är var för sig mindre än
  de PR:er som redan byggt allt runt dem, eftersom porten, flaggan, mock-vägen och
  proven finns. Inget underlag för en tidsuppskattning i dagar finns.
- UPPSKATTNING: Agent 3-kedjans två blockerande och fem bör-fixas är det närmaste
  verkliga arbetet oavsett riktningsval.
- ANTAGANDE: en första fastighetskund bokför antingen manuellt eller genom sin
  redovisningskonsult. Inget kundunderlag finns som styrker det.

---

## 5. Vilket system är auktoritativt, och hur hanteras konsultens rättelser

### Mätt hinder mot två samtidiga böcker

1. **Verifikationsnumren bevaras inte vid import.** Accounteds `importVouchers`
   renumrerar per målserie via `next_voucher_number` och sparar källans
   `(serie, nummer)` i `MigrationDocumentation.voucherNumberMapping` för spårbarhet
   (BFNAR 2013:2). Juridiskt korrekt för en migrering — men efter importen har
   samma affärshändelse **två olika verifikationsnummer**, och det finns ingen
   stabil gemensam nyckel.

2. **Evenos idempotens finns bara lokalt.** `createNumberedEntry` är idempotent per
   `(org, source, sourceId)`. De sourcenamnrymder som bär hyresflödet är mätta:
   `RENT_NOTICE`, `PAYMENT`, `BANK_RECONCILIATION`, `bank_reconciliation_unmatch`,
   `deposit`, `MISC_CHARGE`, `INVOICE`, `SUPPLIER_INVOICE`. Inget av detta följer
   med i en SIE-fil.

3. **Det finns ingen returkanal.** SIE är enkelriktat. En rättelse som konsulten gör
   i det externa systemet syns inte i Eveno, och Eveno kan inte upptäcka att den
   skett.

### Slutsatsen som följer av mätningen

**Två auktoritativa böcker är inte en modell, det är ett fel.** Tre hållbara
alternativ, och valet är ägarens:

Alternativen nedan gäller **enbart lager 3, huvudboken.** Lager 1 och 2 fördelas
separat (se punkt 3). Inget alternativ förutsätter att matchningen flyttar.

| Alternativ | Auktoritativ för bokföringen | Pris |
|---|---|---|
| **A. Eveno äger boken, extern är mottagare** | Eveno | enklast; Eveno fortsätter bära huvudboken. **Kräver en uttrycklig rättelseregel, se nedan.** |
| **B. Extern äger boken, Eveno matar** | leverantören | kräver returkanal för betalningsstatus om lager 2 också flyttar, och omdesign av agentplattformens effektmodell |
| **C. Delad, per räkenskapsår** | Eveno för öppet år, extern för stängda | gränssnittet blir ett datum; kräver att Eveno aldrig postar i ett överlämnat år |

### RÄTTAT v1→v2: alternativ A behöver en rättelseregel, inte accepterad divergens

Version 1 skrev att en rättelse hos konsulten kunde vara "ENDAST för deklaration
(divergens accepteras uttryckligen)". Det håller inte. En bokföringspåverkande
rättelse hos konsulten **är ett bokföringsfaktum**, och två böcker som tillåts vara
oense är inte en modell.

Alternativ A är bara hållbart med en av dessa regler, och valet är ägarens:

```
A1  Konsulten rättar I EVENO. Det externa systemet är en ren mottagare och
    importeras om efter rättelsen. Kräver att konsulten får åtkomst till Eveno.

A2  Konsulten rättar externt, och rättelsen FÖRS TILLBAKA till Eveno som ett
    verifikat innan året stängs. Kräver en definierad returväg och en ägare av
    avstämningen. SIE har ingen sådan kanal — den måste byggas eller skötas manuellt.

A3  Året ÖVERLÄMNAS vid en namngiven tidpunkt, varefter Eveno inte längre är
    auktoritativt för det året. Det är i praktiken alternativ C, och ska då
    kallas C och inte A.
```

Utan en av A1, A2 eller A3 är alternativ A inte ett alternativ, utan en obesvarad
fråga.

**Anmärkning till alternativ B:** Evenos förbrukningsgrind (#877) och
leveransmekanism (#878/#879) är byggda kring att bokföra i samma
Postgres-transaktion, med `(org, source, sourceId)` som idempotensnyckel och
`CONSTRAINT TRIGGER` som spärr. Blir bokföringen ett externt HTTP-anrop finns ingen
transaktionsgräns att rulla tillbaka. `EFFECT_DECLARATIONS` och `resumptionPolicy`
antar lokalt. Det är en materiell omdesign, inte en konfiguration.

---

## Ägarbeslut som behövs

Inget nedan är beslutat i det här dokumentet.

1. **Bekräfta gränsen i punkt 1.** Godkänn listan BEHÅLLS som infrastruktur som
   fortsätter underhållas och testas, och listan FÖRESLÅS PAUSAT som arbete som
   inte påbörjas. Särskilt: bekräfta att `closeFiscalYear` och periodstängningen
   ligger i BEHÅLLS.

2. **Välj auktoritetsmodell A, B eller C** (punkt 5). Allt annat i en integration
   hänger på det svaret, och det går inte att skjuta upp till efter ett
   leverantörsval.

3. **Besvara de fem bankfrågorna i punkt 3**, och särskilt: ska det nullbara
   `paymentDataThrough` ersättas av ett uttryckligt tillstånd innan någon
   integration börjar? Min bedömning är ja, och att det är litet arbete nu och
   dyrt senare.

4. **Besluta ordningen mellan bevisnivåerna i punkt 2.** Min bedömning: gör
   engångsimport-beviset mot EN mottagare innan någon leverantör väljs, och gör det
   mot accounted eftersom exportbeviset redan finns där.

5. **Besluta hur produktens gräns uttrycks i masterplanen.**

   **RÄTTAT v1→v2.** Version 1 skrev att visionstexten "inte längre är sann som
   skriven" om deklarationslagret aldrig byggs. Det var en överdrift. Behålls
   huvudboken så sköter systemet faktiskt bokföringen löpande, och löftet står
   kvar. Det som behöver skrivas ut är **gränsen**: Eveno bokför, stänger period
   och stänger år — Eveno upprättar inte bokslut och lämnar inte in deklarationer.
   Det är ett förtydligande av texten, inte en motsägelse mot den.

   Beslutet som behövs: ska gränsen skrivas in i visionsavsnittet, eller stå som en
   egen rad bland det som återstår?

6. **Besluta vem som äger dokumentet `docs/revision-status.md`-raden för den här
   frågan**, så att beslutet inte blir en rad utan sha som nästa session bygger på.

---

## Separat fynd ur samma granskning, utan koppling till riktningsvalet

`CORE_ACCOUNTS.DAMAGE_REVENUE = 3040` (`constants/index.ts:98`, `bas-chart.ts:82`).

3040 finns inte i BAS 2026 (kontrollerat mot en referens om 1 286 konton). Enligt
den officiella BAS-kopplingstabellen (bas.se, `INK2_P1_intervall-241119.xlsx`):

```
SRU 7410  rad 3.1  Nettoomsättning          30xx-37xx   ← hit hamnar 3040
SRU 7413  rad 3.4  Övriga rörelseintäkter   39xx        ← hit hör det
```

BAS:s konto för mottagna skadestånd är **3992 "Erhållna skadestånd"**. Med 3040
redovisas ett depositionsavdrag för skada som nettoomsättning i hyresvärdens
INK2R. Evenos egen kommentar (`bas-chart.ts:87-88`) säger att 3040 medvetet hålls
skilt från 3990 — avsikten var rätt, kontonumret är fel. Förslag: 3040 → 3992,
fortfarande skilt från 3990.

**Detta är en SEPARAT redovisningsrättelse med egen granskning.** Den hör till
`bokforings-expert`, inte till riktningsbeslutet. **Ingen kodändring och ingen
migration ingår i det här beslutet.** Befintliga poster på 3040 kräver en egen
migrationsplan, och den planen är inte skriven.
