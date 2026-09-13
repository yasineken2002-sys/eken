# Betalningsfärskhet nivå 1 — design före schema
2026-09-13. Byggorder: registrerat första importförsök utan täckningsdatum pausar skyddade automatiska krav. Egen gren från reproduktionsbeviset 88d5fc38, produktbas 3b71e905. Ingen merge eller aktivering beställd.

## Beslut och avgränsning
Organization.paymentImportStartedAt är ett oföränderligt förstvärde. NULL betyder att registrerat försök saknas, aldrig bevis för manuellt arbete eller färsk bankdata. Markör + NULL täckningsdatum pausar; utan markör kvarstår dagens passage; med datum kvarstår den befintliga åldersregeln. Ingen ny filkvittens, inställning eller matchningsregel.

Registreringen äger en kort ReadCommitted-transaktion och måste committa före filvalidering, parser, kö eller provider. Ett misslyckat lagringsförsök stoppar fortsatt import. Controller och tjänst använder samma idempotenta förstmarkör, inte två händelser. Historiska BankStatementImport-rader kan ge sitt verkliga MIN(uploadedAt); gamla ospårade CSV/BgMax-försök kan inte återskapas. Alla historiska statusar är försök, inte intyg om täckning.

## Samtidighet och effektgräns
Markör och varje skyddad effekt tar samma organisationsbundna advisory transaction lock i namespace payment-freshness innan avi-, konto- eller sekvenslås. Inget organisationsradlås införs. Efter låsväntan läses organisationen i ett separat ReadCommitted-statement. Root-klient och annan isolering avvisas av effektporten. Vinnande markör stoppar effekten; vinnande effekt får committa och markören blockerar senare effekter. Låset bevisar inte global frihet från befintliga avi/sekvens-deadlocks.

Skyddet gäller påminnelseavgift, ränta, inkasso-redo och automatisk befarad kundförlust. Ränta har en egen transaktion och kontrolleras separat. Manuell befarad kundförlust bevarar sin befintliga väg och får ingen dold ny arbetsflödespolicy. En sen paus räknas som paus, inte systemfel. Redan committad avgift/avsikt eller redan köat mejl återkallas inte. Larm ligger utanför pengatransaktionen.

Monotont framflyttade täckningsdatum behåller sin gamla skrivväg. De kan bara förbättra underlaget, så en samtidig framflyttning kan ge en konservativ extra paus. Bakåtskrivning/nollställning stöds inte av denna samtidighetsmodell.

## Ingångar
Tre autentiserade uppladdningshandlers före req.file; direkta CSV/BgMax/PDF-tjänster; PDF-confirm efter organisationsbunden uppslagning; behörighetskontrollerad AI-BgMax före base64; explicit PSD2-sync före köläggning; sync med minst ett ACTIVE-samtycke före dekryptering/provider. Anslutningsstart, callback och oautentiserade/proxy-avvisade begäranden intygar inget försök.

## Vad detta inte bevisar
Ett befintligt datum är fortfarande inte ett fullständighetsbevis. CSV med giltigt datum men ogiltigt belopp, partiell import och tom PSD2 utan datum ska särredovisas. Den senare förblir pausad. Inga syntetiska datum eller lastSyncedAt skrivs som täckning. Historiska försök + NULL kan även pausa någon som senare arbetat manuellt; införandet kräver en läsande inventering och separat ägarbeslut, inget tyst undantag.

## Bevisplan
Bevara #889 som fryst röd bas. F02–F05 blir gröna med oförändrat säkerhetsfacit; F01/F06–F08 bevarar beteenden. Markörens ordning och persistens, tidiga HTTP-fel, läsning efter låsväntan i båda riktningar och mellan olika organisationer, root/RepeatableRead-avvisning samt faktisk cron/DB-effekt prövas. Två isolerade DB-körningar med fixturräkning; sparad commit före beteendemutation; återställning och grön CI för exakt HEAD. Ingen produktionsdatabas eller verkligt utskick används.
