# Fortsättning av steg 2.1 — kontrakt före rättningar

Ägarordern höjer taket till 550 ändrade produktionsrader och lägger till en
uttrycklig kodgräns samt beständig konflikt för väntande DECIDED. Tidigare
kontrakt, före-filer, manifest och stopprapport är historik och bevaras.
Säkringscommit `9a3305e64ed2753e64d192e9f69b48dd20bb722d` innehåller utkastet
oförändrat: 373 tillagda + 67 borttagna rader i elva produktionsfiler.
Enbart dess lokala formateringshook stängdes av för att följa kravet SOM DE ÄR;
inga CI-kontroller har stängts av eller försvagats.

## Avgränsad identitet

Fasta, namngivna appfiler binder mallkärnor, mallhjälpare, kontext och inställningar.
Motorpaketrötterna är uttryckliga. Bara deras deklarerade produktionsberoenden
och relevanta peers ingår; varje beroende löses från sitt verkliga föräldrapaket.
Detta är ingen vandring i tjänsternas importer, module.children eller require.cache.
Paket dedupliceras efter faktisk installationsrot, inte bara namn: flera versioner
av samma motor kan användas samtidigt. Manifestet redovisar resolverade absoluta
sökvägar, beroendekanterna och faktiska innehållsdigester. Installationssökvägen
kan alltså påverka identiteten. Dynamisk react-dom/server ingår genom paketets bytes.

Hela utpekade filer/paket innebär konservativ identitet: också en semantiskt
likvärdig omskrivning eller orelaterad metod INOM filen kan ge ny identitet.
En util UTANFÖR den deklarerade gränsen kan inte utöka den genom en serviceimport.
Käll-/motorinstallation måste förbli oföränderlig under processens livstid.
Den kontrollerade browsern har separat ägande men samma innehålls- och PDF-kärnor.
Äldre PDF-anrop får inga globala nya miljökrav.

## DECIDED och RENDER_IDENTITY_CONFLICT

Basens atomiska beslut/dispatch får redan innehålla förseglad artefakt A.
En kontroll i befintlig inaktiv `DeliveryExecution.run`/`grant` jämför tillgängliga identitets-/resursdigester
med A och använder befintlig DeliveryObservation med kind CONFLICT och reason
RENDER_IDENTITY_CONFLICT. Nekningen returneras efter egen lyckad commit.
Beslutet, dess begäran och den befintliga artefakten ändras inte. Ingen ny
framställning, FIRST/grant eller POST tillåts på det konfliktdrabbade beslutet.
Konflikten blockerar även efter omstart eller återställd tillgänglig A.
Människan måste återkalla DECIDED och fatta nytt beslut genom befintliga regler;
tjänsteprincipalen får inte göra detta. Ingen parallell beslutsmaskin införs.
Det verkliga rendereravslaget och denna beständiga DB-gräns provas separat med
samma faktiska identiteter A/B. Detta är inte atomisk riktig rendering + DB.
Denna provbara gräns kopplar inte en verklig 2.2-adapter till exekveraren.

## Nya frysta obligatoriska prov

| ID | Oberoende krav |
| --- | --- |
| r21-15 | Samma manifest/data/miljö ger samma identitet; orelaterad util utanför gränsen påverkar inte. |
| r21-16 | Ändrade faktiska mall-, resurs-, motor/font- och dynamiska SSR-bytes upptäcks. |
| r21-17 | DECIDED A mot B ger namngiven konflikt som annan DB-anslutning ser efter nekning; befintlig A bevaras, ingen ny artefakt/render/grant/POST. |
| r21-18 | Omstart och återställd tillgänglig A öppnar inte rätt på det konfliktdrabbade beslutet. |
| r21-19 | Människan kan återkalla och fatta nytt B-beslut; tjänsteprincipalen saknar dessa rättigheter. |
| r21-20 | Beständig identitetskonflikt blockerar även om SERVICE använder befintligt domän-API för övergång till SENDING; ingen ny grant/artefakt/POST får utfärdas. |
| r21-21 | SERVICE-start till SENDING/UNKNOWN före första exekveringsgrant kringgår inte resurskontrollen; A→B ger beständig konflikt utan grant/POST. Efter verklig grant gäller fortfarande 2b-30:s förseglade retries utan resursläsning. |
| r21-22 | Äldre och kontrollerad PDF använder samma innehållskärna men skilda browserinstanser; avslag påverkar inte den äldre vägen och ägaren stänger båda. |
| r21-23 | Den extra registrerade InvoiceReminder-mallen jämförs rått mot exakt fryst bas; UTC-datum bevaras och den deklarerade skillnaden mot äldre Europe/Stockholm visas. |

Alla tidigare r21-01–14 och 17 + 30 steg 1-prov kvarstår. CI kräver exakt en
relevant svit, exakt ett prov per hårdkodat ID, passed och numPassingAsserts > 0.
Kanarien tar bort själva r21-03-provet med vanlig commit/push, behåller kravlistan
och återställer provet med en ny commit. Ett tidigare typ-/fixturfel räknas inte.

## Produktskillnad och miljö

Varje PDF får en egen asOf från processens Date. Fakturans liveanrop fångar tiden
efter DB-läsning, logohämtning och mappning, precis före createRenderingContext.
Synliga fakturadatum är fortsatt underlagsdata; asOf styr där endast PDF-metadata.
Avi, avipåminnelse och båda inkassounderlagen fångar tiden när
collectRenderingContext anropas: efter DB-/behörighets-/statuskontroller och
eventuell claim men före logohämtningen. Date-argumentet utvärderas före await.
Detta är inte början på hela datainsamlingen. Bulkexport har ingen gemensam batchtid.

