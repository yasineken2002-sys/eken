# Agent 3: utskicksgrind — förinventering och stoppbeslut

Datum: 2026-09-10. **Stopp före implementation enligt ägarens cirka 400-radersregel.**
Detta är ett beslutsunderlag, inte en leveransrapport för en färdig PR 2.
Ingen produktionskod, migration, testkod, befintlig rapport eller PR har ändrats.
PR 3 (rättelsevägen) har inte påbörjats.

## Arbetsyta och verifierad bas

- Bare-repository: `/workspaces/eken-fran-mac-20260909/repository.git`, verifierat som bare med origin `yasineken2002-sys/eken`.
- Ny worktree: `/workspaces/eken-fran-mac-20260909/arbete/agent3-utskicksgrind`.
- Ny gren: `codex/agent3-utskicksgrind`.
- Bas och oförändrad HEAD: `9f879291dd039e404ba80b7266fbd53842a0b42b`, den av ägaren angivna godkända commiten i PR #877.
- Befintliga worktrees och grennamn kontrollerades före skapandet; inget arbete skrevs över.
- `pwd -P`, branch, HEAD och `git status --short` verifierades efter skapandet och före rapportskrivningen. Trädet var rent; granskarna arbetade enbart läsande.
- `CLAUDE.md` och `docs/granskning/agent3-debiteringsgrind.md` lästes. Inga tillämpliga AGENTS.md hittades i kontrollerade föräldrakataloger eller spårade filer.
- Fetch och worktree-kommandon använde det angivna bare-repositoryt uttryckligen. Alla kommandon hade uttrycklig arbetskatalog.

Körda Git-kommandon för bas och skapande:

```sh
git --git-dir=/workspaces/eken-fran-mac-20260909/repository.git fetch --no-tags origin refs/heads/codex/agent3-debiteringsgrind:refs/remotes/origin/codex/agent3-debiteringsgrind
git --git-dir=/workspaces/eken-fran-mac-20260909/repository.git worktree add -b codex/agent3-utskicksgrind /workspaces/eken-fran-mac-20260909/arbete/agent3-utskicksgrind origin/codex/agent3-debiteringsgrind
```

## Hur inventeringen härleddes

`rg` saknas i miljön; sökning gjordes med `git grep`, `git ls-files` och riktade `sed`-läsningar. Sökningar över produktionskoden följdes bakåt till anropare och framåt genom PDF-, mejl- och lagringsadaptrarna. Tester och fixturer skildes från produktionsanrop. Följande sökuttryck användes bland annat:

```text
sendNotices|processNoticeSendJob|sendInvoiceEmail|processInvoiceSendJob|sendRentNotice
outbox|dispatch|idempotencykey|idempotency.key
consumptionChargeId|consumptionCharges|ConsumptionCharge|UTILITY
generateInvoicePdf|generateFromHtml|pdfUrl|pdfKey|storageKey|signedUrl
trackingToken|trackPdf|invoice.*pdf|pdf.*invoice
failedEmail\.|failedEmails|queue\.add\(|getQueues\(|\.retry\(
attachRentNoticeLineCharges|generateMonthlyNotices|createInitialNoticesForLease
resend\.emails\.send|\.sendMail\(
```

Sökytor: `apps/api/src`, `apps/api/prisma/schema.prisma`, migrationskatalogen, scripts och CI-konfiguration. Därutöver följdes direkta/nästlade Prisma-radskrivningar och relevanta SQL-triggers. Breda första sökningar gav även reconciliation-träffar; de följdes inte vidare och ingen sådan fil ändrades. Nedanstående antal avser identifierade kodvägar på denna HEAD. De bevisar inte innehållet i driftens Redis/R2 eller förekomsten av externa driftmanus.

Alla korta TypeScript-hänvisningar nedan är relativa till `apps/api/src/`. `schema.prisma` avser `apps/api/prisma/schema.prisma`. Filrader avser oförändrad bas-HEAD.

