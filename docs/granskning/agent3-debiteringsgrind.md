# Agent 3: spårbar debiteringsgrind

## Beslut före implementation (2026-09-10)

Bas: `3fa4b55128143d5bd70f696178679f2a99f22f29` på `origin/codex/agent3-svarsgrind`.
Egen worktree: `/workspaces/eken-fran-mac-20260909/arbete/agent3-debiteringsgrind`.
`repository.git` verifierat som bare-repository för `yasineken2002-sys/eken`.
Inga AGENTS.md hittades i worktreen eller dess överordnade arbetskataloger.
CLAUDE.md och TILLÄGG på `claude/terminal-workflow-reports-cncszy` lästa.

### Inventering av basen (radnummer avser basens filer)

Bedömningsvärden: **3**. `NEEDS_INVESTIGATION` = Behöver utredas;
`CONFIRMED` = Avvikelsen bekräftad; `EXPLAINED` = Förklarad avvikelse.
Inget värde intygar att underlaget är korrekt eller godkänner debitering.
Kontraktskällor: Prisma `apps/api/prisma/schema.prisma:7065`, Zod
`packages/shared/src/schemas/index.ts:2371`, DTO
`apps/api/src/consumption/dto/save-reading-review.dto.ts:28`, presentation
`packages/shared/src/utils/reading-review.ts:215`, kö
`packages/shared/src/utils/reading-review-queue.ts:10`. Shared-beslutstypen
härleder assessment från SaveReadingReviewInput.

Finding-koder: **4**, i `packages/shared/src/utils/reading-review.ts:18` och
SaveReadingReviewSchema/DTO. `DATA`: ogiltigt värde/period (:83);
`OVERLAP`: samma periodslut eller överlappande perioder (:101, :118);
`DECREASE`: sjunkande kumulativ ställning (:132); `HIGH_RATE`: minst tre gånger
medianen av tre jämförbara positiva dagstakter (:181).
Analysen producerar idag högst en finding per avläsning (continue), men grinden
ska bedöma hela relevanta mängden och aldrig välja enbart första varningen.

Produktionsskrivare (sökning även på modellrelationer, rå SQL och anropare):

| Funktion                                             | Antal skrivställen | Fil:rad                                                                           |
| ---------------------------------------------------- | -----------------: | --------------------------------------------------------------------------------- |
| Avläsning + DRAFT-charge                             |              1 + 1 | consumption/consumption.service.ts:343,363                                        |
| CONFIRMED, initial                                   |                  1 | consumption/consumption.service.ts:501                                            |
| CONFIRMED, återleverans efter makulering             |                  2 | invoices/invoices.service.ts:803; avisering/avisering.service.ts:2296             |
| Avi-rad + ATTACHED                                   |                  1 | consumption/consumption.service.ts:544 (anrop avisering/avisering.service.ts:371) |
| UTILITY-faktura, nästlade rader + ATTACHED/invoiceId |                  1 | consumption/consumption.service.ts:611                                            |
| Direkt förbrukningsverifikat                         |                  1 | accounting/accounting.service.ts:2456 (anrop consumption.service.ts:516)          |
| Bokslut med charge som estimatbas, två verifikat     |                  1 | consumption/consumption.service.ts:792,849; accounting/accounting.service.ts:3464 |
| Bedömningsrevision                                   |                  1 | consumption/reading-review.service.ts:48                                          |

Sökningen hittade även `history/history-fixture.ts:379` (teststöd),
`prisma/seed-history.ts:112–113` och `scripts/delete-organization.ts:96`
(uttrycklig organisationsstädning). Dessa är inga användarvägar till debitering.
Ingen produktionsuppdatering av avläst värde hittades; DB-triggers ska ändå täcka
INSERT/UPDATE/DELETE, inklusive rå SQL och nästlade skrivningar. Mätarens
redigeringsväg ändrar bara status/etiketter, inte identitet eller mätartyp
(consumption.service.ts:105). Tariffer och avtal/enhetsmoms används vid intake;
grinden ska inte prissätta om ett sparat snapshot.

