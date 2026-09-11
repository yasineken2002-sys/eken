# Agent 3 — steg 2.1: kontrakt före implementation

Beställning 2026-09-11. Fryst bas `5ae9906b152307eae0d79eec719d4303a042742c`.
Egen worktree `arbete/agent3-rendering-2-1`, gren `codex/agent3-rendering-2-1`.
Avsedd utkastbas: `codex/agent3-utskicksgrind-2b`. #877–879 förblir frysta.
Denna text och rått föreunderlag skrivs innan produktionsändringen.

## Härledd mängd (radnummer i den frysta basen)

Fem betalningsrelaterade HTML/PDF-kärnor, tio kombinationer av kärna och dokumenttyp:

| Kärna och typer                                                         | Befintlig kedja                                                                                | Beroenden att göra explicita                                                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Faktura: RENT, DEPOSIT, SERVICE, UTILITY, OTHER; classic/modern/minimal | `invoices/pdf.service.ts:135` → `templates/invoice-pdf.template.ts:129` → `page.pdf:205`       | DB/partsnormalisering135–201, föränderliga logobytes152–159, datumformat114, fontfallback och PDF-metadata   |
| Avi: RENT och DEPOSIT                                                   | `avisering.service.ts:961,1029` → `buildNoticePdfHtml:1033` → `PdfService.generateFromHtml:75` | logo1048, månad1109, datum1122/1171–72/1523/1548, **synligt dagens datum1452**, osorterade rader1064         |
| Avipåminnelse                                                           | `rent-reminder.service.ts:1125` → `buildReminderPdfHtml:1284` → generisk PDF                   | logo1298, **förseningsdagar från klockan1313**, förfallodatum1314, kvarstående skuld1312                     |
| Fakturans inkassounderlag                                               | `collection-export.service.ts:195,337` → `buildPdfHtml:872` → generisk PDF                     | klartext876, skuld906, **Genererat-datum912**, logobytes940, rader928 och påminnelser919                     |
| Avins inkassounderlag                                                   | `rent-collection-export.service.ts:195,265` → `buildPdfHtml:500` → generisk PDF                | ekonomiska figurer501, klartext506, **Genererat-datum522**, händelseordning525/691, räntesegment527, logo542 |

ConsumptionCharge binds till RentNoticeLine (`schema.prisma:5076,5090`) och Invoice
(`6298,6309`). `consumption.service.ts:604–610` lägger rader på RENT; `668,718`
skapar separat UTILITY-faktura. Samma renderare används för dokument utan förbrukning.
Inkassounderlagen kan avse samma fordringar och ingår därför också. DEPOSIT-avins
saknade förbrukningskoppling är inget skäl att undanta dess regression.

Tre PDF-primitiver finns: generisk HTML75, kontrakt102 och faktura135. Övriga
anropare till generisk PDF (besiktning, månadsrapport, plattformsfaktura, AI-dokument)
och kontraktsprimitiven ska behålla tidigare beteende. De är inte dokument från
ConsumptionCharge-kedjan. Ingen extra fryst produktionsrenderer skapas.

En mejlmotor (`mail/mail.renderer.ts:52,64`) med17 registrerade mallar27–44.
Sex aktiva betalningsvarianter: invoice-created (`mail.service.ts:489`),
invoice-overdue530, reminder-friendly550, reminder-formal585, custom avi694 och
custom avipåminnelse627. Invoice-reminder510 saknar nuvarande produktionsanropare.
Kedjan är MailService → MailQueue68 → MailWorker81 → MailRenderer → befintlig
provider. Den nya grinden eller exekveraren kopplas inte in. Övriga11 mejlmallar
är utanför betalningsmängden; en ändring i den gemensamma motorn måste ändå
bevara deras befintliga kontrakt.

## Fullständig beroendeinventering

- Tid: ovanstående fyra synliga klockläsningar och Chromiums dolda
  CreationDate/ModDate. Dokument-/förfallodatum och F-skatt-datum är data och
  ska bevaras. Datumformat använder sv-SE men saknar ofta explicit tidszon.
- Slump: ingen egen slump/UUID i dessa innehållskärnor. Befintliga dokumentnummer,
  OCR och filnamn är indata. Fakturafilnamn504, avi726, påminnelse683 ska bevaras.
  Historiskt motiv för att PDF-metadata läser klockan: **INGEN DOKUMENTERAD ORSAK**.