## Originaldokument: ingångar och fullföljda anropskedjor

Två faktiska kopplingar hittades: avi via `RentNoticeLine.consumptionChargeId` (`schema.prisma:5071`, `consumption/consumption.service.ts:639`) och separat faktura via `ConsumptionCharge.invoiceId` (`consumption.service.ts:747`, omvänd relation `schema.prisma:1811`). Aktuell produktion skapar RENT-avi respektive UTILITY-faktura. En framtida grind måste följa faktiska kopplingar, inte enbart dokumenttyp eller mejlmall.

**13 identifierade HTTP-ingångar för originaldokument:** 8 kan starta utskick direkt/indirekt, 4 lämnar PDF-byte och 1 redirectar. Därutöver finns 2 cron-ingångar och 3 AI-grenar. Rotingångar och interna anropsställen räknas separat.

| Ingång | Kod och fortsättning |
| --- | --- |
| POST /avisering/send | `avisering/avisering.controller.ts:132` → `sendNotices`, :136 |
| POST /avisering/send-all/:month/:year | Samma controller :139 → urval PENDING → `sendNotices`, :153 |
| POST /avisering/cron/run/:year/:month | Samma controller :122 → `scheduler.runForMonth`, :129 → `avisering.scheduler.ts:99` |
| POST /invoices/:id/send-email | `invoices/invoices.controller.ts:252` → `sendInvoiceEmail`, :260 |
| POST /leases/:id/initial-notices | `leases/leases.controller.ts:47` → `retriggerInitialNotices` → `avisering.service.ts:655` → :864 |
| PATCH /leases/:id/status | `leases.controller.ts:76` → `transitionStatus` → `leases.service.ts:1010` |
| PATCH /leases/:id/renew | `leases.controller.ts:102` → `renew` → `leases.service.ts:1409` |
| POST /leases/with-tenant, activate=true | `leases.controller.ts:59` → `createWithTenant` → `leases.service.ts:1207` → aktivering |
| Månadscron | `avisering/avisering.scheduler.ts:41` → `runForMonth` → :99 |
| Avtalslivscykelcron | `leases/leases.service.ts:1419` → automatisk förnyelse → :1699 |
| AI send_invoice_email | `ai/tools/tool-executor.service.ts:1333` → :1351 |
| AI transition_lease_status | Samma fil :1638 → :1656 → aktivering vid ACTIVE |
| AI create_tenant_and_lease | Samma fil :2808 → :2813 → aktivering |

Gemensam aktiveringskedja: `leases.service.ts:772` → `lease-activation.queue.ts:101` (Redis-skrivning :116) → `lease-activation.worker.ts:65` → `AviseringService.createInitialNoticesForLease` → `avisering.service.ts:864`. Initialavi-vägen kan återanvända en befintlig RENT-avi (`avisering.service.ts:191`, :850) och kan därför inte antas sakna förbrukningsrader.

Närmaste anropsställen: **4 till sendNotices** (`avisering.controller.ts:136,153`, `avisering.scheduler.ts:99`, `avisering.service.ts:864`) och **2 till sendInvoiceEmail** (`invoices.controller.ts:260`, `tool-executor.service.ts:1351`).

Kärntransport: ingång → **2 PDF-producenter** (`avisering.service.ts:902`, `invoices.service.ts:1639`) → gemensam `PdfQueue.enqueue`, `pdf-jobs/pdf.queue.ts:32` → **2 workergrenar**, `pdf.worker.ts:41,71` → `processNoticeSendJob`/:927 eller `processInvoiceSendJob`/:1654 → PDF → **2 mejlanrop**, `avisering.service.ts:971`, `invoices.service.ts:1688` → `MailService.sendRentNotice`/:694 eller `sendInvoice`/:489 → gemensam `mail/mail.queue.ts:102` → `MailWorkerBase.processJob` → **1 faktiskt leverantörsanrop**, `mail/mail.worker.ts:89`.

