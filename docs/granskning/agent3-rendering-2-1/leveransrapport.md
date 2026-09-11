# Agent 3, steg 2.1 — leveransbevis för PR #880

PR: https://github.com/yasineken2002-sys/eken/pull/880. Basen är
`codex/agent3-utskicksgrind-2b` på exakt
`5ae9906b152307eae0d79eec719d4303a042742c`. Endast
`codex/agent3-rendering-2-1` i `arbete/agent3-rendering-2-1` har ändrats/pushats.
Ingen merge, aktivering, historikomskrivning eller 2.2-koppling.

Säkringscommit: `9a3305e64ed2753e64d192e9f69b48dd20bb722d`, med det ofullständiga
utkastets exakt 373+67=440 produktionsrader i elva filer, utan rättningar.
Dess [väntade röda CI](https://github.com/yasineken2002-sys/eken/actions/runs/34618454345)
är bevarad och är inte rendererkanarien. Implementationscommit:
`f6e9d162d163586f1172832aabefadc96ad08cab`.
Slutlig återställningscommit, kanarie och grön CI för exakt HEAD anges i
PR-beskrivningen och leveransmeddelandet, utan att skriva om Git-historiken.

## Mängd, gemensamma kärnor och produktpåverkan

[Inventeringen](kontrakt-och-inventering.md) härleder fem betalningsrelaterade
HTML/PDF-kärnor och tio kombinationer av kärna och dokumenttyp. En mejlmotor
har 17 registrerade mallar; sex aktiva betalningsvarianter samt den extra
registrerade InvoiceReminder omfattas av jämförelserna. Övriga elva mallar
använder inte den ändrade datumhjälparen. Historiska motiv som saknas anges
som **INGEN DOKUMENTERAD ORSAK** i inventeringen.

| Gemensam kärna | Verklig anropare och innehåll | Förändring och regressionsbevis |
| --- | --- | --- |
| Faktura | `pdf.service.ts:160` → `renderInvoice:234` → `invoice-pdf.template.ts` | Sex PDF-fixturer, fem utan förbrukning; classic/modern/minimal och 55 rader. Samma kärna används för alla fakturatyper; den grenar inte på enumtypen. |
| Avi | `avisering.service.ts`, `buildNoticePdfHtml` | Fyra fixturer: ren hyra, deposition, proration/backfill och förbrukning/kredit. |
| Avipåminnelse | `rent-reminder.service.ts`, `buildReminderPdfHtml` | Två delbetalda dokument med/utan förbrukning; skuld, avgift och förseningsdagar bevaras. |
| Fakturainkasso | `collection-export.service.ts:877`, `buildPdfHtml:890` | Två underlag med/utan förbrukning. Single/bulk använder samma privata PDF-ingång och innehållskärna. |
| Aviinkasso | `rent-collection-export.service.ts`, `buildPdfHtml` | Två underlag med/utan förbrukning. Båda har två sidor i den frysta basen och efter. |
| Mejl | `mail.renderer.ts:67`; `mail.service.ts` gemensamma payload-/custombyggare | Sex fulla köenvelopes med rå HTML/text och tre korrelerade PDF-bilagor; separat InvoiceReminder-prov. |

ConsumptionCharge kan finnas på faktura och på avins medlemsrader; påminnelser
och inkassounderlag avser samma fordringar. De fem befintliga offentliga
anroparna körs i r21-05 med verklig PdfService och anrop genom samma kärnor;
deras utdata matchar råa efterfiler. DB, lagring, kö och klocka är syntetiska.
Det finns ingen andra fryst produktionsrenderer. Kontrakt, besiktning,
månadsrapport och andra generiska PDF-anrop behåller sin äldre browserväg.

## Före/efter-deklaration och exakta undantag

`before-final-1/2` är fortfarande auktoritativa. Alla tidigare serier och
driverversioner är bevarade. Före/före gav olika råa PDF-filer i samtliga
16 fall: endast Info.CreationDate och Info.ModDate skilde. Detta undantag
är exakt två 14-siffriga datumfält, med kontrollerad position, längd,
syntax, antal och trailerns Info-referens. Övriga bytes jämförs exakt.

| Dokument | Deklarerad skillnad | Synlighet och konsekvens |
| --- | --- | --- |
| Faktura | De två PDF-datumfälten kommer från context.asOf. | Metadata. Dokument-/förfallodatum, belopp, logotyp, OCR, layout och filnamn bevaras. |
| Avi | Samma metadata; synligt Datum kommer från tillförd asOf. | Datum bevaras vid samma indata. Insamling över UTC-midnatt kan ge tidigare Datum än den gamla senare klockläsningen. |
| Påminnelse | Samma metadata; förseningsdagar kommer från asOf. | Samma värde vid samma tid. En lång insamling över dueDate+n×24h kan ändra antalet jämfört med den gamla senare läsningen. |
| Båda inkassounderlagen | Samma metadata; Genererat kommer från asOf. | Befintligt datum bevaras. Basen fångade redan datum före logo-await. |
| Sex aktiva mejl | Ingen rå HTML-/text-/ämnes-/mottagar-/filnamnsändring för lika indata. | Endast de två datumen i bifogade PDF-bytes undantas; canonical base64 och övrig rå envelope kontrolleras. |
| InvoiceReminder | UTC-värd: inga byteundantag. Tidigare Stockholm-värd: exakt en dueDate-text per HTML/text, 12→11 september 2026 i gränsfixturen. | Öppet deklarerad UTC-förändring, inte osynlig refaktorering. |

Fakturan fångar asOf efter DB, logo och mappning, före createRenderingContext.
De övriga fyra fångar Date-argumentet efter DB/grind/claim men före logo-await.
Det är inte en atomisk tid för hela insamlingen eller en gemensam batchtid.
Explicit UTC kan även ändra datum jämfört med äldre icke-UTC-värdar; detta
skiljs från goldenfallen med samma underlag/tid. Inga synliga datum har tagits bort.

Den extra mejlserien är ett **sent kompletterat föreunderlag**, öppet återkört
från exakt basens 21 Git-källblobbar. Den ersätter inte ursprungliga fångster.
[Kompletteringen](extra-mail-komplettering.md) och pinnad källista beskriver
gränsen; gamla runtime-versioner som inte finns sparade påstås inte återställda.

## Råa bevis och visuell kontroll

`after-proof-4/process-1/2/run-1` innehåller två nya Node-/Chromeprocessers
22 fall: 16 PDF och sex mejl, sammanlagt 66 råa artefakter per process.
Samtliga råa efterbytes är identiska mellan processerna. Mot vardera
auktoritativt föreunderlag passerar 66 jämförelser; 19 råa filer skiljer
(16 PDF och tre envelopes med dessa bilagor), enbart enligt ovanstående
snäva datumundantag. **Elva PDF-fall utan förbrukning ingår.**

Exempel på rå SHA256, före-1 → efter (efter-2 är identisk):

- Ren faktura: `835faa00b2b42f924200577c94411301c5381cdcf7906831bf763acedc36ab0b`
  → `680d533b8dbd062f7f22e421e625fd400574cadafcfbf3d0647fc082fcc9e192`.
- Ren hyresavi: `169cdf9ab5b5d467d6b7649564df40884017832b438b7fb539740ae446791a6c`
  → `b88d85dc2ea4aaf1d20e24715be043c05df53d1459e03e9e747d66e19e748910`.

Fullständiga hashpar, fältoffset, miljöer, fixturhashar och resursidentiteter
finns i respektive manifest och `after-proof-4/golden-comparisons.json`.
Fixturhash: `32b052efb9d2fd04829506642032515a90a1d6120e640f0529bb36c806ab222e`.
De initiala efterfångsterna gjordes med ocommittad implementation; manifestens
faktiska källfilshashar binder dess bytes. HEAD-fältet ensamt är inte det beviset.

Alla 21 sidor från 16 PDF-par rasteriserades: 21/21 PNG-par är exakt identiska.
Huvudagenten inspekterade ren classic-faktura och ren hyresavi före/efter.
Separat granskare inspekterade åtta ytterligare sidpar: ren påminnelse,
båda rena inkassounderlagen, långfaktura sida 2/3, modern faktura och
förbrukningsavi. Inga nya synliga skillnader observerades.
Detta är separat från rå PDF-byteidentitet, inte en ersättning för den.

Äldre presentationsfel bevaras öppet: modern faktura saknar synligt
fakturanummer; kredit 100,00 saknar synlig rad i förbrukningsavi/påminnelse
trots reducerad total; långfakturans rader 33/53 går in i sidfotsområdet.
[Den visuella rapporten](granskning-regressioner.md) beskriver fynden.

## Identitetsgräns, browser och beständig konflikt

`rendering-context.ts:78` definierar de fasta appfilerna och mallkatalogerna.
`:110` går endast genom de deklarerade motorpaketens beroenden/peers;
`:135` anger rötterna Puppeteer, React Email render/components. Faktiska
dynamiska React DOM/server-bytes ingår. Föräldraspecifik resolution och
frånvarande valfria beroenden binds; inga serviceimporter vandras transitivt.
`:142` binder Node/Intl/NODE_ENV; `:162` binder Chromeinstallationen,
fontbytes, fontconfig, verktyg och relevanta faktiska nativebibliotek.

R21-06/07/15/16 provar samma nyckel med nya bytes, motor-/mall-/fontändring,
dynamisk SSR-kod och orelaterad util utanför gränsen. R21-22 provar skilda
ägda browsers, samma withPage-kärna, varm A mot ärlig ny B-kontext, fortsatt
äldre PDF-väg vid miljöfel och stängning av båda browsers.
`pdf.service.ts:290` kontrollerar identitet före/efter launch och före anrop.

`delivery-execution.ts:167` använder befintlig ägd starttransaktion.
`:172` gör tidigare RENDER_IDENTITY_CONFLICT beständig även över omstart.
`:177` kontrollerar resurser före första grant, även om SERVICE redan har
skapat SENDING/UNKNOWN. `:187` namnger konflikten; `:193` skriver den i den
befintliga oföränderliga DeliveryObservation-historiken; `:197` returnerar
nekning så spåret committas. Ingen ny artefakt, grant eller POST utfärdas.
Beslut A, dess förseglade dispatch och dess historik förblir oförändrade.

DECIDED kvarstår efter vanlig konflikt. Människan kan återkalla och fatta
nytt B-beslut genom befintliga regler. SERVICE får starta/registrera korrelerade
utfall men inte återkalla, besluta eller genomföra mänsklig utredning.
Det offentliga äldre övergångs-API:t kan fortfarande skapa SENDING/startGranted;
detta är inte en nätanropsgrant från exekveraren. R21-20/21 visar att det inte
kringgår spärren. En sådan artificiell SENDING har inte fått någon ny mänsklig
REVOKED-övergång i denna PR. Efter verklig tidigare grant återanvänds förseglat
innehåll utan ny resursläsning/rendering, vilket oförändrade 2b-30 provar.

Verkligt rendereravslag och beständig DB-konflikt provas separat med samma
faktiska A/B-resursidentiteter. DB-provet har uttryckligen simulerad provider
och artefaktport. Detta är **inte** en atomisk riktig renderer+DB-adapter och
uppfyller inte i sig den senare verkliga 2.2-kopplingen av 2b-29/30.

## Avsiktlig beteendenegativkontroll

`verify-behavior-mutation.py` ändrade exakt en redan ny produktionsrad i
PdfService: första synliga "Att betala" ersattes med "Att betalX". Taket
för produktionsdiffen ökade inte. Två verkliga processer sparade fulla råa
fångster i `behavior-red/`; ordinarie r21-03 blev rött med
`Undeclared PDF byte difference`, inte ett typ-/kompileringsfel.

Endast denna mutation återställdes, med kontroll mot exakt originalbytes.
Två nya processer sparade `behavior-restored/`; r21-03 och r21-04 blev gröna.
Alla 66 råa återställda artefakter matchar också after-proof-4 i båda processerna.
`behavior-mutation-results.json` binder råa resultat och källhashar:
muterad `a78d14304e6761b20e372cbd4621da1b22d99ce5c18c144e9b4d01c7167741b2`,
återställd `ee642ac012c1e2c380dc957b71e9729bbc1aaa85361a042af33cd2ab0168998a`.

## Körningar och granskare

- Renderer: samtliga 18 prov r21-01–16,22,23 godkända i riktade lokala urval.
  Lokala urval har pending för ovalda prov; de påstås inte vara full CI.
- PostgreSQL: två nya processer, 63/63 i vardera (17+30 gamla, fem nya
  konfliktprov, elva delete-organization-prov). 105,752 respektive 75,675 sekunder.
- Båda DB-körningarna: 115 publictabeller, 191→191 rader (189 migrationer och
  två referensrader). Egna scheman hade 1106 respektive 2449 fixturrader före
  städning och saknades efteråt. Nio faktiska låspar per körning; fulla PID,
  tabellräkningar och hashkontroller i `verification/database-summary.json`.
  Före containerstädning räknades åter 115 publictabeller och 191 rader; inga
  egna testscheman fanns kvar. Endast den egna namngivna containern och dess
  testvolym togs bort. Separata råa JSON-städbevis finns i samma katalog.
- Nio berörda befintliga sviter: 121/121 gröna, inklusive äldre DB-regression.
- Full API-typkontroll grön; riktad ESLint grön efter testimportsrättning.
  PDF-kontrollen: tre renderingsställen, tio producenter, 59 malliteraler.

Råa loggar och JSON-rapporter finns i `verification/`. Lokala avbrott med
SIGTERM och en för låg explicit Node-heapgräns är bevarade och räknas inte
som beteendenegativkontroll. Setupkontroller har därefter flyttats till
Nodeassert så varje obligatoriskt prov behöver egna positiva Jest-assertions.
Ett tillfälligt tomt första rendererprov kördes verkligen och fick noll egna
assertions; det återställdes exakt. Den verkliga CI-kontrollens kod avvisade
det rapportresultatet samt saknat/dubbelt/hoppat/noll-assertionsprov och dubbel
svit i en lokal felinjektion över sammansatta riktiga rapporter. Det är inte
en full CI-körning eller ersättning för GitHub-kanarien.
CI hårdkodar samtliga 17+30+23=70 ID:n och kräver exakt en relevant svit,
exakt ett godkänt prov per ID och numPassingAsserts>0. CI startar den verkliga
renderern i två processer; lokal återanvändning av omedelbart föregående
fångster är uttryckligen förbjuden när CI är satt.

Separata rapporter: [identitet/browser](granskning-determinism.md),
[produktionsregressioner](granskning-regressioner.md),
[oberoende facit/CI](granskning-facit-ci.md). Browserägande, kod-/motorgräns,
dynamiska beroenden, CSV deliveredAt, datumparser, tidszoner, typfel,
SERVICE-genvägar och setup-räknarfynd är åtgärdade. Eget författade prov
markeras som sådana; en granskare utger inte sin egen implementation för
oberoende granskning.

## Budget och begränsningar

Produktion mot godkänd bas: **13 filer, 470 tillagda +80 borttagna =550**.
Prisma- och migrationsfiler har inga ändringar. Exekverarens nya inline-SQL,
CI och PDF-kontrollskriptet ingår i siffran.

| Produktionsfil | Tillagda | Borttagna |
| --- | ---: | ---: |
| `.github/workflows/ci.yml` | 14 | 3 |
| `apps/api/scripts/check-pdf-templates-selfcontained.mjs` | 2 | 2 |
| `avisering/avisering.service.ts` | 30 | 17 |
| `avisering/rent-reminder.service.ts` | 14 | 8 |
| `collections/collection-export.service.ts` | 30 | 10 |
| `collections/rent-collection-export.service.ts` | 33 | 17 |
| `consumption/delivery-execution.ts` | 18 | 3 |
| `invoices/pdf.service.ts` | 89 | 11 |
| `invoices/rendering-context.ts` | 202 | 0 |
| `invoices/templates/invoice-pdf.template.ts` | 2 | 2 |
| `mail/mail.renderer.ts` | 14 | 3 |
| `mail/mail.service.ts` | 21 | 4 |
| `mail/templates/shared/format.ts` | 1 | 0 |

Sökvägar utan prefix i tabellen ligger under `apps/api/src/`.

Testkod, syntetiska resurser, råa fångster/loggar och dokumentation räknas
separat i slutlig diffstat. Inga produktionshjälpare klassificeras som tester.
Raw golden och kopierad fontconfig har avsiktligt kvar sin whitespace;
kodens diffcheck är grön. Formateringshooken har inte fått ändra råbevisen.

Lokalt verifierad miljö: Linux x64, Ubuntu 24.04.3, Node24.11.1/ICU77.1,
Puppeteer24.40.0, Chrome146.0.7680.153 och sparad DejaVu/fontconfig.
Den första CI-körningen renderade i Ubuntu24.04.5, Node20.20.2/ICU78.2,
samma Puppeteer/Chrome och sparade fontbytes. Golden/reproduktion passerade
också där; det ger inte ett allmänt löfte om alla indata mellan miljöerna. Ingen garanti ges för
andra OS/motorer, godtyckliga nativeplugins, custom ICU/NODE_OPTIONS eller
förändrade installationsfiler under processens/browserns livstid. En extrem
transient filändring mellan kontroller är inte bevisat upptäckbar.
Absoluta installationsvägar och hela deklarerade filer/paket kan ändra
identiteten även vid semantiskt likvärdig kod. Ny orelaterad kod inom en
deklarerad fil kan därför konservativt ge ny identitet. Ingen historisk
motorförvaring eller automatisk fallback byggs.

Upprepad DB-insamling med annan radordning är inte samma frysta underlag.
Produktionens driftmiljö, samtidighetskapacitet och kostnaden för faktisk
innehållshashning är inte produktionsmätta. Grinden/exekveraren förblir
oinkopplade, men befintliga renderingsanrop använder de nya gemensamma kärnorna.
Inga riktiga mejl, betalda API-anrop eller produktionsuppgifter har använts.

Lanseringsnoteringen är `docs/revision-status.md:3`, med exakt SHA-länk till
2b-26 på `5ae9906b152307eae0d79eec719d4303a042742c`. Transportbegränsningen
om extrem processpaus efter sista tidskontrollen kvarstår. PROVIDER_ACCEPTED
är API-acceptans, inte mottagarleverans eller läsning.

Steg 2.2 återstår: fryst snapshot till faktisk artefaktadapter, verkliga
artefakter till exekverare och dess fulla 2b-29/30-bevis. Kö/workeraktivering,
äldre dokument, produktionsmätning och 2c är inte byggda.

## Första fulla CI-fyndet och rättningen

[Körning 34629504393](https://github.com/yasineken2002-sys/eken/actions/runs/34629504393)
på f6e9d162 körde 490 API-sviter och 6090 prov: 489 sviter/6088 prov gröna.
Endast r21-10/11 föll med `spawn pdftotext ENOENT`. Alla råa golden-,
reproduktions- och identitetsprov passerade. Alla andra CI-jobb var gröna.
Detta är ett miljöinstallationsfel, inte den avsiktliga borttagningskanarien.

Det befintliga nya browsersteget installerar nu uttryckligen `poppler-utils`,
med vanlig flerradig YAML och samma apt-installmönster som CI:s befintliga
postgresklientinstallation. Två produktionsrader tillkommer. Samtidigt
återtas en onödig utvidgning av PDF-guardens direktanropsregex till basens
regel. Alla aktuella nya klassanrop går via lokala HTML-variabler, där
klassprefixstödet och 120-fönstret behålls. Okända direkta producenter nekas
fortfarande. Oberoende granskare bekräftade avgränsningen, och guard +
självtest är gröna: 3 renderingsställen, 10 producenter, 59 malliteraler och 6 kanarier.
Netto är budgeten fortsatt 550, nu 470 + 80. Ingen rendering eller golden ändras.

## Grön fullkörning före borttagningskanarien

[CI 34631616328](https://github.com/yasineken2002-sys/eken/actions/runs/34631616328)
är grön på `3eecefa5711aa64bfdb13b9a9b151ed36bc16d76`: samtliga 61 jobb,
490 API-sviter och 6090 API-prov. Kravkontrollen verifierade alla 70 ID:n.
API-tasken loggar `cache miss, executing`. Två nya Node-/Chromeprocesser
(4479/4596 respektive 6774/6869) gav 66 identiska råartefakter. Full logg,
körmetadata, verkliga capture-records och härledd sammanställning finns i
`verification/ci-green-before*`. Denna gröna körning föregår kanarien och
ersätter inte kravet på grön CI för slutlig återställd HEAD.

## Verklig röd kanarie och exakt återställning

Kanariecommit `66bec1ba64a4d68699ac7a6a2baf33c0c4029640` tog bort endast
r21-03:s provblock och dess då oanvända import: en fil, 21 borttagna testrader.
CI-listan ändrades inte. [Körning 34632751687](https://github.com/yasineken2002-sys/eken/actions/runs/34632751687)
blev röd av exakt `invoices/rendering.real.spec.ts: r21-03 saknas eller saknar
godkända genomförda assertions`. Run test suite var grön: 490 sviter och
6089 prov; den efterföljande obligatoriska ID-kontrollen föll. Övriga jobb
var gröna utom den sammanfattande CI passed-grinden, som korrekt föll på Tests.

API-tasken hade `cache miss, executing`; två verkliga Node-/Chromeprocesser
(5021/5114 och 7287/7400) renderade 66 identiska råartefakter. Testloggens SHA256
är `9167fcabce9ea589b0f18306f043f76fa0557b0ad3c9c1bbeaf78cabb17aaf45`.
Metadata, full rålogg, captures och exakt commitdiff finns under
`verification/ci-canary-*`. Kanarien är alltså ett saknat beteendeprov,
inte ett kompileringsfel, ett hoppat prov eller en ändrad kravlista.

De två borttagna spannen återställdes efter kontroll att arbetsfilen fortfarande
var exakt den avsiktliga mutanten. Originalets och den återställda filens SHA256
är båda `5076cba1e4480b4efdbc675f3e3001b0367c332c40adea339205968847105b4a`;
mutantens är `d46ff9ebe5b627d2dbb3377e8c3653d73acaf13df5039ac73075dcd9674e824d`.
CI-filens oförändrade SHA256 är
`608ae7a9b1324960bd69d608f4c48a71c07745164add72db8487d50f7c6104e9`.
Återställningen levereras i en vanlig ny commit tillsammans med bevisen.
Slutlig HEAD och dess slutliga gröna CI-länk publiceras i PR-beskrivningen
och leveransmeddelandet efter verifiering; inga nya repoändringar görs för
att föra in den då redan provade commitens eget SHA i filen.

## Samlad diff mot godkänd PR-bas

| Klass | Filer | Tillagda rader | Borttagna rader | Binärfiler |
| --- | ---: | ---: | ---: | ---: |
| Produktion | 13 | 470 | 80 | 0 |
| Testkod | 24 | 3475 | 124 | 0 |
| Råa testbevis och syntetiska resurser | 1501 | 390654 | 0 | 388 |
| Dokumentation | 9 | 1512 | 0 | 0 |

Testkod omfattar endast specar, testfixturer/-hjälpare och kördrivare för bevis.
Historiska kopior av gammal implementation används endast av jämförelseprov.
Råa PDF, PNG, typsnitt, före-/eftermanifest och CI-loggar är testbevis; de
historiska fångsterna behålls även när de gör diffen stor. Binärfiler saknar
textbaserat radantal i git numstat och redovisas därför i egen kolumn.