- Resurser: logotyp hämtas via föränderliga nycklar. `logo.util.ts:15` ger data-URL,
  med MIME från suffix och null vid saknad logga. Fakturan har separat suffixregel.
  Dessa fallbackregler och synliga logotyper ska bevaras; nyckel ensam är inte identitet.
- Typsnitt/bilder: Arial/Courier/OCR-B och systemfallback i avi1385/1420/1431;
  delad branded-pdf-shell använder brandFont-stack. Inga externa bilder i MailLayout.
  Dolda beroenden är valda fontbytes, fontconfig-alias/prioritet, Chrome-installationens
  resursfiler och dynamiska bibliotek. Fc-list eller motorversionssträng ensam räcker inte.
- Sortering: InvoiceLine saknar sortOrder/createdAt; DB hämtar lines utan orderBy.
  Reminder-listan sorteras på sentAt utan tie-breaker; avihändelser på createdAt.
  Renderingens underlag bevarar uttrycklig arrayordning. Att sortera UUID hade ändrat
  ordning, zebrarader och sidbrytningar. Datainsamlingsordning är inte en garanti om
  reproduktion från en ny DB-läsning. Framtida fryst anropare måste bevara ordningen.
- Miljö: uppmätt Puppeteer24.40.0, Chrome146.0.7680.153, Node24.11.1/ICU77.1,
  Ubuntu24.04.3 x64, UTC. Kompletta före-manifest innehåller filhashar.
  Produktions-Docker använder node20-slim och opinnade OS-fontpaket; CI använder
  Node20. Inga oprövade OS-/motor-/fontkombinationer omfattas av determinismlöftet.
- Bibliotek: React18.3.1 och React Email render2.0.7 ger HTML och text. Aktuell
  Date/Intl/ICU och templateversion är beroenden även utan egen new Date().
  Mail rundar hela SEK; PDF visar två decimaler. Det är befintligt beteende.
- Inställningar: PDF A4/printBackground, generiska marginaler20/15mm,
  fakturor0mm; launch-flaggor `pdf.service.ts:23`, vänteläge `pdf-wait-until.ts`.
  Kontraktets header/footer och marginaler ska inte ändras.

## Kontrakt för gemensamma kärnor

Underlag + innehållsbundna resurser + explicit renderingskontext ger utdata.
Nuvarande caller samlar DB-data, logotyp och tid; samma kärna ska kunna anropas
utan DB/StorageService av den framtida frysta callern. Synliga datum och
förseningsdagar får inte tas bort. UTC är uttrycklig tidszon i denna garanti.

Resursidentitet omfattar faktiska bytes/MIME, inklusive null som ett eget fall.
Samma lagringsnyckel med andra bytes ger annan identitet. Motoridentiteten ska
omfatta faktisk körande Chrome/installationsresurser, fontbytes och effektiv
fontconfig, relevanta dynamiska bibliotek samt Node/ICU/locale. Förväntad
identitet jämförs med faktisk miljö före rendering. Ingen gammal miljöhash får
användas över anrop när filerna kan ha ändrats. Miljön förutsätts oföränderlig
under ett anrop; samtidiga utbyten av motorns systemfiler är inte en garanti.
Extern nätladdning och JavaScript ska vara avstängda i den explicit reproducerbara
PDF-vägen. HTML-innehåll, PDF-inställningar, resurser och kontext ingår i identiteten.

## Oberoende föreunderlag och deklarerad ändring

`capture-before.cjs` använder den gamla riktiga PdfService och de gamla HTML-
byggarna; bara DB, lagring och kö är syntetiska portar. Ingen simulerad PDF-port.
Två separata processer har sparat22fall vardera:16PDF och6mail.11PDF-fall saknar
förbrukning. JavaScripts dokumentklocka är uttryckligen fryst till
2026-09-11T12:00:00Z under HTML-byggnad; Chromiums metadata-klocka är verklig.
Rå HTML/PDF/mail/envelopes, fixturer, resurser och SHA256 finns i `before-1/2`.
`before-comparison.json` innehåller råa hashpar och exakta metadataoffset per PDF.

Mätning före/före:16/16PDF skiljer rått, men ENDAST CreationDate och ModDate i
första Info-objektet. All HTML och alla sex mejlens text/HTML är rått identiska.
Tre mail-envelopes skiljer därför att deras base64-bilagor bär dessa PDF-datum.
Detta är ingen uppgift om att råa PDF-filer är identiska.

Följande deklaration är fryst före produktionsändring; gäller även rena dokument:

