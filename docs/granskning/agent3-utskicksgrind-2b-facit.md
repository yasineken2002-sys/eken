# PR 2b — fryst oberoende facit före implementation

Datum: 2026-09-11. Bas: `0973272d5eb8f6f8285ec8c98f039a47f6ec568b`.
Facit bygger på byggordern och den separata granskaren `granska_facit_2b`,
före produktionsändringar. Förväntningar får inte härledas från den kod som
ska provas. **Alla nedanstående 2b-prov är ännu okörda: budgetstopp.**

## Oförminskad obligatorisk mängd

Befintliga obligatoriska ID:n ska anges uttryckligen, oberoende av vad som
råkar finnas kvar i en testfil eller Jest-rapport:

```text
2a-01, 2a-02, 2a-03, 2a-04, 2a-05, 2a-06, 2a-07, 2a-08, 2a-09,
2a-10, 2a-11, 2a-12, 2a-13, 2a-14, 2a-15, 2a-16, 2a-17
```

Nya obligatoriska ID:n i detta facit:

```text
2b-01, 2b-02, 2b-03, 2b-04, 2b-05, 2b-06, 2b-07, 2b-08, 2b-09,
2b-10, 2b-11, 2b-12, 2b-13, 2b-14, 2b-15, 2b-16, 2b-17, 2b-18
```

CI ska kräva lyckad faktisk exekvering av varje ID i rätt svit samt av
sviten själv. Saknat, överhoppat, todo eller underkänt obligatoriskt prov
ska fälla kontrollen med namngivet ID. Även övriga förekommande prov ska
vara godkända. Denna dokumentlista är ännu inte en implementerad CI-spärr.

## Observerbart beteende

| ID | Scenario | Oberoende förväntning |
| --- | --- | --- |
| 2b-01 | Beslut och outbox lyckas | Samma commit innehåller ett beslut och en köavsikt med samma organisation, dokument och utskicks-ID; noll externa effekter före commit. |
| 2b-02 | Fel efter delskrivning respektive verkligt uppskjutet constraint-fel efter outboxskrivning | Anropet avvisas; beslut, medlemmar, händelser och outbox återgår till exakta tidigare radantal; transporten har noll anrop. Sista constraintkontrollen ska faktiskt fälla det uppskjutna felet. |
| 2b-03 | Omstart före köpublicering | Ny process hittar beständig avsikt och publicerar samma utskicksidentitet. |
| 2b-04 | Publicering lyckas men lokal kvittens uteblir; separat förlust av tidigare publicerat Redis-jobb | Återpublicering kan ge dubbla jobb med samma utskicksidentitet; högst en vunnen start. DB kan återställa transporten utan att jobbhistorik blir affärsminne. |
| 2b-05 | Dubbla jobb och två faktiskt överlappande workers | Exakt ett beständigt SENDING/försöks-ID och exakt ett leverantörsanrop i lyckat kontrollfall. Visa deltagande anslutningar och faktisk blockering före barriärsläpp. |
| 2b-06 | Beslut → aktuell bedömning INCORRECT → jobb | Beständig identifierbar konflikt; noll leverantörsanrop; gammalt beslut skrivs inte om. Ändringen görs genom verklig domän-/skrivsamordning. |
| 2b-07 | Beslut → återkallelse → gammalt jobb | REVOKED kvarstår och noll leverantörsanrop. |
| 2b-08 | Verkligt existerande fel organisation, dokument eller mottagare, inklusive fel artefakt från annan giltig operation | Alla korskopplingar avvisas utan partiell effekt; ett saknat UUID räcker inte som fixtur. |
| 2b-09 | Utbytta PDF-byte, mejlbyte eller återanvänd lagringsnyckel, även resursbyte mellan beslut och framställning | Det ursprungligen bundna bytebeviset avvisar substitutioner före anrop; framställning får inte använda senare utbytta resursbyte. Separat positivt kontrollfall skickar de exakt bundna byten. |
| 2b-10 | Relevant ändring vinner mot start | Ändringen committar; start nekas med beständig konflikt och noll anrop. Ordningen bevisas med verkliga transaktioner. |
| 2b-11 | Start vinner mot relevant ändring | SENDING är committat före anrop; ändringen får inte committa under SENDING/UNKNOWN. |
| 2b-12 | DB-session försvinner medan provideranropet väntar | Låset får försvinna, men beständigt SENDING/UNKNOWN stoppar ny ändring och nytt försök; det redan pågående externa anropet kan fortfarande slutföras. Anslutningsförlust och samtidigt pågående anrop måste observeras. |
| 2b-13 | Krasch efter SENDING, före provideranrop | Återstart skickar inte automatiskt; dokumentposition och försöks-ID bevaras och osäkerheten registreras konservativt. |
| 2b-14 | Simulerad acceptans följd av krasch respektive misslyckad lokal kvittolagring | Inget automatiskt omutskick; återstart når/bevarar UNKNOWN med samma korrelation. Ett sent svar kringgår inte kravet på mänsklig utredning. |
| 2b-15 | UNKNOWN efter omstart, faktisk tidspassage, Redis-tömning, leaseutgång och ny nyckel | Ingen frigöring, omsändning eller ny originaloperation. Rapportera faktisk observerad tid; kort förflyttning är inte ett dygns uthållighetsprov. |
| 2b-16 | UNKNOWN får utfallsuppgift utan mänsklig utredning eller tillräckligt korrelerat slutbevis | Avvisas och UNKNOWN kvarstår. Timeout, tomt uppslag och saknat kvitto är otillräckligt. Negativ upplösning måste även utesluta senare anrop från gammal auktoriserad process. |
| 2b-17 | Accepterat original och uttryckligen godkända fakturaomsändningar | Två successiva omsändningar får egna beslut, utskicks-ID:n, artefaktbindningar och försök; permanent originalposition bevaras. Exakt replay skapar ingen ytterligare effekt; nytt ORIGINAL och aviomsändning nekas. |
| 2b-18 | Workerprincipal och gammal återupptagen worker | Ingen påhittad User; endast behörig tjänst kan verifiera/verkställa befintligt beslut. Tjänsten får inte fatta nytt godkännande eller lösa UNKNOWN. Gammalt jobb utan vunnen start får ingen rätt genom lease/replay. Pausad tidigare vinnare före anrop får inte leda till ersättningssändning eller osamordnad ändring. |

