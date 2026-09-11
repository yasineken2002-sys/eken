# Steg 2.2 — fryst beteendefacit och bindningsbeslut

Datum: 2026-09-11. Granskad bas: `e90a70a028c5d46b41f3dea26644de67fddb6529`.
Detta facit sparas före adapterimplementation. Det beskriver förväntade beteenden,
inte uppmätta utfall. Radräknaren byggs först enligt ordern. Inget r22-prov är ännu kört.

## Omfattning och avgränsning

En inaktiv koppling mellan ett leveransbeslut och de godkända verkliga renderarna.
Ingen producent, worker, utlämningsväg eller flagga kopplas in. Inga utskick,
leverantörsanrop, produktionsmätningar eller migrationer utförs som del av inventeringen.
#877, #878, #879 och #881 är frysta; #880 är ersatt. Ingen merge och ingen 2c.

Budgeten är 450 ändrade produktionsrader inklusive räknare, Prisma, SQL och CI.
Tester och dokumentation särredovisas. Om den konkretiserade minsta helheten inte
ryms stannar adapterbygget före implementation, med mätning och begäran om högre tak.

## Oberoende facit

Varje id nedan ska bli exakt ett godkänt beteendeprov i exakt en namngiven svit,
med minst en godkänd assertion. De läggs till den hårdkodade CI-listan när adapterproven
implementeras; de 70 tidigare id:na behålls. Varken en funnen fil eller noll prov är bevis.

| Id | Förutsättning / angrepp | Förväntat observerbart utfall |
| --- | --- | --- |
| r22-01 | Ny registrerad faktura med beslutade rader och frysta avsändar-/mottagaruppgifter | Verklig PDF, HTML, text och mejlkuvert avser exakt det frysta underlaget; oföränderlig body och digest binds till samma beslut. |
| r22-02 | Ny registrerad hyresavi med hyresperiod, förbrukningsrader och fryst logotyp | Verklig avirendering och mejl avser samma frysta underlag; år/månad/datum/belopp avkodas korrekt utan ändrad radordning. |
| r22-03 | Snapshot med felaktigt typat/ogiltigt tal eller datum | Framställningen avvisas före bindning. Ingen ny dispatch, inget förvanskat belopp eller tyst standardvärde. |
| r22-04 | Samma kommandonyckel, men ändrad fryst tid, avsändare, resursdigest eller resursbyte | KEY_CONFLICT; tidigare beslut och artefakt ändras inte. Nyckelordning i JSON ändrar däremot inte kommandots innebörd. |
| r22-05 | Dokument/medlemsmängd ändras och committas medan verklig rendering pågår | Den efterföljande atomiska bindningen avvisar det inaktuella underlaget. Varken nytt beslut, medlemmar eller dispatch lämnas halvt committade. |
| r22-06 | Samma fullständiga kommando återkommer efter omstart; aktuell DB och rendererresurser har ändrats | Idempotent återläsning ger samma redan sparade dispatch och body. Den skapar inget nytt beslut och förbereder inte om innehållet. Detta ger inte ny anropsrätt. |
| r22-07 | Samma resurs-/lagringsnyckel får andra verkliga logotyp- eller bilagebyte | Avvisning mot beslutets digester. Ingen artefakt med de utbytta byten godkänns. |
| r22-08 | Verklig framställare körs med ändrad aktuell klocka/slump; därefter angrips datum, filnamn och ett bilagebyte var för sig | Oförändrade frysta indata ger identisk fullständig body. Varje avsiktligt ändrat artefaktinnehåll upptäcks av kontraktsjämförelsen. |
| r22-09 | Samma sparade faktura- respektive avibeslut återges i två nya Node-/Chromium-processer | PDF, HTML, text, bilagefilnamn, kuvert och fullständig providerbody är byteidentiska, utan återanvänd rendercache. |
| r22-10 | Renderingen får endast hämtat fryst underlag och frysta resurser; åtkomst till aktuell DB/konfiguration/lagringshämtning görs otillgänglig | Verklig rendering lyckas ändå. Aktuella domänfrågor under framställning skulle fälla provet. Separat färsk identitetskontroll är tillåten. |
| r22-11 | DECIDED bundet till verklig rendereridentitet A; aktiv miljö ändras till B | Verklig reproduktion nekas. Startgrinden committar RENDER_IDENTITY_CONFLICT, ger ingen anropsrätt och lämnar beslut/body oförändrade. Spåret består över omstart och efter återställning till A. |
| r22-12 | Rå SQL försöker byta sparad body, digest eller resursmanifest på en verkligt renderad dispatch | Uppdateringen avvisas; ursprunglig artefakt och bindning består. |
| r22-13 | Två samtidiga anrop med samma fullständiga kommando förbereder verkligt innehåll | Ett beslut och en dispatch; båda anroparna får samma beständiga identitet och byte. Ingen lång rendering hålls under beslutets skrivtransaktion. |
| r22-14 | Verklig resurs/miljö ändras mellan frysning, framställning och slutlig bindningskontroll | Gammal och ny identitet får inte blandas till en godkänd artefakt. Hela den nya bindningen avvisas. |