| Dokumenttyp                  | Planerad före→efter-skillnad                                                                  | Synlighet/konsekvens                                    | Kontroller                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| Faktura, alla typer/layouter | Endast Info.CreationDate/ModDate får värde från kontext i stället för Chromiums väggklocka    | Metadata; inget innehåll/layout/filnamn ändras          | 6fakturafixturer, inklusive5utan förbrukning och55rader        |
| Hyresavi/depositionsavi      | Samma två metadatafält; dagens synliga Datum hämtas från tillförd kontext med samma värde     | Synligt datum BEVARAS; UTC explicit                     | 4avier, inklusive3utan förbrukning, proration/backfill/deposit |
| Avipåminnelse                | Samma två metadatafält; tillförd tid används för befintliga förseningsdagar                   | Befintlig text, skuld, datum och antal dagar bevaras    | 2delbetalda påminnelser, med/utan förbrukning                  |
| Fakturainkasso               | Samma två metadatafält; Genererat-datum tillförs                                              | Synligt datum, klartext, restskuld och avgifter bevaras | 2underlag med/utan förbrukning                                 |
| Aviinkasso                   | Samma två metadatafält; Genererat-datum tillförs                                              | Datum, OCR, ränta/segment och totalsumma bevaras        | 2underlag med/utan förbrukning                                 |
| Sex mejlvarianter            | Ingen HTML/text/ämnes-/mottagar-/filnamnsändring; bifogad PDF har ovanstående metadataändring | Inget ändrat meddelandeinnehåll                         | 6mail, fulla envelopes och råa bilagor                         |

Undantaget i golden-jämförelsen ska vara exakt de två verifierade fasta datumfälten,
med antal, position, format och längd kontrollerade. Alla andra bytes ska jämföras
utan normalisering. Textuttag och visuell kontroll är separata bevis, inte ersättning
för bytejämförelsen. Inga breda metadata-/bild-/textfilter godkänns.

## Omfattningsbedömning före implementation

Tak450 ändrade produktionsrader = tillagda + borttagna; CI ingår.
Reviderad plan efter miljögranskning (inte en uppmätt slutdiff):

| Del                                                                             | Ändrade rader |
| ------------------------------------------------------------------------------- | ------------: |
| Kontext, resursidentitet, explicit formatering                                  |            52 |
| Verifierad faktisk motor/fontconfig/font/biblioteksmiljö                        |            94 |
| Smala gemensamma PDF-hooks och två metadatafält; befintliga PDF-block står kvar |            70 |
| Fakturans gemensamma ingång/caller                                              |            28 |
| Avi                                                                             |            38 |
| Avipåminnelse                                                                   |            30 |
| Två inkassokärnor inklusive klartextgräns                                       |            64 |
| Mail, delad innehållsbyggnad och identitet                                      |            55 |
| CI-kravlista och verklig renderer                                               |            17 |
| **Plan**                                                                        |       **448** |

Två rader reserv. Tidig410-skattning saknade full miljöbindning. Granskarens
mellansummeringar500/560 var räknefel; den specificerade tabellen var460 och
smala hooks sparar uppskattningsvis12. Inget stoppbeslut får bygga på de räknefelen.
Om nödvändig faktisk lösning överskrider450 stoppas arbetet med konkret diff;
krav ska inte döljas och kod inte komprimeras för att passa.

## Frysta provkrav och gräns mot2.2

Nya obligatoriska renderer-ID:n r21-01–r21-14 ska skyddas av hårdkodad CI-lista:
identiska råbytes; nya processer; oberoende golden; odeklarerad mutation; samma
produktionskärnor; resursbyte under samma nyckel; ändrad miljöidentitet; explicit
datum; mail/envelopes; belopp/OCR/mottagare/rader/sidbrytning; externa laddningar;
rendererportens negativa fall; oföränderligt underlag/ordning; strikt metadataparser.
En avsiktlig mutation ska få ett beteendeprov att bli rött och sedan grönt efter
exakt återställning. Steg1:s17+30ID:n och CI-kontroll bevaras.

2.1 kopplar inte beslutets snapshot till artefakter eller artefakter till exekverare.
Inga nya kö-/workerintegrationer, aktivering, äldre dokument, produktionsmätning
eller2c. Gröna rendererprov innebär inte att2b-29/30 körts med verklig2.2-adapter.
Lanseringsrisken från2b-26 står separat i `docs/revision-status.md` med exaktSHA-länk.

### Tillägg före implementation: oberoende granskarfynd

