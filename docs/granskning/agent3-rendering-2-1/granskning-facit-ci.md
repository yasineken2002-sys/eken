# Läsgranskning av facit och CI, steg 2.1

Granskare: separat agent `granska_provider`. Granskad arbetskopia: 2026-09-11,
efter rättningarna av de namngivna fynden i rendererproven. Detta är en
källkodsgranskning, inte ett intyg om genomförda prov eller grön slutlig CI.
Huvudagentens verkliga Jest-körning pågick vid denna återgranskning. Jag har
inte kört Jest, typecheck, rendering eller DB-prov och har i denna uppgift
bara skapat denna rapport.

De namngivna fynden är åtgärdade i den lästa koden. Inget kvarstående
blockerande fynd i dessa rättningar; faktisk provkörning och CI återstår att
styrka i leveransrapporten.

| Fynd | Lästa åtgärder och bevisets räckvidd |
| --- | --- |
| Bilagans base64-avkodning kunde dölja whitespace utöver PDF-datumundantaget. | `comparableEnvelope` kräver nu att avkodning/återkodning ger exakt samma base64. r21-04 tillför whitespace och kräver uttryckligt avslag. Övrig rå JSON behålls; hela envelopen serialiseras inte om i jämföraren. |
| Processprovet redovisade bara Node-PID. | Fångstdrivern sparar nu `browser.process().pid`. r21-02 kräver olika positiva Chromium-PID samt olika positiva Node-PID som skiljer sig från Jest-processen. Två separata Node-anrop utför faktisk rendering. |
| Föreunderlagets ursprung kontrollerades inte uttryckligen i goldenprovet. | r21-03 kontrollerar både `baseSha` och `sourceHead` för before-final-1/2 mot `5ae9906b152307eae0d79eec719d4303a042742c`. Råfiler verifieras med manifestens längder och SHA256; 22 fall är hårdkodade. |
| Provet kontrollerade originalobjektet efter att ett annat, omvänt objekt renderats. | r21-13 sparar nu även `reversed` direkt före riktig rendering och jämför samma objekt efteråt. |
| Datumliknande text utanför Info saknade negativprov. | r21-14 använder två olika datum i kommentarer utanför Info, kräver att produktionens metadatahantering lämnar dem kvar och att goldenjämförelsen fäller skillnaden. |
| Dubblerad Info-referens kunde godtas av produktionens metadatahantering. | Produktionen kräver nu exakt en Info-referens och ett objekt i det första objektsegmentet. r21-14 provar dubblerad referens och saknade terminatorer, utöver fel nyckel, format, bredd, tidszon och objektreferens. |
| Filstorleken på Chrome var ensam inget negativprov för PDF-motorkod. | r21-16 muterar nu också Puppeteers faktiska paketentry, kontrollerar ändrad identitet samt avslag i riktig PDF-/mejlingång mot gammal identitet. r21-07 provar faktiska font- och fontconfig-bytes; Chrome-binärens innehåll inventeras men muteras inte i detta prov. |
| Den faktiska CI-miljön sparades bara i lokala provfiler. | Rendererprovet skriver nu processidentiteter, faktisk miljö, kodidentitet och artefaktmanifest till provloggen för båda fångsterna. Det gör miljöuppgifterna åtkomliga i en framtida CI-körnings logg. |

Bärande läspunkter:

- [Rendererprov](../../../apps/api/src/invoices/rendering.real.spec.ts):
  `beforeAll`, r21-02/03/04/13/14/16.
- [Oberoende goldenhjälp](../../../apps/api/src/invoices/rendering.golden.test-helpers.ts):
  `REQUIRED_RENDERING_CASES`, `readArtifact`, `comparablePdf`, `comparableEnvelope`.
- [Fångstdriver](capture-after.cjs): faktisk Node-/Chromium-identitet och miljömanifest.
- [Produktionskontext](../../../apps/api/src/invoices/rendering-context.ts):
  `stampPdfDates` och den uttryckliga fil-/paketgränsen.
- [CI](../../../.github/workflows/ci.yml): hårdkodade 2a-01–17,
  2b-01–30 och nu r21-01–23, totalt 70 obligatoriska ID:n; se tillägget nedan.

Goldenregeln undantar bara de två 14-siffriga datumvärdena för CreationDate
och ModDate i den stödda Info-strukturen. Antal, syntax, längd och position
kontrolleras; andra bytes jämförs utan normalisering. Regeln är avsiktligt
smal och är ingen allmän PDF-parser. Båda före-serierna jämförs mot första
efter-serien; r21-01 jämför dessutom alla råa artefakter mellan efter-serierna.

CI kräver exakt en godkänd svit per angiven fil och exakt ett godkänt prov
med positiva Jest-assertions per hårdkodat ID. Saknad, dubbel, hoppad eller
tom testpost kan inte uppfylla kontrollen. Detta bevisar inte ensamt provens
semantik: den verkliga borttagningskanarien för r21-03, återställning med ny
commit och grön CI för exakt slutlig HEAD måste redovisas separat. Jag har
inte bevittnat dessa körningar i denna granskning.