2a:s A–D förblir egna obligatoriska prov. 2b-17 kontrollerar även den
omvända riktningen: två legitima omsändningar får inte felaktigt slås ihop.

## Verkliga komponenter och kontrollerade gränser

Den framtida riggen ska köra produktionsklasserna, verklig Prisma och riktig
isolerad PostgreSQL med samtliga oförändrade produktionsregler. Den ska
skapa egna organisationer, dokument, charges och bedömningar via verkliga
primitiver. Transport och provider ersätts vid uttryckliga portar för att
styra publicering, acceptans, paus och fel utan riktiga utskick.

Om renderer eller objektlagring också ersätts måste rapporten säga det.
Syntetiska utdata kan pröva kärnans bindning och substitutionsskydd men
bevisar inte att verklig faktura-/avirendering använder rätt frysta underlag.
Den senare kedjan behöver ett eget verkligt framställningsprov innan den
kan kallas verifierad. Inget syntetiskt leverantörsprov är ett driftbevis.

Samtidighet ska använda separata enanslutningsklienter, fånga deras PID:n
och kräva att `pg_blocking_pids(secondPid)` innehåller just `firstPid` innan
barriären släpps. Providerporten ska signalera påbörjat anrop och vänta.
Endast workeranslutningens verifierade PID i den egna isolerade DB:n får
avslutas för felinjektionen. Sessionens bortfall ska observeras medan
providerporten fortfarande väntar. Därefter prövas en annan worker och en
ny skrivare via egna anslutningar före svar från providern.

Ingen DB-fence kan ensam bevisa revokering av kod som redan passerat sista
kontrollen. Provet skiljer därför gammalt jobb utan start från redan
auktoriserat fördröjt anrop; det senare kräver kvarhållen reservation och
verifierad extern finalitet innan negativ upplösning, se kontraktet.

Två fullständiga DB-körningar ska använda samma egna testdatabas med hela
migrationskedjan och separata UUID-scheman. Mät public-baslinjens tabeller,
radantal och extension före/efter, samt alla egna fixturrader före städning.
Koppla ned klienterna och ta endast bort respektive eget schema. Inga
produktionsregler stängs av för fixturer eller städning. Före Jest/typecheck
körs `pgrep -af '[j]est|[t]sc'`; ett tungt lokalt jobb i taget.

## Två negativa bevis med olika syfte

CI-kanariefågeln ska utföras först efter att en fungerande ratchet med alla
17 ID:n och alla prov sparats i en vanlig commit. Utkast-PR måste finnas:
nuvarande workflow kör på pull_request, men branch-push bara på main.

1. Ta bort hela själva 2a-17-provet i en ny commit på den egna grenen.
2. Pusha endast den grenen och verifiera CI-körningens exakta headSha.
3. Kräv lyckad testexekvering med de 16 kvarvarande 2a-proven och rött steg
   `Verify delivery decision DB assertions actually passed` med namngivet
   saknat `2a-17`. Kompileringsfel eller andra fel är inget sådant bevis.
4. Återställ endast provet från den sparade versionen i ännu en vanlig
   commit. Pusha och länka dess gröna CI. Ingen historikomskrivning.
5. Verifiera också slutlig 2b-HEAD efter eventuella senare ändringar; tidigare
   återställd grön körning är inte slutbevis för annan kod.

Den lokala beteendenegativkontrollen ska rikta sig mot byteverifieringen i
2b-09. Spara först fungerande implementation i commit. Ta tillfälligt bort
endast det skyddet och kräv att substitutionsprovet faller på beteende:
fel byte passerar eller förväntat avslag uteblir. Återställ den namngivna
filen och kontrollera tom diff mot sparad produktionsversion. Försvagningen
får aldrig committas eller pushas. Ordinarie DB-körning ska därefter bli grön.

Ingen av negativkontrollerna har utförts vid detta budgetstopp. Inga röda
eller återställda gröna CI-länkar kan därför redovisas som bevis ännu.