Rapport: `reading-review.query.ts:48` läser hela organisationens avläsningar,
`reviewReadings` grupperar på organisation+mätare och sorterar periodslut+ID.
Luckor, typbyte och strukturella fel bryter trendserien. Saknad historik är inte
en varning. `trendAssessed` och `notTrendAssessed` beskriver täckning, inte
betalningsbeslut. Fingerprint SHA-256 (:14) binder kod, avläsning, mätare,
originalkällor och `consumption-review-v2`. Högsta revision väljs per
avläsning+finding (`reading-review-queue.ts:29`), aldrig en äldre revision bara
för att dess fingerprint matchar. Revisionsunikhet i schema:7092; UPDATE spärras
av trigger i `20260908203000_meter_reading_review/migration.sql:25`.

Äldre poster: **alla** befintliga CONFIRMED/ATTACHED saknar den nya kontrolltypen.
Antalet verkliga rader är **inte mätt**: inga kunddata läses. Tre skrivvägar till
CONFIRMED betyder att även en tidigare levererad och senare lossad post berörs.
Gamla verifikat ska inte skrivas om. Återleverans, saknad bokföring och
periodisering ska kräva ny aktuell kontroll.

### Explicit beslutstabell

| Aktuellt tillstånd                                                             | Debitering                                         |
| ------------------------------------------------------------------------------ | -------------------------------------------------- |
| Ingen varning, giltig oförändrad kvantitet och befintliga kontroller uppfyllda | JA, historik är inget nytt generellt krav          |
| Varning utan aktuell senaste bedömning                                         | NEJ                                                |
| NEEDS_INVESTIGATION                                                            | NEJ                                                |
| CONFIRMED ensamt                                                               | NEJ; betyder fortfarande bara Avvikelsen bekräftad |
| EXPLAINED ensamt                                                               | NEJ                                                |
| DATA, OVERLAP eller DECREASE, oavsett kommentar/intyg                          | NEJ; rättelse kräver ändrat underlag               |
| HIGH_RATE + EXPLAINED + aktuellt uttryckligt VERIFIED_CORRECT_REAL_INCREASE    | JA                                                 |
| INCORRECT eller inaktuellt fingerprint/regelversion/revision                   | NEJ                                                |
| Flera relevanta varningar                                                      | JA endast om varje varning uttryckligen tillåts    |

Minsta separata modell: nullable `billingBasisDecision` på en NY
MeterReadingReview-revision: `VERIFIED_CORRECT_REAL_INCREASE` eller `INCORRECT`.
NULL betyder inget intyg. Intyget säger att människan har kontrollerat mätvärde,
period och visade jämförelseavläsningar, funnit underlaget korrekt och ökningen
verklig och förklarad. Fritexten är motivering, aldrig en godkännandeknapp.
Intyget får bara öppna HIGH_RATE med EXPLAINED. Ingen historisk backfill.

Separat append-only `ConsumptionChargeCheck` binder charge/org/reading till
snapshot, SHA-256, regelversion, relevanta review-ID/revisioner, aktör och tid.
Normalfallet lagrar också underlag och trendtäckning. GET visar aktuellt
kontrollunderlag; konfirmering kräver dess förväntade fingerprint. Ändring ger
409 och omläsning, ingen automatisk retry mot nytt underlag.

### Samtidighetsstrategi och avgränsning

READ COMMITTED + transaktionsbundet advisory lock per organisation, FÖRE
underlagsläsning. DB-triggers på avläsningar, bedömningar och charges tar samma
lås vid INSERT/UPDATE/DELETE. Därmed ingår också rå/nästlad skrivning. Lås håller
igenom kontroll, spår, status och verkligt verifikat. READ COMMITTED undviker
att en Serializable-snapshot från före låsväntan används efter låset. Konflikt
får inte automatiskt försöka godkänna igen. Befintliga timeout-gränser behålls.