`before-controlled-1/2` använder åtta innehållsfrysta DejaVu-fontfiler och kopierad
fontconfig för en återanvändbar testmiljö. Dessa är testresurser, inte produktionens
fonter. Före1→före2, controlled1→controlled2 och före1→controlled1 har samma bytes
utanför exakt de två PDF-datumfälten. Fonter ensamma garanterar inte överensstämmelse
med Node20/annan ICU i CI; det måste mätas, och miljöidentiteten ska skilja dem.

Den första fångstdrivern hade motsägande manuella uppgifter för fakturamejlets
mottagare/nummer/förfallodatum och avimejlets förfallodatum jämfört med bilagorna.
`capture-before-v1.cjs` och de ursprungliga råfilerna bevaras. Korrigerad driver
hämtar dessa fält ur motsvarande bilagefixtur; `before-final-1/2` är auktoritativt
föreunderlag och manifesten binder driverfilens SHA256. Alla före-serier kör basens
oförändrade produktionsrenderer. Envelopes här är **köenvelopes**; MailWorker,
Resend-from och fullständig providerbody ingår inte i2.1-fångsten.

Befintliga presentationsbrister som bevaras och ska synas i ägargranskningen:
modern kundfaktura saknar fakturanummer; krediterad förbrukningsavi och
avipåminnelse saknar synlig kreditrad trots korrekt reducerad totalsumma.
Långfakturans sida2/3 har endast0,786pt överlapp i sista textradens/footerns bounding
boxes, ännu inte ett visuellt konstaterande om glyphkollision. Ingen av dessa
brister får kallas introducerad regression eller döljas bakom ett generellt
påstående om att alla specifikationer summerar korrekt.

### Oberoende obligatoriska assertions

| ID     | Förväntan fastställd före implementation                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| r21-01 | Samtliga16fall ger identiska råbytes två gånger med identiskt underlag/context                                        |
| r21-02 | Nya Node-/Chrome-processer ger samma råbytes; ingen instanscache får förklara utfallet                                |
| r21-03 | Före-final matchar efter utanför enbart två exakt identifierade Info-datumfält                                        |
| r21-04 | Ändrad synlig text eller annan byte utanför undantaget fäller samma golden-kontroll                                   |
| r21-05 | Befintliga produktionsanropare delegerar till samma fem rena kärnor                                                   |
| r21-06 | Samma lagringsnyckel med nya resursbytes ger ny identitet; falsk digest avvisas                                       |
| r21-07 | Ändrad faktisk motor/font/fontconfig-miljö ger ny identitet eller avslag mot förväntan                                |
| r21-08 | Synliga dokumentdatum/förseningsdagar kommer från explicit kontext, inte väggklockan                                  |
| r21-09 | Sex verkliga mailrenderingar bevarar HTML/text och korrelerade köenvelopes                                            |
| r21-10 | Underlagets datum, belopp, OCR, mottagare, förbrukningsrader och sidindelning bevaras; kända basbrister anges separat |
| r21-11 | Reproducerbar PDF-kärna avvisar extern laddning och exekverar inte JavaScript                                         |
| r21-12 | Återanvändbara portprov upptäcker ändrad tid/slump/filnamn/bilagebyte; ingen påstådd2.2-koppling                      |
| r21-13 | Renderingen muterar inte indata; uttrycklig radordning bevaras                                                        |
| r21-14 | Fel antal/format/position/längd på PDF-datum kan inte passera smal metadatabehandling                                 |

Fakturafixturernas6fall täcker alla layoutgrenar. Kärnan gör ingen branch på
invoice.type, varför DEPOSIT/OTHER representeras genom samma kärna och deras
uttryckliga raddata, inte genom ett falskt påstående om separata före-filer.
Metadatakontrollen måste följa trailerns /Info-referens (basen:1 0 R) och får
inte bara ersätta globalt matchande datumsträngar. Datumliknande text utanför
Info får inte försvinna ur jämförelsen.

### Öppen omfattningsrisk upptäckt före implementation

Färsk filhash före varje anrop räcker inte ensam när Chromium återanvänds:
en redan varm browser kan ha cachat äldre fontconfig/fontval. Den får inte
intyga nya resursbyte med en ny identitet men gammal intern cache. Miljön
behöver därför bindas före browserstart och verifieras efter launch samt före
varje explicit reproducerbart anrop; drift ska kräva ny process eller avvisas.
Det gäller också en browser som först använts av en annan generisk PDF-caller.
448-planen innehöll inte uttryckligen denna livstidsbindning. Ingen produktion
är ändrad medan den nödvändiga kostnaden omprövas.