Tre mejlköer och tre workerklasser (`mail.worker.ts:319,342,365`) delar detta leverantörsanrop. PDF- och mejlkön gör båda fem automatiska försök (`pdf.queue.ts:23`, `mail.queue.ts:87`). PDF-kön saknar medvetet statiskt jobb-ID för att tillåta nya försök (:12–14); mejlkön använder idempotencyKey som jobb-ID (:96). Ingetdera är ett beständigt leveransbeslut.

## Nedladdning och andra utlämningsvägar

| Ingång | Terminal och befintlig kontroll |
| --- | --- |
| GET /invoices/:id/pdf | `invoices.controller.ts:65` → `PdfService.generateInvoicePdf`, :71 → `.send(buffer)`, :76 |
| GET /avisering/:id/pdf | `avisering.controller.ts:183` → `getNoticePdfBuffer`, :185 → `.send(buffer)`, :189 |
| GET /portal/invoices/:id/download | `tenant-portal/tenant-portal.controller.ts:490` → ägarskap och DRAFT-spärr :501 → `.send(buffer)`, :510 |
| GET /portal/rent-notices/:id/download | Samma controller :516 → ägarskap och PENDING/CANCELLED-spärr :527 → `.send(buffer)`, :536 |
| GET /track/view/:token | `invoices/tracking.controller.ts:59` → tokenuppslag → redirect :77 till vanlig faktura-PDF; ingen egen byteutlämning |

**4 PDF-byteutlämningar, 1 redirect, 2 gemensamma renderare**: `invoices/pdf.service.ts:135` och `avisering.service.ts:1033`. Ingen kontrollerar aktuell förbrukningsbedömning vid utlämningen. FAILED-avi nekas inte av portalens statusfilter. Redirectens verkliga proxy-/versionsbeteende har inte provats.

JSON-listorna `/portal/notices`, `/portal/invoices`, `/portal/rent-notices` (`tenant-portal.controller.ts:430,437,448`) är inte PDF-terminaler. En ny mejlgrind skulle inte i sig ändra deras publiceringspolicy.

## Påminnelser, export och återförsök som också måste beaktas

| Flöde | Identifierade ingångar och terminalkedja |
| --- | --- |
| Avipåminnelse | **2 ingångar:** cron `avisering/rent-reminder.service.ts:233` och HTTP-omsändning `avisering.controller.ts:241`. **2 PDF-producentanrop:** `rent-reminder.service.ts:342,1666`. En workergren → `processReminderSendJob`, :1057 → PDF :1126 → mejlanrop :1157 → gemensam MailWorker. |
| Fakturapåminnelse | **3 ingångar:** cron `notifications/payment-reminder.service.ts:67`, HTTP `notifications.controller.ts:113`, AI `tool-executor.service.ts:1363`. **4 mejlanropsställen:** `payment-reminder.service.ts:364,646`, `notifications.service.ts:443`, `tool-executor.service.ts:1449`. Ingen original-PDF, men betalningskrav som kan inkludera förbrukning. |
| Inkassoexport | **5 ingångar:** HTTP `collections/collections.controller.ts:72,82`, `collections/rent-collections.controller.ts:41,53`, AI direkt `tool-executor.service.ts:4624`. **4 PDF-producenter/jobbsorter:** `collection-export.service.ts:124,142`, `rent-collection-export.service.ts:160,175`. PDF-worker :49–66 eller AI:s direkta serviceanrop → exportmetoder :155,237 respektive :188,239. |

Exportmetoderna har **6 uppladdningsställen**: två filer (PDF/CSV) per enkelexport och en ZIP per bulkexport (`collection-export.service.ts:204,205,347`, `rent-collection-export.service.ts:204,205,284`). Lagring returnerar signerad URL (`storage/storage.service.ts:101`); avi-bulk kan läsa en tidigare lagrad påminnelse-PDF (:270). Påminnelsens PDF lagras på återanvänd nyckel (`rent-reminder.service.ts:1269`).

