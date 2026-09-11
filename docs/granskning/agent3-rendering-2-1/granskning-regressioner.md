**Oberoende regressionsgranskning, Agent 3 steg 2.1, 2026-09-11.**

Granskad arbetskopia ovanpå `9a3305e64ed2753e64d192e9f69b48dd20bb722d`,
mot godkänd bas `5ae9906b152307eae0d79eec719d4303a042742c`. Radnummer nedan
avser arbetskopian vid granskningen. Granskaren har läst kod, kontrakt och
prov samt tidigare använt lätta PDF-text-/sidantalverktyg. Ingen ny Jest-,
PostgreSQL-, Chromium- eller typecheck-körning har utförts av granskaren.
Körningsresultat ska hämtas ur huvudleveransens bevarade loggar.

**Historiskt blockerande fynd från första granskningen: den nya konfliktspärren
kan kringgås genom befintlig publik SERVICE-start.** Följande text och provtabell
bevarar den då granskade kandidatens beteende. Aktuell rättnings- och
verifieringsstatus redovisas i återgranskningen sist i dokumentet. Fyndet var
en härledd anropskedja ur koden, ännu inte ett kört reproduktionsprov.

1. Skapa DECIDED med resurs A; byt till B och kör `DeliveryExecution.run`.
   Den nya vägen registrerar `CONFLICT/RENDER_IDENTITY_CONFLICT` och lämnar
   beslutet DECIDED (`delivery-execution.ts:172`, `:194`).
2. Anropa därefter den publika `DeliveryDecisions.transition` med samma
   organisation, dokument, beslut och aktiva tjänsteprincipal,
   `authorityKind: SERVICE`, `to: SENDING`, `attemptId: null` och ny commandKey.
   `authorize(..., true)` tillåter principalen (`delivery-decisions.ts:117`,
   `:263`). Startgrenen läser snapshot men ingen konfliktjournal (`:267`).
   Metoden väljer dispatchens riktiga attemptId och kan returnera
   `startGranted: true` efter egen commit (`:255`, `:272`).
3. Den befintliga eventtriggerns SERVICE-gren och SENDING-kontroll saknar
   också denna konfliktspärr
   (`20260911150000_delivery_execution/migration.sql:119`, `:155`).
4. Låt den kontrollerade tiden gå minst en sekund och anropa `run` igen.
   Tillståndet är då SENDING; resurs-/journalgrenen hoppas över och ett
   UNKNOWN-event samt RETRY kan skapas (`delivery-execution.ts:201`).
   RETRY-triggern kräver ett SENDING-event men inget föregående FIRST;
   första väntetiden är en sekund (`migration.sql:82`, `:95`).
5. `finalCheck` läser CLOSED, inte den befintliga identitetskonflikten
   (`delivery-execution.ts:210`). Oförändrad A och öppet tidsfönster kan
   därför nå den simulerade eller framtida providerporten.

Detta kräver ingen godtycklig DB-mutation. Det är en befintlig publik
domänmetod med den organisationsbundna principalens tillåtna identitet.
Spärren måste omfatta denna väg innan påståendet ”ingen ny start/grant/POST
på konfliktdrabbat beslut” kan godkännas. Ett riktat beteendeprov bör lägga
SERVICE-starten mellan r21-18:s konflikt och återleverans, kräva nekad start,
oförändrad start-/grantjournal och noll provideranrop. En spärr enbart vid
sista nätkontrollen räcker inte för kravet att inga nya grants ska utfärdas.
Rättningen får inte återinföra resursläsning/rendering vid vanliga UNKNOWN-retries.

**Vad r21-17/18/19 faktiskt skyddar.**