Kvantiteten kontrolleras mot aktuell avläsning och (för kumulativ avläsning)
faktisk föregångare enligt intake-regeln. Efterregistrerad mellanavläsning kan
annars ändra differensen utan någon target-varning. Inga belopp eller mätvärden
ändras av grinden. Avi och faktura låser före urvalet och kräver giltigt sparat
spår; avi måste även tillhöra rätt avtal/hyresgäst. Bokslutsbasen kontrolleras
före de två nya periodiseringsverifikaten.

## Samordnad leverans

Denna utkast-PR har bas `codex/agent3-svarsgrind`. En PR överst i stapeln
hindrar inte tekniskt att äldre PR:er mergas utan grinden. Grinden **måste ingå
i den samordnade leveransen av Agent 3**. Inga andra PR:er ändras eller mergas.

## Vad grinden inte kan garantera

Ett korrekt tekniskt godkännande bevisar inte att en mänsklig bedömning är sann
eller att själva mätaren visar rätt. Rättelse/kreditering är ett separat kommande
bygge. Ingen bankmatchning eller ändring av beloppsregler ingår. Agentgranskning
är inte juridiskt godkännande.

## Genomförande och verifiering

Pågår. Inga test- eller leveransresultat påstås innan de har mätts.

### Omgranskning och kvarstående leveranshinder

Tre separata granskare läste kod och sina projektroller självständigt:
`security-auditor` (organisation/behörighet/samtidighet), `bokforings-expert`
(intygets innebörd/bokföring) och `code-reviewer` (kringgåenden/historik/testfacit).
De körde inga tester; huvudagentens körningar redovisas separat.

Åtgärdade invändningar: avin låses `FOR UPDATE` innan status läses; en tidigare
bedömd varning som försvinner vid ändrad historik blockerar; formulär bevaras
även när varningen försvinner eller omläsningen misslyckas; nolltariffens gamla
normalbeteende bevaras; bokslutet använder en transaktion per mätare och gör
no-op-kontroller före grind; User låses `FOR SHARE` innan aktiv roll läses;
kontrollens org/charge/reading binds med sammansatt FK; explicit kontrollrevision
ersätter tidsstämpel som ordning. Råskrivningsproven använder inga hjälplås.
Kodgranskarens två sista testfynd (andra knappens namn och blandat JA/NEJ för två
HIGH_RATE) har fått motsvarande teständringar; körresultat redovisas nedan.

**Kvarstående HIGH/hinder — redan ATTACHED dokument:** befintlig PENDING/FAILED
avi och DRAFT UTILITY-faktura kan skickas utan ny grind. Samma risk gäller en
nyss kopplad debitering vars bedömning blir INCORRECT innan köjobbet körs.
Berörda oförändrade filer: `avisering/avisering.service.ts:883,927,971,990`,
`invoices/invoices.service.ts:1617,1654,1688,1703` samt
`pdf-jobs/pdf.worker.ts:41,71`. PDF-hämtning av redan skapade dokument ligger
också utanför kopplingsgrinden (`avisering.service.ts:1013`). Detta bygge
**är därför inte ett färdigt skydd för hela historiska leveransflödet** och ska
inte levereras som om hindret vore löst. En komplett utskicksgrind behöver ett
beständigt, atomiskt leveransbeslut och samordning med den externa mejlkön;
en kontroll före PDF-rendering lämnar ett race och en lång DB-transaktion runt
Chromium löser inte externa köeffekters rollback. Ingen sådan halvåtgärd införs.
Produkttexten lovar uttryckligen kontroll före _koppling till avi eller faktura_.

Två efterföljande manuella betalningsvägar finns: `invoices.service.ts:1409`
→ `accounting.service.ts:2154` och `avisering.service.ts:1842`
→ `accounting.service.ts:3822`. De bokför verklig inbetalning, likvidkonto mot
1510, och skapar inte ny förbrukningsintäkt. De spärras inte av detta bygge.
Bokföringsgranskaren rekommenderar denna åtskillnad. Reconciliation ändras inte.

Granskarna är eniga om utskickshindret. Deras kodläsning av konfirmering,
återkoppling och direkt förbrukningsbokföring fann efter åtgärderna inget nytt
kringgående. Detta är inte ett juridiskt godkännande eller ett godkännande av
hela leveransen.