Totalt i PDF-kön hittades **9 producentanrop och 8 jobbkategorier**. En producent/kategori är plattformsfaktura och utesluts nedan: **8 relevanta producentanrop, 7 kategorier** återstår. Utöver PDF- och mejlkön finns aktiveringsköns producentsteg ovan. Detta är antal kodställen, inte antal historiska jobb.

Påminnelse/export arbetar med senare skuldtillstånd. **SENT/OVERDUE är ändå inte bevis på att originaldokumentet faktiskt skickats.** SENT sätts redan efter mejlköning (`avisering.service.ts:990`, `invoices.service.ts:1703`), och `notifications.service.ts:325,364` kan därefter sätta OVERDUE. Dessa vägar får därför inte uteslutas från skyddet enbart med hänvisning till status. Hur de omfattas måste vara uttryckligt innan ett helt skydd kan levereras; inget nytt rättelse-/kravtrappeflöde föreslås här.

**FailedEmail:** 1 skrivare (`mail.worker.ts:239`), 0 läs-/replayvägar hittade i genomsökta produktionsfiler/scripts. 0 explicita Bull retry()/retryJobs()-anrop eller BullBoard-registreringar hittades där. Automatiska köåterförsök finns däremot enligt ovan. Kommentar om att felraden kan replayas bevisar inte en implementerad replayväg. `MessagesService.retryFailed`, `messages/messages.service.ts:268`, gäller SentMessage/fritext, inte dessa PDF-jobb.

## Uteslutningar och inventeringens gränser

- `platform-invoice-send`, `pdf.worker.ts:74`, och dess producent `platform/invoices/platform-invoices.service.ts:361`: separat PlatformInvoice utan ConsumptionCharge-koppling. De 2 direkta generiska MailService.enqueue-anropen där (:392,857) hör till samma modell.
- `MailService.sendInvoiceReminder`, `mail.service.ts:510`: definition, 0 produktionsanrop hittade. Andra påminnelsemetoder ovan har verkliga anrop.
- Trackingpixel (`invoices/tracking.controller.ts:28`) lämnar ingen faktura-PDF. `apps/api/src/public/` har config/plans, inte avi-/fakturaleverans.
- Kontrakts-, besiktnings- och månadsrapport-PDF är andra dokument. Generisk dokumentleverans kan lagra godtyckliga uppladdade byte (`documents/document-delivery.service.ts:97`); kategorin INVOICE blir OTHER. Ingen tillförlitlig ConsumptionCharge-identitet kan härledas ur godtyckliga filbyte. Detta är ett uttryckligt kvarstående innehållsproblem, inte ett skyddat flöde.
- Generiska signerade dokumentlänkar (`documents/documents.service.ts:329`, `tenant-portal.controller.ts:565`) kan användas under giltighetstiden utan ny domänkontroll. Inga verkliga lagringsobjekt eller utfärdade länkar har undersökts.
- Betalning, tidigare bokföring, rättelse och reconciliation ligger utanför ändringsförslaget. Inga sådana ändringar har gjorts.
- Ingen runtimeinventering av Redis, R2, leverantörshistorik, proxy eller externa driftmanus har genomförts. Inga riktiga kunddata har lästs. Fullständig mängd dokumentinnehållsskrivare är ännu inte verifierad.

## Dokumentversion och ändringsytor

`Invoice.updatedAt` och `RentNotice.updatedAt` (`schema.prisma:1818,5020`) är inte versioner för hela dokumentet. Radmodellerna saknar versionsfält (:1986,5062); InvoiceLine saknar dessutom direkt charge-FK. Ett korrekt avläsningskontrollspår (`schema.prisma:7107`) identifierar inte mejlets faktiska PDF.

Verifierade radskrivningsfynd: **7 direkta ställen** (`misc-charges/misc-charge.service.ts:297`, `consumption.service.ts:639`, `invoices.service.ts:467,817,971`, `avisering.service.ts:2308`, `payment-reminder.service.ts:578`) och **3 nästlade** (`consumption.service.ts:728`, `invoices.service.ts:363,475`). Antalen avser dessa fynd, inte alla tänkbara innehållsändringar.

