# Betalningsfärskhet nivå 1 — design före schema

2026-09-13. Byggorder: registrerat första importförsök utan täckningsdatum pausar skyddade automatiska krav. Egen gren från reproduktionsbeviset 88d5fc38, produktbas 3b71e905. Ingen merge eller aktivering beställd.

## Beslut och avgränsning

Organization.paymentImportStartedAt är ett oföränderligt förstvärde. NULL betyder att registrerat försök saknas, aldrig bevis för manuellt arbete eller färsk bankdata. Markör + NULL täckningsdatum pausar; utan markör kvarstår dagens passage; med datum kvarstår den befintliga åldersregeln. Ingen ny filkvittens, inställning eller matchningsregel.

Registreringen äger en kort ReadCommitted-transaktion och måste committa före filvalidering, parser, kö eller provider. Ett misslyckat lagringsförsök stoppar fortsatt import. Controller och tjänst använder samma idempotenta förstmarkör, inte två händelser. Historiska BankStatementImport-rader kan ge sitt verkliga MIN(uploadedAt); gamla ospårade CSV/BgMax-försök kan inte återskapas. Alla historiska statusar är försök i den uppmätta produktkedjan, inte intyg om täckning. MIN(uploadedAt) är tid för första bevarade försöksrad, inte bevis för faktisk start; api-raden skrivs efter synk och bevisar inte ACTIVE-samtycke eller providerkontakt. Någon schemalagd köproducent finns inte på denna bas: den befintliga API-kön startas av explicit behörig POST sync.

## Samtidighet och effektgräns

Markör och varje skyddad effekt tar samma organisationsbundna advisory transaction lock i namespace payment-freshness innan avi-, konto- eller sekvenslås. Effekterna tar delat lås, markören exklusivt, så oberoende effekter behöver inte serialiseras av färskhetsgrinden. Effekterna inför inget organisationsradlås. Markörens vanliga UPDATE tar ett kort radlås; samordningen med effekterna sker med advisory-låset. Efter låsväntan läses organisationen i ett separat ReadCommitted-statement. Root-klient och annan isolering avvisas av effektporten. Vinnande markör stoppar effekten; vinnande effekt får committa och markören blockerar senare effekter. Låset bevisar inte global frihet från befintliga avi/sekvens-deadlocks.

Skyddet gäller påminnelseavgift, ränta, inkasso-redo och automatisk befarad kundförlust. Ränta har en egen transaktion och kontrolleras separat. Manuell befarad kundförlust bevarar sin befintliga väg och får ingen dold ny arbetsflödespolicy. En sen paus räknas som paus, inte systemfel. Redan committad avgift/avsikt eller redan köat mejl återkallas inte. Larm ligger utanför pengatransaktionen.

Monotont framflyttade täckningsdatum behåller sin gamla skrivväg. De kan bara förbättra underlaget, så en samtidig framflyttning kan ge en konservativ extra paus. Bakåtskrivning/nollställning stöds inte av denna samtidighetsmodell.

## Ingångar

Tre autentiserade uppladdningshandlers före req.file; direkta CSV/BgMax/PDF-tjänster; PDF-confirm efter organisationsbunden uppslagning; behörighetskontrollerad AI-BgMax före base64; explicit PSD2-sync före köläggning; sync med minst ett ACTIVE-samtycke före dekryptering/provider. Anslutningsstart, callback och oautentiserade/proxy-avvisade begäranden intygar inget försök.

## Vad detta inte bevisar

Ett befintligt datum är fortfarande inte ett fullständighetsbevis. CSV med giltigt datum men ogiltigt belopp, partiell import och tom PSD2 utan datum ska särredovisas. Den senare förblir pausad. Inga syntetiska datum eller lastSyncedAt skrivs som täckning. Historiska försök + NULL kan även pausa någon som senare arbetat manuellt; införandet kräver en läsande inventering och separat ägarbeslut, inget tyst undantag.

## Bevisplan

Bevara #889 som fryst röd bas. F02–F05 blir gröna med oförändrat säkerhetsfacit; F01/F06–F08 bevarar beteenden. Markörens ordning och persistens, tidiga HTTP-fel, läsning efter låsväntan i båda riktningar och mellan olika organisationer, root/RepeatableRead-avvisning samt faktisk cron/DB-effekt prövas. Två isolerade DB-körningar med fixturräkning; sparad commit före beteendemutation; återställning och grön CI för exakt HEAD. Ingen produktionsdatabas eller verkligt utskick används.

