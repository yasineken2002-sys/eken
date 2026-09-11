# Fryst experimentsammanfattning

Samtliga nedanstående arkivmedlemmar läses från exakt
`73d221c9b7e002b70262a3186b76fea876d6ad01`. Det är beviskällans SHA, inte ett
påstående att varje experiment kördes på den revisionen. Manifesten och de
ursprungliga rapporterna inne i arkivet behåller sina faktiska körnings-SHA,
kodhashar, miljöer och tidpunkter.

Arkivreferens för varje rad: `archive-manifest.json` → `files` med radens
`experiment`-ID → ursprunglig `path`, fil-SHA256 och storlek. Hela arkivets
hash är `10a5b90e2860123ee7294627ae73cac5505691d8b6b647677a044ca955390af7`.
Hämtningsreferens och retention finns i README/arkivkvittot. Sammanfattningen
ändrar inte ursprungliga förväntningar eller omklassificerar fel till godkänt.

| ID | Metod och ursprungliga filer | Resultat | Begränsning/rättning |
|---|---|---|---|
| E01 | Basens verkliga renderer körd två gånger; `before-1/2`, sedan `before-controlled-1/2`, verifieringsscript och hashjämförelser. | Endast två PDF-datumfält varierade; fixerade fontbytes gav samma jämförbara resultat. | Första drivern hade motsägande mottagare/nummer/förfallodatum mellan mejl och bilagor. Korrigerade **before-final-1/2** förblir auktoritativa och ligger kvar. Gamla serier är historik, inte reservfacit. |
| E02 | Tidig faktisk efterfångst, `after-development` och dess driver. | Råa 22 fall sparade för utvecklingsjämförelse. | Avser ofullständigt utkast, inte godkänd slutimplementation eller full CI. |
| E03 | Påbörjad `after-proof-2`. | Ofullständig serie bevarad. | Avbrott; får inte summeras som godkänd reproduktion. |
| E04 | Separata fångster i `after-proof-3`. | Råa resultat och dåvarande identitet/miljö sparade. | Äldre implementationsidentitet; ersätter inte sista efterbeviset. |
| E05 | `after-proof-4`: två färska Node/Chromeprocesser, verklig rendering, tillhörande förändrade fontmiljöer och extra mejlkörningar. | 66 råartefakter identiska; golden mot båda auktoritativa föreserierna godkänt med exakt två datumfält undantagna. Elva rena PDF-fall ingår. | Fångstens dåvarande HEAD ensam binder inte ocommittad implementation; faktiska källhashar/identitet finns i manifesten. Ingen 2.2-adapter. |
| E06 | Produktionsrad ändrad från synlig `Att betala` till `Att betalX`; `behavior-red`, exakt återställning och två nya processer i `behavior-restored`. | r21-03 verkligen rött med `Undeclared PDF byte difference`; återställda r21-03/04 gröna och samtliga råbytes matchar E05. | Detta är beteendemutationen. Tidigare typ-/fixtur-/minnesfel räknas inte som negativkontroll. |
| E07 | Verkliga PDF-sidor rasteriserade före/efter; `visual-before`, `visual-after-proof-4` och driver. | 21/21 PNG-par byteidentiska; rena fakturor/avier och ytterligare sidpar visuellt granskade. | Rasterjämförelse är separat från PDF-byteidentitet. Äldre saknat fakturanummer, osynlig kreditrad och sidfotsöverlapp bevarades och dokumenterades. |
| E08 | Två isolerade PostgreSQL-körningar, `agent3-r21-db-1/2.json`, databas- och städsammanställningar. | 63/63 i vardera, nio faktiska låspar per körning; 115 publictabeller och 191 rader oförändrade. Egna scheman och container städade. | Isolerade syntetiska data; inte produktionsmätning eller bevis att befintliga produktionsskrivare är inkopplade. |
| E09 | Nio berörda befintliga sviter i `agent3-r21-existing.json`. | 121/121 godkända. | Riktat lokalt urval, inte hela CI. |
| E10 | Lokala rendererurval och råa Jest-rapporter. | Alla 18 renderer-ID:n godkända i slutliga urval; tidszon-/importfixar redovisade. | Ovala prov är pending i urvalen. SIGTERM, för låg heap och tidiga fel är bevarade/redovisade, inte gröna helkörningar. Vissa omnämnda textloggar saknas i 73d-trädet. |
| E11 | Verkligt tomt första prov, setup-räknarkorrigering till Nodeassert samt felinjektion i CI-guardens rapportindata. | Tomt prov gav 0 egna assertions; guard nekade saknat/dubbelt/skippat/tomt prov och dubbel svit. | Kompositrapporter är lokal guardkontroll, inte full CI. Den riktiga kanarien är E14. |
| E12 | Första fulla CI på f6e9d162; sparade faktiska captures och ursprunglig rapport i E16. | 489/490 sviter, 6088/6090 prov; r21-10/11 föll på saknat `pdftotext`. Rågolden/reproduktion passerade. | Oväntat installationsfel; Poppler installerades i CI. Inte avsiktlig kanarie. [Körning](https://github.com/yasineken2002-sys/eken/actions/runs/34629504393). |
| E13 | Full CI före kanarie på `3eecefa5711aa64bfdb13b9a9b151ed36bc16d76`, full logg/metadata/captures. | 61 gröna jobb, 490 sviter, 6090 prov, 70 obligatoriska ID; cachemiss och två nya processpar. | Grön föregångare, inte slutlig återställnings-HEAD. [Körning](https://github.com/yasineken2002-sys/eken/actions/runs/34631616328). |
| E14 | Endast r21-03 och oanvänd import togs bort i `66bec1ba…`; full logg, commitdiff, original-/mutant-/återställningshashar. | 490 sviter/6089 prov gröna; verklig CI röd för exakt saknat r21-03. Exakt återställning med vanlig ny commit. | Följande no-skipped-steg kördes inte efter guardfelet; slutgrön körning gjorde det. [Röd körning](https://github.com/yasineken2002-sys/eken/actions/runs/34632751687). |
| E15 | 450-radersstopp, sparat ofullständigt 440-radersutkast och typkontroll. | Utkastet säkrades oförändrat i `9a3305e6…`; kända typ-/browser-/identitetsfel redovisades. | Ägarens senare 550-order tillät rättningarna. Stoppet och den röda utkast-CI:n får inte döljas. [Utkast-CI](https://github.com/yasineken2002-sys/eken/actions/runs/34618454345). |
| E16 | Ursprungliga separata granskningsrapporter och full leveransrapport. | Blockerande fynd åtgärdade; slutlig kod godkänd på 73d. | Historiska formuleringar och hänvisningar bevaras ordagrant; vad som verkligen ingår i arkivet avgörs av medlemsmanifestet. |

Behållna experiment: de auktoritativa before-final-serierna kördes från exakt
5ae och deras ursprungliga fångst-/fixturkällor matchar manifesthasharna.
Extra InvoiceReminder är öppet **sent kompletterat** föreunderlag från 21
pinnade bas-källblobbar, i UTC och Europe/Stockholm. Båda kompletta källarkiven,
renderingsresultaten och förklaringen ligger kvar; de ersätter inte before-final.
Den deklarerade synliga skillnaden är en dueDate-text 12→11 september på den
äldre Stockholm-värden. Ingen bred normalisering införs.

Godkänd slutlig CI på73d är en separat extern referens:
[34634346933](https://github.com/yasineken2002-sys/eken/actions/runs/34634346933),
61 jobb, 490 sviter/6090 prov, 70 obligatoriska ID, verklig cachemiss och två
nya processpar. Dess slutlogg hade SHA256
`82107538cdc733f53ffe0b2aacc9ca5f59faea4aae513fb85cf8cd934c9ab956` och fanns
utanför73d-trädet. Den har därför inte lagts in som om den vore en arkivmedlem
från73d. Den nya beskurna grenen måste dessutom få egen färsk grön CI.