Ytterligare säkerhetsfynd under slutkontrollen: dubbla jämförelseperioder kunde
släcka en ännu obedömd HIGH_RATE. Analysen exponerar därför nu
`readingComparisonCandidates`: högst tre möjliga jämförelseperioder (med en
extra föregångare för kumulativa differenser), alla rader vid samma periodslut,
och samma typ-/luckgräns som trendanalysen. Grinden tar med befintliga
strukturella fel där även när ingen trend kunde beräknas. Färre felfria perioder
är fortfarande tillåtet; ett fel före en verklig tidslucka eller utanför
jämförelsefönstret medför inte permanent stopp. Tre nya självständiga DB-facit
provar den skillnaden. Detta ändrar inte de fyra finding-kodernas regler eller
något mätvärde.

Slutlig läsuppföljning: säkerhetsgranskaren godtar jämförelseavgränsningen och
läsendpointens organisationsscopning utan nya blockerare. Kodgranskaren anger
Approve för den granskade implementationen som utkast, efter att båda sista
testfynden åtgärdats. Båda undantar uttryckligen utskicksflödet och har inte
självständigt verifierat testloggar, negativkontroll eller levererad HEAD.

### Migration och begränsningar

Två additiva migrationer: `20260910160000_consumption_charge_gate` inför nullable
intygsfält, kontrolltabell utan historiska rader, UPDATE-spärr och tre
organisationslåstriggers. `20260910170000_consumption_check_identity` inför
obligatorisk kontrollrevision, unik org+charge+revision, sammansatt FK till rätt
org+charge+avläsning samt kontrolltabellens egen låstrigger. Den andra förutsätter
att den första nya tabellen är tom; de hör till samma leverans. Inga tidigare
bedömningar omtolkas och inga gamla verifikat uppdateras. Radering av kontrollspår
är fortfarande möjlig vid uttrycklig organisationsstädning; scriptet raderar
spåren före charges. Append-only betyder här förbud mot UPDATE, inte att en
privilegierad databasadministratör saknar möjlighet att radera data.

Låsnyckeln är `hashtextextended('consumption-gate:' || organizationId, 0)`.
Alla berörda skrivningar tar transaktionsbundet advisory lock; User, Lease och
Meter skyddas dessutom med radlås där deras identitet/behörighet läses. Avin låses
innan statuskontroll. En skrivare som redan har radlås kan ge deadlock mot
organisationslåset; PostgreSQL avbryter en transaktion, och P2034/40P01 blir
svensk 409 där grinden körs. Ingen automatisk konfirmeringsretry sker. De gamla
transaktionsgränserna 5 s timeout/2 s maxWait är bevarade. Organisationslåset
serialiserar olika mätare inom samma organisation; stora organisationsvolymer
har inte lasttestats och ska inte mötas med höjd timeout utan mätning.

Kompletterad skrivaravstämning: 6 direkta produktionsskrivställen för
ConsumptionCharge (1 create, 5 updateMany), 1 för MeterReading och 1 för
MeterReadingReview. Kontrollspåret tillför 1 create. Sökning på relationer/nästlade
skrivningar och sourceId-strängar fann ingen ytterligare ingång till ny
förbrukningsintäkt. Den nästlade fakturaradsskrivningen ligger i
`consumption.service.ts` under samma lås som charge-uppdateringen. Befintlig
krediteringsadapter `avisering/rent-notice-credit.service.ts:301–318` refererar
också charge-verifikatet; den minskar en redan bokförd fordran och ändras inte.
De två explicita städrutinerna, `scripts/delete-organization.ts` och
`prisma/seed-history.ts`, raderar nu kontrollspår före charges. Seed-scriptet har
fortsatt sin befintliga avgränsning till syntetiska SEED_IDS; det har inte körts.

### Webbevis

