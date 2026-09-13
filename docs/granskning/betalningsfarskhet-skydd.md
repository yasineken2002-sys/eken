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

Två slutkörningar och exakt-HEAD CI redovisas i leveransdelen när de är färdiga. Grön lokal körning innebär inte godkänt införande.