## Införandespärr

Ingen aktivering eller driftgaranti med blandade kodversioner. Gammal worker kan ignorera markören och gammal importer kan skriva ett försök efter backfill utan markör. Före införande måste berörda gamla producenter och kravworkers stoppas/dräneras eller avskärmas på annat verifierat sätt, sedan migrering och verifierad versionsväxling. Backfill måste köras efter sista gamla importen. Detta bygge utför inte produktionsövergången.

## Uppmätt på implementation 87c6685a

Första körningen: 23/23 riktiga PostgreSQL-prov, 144/144 berörda enhetsprov inklusive HTTP/JWT/rollkontroll, 9/9 webbtextprov och grön API-typkontroll. F12 fälldes på expectPaused när endast effektgrindens beslut avaktiverades; det verkliga försöket gav då avgift. Exakt fil återställd från 87c6685abbcff8f2a119e7ad889888a27b7007a5, sha256 b3ce620df692ee13875abecfd43251d1258af484b2e1db803932cb9f90ad3ac0. Negativkörningens 22 ej valda fall är avsiktlig testfiltrering, inte en full svit.

Migrationen provades från 184 tidigare migrationer med tre egna organisationer och tre verkliga historikrader i isolerad PostgreSQL. Äldsta pdf-försöket valdes, utan historik förblev NULL, befintligt datum bevarades. UPDATE till NULL/annat förstvärde avvisades; oförändrat värde/annat organisationsfält tilläts. Samtliga sex egna rader städades. Alla 185 migrationer applicerade; ingen kunddatabas användes.

Lokala tredjeparter lånades från befintlig pnpm-cache, med egen genererad Prisma 5.22-klient och egna byggda shared/ui. Låsfilsskillnaden mot cachen är en extra deklaration av yaml 2.8.2 i API-importern, inga andra versionsskillnader. CI måste därutöver verifiera grenens verkliga frysta låsfil på ren runner.

## Slutverifiering lokalt 2026-09-13

De sparade `live/farskhet-skydd-db-slut-1.log`/`.json` och `live/farskhet-skydd-db-slut-2.log`/`.json` har lästs efter återstarten. Båda visar 23/23 godkända prov, noll fallerade, noll överhoppade och noll runtime-fel. De kördes mot den egna isolerade databasen `eveno_farskhet_test` på port 55439. Dessa resultat hör till implementationen i 87c6685a; senare CI-rättelse redovisas nedan.

Radantalen är identiska före och efter i båda körningarna, tabell för tabell över 106 tabeller: `_prisma_migrations=185`, `CustomerNumberSequence=1`, `ReferenceInterestRate=1`, övriga 103 tabeller noll. Det är totalt 187 rader inklusive migrationshistoriken, två utan den. Inga organisations- eller importfixturer finns kvar efter städningen. Loggarna räknar före/efter, inte det sammanlagda antalet skapade fixturrader under körningen; lika radantal intygar inte äldre raders innehåll.

Negativkontrollens JSON bekräftar ett fallerat F12 och 22 avsiktligt ej valda fall. När endast effektgrindens beslut avaktiverades skapades 60 kr avgift, ett event, ett verifikat och ett köjobb; `pausedStale` blev 0. Vid återläsningen inför c0f62025 var den återställda produktionsfilen byteidentisk med implementationscommitten och hade ovan angiven SHA-256. Båda gröna slutkörningarna följde efter återställningen.

De tre cron-spionerna i `rent-bad-debt.service.spec.ts` har flyttats till `automaticallyReclassifyToProbableLoss`, med två argument. Beteendefacitet för moms, saknad bokförd fordran och paus är bevarat; direkta manuella provanrop kvarstår. Övriga anrop och konstruktionsriggar för aviseringstjänsterna har kontrollerats. PSD2-provet i `import-entry-boundary.spec.ts` väntar nu på en kontrollerad mock-promise och kräver att kön inte anropas innan den upplöses. Rubriken beskriver portordningen, inte DB-commit.