| Prov | Oberoende bedömning av assertionerna |
| --- | --- |
| r21-17 (`delivery-execution.db.spec.ts:1926`) | A/B använder verklig `renderingCodeIdentity`, `documentContext` och de riktiga syntetiska logobyten. B har en tillagd byte bakom samma identitetsnyckel. Dispatch och DECIDED-request jämförs med A-digesterna. En läsare med annan `pg_backend_pid()` läser efter avslutad nekning exakt en namngiven CONFLICT, utan grantId; alla andra räknade domänrader, beslut, event och befintlig dispatch jämförs oförändrade. Renderantal ökar inte; send, kö och provideracceptanser förblir noll. |
| r21-18 (`:2014`) | Konflikten läses av annan anslutning, workeranslutningen kopplas från, A återställs och en ny exekverarinstans/DB-anslutning publicerar samma decisionId. Journalen måste vara CONFLICT, PUBLISHED, CONFLICT och ursprungligt konfliktradsinnehåll är identiskt. En enda oförändrad dispatch, DECIDED-historik, inget nytt render- eller provideranrop. Detta provar instans-/anslutningsomstart, inte en separat Node-process. |
| r21-19 (`:2101`) | SERVICE-återkallelse och SERVICE-beslut nekas med oförändrade radantal. HUMAN återkallar A och beslutar B med ny decisionId/attemptId, korrekt previousId/sequence och mänsklig eventidentitet. A, dess ursprungliga DECIDED-event, dispatch och konflikt bevaras. Endast nya B får slutligen ett simulerat anrop och en acceptans. Provets SERVICE-negativfall omfattar inte den tillåtna SENDING-väg som beskrivs ovan. |

A/B är innehållsbundna resurser byggda med aktuell kodidentitet och logokontext;
de är inte två kompletta verkliga PDF-artefakter. `harness` använder fortfarande
`syntheticRenderer` och `SimulatedDeliveryProvider` (`delivery-execution.db.spec.ts:444`).
Detta är lämpligt för den inaktiva DB-gränsen, men bevisar inte atomisk verklig
rendering tillsammans med journalföring. `r21-06` provar det verkliga
rendereravslaget separat. Kopplingen i steg 2.2 är fortfarande obeställd.

**Tidigare produktfynd och åtgärder i aktuell kandidat.**

- Felaktigt sidantal i första r21-10-versionen: de auktoritativa filerna
  `before-final-1/collection-notice-clean.pdf` och
  `collection-notice-utility-credit.pdf` har två sidor, 54 470 respektive
  54 344 bytes. Detta verifierades med `pdfinfo`. Aktuellt prov kräver nu
  två sidor för båda (`rendering.real.spec.ts:346`), fyra för långfakturan
  och en för övriga fall. Facitfilerna ändrades inte.
- Den första allmänna formuleringen ”asOf vid insamlingsstart” var felaktig.
  `fortsattning-550.md:61` beskriver nu de olika fångstpunkterna korrekt.
  `r21-08` provar uttryckligt tillförd tid i kärnorna, inte en faktisk paus
  i liveanroparen. Den begränsningen är nu uttrycklig i kontraktet.
- UTC påverkar synliga datum om tidigare värd hade annan lokal tidszon,
  inklusive avimejlets ämnesrad. Detta är nu deklarerat i
  `fortsattning-550.md:76`. Föreunderlagets UTC-jämförelse ger ingen
  garanti om gamla lokala datum i andra tidszoner.
- Belopps-, OCR-, mottagar- och ordningslogiken har vid läsning bevarats i
  de fem kärnorna. Verkliga före/efter-prov ska ändå passera. De elva rena
  PDF-fallen är huvudfallen; den nya routing-hjälparen använder fem rena
  dokument och riktiga publika anropare/riktig PDF, inte simulerade PDF-bytes.
- Äldre presentationsfel ska kvarstå öppet: modern kundfaktura visar inte
  fakturanumret; förbrukningsavi/påminnelse med kredit saknar separat synlig
  kreditrad trots korrekt nettototal. Långfakturan har sidor med rader
  01–13, 14–33, 34–53, 54–55. Dessa observationer får inte bli tysta
  layout- eller innehållsrättningar i denna PR.

**Exakta asOf-punkter i de levande anroparna.**

| Anrop | Fångstpunkt och betydelse |
| --- | --- |
| Faktura | `pdf.service.ts:231`: efter DB-läsning, logohämtning och datamappning, före miljöinsamling/rendering. Synliga fakturadatum är underlagsdata; asOf styr PDF-metadata. |
| Avi | `avisering.service.ts:962`/`:1031` → `pdf.service.ts:90`: efter dokument/org och eventuella sändningsgrindar, före logo-await. Styr synligt Datum (`avisering.service.ts:1465`) och metadata. |
| Avipåminnelse | `rent-reminder.service.ts:1125` → `pdf.service.ts:90`: efter dokument/org och återleveransgrindar, före logo-await. Styr förseningsdagar (`:1319`) samt metadata. Antalet hela dygn skiftar vid dueDate + n × 24 timmar. |
| Fakturainkasso | `collection-export.service.ts:196`/`:338` → `:877` → `pdf.service.ts:90`: efter lyckad claim, före logo-await. Styr Genererat (`:932`) och metadata. |
| Aviinkasso | `rent-collection-export.service.ts:196`/`:266` → `:501` → `pdf.service.ts:90`: efter exportgrind, före logo-await. Styr Genererat (`:538`) och metadata. |