Även krediter, mottagare, organisation, bankgiro, mall och logotyp påverkar dokumentet (`avisering.service.ts:1013`, `invoices/pdf.service.ts:135`, `organizations/organizations.service.ts:200,260`). Fakturaworkern läser mejldata före ett separat PDF-uppslag (`invoices.service.ts:1655,1681`): dessa två uppslag är inte ett atomiskt dokumentsnapshot. Att bara lägga ett updatedAt-villkor på dokumentraden räcker därför inte.

## Beslut och invariants som kräver vidare bygge

Detta är designkrav/förslag, **inte implementerade garantier**:

1. Ett oföränderligt beslut måste binda organisation, aktör, berörda charge/check-ID:n/revisioner, fingerprint/regelversion, exakt dokumentversion/innehåll, mottagare och utskicksidentitet. Klienten får inte leverera egna bevis. Även service-, cron- och AI-vägar behöver serverkontrollerad aktörsgrund.
2. Beslut och köläggningsavsikt måste sparas atomiskt under samma samordning som relevanta underlagsändringar. Ingen generell SQL-outbox hittades. RentNoticeSend (:5126) är utskicksidentitet/korrelation för påminnelse, inte en återupptagbar outbox.
3. Redis-jobbet transporterar ett redan fattat beslut. Worker verifierar exakt detta beslut och dokument; den får inte godkänna nytt underlag. Ändring före leveransstart ger beständigt konfliktutfall och inget leverantörsanrop, även för ett redan köat jobb.
4. Identiteten per debitering/dokument/utskick behöver icke-nullbar unikhet och organisationsbindning. Om befintlig unikhet utökas gäller CLAUDE.md:1996:s sentinelregel. Nya beslut får inte fyllas med påhittade historiska attester.
5. **Kan ett nytt leveransbeslut fattas för ett redan skickat dokument? Nej för det första originalutskicket.** Skapande måste avvisas; idempotent läsning av samma befintliga beslut är en annan operation och får inte orsaka en ytterligare leverans. Dagens fakturajobb tillåter SENT (nekar VOID/PAID, :1666), medan avijobbet avstår vid sentAt/SENT (:945). Befintlig omsändning måste få uttrycklig hantering; ett nytt beslut får inte smygas in som retry.
6. Gamla SENT-poster utan bevis får inget fabricerat godkännande. Gamla mejljobb saknar besluts-ID; originalfakturamail saknar till och med dokumentkorrelation (`mail.types.ts:79,120`, `mail.service.ts:24,489`). Frivillig ny metadata med genomsläpp när den saknas lämnar luckan öppen. Att stoppa alla oidentifierbara gamla fakturamail kan påverka vanliga fakturor; säker övergång som bevarar normalflöden är ännu inte fastställd.

## Oåterkallelig punkt och kvarstående leveranshinder

Den externa gränsen är när leverantören accepterar anropet från `mail.worker.ts:89` för sändning. Köläggning och lokal SENT-markering ligger före detta och får inte döpas om till faktisk leverans. Leverantörsacceptans bevisar heller inte mottagarens leverans eller läsning.

En kontroll följd av ett olåst nätanrop lämnar en samtidighetslucka. Ett transaktions-/sessionlås runt anropet räcker inte vid krasch: DB-låset kan släppas medan leverantören fortfarande accepterar ett redan överfört anrop. En sträng garanti kräver exempelvis ett **beständigt SENDING/UNKNOWN-tillstånd och en samordnad skrivspärr för det berörda underlaget/dokumentet**, som består vid krasch. En konkurrerande ändring måste då antingen vinna före leveransstart (jobbet blockeras), eller nekas/ordnas efter det pågående försöket. Ett fastnat/okänt försök får inte automatiskt återauktoriseras eller spelas om med ny nyckel.