`apps/web/e2e/consumption-charge-gate.spec.ts` kördes i Chromium mot ordinarie
Nest-API, dess autentisering/behörighetsvakter och PostgreSQL. 1/1 grönt på 16,8 s
(testet 12,6 s). HTTP-konfirmering utan bedömning gav 409 och noll kontrollspår/
verifikat. Webbflödet sparade först INCORRECT (fortsatt spärr), därefter en ny
revision med EXPLAINED + uttryckligt korrekthetsintyg, läste om och konfirmerade.
Slutläge mätt direkt i DB: CONFIRMED, 1 kontrollrad, 1 verifikat, 2 verifikatrader.
Fixturen raderades i finally. [Skärmbild](agent3-debiteringsgrind-webb.png).

Testmiljön använde bara syntetisk organisation, egen tom Redis på egen port och
`agent3_debiteringsgrind_test`. API-processen startades med en tillåten lista av
lokala testvariabler, inga externa API-nycklar och cron avstängt. Egna API-/Vite-
processer och Redis stoppades efter provet. Inga mejl, riktiga kunddata eller
betalda AI-anrop användes. Tidiga E2E-fel gällde ESM-import i testet, beloppets
befintliga formatering och en ofullständig syntetisk termsVersion-fixture; dessa
rättades och den riktiga klickkedjan kördes därefter grönt.

### Två slutliga DB-körningar

Databas: **agent3_debiteringsgrind_test**. Den skapades separat och var tom
(0 tabeller i public). `prisma migrate deploy` applicerade 188 migrationer,
inklusive de två nya; detta har verifierats i `_prisma_migrations`. Ingen
migration kördes i befintlig utvecklings- eller kunddatabas.

| Körning     | Resultat               | Tid      | Organisationer/avläsningar/bedömningar/charges/spår/verifikat/verifikatrader/fakturor/avier/avirader före → efter |
| ----------- | ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| 1           | 44/44 gröna, 0 hoppade | 28,100 s | 0/0/0/0/0/0/0/0/0/0 → 0/0/0/0/0/0/0/0/0/0                                                                         |
| 2, samma DB | 44/44 gröna, 0 hoppade | 18,212 s | 0/0/0/0/0/0/0/0/0/0 → 0/0/0/0/0/0/0/0/0/0                                                                         |

44 inkluderar 43 fixturebaserade DB-prov och 1 miljökrav som uttryckligen fäller
om DATABASE_URL saknas. beforeEach kontrollerar tomma verksamhetstabeller för
varje ny fixtureorganisation; afterEach raderar i FK-ordning och kontrollerar
att spår, bedömningar och verifikat är borta; afterAll jämför alla tio totala
radantal med beforeAll. JSON-rapporter lokalt: `/tmp/agent3-db-run1.json` och
`/tmp/agent3-db-run2.json`; motsvarande `.log` innehåller radantalen.

DB-proven använder ConsumptionService, ReadingReviewService, AccountingService,
VerifikationsnummerService och InvoiceEventsService mot riktig PostgreSQL.
Aviannulleringsprovet använder även verklig AviseringService. Oanvända PDF-/
lagringsadaptrar laddas inte. Två spioner för styrd överlappning delegerar till
verklig bokföring; rollback-provet kastar först **efter verklig verifikatskrivning**
och mäter att transaktionen lämnar noll spår/verifikat. Kö-/mejlutskick provas
inte här. Äldre compliance-/bokföringsenhetsprov mockar grinden och kontrollerar
befintlig beloppslogik/anropskontrakt; de är inte bevis för DB-effekter.

### Exakta lokala testkommandon

Alla kommandon kördes i den egna worktreen. Före Jest/tsc kontrollerades den
delade maskinen med `pgrep -af '[j]est|[t]sc'`, även utanför sandboxens
PID-namnrymd. Ett tungt jobb kördes åt gången. `/tmp/agent3-db-run.py` tillförde
endast anslutningen till den ovan namngivna isolerade databasen från lokal
containerkonfiguration, utan att skriva ut anslutning eller lösenord.

Från `apps/api`:

```sh
python3 /tmp/agent3-db-run.py pnpm exec prisma migrate deploy
python3 /tmp/agent3-db-run.py pnpm exec jest src/consumption src/accounting/accounting.consumption.spec.ts src/accounting/dto-contract.spec.ts --runInBand
python3 /tmp/agent3-db-run.py pnpm exec jest src/consumption/charge-gate.db.spec.ts --runInBand --json --outputFile=/tmp/agent3-db-run1.json
python3 /tmp/agent3-db-run.py pnpm exec jest src/consumption/charge-gate.db.spec.ts --runInBand --json --outputFile=/tmp/agent3-db-run2.json
NODE_OPTIONS=--max-old-space-size=2400 pnpm exec jest src/common/authz/authz-surface.spec.ts src/common/authz/object-scope.spec.ts src/scripts/delete-organization.spec.ts src/consumption/reading-review-decisions.spec.ts src/consumption/charge-gate.spec.ts --runInBand
```

Resultat: modul-/DTO-körningen **839/839 i 12 sviter**, sista vakt-/scriptkörningen
**87/87 i 5 sviter**. Vaktkörningen ovan kördes utan UPDATE-flaggor och verifierade
golden-filen. Tidigare inventeringskörningar använde explicit
`UPDATE_AUTHZ_GOLDEN=1 UPDATE_OBJECT_SCOPE=1`; objektinventariet ändrades inte,
behörighetsinventariet tillförde den motiverade organisationsscopade GET-kontrollen.
Separata strict-boolean/string/ISO-kontraktsprov ingick även i den tidigare
245/245-körningen (14 sviter).

Från worktreens rot:

```sh
pnpm --filter @eken/shared build
pnpm --filter @eken/ui build
node --max-old-space-size=2600 node_modules/typescript/bin/tsc --noEmit -p apps/api/tsconfig.typecheck.json
node --max-old-space-size=2200 node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
pnpm --filter @eken/web exec vitest run src/features/consumption --maxWorkers=1 --minWorkers=1
node apps/api/scripts/check-request-contract.mjs
node apps/api/scripts/check-transaction-limits.mjs
git diff --check
CI=1 pnpm --filter @eken/web exec playwright test --list
```

Webb: **80/80 i 10 filer**. Kontraktsvakt: 98 delade nyttolasttyper, inga nya
eller inaktuella överträdelser (6 kända i 5 filer kvar på basen).
Transaktionsvakt och diffkontroll gröna. ESLint kördes på alla 30 ändrade
TS/TSX-filer, exit 0; två loggvarningar i DB-specen rättades till projektets
console.warn och filen lintades därefter utan anmärkning.
Playwright-discovery med CI=1 hittade **16 prov i 14 filer**, inklusive det nya.
Workflowens förväntade antal är uppdaterat till det uppmätta 16.

Browserprovet från `apps/web`:

```sh
python3 /tmp/agent3-db-run.py pnpm exec playwright test --config=/tmp/agent3-playwright.config.cjs
```

Den lokala configen väljer enbart `consumption-charge-gate.spec.ts`, 1 worker,
Chromium, inga retries och befintliga egna API/Vite-servrar. Testet självt ligger
i ordinarie E2E-katalog och ingår i CI:s vanliga discovery. API startades med
`node -r ts-node/register/transpile-only src/main.ts`, webb med
`pnpm exec vite --host 127.0.0.1`. Den äldre ändrade
`consumption-charge-confirm.spec.ts` har inte körts lokalt eftersom dess gamla
fixture pekar på eken_dev; den körs av CI i dess isolerade tjänst. Hela sviten
har inte körts lokalt enligt byggorderns resursavgränsning.

Första API-typkontrollen med 1800 MB slutade med uttrycklig V8 heap-out-of-memory,
exit 134; därefter användes 2600 MB. Det var diagnostiserat heapfel, inte en
slutsats från SIGTERM. Tidiga DB-fel var testimport/fixturtypning och FK-städning;
fixturens invoice events/rader lades i rätt raderingsordning. Alla slutliga
DB-körningar ovan städade rent. Inga timeouter i produktionen höjdes.