JavaScript utvärderar `new Date()` innan det följande await-argumentet i
`collectRenderingContext`. Varje dokument har egen tid; inget gemensamt
batchdatum eller fryst DB-snapshot införs här. Avi och reminder läste tidigare
klockan efter logo-await. Båda inkassokärnorna läste däremot redan Genererat
före logo-await i basen (fakturainkasso `:912` före `:940`, aviinkasso `:522`
före `:542`). Endast en lång logoväntan medför därför ingen ny sådan synlig
datumskillnad för inkassodokumenten. Filernas exportkatalogdatum fångas
fortfarande separat efter rendering och är inte rendereridentitet.

**Återgranskning av faktisk provkörning, 2026-09-11 efter 17:12 UTC.**

Granskaren har läst de två verkliga Jest-resultaten nedan, den aktuella
produktionsdiffen, routing-hjälparen och `rendering.real.spec.ts`. Ingen egen
rendering eller tung körning har utförts. Resultaten gäller arbetskopian ovanpå
`9a3305e64ed2753e64d192e9f69b48dd20bb722d`, inte verifierad slutlig HEAD eller CI.

| Bevarad körningskälla | Utfall och SHA-256 |
| --- | --- |
| `/tmp/agent3-r21-real-4a.json`, start 17:08:27.984 UTC | 9 godkända, 0 underkända, 8 ej valda. `a1d44eda5e2c78b23e647eb2c6505ca7b9e4a1c8392f86b87f77db5ca3de4157` |
| `/tmp/agent3-r21-real-4b.json`, start 17:10:58.076 UTC | 3 godkända, 1 underkänt, 13 ej valda. `1e7c0cfce52c8570bc463f35bc820a874c8736d693eb8ff1c865f8abca62b3db` |

Godkända ID:n och faktiskt genomförda godkända assertions: r21-01 (181),
02 (8), 03 (6), 04 (5), 05 (154), 06 (4), 08 (5), 09 (26), 10 (45),
12 (5), 14 (23) och 15 (5). Riktade körningars `pending` betyder inte
godkänd obligatorisk kontroll. Den första r21-07-körningen är röd vid kontrollen
att fontfilen kommer från kopierad fontkatalog (`rendering.real.spec.ts:274`
vid körningen). Aktuell provkod skickar nu uttryckligt `process.env` till
`fc-list`; ingen grön omkörning av r21-07 har lästs i denna återgranskning.

r21-05 gör verkliga anrop genom `generateInvoicePdf`, `getNoticePdfBuffer`,
`processReminderSendJob`, `exportForInvoice` och `exportForNotice`. Call-through-
spies kräver en körning av respektive gemensam kärna, samma kontextobjekt vidare
till PDF-gränsen och faktisk PDF-utdata. Den riktiga PdfService/Chromium-vägen
används; DB, lagring och mejlkö är syntetiska. Alla fem fallen är utan förbrukning.
Det yttre provet kräver därefter att varje anropares råa PDF är byteidentisk med
sin riktiga efterfångst och sparar `after-proof-4/caller-*.pdf`. Den injicerade
fixturklockan visar kontextens fortplantning, inte den levande klockans
fångstordning; den ordningen har granskats separat i tabellen ovan.

Efterfångsternas manifest i `after-proof-4/process-{1,2}/run-1` redovisar skilda
Node-PID 406114/410854 och Chromium-PID 406613/411166, samma fixturhash
`32b052efb9d2fd04829506642032515a90a1d6120e640f0529bb36c806ab222e` och kodidentitet
`e25aa4506330bd2c25f7078512228fc5385ce870c6565a9e25a77700f440eb9b`.
Varje manifest har 16 PDF:er, varav 11 utan förbrukning. r21-01/02 kräver rå
byteidentitet mellan dessa separata processer. r21-03 jämför båda auktoritativa
`before-final`-serierna med efterutdata, med endast två exakt avgränsade
Info-datumfält som PDF-undantag. Det påstås inte att hela råa före- och efter-PDF
är identiska. r21-04/14 verifierar avslag för andra eller felaktigt formade
byteskillnader. Inget nytt före-facit har skapats för att få dessa prov gröna.

