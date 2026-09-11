# PR 2b — fryst oberoende facit före implementation

Datum: 2026-09-11. Bas: `0973272d5eb8f6f8285ec8c98f039a47f6ec568b`.
Facit bygger på byggordern och den separata granskaren `granska_facit_2b`,
före produktionsändringar. Förväntningar får inte härledas från den kod som
ska provas. **Alla nedanstående steg 1-prov är ännu okörda vid denna frysning.**

Byggordern STEG 1, 2026-09-11, ändrar öppet det tidigare facitet före SQL:
2b-12–16 och 18 tillåter nu begränsat identiskt omanrop och endast positiv
verifierad retryupplösning av UNKNOWN. Versionen vid `6524b68f` bevaras i
historiken. 2a-01–17 och A–D bevaras; den generiska mänskliga vägen utan
utredning ska fortfarande nekas. Kontraktets exakta tider, budget och
hantering av sena kvitton är en del av dessa förväntningar.

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
2b-10, 2b-11, 2b-12, 2b-13, 2b-14, 2b-15, 2b-16, 2b-17, 2b-18,
2b-19, 2b-20, 2b-21, 2b-22, 2b-23, 2b-24, 2b-25, 2b-26, 2b-27,
2b-28, 2b-29, 2b-30
```

CI ska kräva lyckad faktisk exekvering av varje ID i rätt svit samt av
sviten själv. Saknat, överhoppat, todo eller underkänt obligatoriskt prov
ska fälla kontrollen med namngivet ID. Även övriga förekommande prov ska
vara godkända. Varje obligatoriskt prov måste ha positivt faktiskt
assertionstal (`numPassingAsserts > 0`), exakt en match och rätt svit.
Funnen fil, tom testfunktion, skip, todo och dubbelt ID räcker inte.
Kravlistorna ska vara bokstavliga i CI, aldrig härledda ur specen. Denna dokumentlista är ännu inte en implementerad CI-spärr.

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
| 2b-12 | DB-session försvinner medan provideranropet väntar | Beständig SENDING/UNKNOWN stoppar deltagande skrivare och ny attempt även när sessionslåset försvinner. Samma attempt får endast tillåtet identiskt omanrop. Observera frånkoppling medan anropet verkligen pågår. |
| 2b-13 | Krasch efter SENDING före anrop | Återstart behåller t0, attemptId och skrivspärr. Identiskt omanrop inom fönstret kan skapa den enda provideracceptansen. Ingen ny start eller nytt beslut. Utan FIRST-observation räknas första retry från t0; högst tre RETRY, aldrig ny FIRST. |
| 2b-14 | Acceptans med tappat svar eller misslyckad kvittolagring | Återstart bevarar UNKNOWN och korrelation. Tillåten identisk retry kan ge två nätanrop men en acceptans och samma mejl-ID. Sent originalkvitto utan retry ger inte tjänsten utredningsrätt. |
| 2b-15 | UNKNOWN över omstart, tid, Redis-tömning, lease och ny nyckel | Ingen ny attempt, ORIGINAL eller INVOICE_RESEND. t0/deadline återställs aldrig. Efter stängning inga nya POST och UNKNOWN kvar. Separera simulerad tid från faktisk väntetid. |
| 2b-16 | UNKNOWN får otillräckligt bevis | Godtycklig ACCEPTANCE-JSON, negativ retry, timeout, 404 och saknat kvitto ger inget slututfall. Endast verifierat positivt svar från tillåten identisk retry får ge maskinell acceptans; mänsklig negativ utredning kräver 2a:s finalitet. |
| 2b-17 | Accepterat original och uttryckligen godkända fakturaomsändningar | Två successiva omsändningar får egna beslut, utskicks-ID:n, artefaktbindningar och försök; permanent originalposition bevaras. Exakt replay skapar ingen ytterligare effekt; nytt ORIGINAL och aviomsändning nekas. |
| 2b-18 | Principaler och gammal worker | Egen organisationsbunden tjänstrad/FK-gren krävs; annan org, inaktiv principal, SYSTEM och människas User-ID nekas. Jobbet kan inte välja principal. Tjänsten får starta/registrera utfall samt snäv positiv retryupplösning, aldrig besluta/återkalla/utreda. Övertagen tx ger ingen nätanropsrätt. |
| 2b-19 | Original accepterat, svar tappat, ny exekverarinstans | Två POST, exakt en provideracceptans, samma ID och byte; UNKNOWN löses med sparad RETRY-korrelation. |
| 2b-20 | Original nådde aldrig provider | Identisk retry använder ursprungligt beslut, attemptId och spärr; den får skapa den enda acceptansen. |
| 2b-21 | Samtidiga omanrop och pågående 409 | Faktisk DB-samordning; högst fyra beviljade anrop totalt och minimiintervall 1/5/30 s. 409 är alltid olöst. Samma slutliga mejl-ID; count/t0 överlever ny process. |
| 2b-22 | 409 innehållskonflikt | Beständig avvikelse/stängning; UNKNOWN kvar; noll nya POST därefter. Inget byte av key eller innehåll för att kringgå konflikten. |
| 2b-23 | Byte av team, metod, endpoint, attemptId, body | Riktiga DB-bindningar och anropsport avvisar varje byte, även självkonsekventa korskopplingar till existerande rader. Global attemptunikhet och UUID-format provas i DB. |
| 2b-24 | Precis före, vid och efter deadline | Strikt före kan beviljas. Likhet/senare nekas och committar beständigt EXPIRED även när operationen rapporterar avslag. Inget bakgrundsjobb behövs. |
| 2b-25 | Stängt över klientomstart och ny köleverans | Samma t0/deadline/stängningshistorik; inga nya auktoriserade POST, UNKNOWN kvar utan senare slutbevis. Ny klockavläsning öppnar inte stängt fönster. |
| 2b-26 | Paus före respektive efter sista kontroll | Före: återupptag vid deadline stoppar POST. Efter: visa uttryckligen att redan auktoriserat anrop kan nå provider efter 24h och möjliggöra ytterligare acceptans när transportantagandet bryts. Ingen ovillkorlig garanti påstås. |
| 2b-27 | Sena, felkorrelerade och motstridiga kvitton | Alla observationer bevaras utan återöppning. Positivt svar från tidigare tillåten RETRY får lösa UNKNOWN; sent original kräver människa. Fel grant/scope eller annat slutligt ID sparas som avvikelse. |
| 2b-28 | Dokument-/charge-spärrens båda riktningar | Dokument och frysta/aktuella charge-medlemmar skyddas över startanslutningens förlust. Annat obesläktat dokument i samma org får committa. Attach/detach får inte kringgå medlemskontrollen. |
| 2b-29 | Återanvändbart rendererportkontrakt | Identiska frysta data/resurser ger exakt samma fullständiga resultat över ny instans. Separata timestamp-, slump-, filnamns- och enbytesmutanter fäller kontraktsprovet. Detta bevisar inte verklig renderer. |
| 2b-30 | Resursbyte bakom samma lagringsnyckel | Fel resursbyte mot förväntad digest nekas före försegling; försök att byta sparade bytes nekas efter commit. Bytt innehåll bakom live-nyckeln påverkar däremot inte retry som läser sparade bytes med noll render-/lagringsuppslag. |

2a:s A–D förblir egna obligatoriska prov. 2b-17 kontrollerar även den
omvända riktningen: två legitima omsändningar får inte felaktigt slås ihop.

## Verkliga komponenter och kontrollerade gränser

Den framtida riggen ska köra produktionsklasserna, verklig Prisma och riktig
isolerad PostgreSQL med samtliga oförändrade produktionsregler. Den ska
skapa egna organisationer, dokument, charges och bedömningar via verkliga
primitiver. Transport och provider ersätts vid uttryckliga portar för att
styra publicering, acceptans, paus och fel utan riktiga utskick.

Renderer och lagring ersätts uttryckligen av betrodda syntetiska portar i steg 1.
Providern är en simulering med separat kontrollerad tid, 24-timmarscache,
pågående anrop, innehållskonflikt och tappat svar. Den räknar nätanrop och
nya acceptanser separat. Transportantagandet får brytas endast i det
uttryckligt negativa pausfallet 2b-26, vars effekt ska redovisas öppet.
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

Ingen av negativkontrollerna har utförts vid denna frysning före implementation. Inga röda
eller återställda gröna CI-länkar kan därför redovisas som bevis ännu.