Avi och avipåminnelse läste tidigare klockan efter logo-await. En väntan över
UTC-midnatt kan nu ge tidigare synligt Datum på avin. För påminnelsens antal
förseningsdagar går gränsen vid dueDate + n × 24 timmar, inte generellt midnatt.
Båda inkassounderlagen läste redan Genererat före logo-await i basen; seg logo
introducerar där ingen ny sådan datumskillnad. r21-08 provar explicit tillförda
tider i kärnorna; det påstår inte en körd midnattspaus i den levande anroparen.

UTC är dessutom en deklarerad presentationsändring för tidigare värdar med
annan lokal tidszon: datum som 2026-09-11T23:30Z visas 11 september i UTC, men
12 september i Europe/Stockholm. Det berör datumfält i PDF och custom-mejl/
aviämnesrad samt de fem React-fakturamallarna InvoiceCreated, InvoiceOverdue,
ReminderFriendly, ReminderFormal och InvoiceReminder. Den sistnämnda har ingen
funnen aktuell produktionsanropare, men en publik sendInvoiceReminder-väg.
Historiskt motiv till denna kvarvarande väg: INGEN DOKUMENTERAD ORSAK.
Dess enda extra datumändring gäller body HTML/plaintext; preview och ämne saknar
datum. Den saknas i de ursprungliga 22 fallen och får därför ett öppet redovisat,
sent kompletterat föreunderlag från exakt fryst källa, aldrig från efter-versionen.
Det ersätter inte before-final-1/2. Övriga elva icke-betalningsmallar använder inte
datumhjälparen. Golden-jämförelsen gäller identiska indata i prövad UTC-miljö;
den säger inte att historisk rendering i andra tidszoner hade samma bytes.
Äldre presentationsfel i inventeringen rättas inte. before-final-1/2 förblir
auktoritativa; endast deras två exakt identifierade PDF-datumfält får undantas.
CI:s Node/OS kan skilja från föreunderlaget. Faktisk miljö måste redovisas och
strikt golden ändå passera; en avvikelse tillåter inte byte av facit/normalisering.

Identiteten omfattar deklarerade appfiler, mallhjälpare, motorpaket med faktisk
upplösning och deras bytes, Node-binär/processversioner/Intl, PDF-motorns
installation och länkade native-bibliotek samt deklarerade typsnitt/fontconfig.
Garantin är begränsad till den redovisade, oföränderliga Linux-installationen.
Specialbyggda native-miljöer, externa ICU-data, särskilda NODE_OPTIONS och
tillfälliga byten mellan kontroller är inte bevisade. Ingen jämförelse mellan
oprövade operativsystem eller motorversioner utlovas. Initial inventeringsförlust
ger null-sentinel: äldre PDF-bootstrap fungerar, kontrollerad rendering kräver
ny process efter att installationen rättats.

## Reviderad uppskattning innan produktionsrättningar

| Del | Försiktig målkostnad utöver säkrade 440 |
| --- | ---: |
| Separat browserägande med befintlig pool/kärna | 15 |
| Ersätt wrapper-/importgraf med deklarerad app- och motorgräns | 29 |
| Beständig DECIDED-konflikt och spärr före start | 40 |
| Verklig browser och hårdkodade obligatoriska ID:n i CI | 16 |
| UTC, CSV, metadataparser och typer | 10 |
| **Arbetshypotes, utan reserv** | **550 totalt** |

Detta är en arbetsuppskattning, inte en uppmätt färdig diff. Granskarnas bredare
intervall når över taket. Den konkreta återbruksdesignen måste därför mätas innan
tunga efterprov; om den nödvändiga formaterade lösningen inte ryms stoppas arbetet
med faktisk kostnad och kvarstående krav. Ingen kod får komprimeras för att passa.

## Verifieringskorrigeringar före CI

Setup-assertions i de tre obligatoriska sviterna använder Nodeassert, så de
fortfarande fäller felaktig miljö men inte ger första provet ett konstgjort
positivt `numPassingAsserts`. De 17 + 30 tidigare provblocken och deras
förväntningar behålls. Databasernas identity-hjälpare gör samma strikta
objektkontroll; i 2a används den även i ett samtidighetsprov.

Goldenhjälparen jämför råa jämförbara PDF-buffrar med `Buffer.equals`, inklusive
längd och varje byte. Detta undviker att Nodeassert bygger en mycket stor
binär textdiff vid den avsiktligt omordnade fakturan. Inga ytterligare byte
undantas. Lokala minnes-/SIGTERM-avbrott och tidigare fixtur-/typfel räknas
inte som beteendenegativkontroll. De bevaras i `verification/`.

Den extra mejlseriens källlista pinnas med SHA256
`75603a26e9273fcc9857cfef13390c2803eb3bbd5b50fd41b1af936f82d5fa58`.
Förefångsten använder fortfarande exakt Git-källa. Efterfångst och läskontroll
använder uttryckligen det sparade förearkivet, med kontroll av lista, paths,
längder, SHA256 och Git-blobhashar. Därmed krävs inga historiska Git-objekt i
CI:s grunda checkout. Det finns ingen tyst reservväg. Den historiska drivern
`capture-extra-mail-before.cjs` matchar båda föremanifestens driverhash.
