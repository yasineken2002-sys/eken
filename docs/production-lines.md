# Produktionsrader och importgräns

Kör `node scripts/production-lines.mjs BAS [HEAD]`. Utan HEAD mäts slutligt
arbetsinnehåll, inklusive index, ospårade filer och borttagningar. Med HEAD
läses filer och konfiguration från just den Git-versionen, inte arbetskopian.
JSON-utdata innehåller varje fils additions/deletions, klass och totalsummor.
Binärfiler redovisas separat; deras radantal är inte noll och ingår inte i en
textbudget. Byten ska bedömas separat av granskaren.

Git körs med `--numstat -z --no-renames --no-ext-diff`: en flytt räknas som
borttagning och tillägg, och märkliga filnamn får inte bryta TSV-parsningen.
Instrumentet ändrar inte repo, index eller konfiguration.

## Klassificering

Följande hela suffix klassas som test:
`*.spec.ts`, `*.test.ts`, `*.test-ports.ts`, `*.test-helpers.ts`,
`*.test-fixtures.ts`, samt samma former för TSX/JS/JSX/MTS/CTS/MJS/CJS.
Pythonformer: `*-test.py`, `*_test.py` och `test_*.py`.
En fullständig sökvägskomponent `e2e/` klassar dess innehåll som test.
Orden ”test” och ”spec” inne i vanliga namn gör inte en fil till test.

`docs/`, `arbete/` samt Markdown/MDX särredovisas som dokumentation.
Övrigt räknas konservativt som produktion, inklusive scripts, Prisma, SQL och
CI. Körbar dokumentationskod som nås från produktion flyttas till produktion
av importgrafen. Klassningen använder föreningen av basens och målträdets
nåbarhet, så även borttagen körbar dokumentationskod räknas som produktion.
Specarna och testhjälparna är ingen generell undantagslista:
en produktionsimport av dem fäller instrumentet.

## Vad grafen mäter

Hela målträdets statiska JS/TS-importer läses genom den delade skannerns
`blankComments` och TypeScripts parser. Även oförändrade helpers, re-exports,
typimporter, sidoeffektimporter, `require`, `import = require` och literal
`import()` ingår. Närmaste tsconfig, dess extends/paths och workspace-paketens
deklarerade källexporter styr upplösningen. Samtliga deklarerade
exports-grenar granskas; ett harmlöst types-spår får inte dölja en runtime-import
av en testfil. Ett byggt dist-träd ersätter inte
kontrollen av workspace-källan. Fel visar en konkret väg till testfilen.
Olösta lokala/aliasimporter i produktionsgrafen och parserfel är röda.

Python använder Python-AST för vanliga import/from-satser. Det är inte
JS-regex tillämpad på Python. Lokal relativ eller modulbaserad import följs. From-importer följer både
modulbasen och en eventuell importerad submodul, utan att kräva att ett vanligt
exporterat värde är en egen fil.

Käll-/konfigurationssymlänkar avvisas; de får inte dölja testfiler eller ge
olika byte i Git och arbetskopian. Ospårade symlänkar avvisas också.
Filnamn med radbrytning avvisas uttryckligen av Git-batchläsaren. Kolon och
tabulator i filnamn får inte radera diagnostik eller förskjuta radstatistik.

## Vad grafen INTE intygar

Variabla importvägar, alias för laddningsfunktioner, eval, genererade filer,
fil-/resursläsning och underprocesser kan påverka runtime utan en statisk
importkant. Kända dynamiska laddningar och fil-/processanrop redovisas med
plats i `limitations`. Det är observationer, inte en fullständig inventering:
även ett alias eller en wrapper kan dölja ett sådant anrop. Python importlib,
runpy och liknande rapporteras som uttryckliga analysgränser.

Grön importkontroll betyder därför inga förbjudna kanter i den statiskt
upplösta grafen, inte att godtycklig runtime-laddning är bevisat säker.
Nya sådana laddningar och kod placerad bakom datafiler måste granskas separat.
Detta skript kan inte heller skydda mot att dess egna regler ändras.

## Verifiering

`node scripts/production-lines.mjs --self-test` kör den gemensamma skannerns
kanarier. `node --test scripts/production-lines.test.mjs` provar instrumentet
med små syntetiska grafer och egna tillfälliga Git-repon. Proven omfattar
aliases, oförändrad indirekt helper, kommentarer/strängar, Python-gränsen,
staged+unstaged+untracked, historiskt träd samt rename/borttagning.

Oberoende kontroll för steg 2.1:

```sh
node scripts/production-lines.mjs \
  5ae9906b152307eae0d79eec719d4303a042742c \
  73d221c9b7e002b70262a3186b76fea876d6ad01
```

Förväntad produktionssumma är 550; den är kontrollfacit, inte en regel eller
specialgren i instrumentet. Räknarskriptet räknar sig självt som produktion.

## Instrumentets kontrollutfall

33 riktade prov passerade efter oberoende granskning. En tillfällig kopia av
skriptet fick testimportspärren neutraliserad: beteendeprovet för en vanlig
helper och barrel föll med AssertionError. Kopian städades; den oförändrade
originalsviten passerade därefter 33/33. Ingen repo-/databasmutation behövdes.

Kontrollintervallet ovan gav 550 produktionsrader, 2366 testrader, 393399
dokumentationsrader och 388 binärfiler; 1253 källfiler granskades, inga
statiska importfel och 312 uttryckligen redovisade analysgränser.
Detta skiljer sig avsiktligt från äldre manuella totalsiffror för test-/
bevismaterial: kategorierna följer den dokumenterade filregeln.