Hur UNKNOWN kan avgöras utan dubbelleverans, och hur gamla oidentifierbara jobb säkert hanteras, måste verifieras innan aktivering. Kodkommentaren `mail.worker.ts:86` anger 24 timmars Resend-deduplikering; aktuellt leverantörslöfte och uppslag/återkallelseförmåga har **inte verifierats**. Rapporten gör därför inget sådant garantipåstående. En lång DB-transaktion runt Chromium löser inte detta.

Historiskt skäl till saknad outbox och fakturakorrelation: **INGEN DOKUMENTERAD ORSAK** i genomgången. PDF-köns avsaknad av statiskt jobb-ID har uttrycklig motivering (:12–14). Portalens kommentar (`tenant-portal.controller.ts:484`) motiverar PDF-generering utan R2-cache med antagen oföränderlighet efter SENT och kostnaden för cachekomplexitet; detta är en dokumenterad cachemotivering, inte ett verifierat leverans-/versionsbevis.

## Konservativ storleksbedömning före implementation

Säkerhetsgranskarens kärnbudget avser tillagda PLUS borttagna produktionsrader inklusive schema/SQL, utan tester och dokumentation:

| Del | Tillagda | Borttagna |
| --- | ---: | ---: |
| Modell, SQL och beständig skrivspärr | 140 | 0 |
| Beslut, snapshot och verifiering | 190 | 0 |
| Outbox och återstart | 70 | 0 |
| Slutlig worker och leverantörsutfall | 100 | 20 |
| Producenter, PDF-led och jobbtyper | 85 | 35 |
| Modulkoppling | 15 | 0 |
| **Summa uppskattad kärna** | **600** | **55** |

**Cirka 655 produktionsrader**, osäkerhetsintervall 600–850, redan före full hantering av nedladdning och närliggande krav-/exportvägar. Detta är en läsbar implementationsuppskattning, inte en uppmätt diff eller ett löfte om övre gräns. Ingen formatering, omflyttning eller minifiering har föreslagits för att dölja storlek.

Kodgranskaren uppskattar självständigt mailkärnan till 500–750 produktionsrader. Domängranskarens snävare tabell ger 420–610 produktionsrader, separat 180–260 test- och 40–70 dokumentationsrader. Domänens totalsiffra 640–940 får alltså inte felaktigt rapporteras som produktionsrader. Alla bedömningar passerar stoppgränsen; säkerhetsbudgeten beskriver även det svåra kraschutfallet.

## Föreslagen uppdelning — kräver ägarbesked

Tre delar inom utskicksarbetet, **ingen är PR 3/rättelsevägen**:

1. **PR 2a: beständigt beslut och dokumentidentitet.** Additiv modell/SQL, organisations-/chargebindning, versions-/snapshotkontrakt, unikhet och omvänd tillståndskontroll. Gemensamma beslutsmetoder med DB-prov. Inga inkopplade utskick. Preliminär budget 250–350 produktionsrader.
2. **PR 2b: outbox och exekvering över leverantörsgränsen.** Återupptagning med samma identitet, worker-verifiering, SENDING/UNKNOWN och skrivsamordning, styrda krasch-/samtidighetsprov. Ingen aktivering av ofullständiga kedjor. Preliminär budget 250–350 produktionsrader.
3. **PR 2c: samordnad inkoppling och hela flödet.** Alla överenskomna producenter/utlämningar, gamla köjobb, synliga konflikter, bevarade normalflöden, negativa prov och helflödesverifiering. Preliminär budget 250–350 produktionsrader; åtkomst-/påminnelse-/exportomfattningen måste preciseras före bygge och kan kräva omprövning av denna budget.

Varje del ska mätas konservativt före och under bygge; ny överträdelse utlöser nytt stopp. De första delarna måste vara inaktiva och får inte påstås stänga luckan. **Hela skyddet är en samordnad leverans först när samtliga inkluderade vägar verifierats.** En PR-stapel hindrar inte tekniskt att en tidigare PR mergas separat; ägaren måste styra den samordningen. Inga sådana nya PR:er har öppnats eller påbörjats. Detta förslag är inte ett tillstånd att leverera ett halvskydd.