Ny seriell körning: `rent-bad-debt.service.spec.ts` 21/21 och `import-entry-boundary.spec.ts` 41/41, tillsammans 62/62, noll överhoppade. Dessa överlappar den tidigare körningens 144 prov och ska inte adderas som unika prov. Riktad ESLint över samtliga 27 ändrade TypeScript-/TSX-filer mot reproduktionsbasen passerade med `--max-warnings=0`. API-typkontrollen har också körts om efter återstarten med exit 0 och noll diagnostik. Nya loggar/JSON finns lokalt i `.proof-betalningsfarskhet-leverans/`. Före Jest/tsc utfördes både pgrep-kontroll och `live/farskhet-tunga-processer.py`; inga andra Jest/tsc körde.

## CI-fångade rättelser och omprov

Första fulla CI på c0f62025 ([34750475140](https://github.com/yasineken2002-sys/eken/actions/runs/34750475140)) hittade transaktionsvaktens ej igenkända optionsobjekt och åtta fallerade prov i två äldre sviter (473 sviter/5779 prov passerade). DB-reproduktionsspecen kördes och passerade, men detta var inte grön CI.

I 5fbed8bb väljer samtliga fem berörda transaktionsanrop `PRISMA_DEFAULT_TX_LIMITS` uttryckligt. `paymentFreshnessTransactionOptions` tillför ReadCommitted till de valda tidsgränserna. Timeout 5000 ms, maxWait 2000 ms och isolering är desamma som före rättelsen. Transaktionsvakten, dess självprov och kvitteringar har inte ändrats; både självprov och skarp vakt passerar.

I ca69d8f0 kompletteras OCR-proveniensriggens mock med `recordImportStarted`, och organisationspartitionen klassificerar den nya interna förstmarkören som medvetet utelämnad från den allmänna organisationsvyn. Ingen matchningsassertion, parserregel, API-select eller partitionsgrind ändras. Dessa två sviter passerar 14/14. De nio övriga berörda enhetssviterna har körts seriellt efter produktionsrättelsen: 165/165. API-typkontrollen passerar också med exit 0.

Ny F12-negativkontroll gjordes efter sparad ca69d8f0: endast effektbeslutet avaktiverades, och exakt ett valt prov föll på `expectPaused` med 60 kr avgift, ett event, ett verifikat och ett köjobb. De 22 ej valda fallen är filtrering. Filen återställdes byte-för-byte från den sparade versionen; slutlig SHA-256 är `557a258a770119abc0515028af74b1d81763cc07266b47b43b5c2ac5db14d210`. Nya loggar/JSON ligger i `.proof-betalningsfarskhet-leverans/` (`enhetsprov-slut`, `ci-riggprov`, `typkontroll-slut`, `negativ-slut`).

Efter den nya återställningen passerade två fulla seriella DB-omprov, `db-slut-3` och `db-slut-4`, 23/23 vardera med noll överhoppade. Båda har samma verifierade före-/efterantal som de sparade första slutkörningarna: 106 tabeller, 187 rader inklusive 185 migrationsrader, endast en kundnummersekvens och en referensränta därutöver. Riktad slutlint över alla 29 ändrade TS/TSX-filer passerar med `--max-warnings=0`. Endast egen märkt testcontainer på port 55439 startades för omproven; inga andra databaser användes. Samtliga nya Jest/tsc-körningar föregicks av de båda processkontrollerna.

## Bevisgränser vid leverans

- F15 injicerar ett fel i markörporten före parser/importhistorik. Det är inte ett verkligt DB-commitfel.
- F22 prövar den uttryckliga manuella tjänstevägen med riktig DB. Det prövar inte HTTP-behörighet för manuell kundförlust.
- F23 prövar att två effektportar kan passera delat lås inom samma organisation utan bokföring. Det intygar inte generell parallell bokföringskapacitet eller frihet från andra låskonflikter.
- PSD2-portordningsprovet har mockad lagring och kö; beständighet och verklig samtidighet bärs av DB-proven.
- F19 förblir en öppen risk: giltigt CSV-datum plus felaktigt belopp kan fortfarande flytta täckningsdatum och tillåta avgift. Fullständighet, matchning, parser, belopp, allokering och nivå 2:s manuella policy utökas inte i detta bygge.

Full CI på ren runner med grenens frysta låsfil och verkligt utförda DB-prov ska redovisas för exakt slutlig HEAD i utkast-PR:ens leveransrapport. Ovanstående är lokala resultat. #889 förblir det röda reproduktionsbeviset och ska inte mergas först. Ingen merge, deploy, aktivering eller framåtpropagering ingår. Införandespärren för gamla och nya producenter/workers kvarstår även efter grön CI.