De elva rena fallen omfattar fem fakturavarianter (inklusive hyresfaktura,
modern/minimal och fyra sidor), tre avier (helhyra, delmånad/backfill och
deposition), delbetald påminnelse och båda inkassounderlagen. r21-10 har passerat
med datum-, belopps-, OCR-, mottagar-, radordnings- och sidantalassertions.
Rena kundfakturan behåller 1 100,00 och rena hyresavin 9 000,00; delbetald
påminnelse behåller 5 060,00. Långfakturans sidindelning är fortsatt
01–13/14–33/34–53/54–55. De två aviinkassounderlagen har två sidor.
Detta är byte-/text-/sidantalsbevis; verklig visuell inspektion är en separat
kontroll som ännu inte har rapporterats till denna granskare.

Ny läsning av produktionen visar samma gemensamma kärna för aviutlämning och
avisändning (`avisering.service.ts:963`, `:1032`), och samma privata adapter för
enskild/bulk inkassoexport. DB-/behörighets-/claimkontroller ligger kvar före
renderingen. Dekryptering sker i inkassoanroparna och klartext lämnas uttryckligt
till kärnan. Beräkningar, OCR, filnamn, mottagare, ordning och PDF-marginaler har
inte ändrats i den granskade diffen. Äldre `generateFromHtml` utan kontext går
fortsatt till sin egen browser (`pdf.service.ts:316`); den kontrollerade vägen
äger en annan (`:309`). Runtime-bevis för detta sista avskiljande kräver r21-22,
som inte ingår bland de lästa godkända resultaten.

Det historiska SERVICE-fyndet är åtgärdat i aktuell kod: konfliktjournalen
kontrolleras före alla grants, oavsett DECIDED/SENDING/UNKNOWN, och resurs A
verifieras även efter publik SERVICE-start om ingen FIRST/RETRY finns
(`consumption/delivery-execution.ts:172`–`:179`). r21-18:s aktuella journal är
CONFLICT, PUBLISHED, utan ny dubblettkonflikt. Nya r21-20/21 täcker de två
härledda vägarna. Deras DB-resultat har inte lästs i denna återgranskning och
ska hämtas från de två isolerade PostgreSQL-körningarna före slutgodkännande.
En offentlig SENDING-övergång kan fortfarande returnera `startGranted`; den
åtgärdade spärren avser exekverarens grant/POST-rätt. En redan SENDING/UNKNOWN
konflikt får inte beskrivas som mänskligt återkallbar DECIDED.

Det nytillkomna InvoiceReminder-fallet har deklarerats i fortsättningskontraktet
och `extra-mail-komplettering.md`, med separat fryst källåterkörning. r21-23,
slutlig full obligatorisk kontroll, avsiktlig beteendemutation, visuell
inspektion och CI-kanarie är ännu inte verifierade genom dessa två JSON-filer.
Inga nya produktionsregressionsfynd framkom vid denna läsning. Bedömningen
är fortsatt begränsad till redovisade syntetiska fall och prövad miljö;
2.2-koppling och fryst produktionssnapshot är inte levererade här.

**Separat visuell återgranskning, 2026-09-11.**

Granskaren har nu öppnat följande åtta sidpar med `view_image`, både före och
efter, från de redan rasteriserade verkliga PDF-sidorna. Ingen ny rasterisering
eller PDF-generering har körts. Granskningen avser läsbarhet och placering;
den ersätter inte råa PDF-jämförelser eller metadatakontroller.