Syntetiska DB-/lagrings-/köportar i fångstproven ersätter inte renderern.
PDF och mejl renderas med de verkliga kärnorna; syntetiska negativa
rendererportprov r21-12 är däremot just portprov. De innebär ingen färdig
2.2-adapter eller atomisk koppling mellan riktig rendering och DB. Den
separata beständiga DECIDED-gränsen provas av r21-17–19. Jag skrev dessa tre
DB-prov på huvudagentens uttryckliga uppdrag; denna rapport ska därför inte
presenteras som en oberoende granskning av min egen DB-testimplementation.

Frysta fonter är inte bevis för samma Node/ICU/OS som föreunderlaget.
Kvarstående miljöskillnader måste framgå av de faktiska körningarna och får
inte döljas genom bredare goldenundantag. Utpekade filers hela innehåll och
resolverade installationssökvägar ingår konservativt i identiteten.
Fortsättningskontraktet redovisar nu detta samt den separata run/grant-gränsen
och begränsningarna för UTC/asOf utan att kalla riktig rendering + DB atomisk.

## Rättningstillägg: SERVICE-start och första exekveringsgrant

Efter första rapporten fann regressiongranskaren att SERVICE kunde registrera
SENDING genom det befintliga domän-API:t efter en redan sparad identitetskonflikt.
Min efterföljande läsgranskning fann även den andra ordningsföljden: SERVICE
kunde skapa SENDING före första run, varpå DECIDED-kontrollen aldrig utfördes.
Det senare gäller även om SERVICE därefter registrerar UNKNOWN. Dessa var
konkreta kringgåenden, inte enbart saknade prov.

Återgranskningen av den samlade rättningen finner inget kvarstående blockerande
fynd i dessa applikationsvägar. `DeliveryExecution.grant` läser både beständig
RENDER_IDENTITY_CONFLICT och förekomst av FIRST/RETRY i samma SELECT, efter
`load` har tagit transaktionens `delivery_lock`. Domänens övergångar och
observationstriggern använder samma lås. Kontroll, eventuell konfliktjournal
och utfärdande av grant sker därför under samma lås och egen commit.

En befintlig konflikt nekar alla tre startbara tillstånd före nya övergångar
eller grants. Resurser och snapshot kontrolleras dessutom vid DECIDED eller
om tidigare FIRST/RETRY saknas, även vid SENDING/UNKNOWN. Nekningen returneras
efter sparad konflikt; återställd A öppnar inte beslutet. Efter en faktiskt
utfärdad grant återanvänds förseglad dispatch utan nya resursläsningar.
Det bevarar den granskade avsikten i 2b-13 och 2b-30; deras körresultat måste
fortfarande verifieras.

r21-20 och r21-21 skrevs av regressiongranskaren och har nu lästs oberoende av
mig. De använder verkliga separata DB-klienter, passerar första retry-backoff
utan att passera deadline och kontrollerar exakt journal, oförändrad dispatch/
beslutshistorik och noll FIRST/RETRY/POST. r21-20 täcker sparad konflikt före
publik SERVICE-start samt omstart/köleverans. r21-21 täcker både SENDING och
UNKNOWN utan tidigare grant, beständig konflikt observerad från annan klient,
omstart och återställd A. Inga nya egna körningar har utförts.

CI-listan har nu 70 unika obligatoriska ID:n, inklusive r21-20/21 och även de
nytillkomna r21-22/23. Samma krav på exakt en svit/prov och positiva assertions
kvarstår. Jag har i detta tillägg granskat semantiken hos r21-20/21;
r21-22/23 har endast verifierats som hårdkodade poster i CI-listan.

## Tillägg: granskade körningsbevis och r21-22/23

Jag har nu läst de sparade JSON-rapporterna och råloggarna för två DB-körningar
och rendererurvalen 4c07, 4d11 och 4e. De tio arkivfilerna i `verification/`
är byteidentiska med granskade `/tmp`-filer. DB-filerna matchar dessutom
SHA256-värdena i [database-summary.json](verification/database-summary.json).
Inga nya testkörningar utfördes av mig vid denna kontroll.

| Sparat urval | Verifierat resultat |
| --- | --- |
| [DB 1](verification/agent3-r21-db-1.json) | 3 sviter, 63/63 godkända prov, 0 fel, 0 hoppade. |
| [DB 2](verification/agent3-r21-db-2.json) | 3 sviter, 63/63 godkända prov, 0 fel, 0 hoppade. |
| [Renderer 4c07](verification/agent3-r21-real-4c07.json) | r21-07 godkänt; 17 övriga prov utanför lokalt urval. |
| [Renderer 4d11](verification/agent3-r21-real-4d11.json) | r21-11 godkänt; 17 övriga prov utanför lokalt urval. |
| [Renderer 4e](verification/agent3-r21-real-4e.json) | r21-13/16/22/23 godkända; 14 övriga prov utanför lokalt urval. |