De 17 befintliga 2a-proven ska köras oförändrade och deras källhashar redovisas.
Två isolerade PostgreSQL-körningar ska redovisa verkliga radantal före/efter och
städning i FK-ordning. Ingen ordinarie data får användas som fixtur.

En avsiktlig beteendemutation ska fälla ett r22-prov och återställas från en
namngiven säker commit med `git restore --source=` för bara berörd fil.
Därefter krävs grönt igen. En separat CI-kanarie tar bort ett namngivet r22-prov;
sviten ska fortfarande köras men assertionskravet ska bli rött för just det saknade id:t.
Återställning görs med en vanlig ny commit, aldrig amend eller historikomskrivning.

## Vad basen faktiskt redan gör

Orderns uppgift att beslutskommandot saknar resursidentitet gäller inte denna bas:

- `apps/api/src/consumption/delivery-decisions.ts:26–33` bär redan valfria
  `resources` och `team`. `:177–200` jämför hela kommandots JSONB vid replay.
- `apps/api/src/consumption/delivery-execution.ts:77–119` skapar beslut och
  dispatch i samma ägda transaktion och kontrollerar verkliga resursbyte mot digesterna.
- `apps/api/prisma/migrations/20260911150000_delivery_execution/migration.sql:56–68`
  kräver att beslutet skapats i samma transaktion och att `resources`/`team`
  stämmer med det första beslutseventets fullständiga request.
- Samma migration `:21–35` har redan beständig body/digest och scope-bindning.

Återanvänd dessa garantier. Ingen ny bindningstabell eller omskrivning av en tidigare
migration är motiverad enbart av orderns historiska formulering.

## Konkreta kvarvarande designval före adapterkod

Snapshoten innehåller redan dokument, rader, krediter, mottagare, organisation,
avtal, fastighet och avläsningsunderlag. SQL gör alla tal till strängar; mappningen
behöver explicit kontrollerad avkodning, inte ett typkast till ett Prisma-objekt.
SQL:s radordning efter id ska bevaras.

Det som måste frysas dessutom är asOf, avsändaradress, faktiska logotypbyte/MIME och
den deklarerade PDF-/mejlmiljön. En versionsmärkt valfri kontext i det redan sparade
fullständiga kommandot kan bära detta. Den verkliga adaptervägen måste kräva kontexten;
gamla kommandon får inga nya standardfält eller ny replay-betydelse.

Nuvarande synkrona render-port körs inne i en femsekunders beslutstransaktion.
Att bara lägga till await skulle hålla databasspärren under Chromium-arbetet.
Den minsta föreslagna vägen är att förbereda fryst snapshot/resurser och rendera
utanför skrivtransaktionen, sedan kontrollera fingerprint och resursbindning igen
när beslut, medlemmar och dispatch committas atomiskt.

Identiskt redan sparat kommando ska återläsas före ny förberedelse. Efter omstart
använder verklig retry fortfarande sparad body; reproduktionsprovet ger aldrig
rätt att ersätta denna med färska renderingsbyte.

Grant måste kontrollera färsk verklig identitet, inte en gammal miljöcache.
Adapter/mappningskod ska ingå i den uttryckligen deklarerade kodidentitetsgränsen.
Faktura, avi och mejl ska återanvända 2.1:s renderare och payloadbyggare.

## Begränsningar som följer med

- Identiska byte förutsätter den deklarerade oföränderliga renderingsmiljön.
- PROVIDER_ACCEPTED betyder API-acceptans, inte mottagarleverans eller läsning.
- Den dokumenterade 2b-26-luckan vid en paus efter sista transportkontrollen kvarstår.
- Äldre dokument, övergången och produktionsinkoppling ligger utanför 2.2.
- Historiskt skäl till varför fryst renderingskontext inte bands tidigare:
  INGEN DOKUMENTERAD ORSAK.
- Detta dokument och kostnadsbedömningen är inte ett renderingstest eller driftbevis.