## Oberoende granskning och invändningar

Tre separata läsgranskare användes enligt rollerna security-auditor, bokforings-expert och code-reviewer. Ingen körde tester eller ändrade filer. Detta är inte juridiskt godkännande och ersätter inte Claudes granskning/ägarens beslut.

- Säkerhet/samtidighet: beständigt kraschutfall och ändringsordning saknas; lås/outbox ensamt bevisar inte extern leverans. Infört som kvarstående designhinder, ingen halvåtgärd byggd.
- Dokument/domän: nedladdning, initialavi, påminnelser och export måste kartläggas; historisk visning får inte förväxlas med nytt kravbrev. Huvudagenten kompletterade en missad HTTP-rot (`POST /leases/with-tenant`) och nyanserade att SENT/OVERDUE inte bevisar faktisk leverans.
- Kod/test: äldre serialiserade payloads kan kringgå nya PDF-kontroller; updatedAt räcker inte; förväntade JA/NEJ måste vara oberoende. Dessa krav kvarstår för den föreslagna uppdelningen.
- Kodgranskaren har även läst den färdiga stopprapporten utan blockerande invändning. Ingen oenighet om stoppet. Exakt omfattning för historiska nedladdningar, närliggande utskick och hantering av okänt providerutfall är ännu inte avgjord.

## Verifierat, inte verifierat och arbetskopians ändringar

**Verifierat genom kodläsning:** arbetsyta/bas, listade anropskedjor, saknade beslutsfält/outbox, nuvarande tidiga SENT-skrivningar, angivna antal och storleksunderlag. **Implementerat:** endast denna lokala förinventeringsrapport. Inget nytt leveransskydd.

**Tester:** inga Jest-, typecheck-, DB-, kö-, webbläsar- eller leveransprov har körts eftersom stoppet inträffade före implementation. Ingen ny databas skapad; inga fixture-/radantal finns att redovisa. DB-specens två körningar och negativkontroll är inte utförda. Inga externa adaptrar har ens körts mockat i denna omgång. Testfacit är oförändrat. De begärda beteendeproven kvarstår efter eventuellt godkänd uppdelning.

**CI:** endast konfiguration läst. `.github/workflows/ci.yml:129,141,147` deployar migrationer, kör API-sviten och kontrollerar uttryckligen PR 1:s charge-gate.db.spec.ts. Det bevisar inte att några nya utskicksprov körts. Ingen ny HEAD, PR eller CI-körning finns och ingen grön CI hävdas för PR 2. PR #877 och dess historiska provresultat har inte ändrats eller körts om.

**Diff:** 0 tillagda/borttagna produktionsrader, 0 teständringar, 0 nya/ändrade migrationer. Totalt finns fortsatt 187 migrationsfiler. Enda nya filen är denna dokumentation: **195 tillagda, 0 borttagna dokumentationsrader**, ännu inte committad. `git diff --stat` för spårade filer är tomt; filens tillagda dokumentationsrader räknas separat med `wc -l` och `git diff --no-index --stat /dev/null <rapportfil>`.

**Leveransstatus:** ingen commit, push, ny PR, merge eller driftsättning. HEAD är fortsatt `9f879291dd039e404ba80b7266fbd53842a0b42b`. PR 2:s utskickshinder kvarstår. Arbete väntar på ägarens beslut om uppdelning.

## Vad grinden inte kan garantera

Ingen ny utskicksgrind är implementerad i denna omgång. Ett framtida korrekt tekniskt godkännande kan inte bevisa att en mänsklig bedömning är sann eller att mätaren visar rätt. Ett leverantörskvitto bevisar inte att mottagaren läst dokumentet. Redan utlämnade filer kan inte återtas genom en senare DB-kontroll. Godtyckliga uppladdade filer saknar säkert strukturerad charge-identitet. De begränsningarna får inte döljas av grön CI.