Båda DB-körningarna innehåller samtliga 17 + 30 tidigare prov, r21-17–21
och 11 prov för organisationsborttagning. Alla rapporterade prov har positiva
assertionstal. r21-20 har 24 och r21-21 har 53 i vardera körningen. r21-17–19
har 20, 17 respektive 29; jag bekräftar dessa kördata men är fortfarande
författare till de tre proven, inte deras oberoende semantikgranskare.

Jag har räknat om de fullständiga inventeringarna i råloggarna: varje 2a-/2b-svit
i båda körningarna har 115 publictabeller och exakt samma tabellvisa antal
före/efter, totalt 191 rader. De enda icke-tomma publictabellerna är de 189
migrationsraderna och två referens-/sekvensrader. Egna fixturer före städning
summerar till 1 106 för 2a och 2 449 för 2b. Loggarna redovisar eget schema
borttaget. Sammanfattningens fem 2a-lås och fyra 2b-lås per körning finns i
råloggarna, med olika backend-PID och `blocked: true` i varje par.

Rendererurvalen återanvänder samma redan fångade lokala processpar:
Node-PID 406114/410854 och Chromium-PID 406613/411166. Loggarna visar samma
artefaktmanifest, kodidentitet och miljö för paret: Linux/x64, UTC,
Node 24.11.1, ICU 77.1, Puppeteer 24.40.0 och Chrome 146.0.7680.153.
Detta är riktade lokala urval, inte tre nya fullständiga processjämförelser
eller en komplett grön renderer-/CI-svit. CI-grenen förbjuder återanvändning
via `RENDERING_CAPTURED_BEFORE_JEST` och ska själv starta processerna.

r21-22 har nu oberoende granskats både som kod och sparat körresultat:
en varm kontrollerad A-browser avvisar även en ärligt framställd B-context
efter fontconfigbyte; äldre väg fortsätter och ägaren stänger båda browsers.
r21-23 kör separata efterprocesser i UTC och Europe/Stockholm och jämför rå
HTML/text mot det öppet sena föreunderlaget från fryst källa. UTC har inget
undantag. Stockholm medger exakt en deklarerad förfallodagsändring 12→11
september per fil; alla andra bytes jämförs exakt. Jag ändrade själv driverns
pinnade arkivläsning efter CI-fyndet om grund Git-checkout. Den ändringen
granskades därefter av huvudagenten och ska inte kallas oberoende av mig.
Historiska `capture-extra-mail-before.cjs` matchar båda föremanifestens
driver-SHA256 exakt; deras råfiler skrevs inte om.

Ändringen i `assertPdfGolden` från djup Buffer-jämförelse till
`assert.ok(b.comparable.equals(a.comparable), ...)` behåller exakt längd-
och bytejämförelse. Samma oberoende kontroll av de två datumfältens positioner
kvarstår. Bara den stora binära feldiffen undviks; ingen ytterligare
normalisering eller tolerans har införts.

Ett ytterligare CI-fynd gällde att de fyra Jest-assertionerna i rendererfilens
`beforeAll` räknades in i första valda provets `numPassingAsserts`. Ett tomt
första prov kunde därför se ut att ha egna assertions. Fyndet är nu åtgärdat
i kod och återgranskat enligt följande tillägg.

## Rättningstillägg: setup räknas inte som obligatoriskt prov

Samtliga tre obligatoriska sviter importerar nu `node:assert/strict` för
setupkontroller. Rendererfilens två metadatajämförelser per fångst använder
`assert.equal`. De båda DB-sviternas beforeAll kontrollerar extension och
tom beslutstabell med Nodeassert; deras identitetshjälpare använder
`assert.deepEqual` för exakt databas/schema. Kontrollerna har behållits men
bidrar inte längre till Jest-räknaren hos första obligatoriska provet.

2b:s beforeEach återställer bara testklockan; afterEach återställer mockar
och stänger anslutningar. Dessa funktioner och klockhjälparen innehåller
inga Jest-assertions. De andra två obligatoriska sviterna har inga sådana
beforeEach-/afterEach-bidrag. DB-sviternas avslutande städkontroller kvarstår.

Den gemensamma 2a-identitetshjälparen används även av `raced`, som anropas
från 2a-07 och 2a-08 i den lästa koden. Det är inte 2a-04. De exakta
identitetskontrollerna utförs fortfarande, nu som Nodeassert, och respektive
prov har flera egna Jest-assertions för låsväntan och domänutfall kvar.
Inga obligatoriska provblock eller krav-ID:n har tagits bort av setupfixen.

Det blockerande räknarfyndet är därmed åtgärdat vid källkodsläsning. Tidigare
sparade assertionstal ovan gäller före setupfixen och ska inte presenteras
som en körningsverifiering av den. Riktade efterkontroller och CI återstår.
Verklig beteendenegativkontroll, borttagen-golden-kanarie och grön CI på exakt
slutlig HEAD är fortfarande inte bevittnade i denna granskning.