| Inspekterat sidpar | Visuellt fynd före och efter |
| --- | --- |
| Ren delbetald påminnelse, [före](visual-after-proof-4/before/reminder-rent-partpaid-1.png) / [efter](visual-after-proof-4/after/reminder-rent-partpaid-1.png) | Samma logotyp, avinummer, Testa Åberg och 11 förseningsdagar. 9 000,00 + 60,00 − 4 000,00 visas som 5 060,00 att betala. Bankgiro 5050-1055 och OCR 1234567897 är tydliga. Ingen synlig ändring, överlappning eller klippning. |
| Rent fakturainkasso, [före](visual-after-proof-4/before/collection-invoice-clean-1.png) / [efter](visual-after-proof-4/after/collection-invoice-clean-1.png) | Samma fakturanummer, två partsrutor, skuldposter och påminnelsehistorik. Kvarstående skuld 960,00 samt förklaringen 1 160,00 − 200,00 är läsbara. Sista förklaringsblocket ryms på sidan; ingen synlig ändring. |
| Rent aviinkasso sida 1, [före](visual-after-proof-4/before/collection-notice-clean-1.png) / [efter](visual-after-proof-4/after/collection-notice-clean-1.png) | Samma avinummer, OCR, mottagare, kapital 9 000,00, avgift 60,00, ränta 103,56 och total 9 163,56. Ränteperioderna och leveranshistoriken ligger kvar utan ny klippning. |
| Rent aviinkasso sida 2, [före](visual-after-proof-4/before/collection-notice-clean-2.png) / [efter](visual-after-proof-4/after/collection-notice-clean-2.png) | Referens- och förklaringsblocket fortsätter på samma glesa andrasida. Detta är bevarad sidbrytning, inte en ny tillagd sida. |
| Ren långfaktura sida 2, [före](visual-after-proof-4/before/invoice-customer-multipage-2.png) / [efter](visual-after-proof-4/after/invoice-customer-multipage-2.png) | Samma rader 14–33, upprepad tabellrubrik och belopp 125,00 per rad. **Äldre layoutbrist:** sista raden 33 går in i den fasta sidfotens område. Sidfotens övre linje skär genom beloppsfältet och radens andra beskrivningsrad ligger intill sidfotstexten. Finns i båda versionerna. |
| Ren långfaktura sida 3, [före](visual-after-proof-4/before/invoice-customer-multipage-3.png) / [efter](visual-after-proof-4/after/invoice-customer-multipage-3.png) | Samma rader 34–53. Motsvarande äldre sidfotsöverlappning drabbar rad 53 i båda versionerna. Textutdragets korrekta radföljd bevisar således inte att alla rader har tillräckligt visuellt utrymme. |
| Ren modern faktura, [före](visual-after-proof-4/before/invoice-customer-modern-1.png) / [efter](visual-after-proof-4/after/invoice-customer-modern-1.png) | Samma mottagare, förfallodatum 2026-09-30, moms, total 1 100,00 och OCR. **Känd äldre brist:** fakturanumret visas fortfarande inte. Layouten och denna brist är oförändrade. |
| Förbrukningsavi med kredit, [före](visual-after-proof-4/before/notice-utility-credit-1.png) / [efter](visual-after-proof-4/after/notice-utility-credit-1.png) | Samma 100 kWh/4 m³, OCR, datum och total 9 400,00 i både sammanställning och betalningsdel. **Känd äldre brist:** de synliga raderna 9 000,00 + 250,00 + 250,00 förklarar inte nettototalen; kredit 100,00 saknar egen synlig rad. Finns i båda versionerna. |

Utöver den visuella inspektionen har en lätt läskontroll räknat om SHA-256
för samtliga 21 PNG-par från 16 PDF-dokument i
`visual-after-proof-4/manifest.json`: alla stämmer med manifestet och varje
före-/efterpar är rått byteidentiskt som PNG. Manifestets SHA-256 är
`f342cd1401e90c9a3ca16e9cbec4b695cd3cb00dac237146f6f9f605a9e92fc4`.
Detta rasterbevis säger inget om osynliga PDF-metadata eller andra PDF-läsare.
Endast ovanstående åtta sidpar har visuellt inspekterats av denna granskare;
huvudagentens kontroll av klassisk ren faktura och ren helhyresavi är separat.

Inga nya synliga före-/efterregressioner hittades i dessa sidpar. Den nyupptäckta
sidfotsbristen på långfakturan är en äldre produktbrist och har rapporterats
till huvudagenten; den rättas inte tyst i denna PR. Bevarade bytes och bevarad
sidindelning får inte beskrivas som att dessa äldre presentationsfel är lösta.
