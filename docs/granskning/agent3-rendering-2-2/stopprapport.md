# Steg 2.2 — radräknare klar, stopp före adapter

## Beslutsläge

Byggorderns första del, den mekaniska produktionsradsräkningen, är genomförd.
Själva renderingskopplingen är inte implementerad. Samma uppdrag och samma nya gren
behålls; ingen extra produktdel eller PR-uppdelning föreslås.

Det uttryckliga taket är **450 ändrade produktionsrader**. Det färdiga instrumentet
och dess CI-koppling tar **435**. Den konkretiserade återstående adapterdelen bedöms
till **257–400**, alltså **692–835** totalt. Bedömningen är en kostnadsprognos,
inte ett matematiskt bevis att varje möjlig implementation kräver exakt dessa tal.

**Begärt ägarbeslut: höj taket till 850 för samma 2.2 och samma PR.**
Adaptern påbörjas inte utan nytt besked. Instrumentet pressas inte ihop till
färre fysiska rader för att få en missvisande budget; det är normalt Prettier-formaterat.

## Arbetsplats och fryst utgångspunkt

- Codespace: `solid-halibut-q7w46v6v57w5c6566`.
- Worktree: `/workspaces/eken-fran-mac-20260909/arbete/agent3-rendering-2-2`.
- Egen gren: `codex/agent3-rendering-2-2`.
- Bas: `e90a70a028c5d46b41f3dea26644de67fddb6529`, PR-bas
  `codex/agent3-rendering-2-1-compact`.
- Facitets första commit: `cac8ef46f20916d7424c876c5abff0f461603eb3`, före adapterkod.
- Inga produktionsanropare, SQL-/Prisma-filer eller renderare är ändrade.
- #877/#878/#879/#881 har verifierats ligga kvar på sina frysta HEAD.
  #880 förblir ersatt; ingen merge, aktivering, 2c eller produktionsmätning.

## Faktiskt instrumentmått

| Klass | Tillagda | Borttagna | Ändrade |
| --- | ---: | ---: | ---: |
| Räknare, `scripts/production-lines.mjs` | 429 | 0 | 429 |
| CI, `.github/workflows/ci.yml` | 6 | 0 | 6 |
| Produktion totalt | 435 | 0 | 435 |
| Räknarens tester, `scripts/production-lines.test.mjs` | 340 | 0 | 340 |

Dokumentationen särredovisas av samma skript. Den ändrar inte produktionsmåttet.
Inga binärfiler tillkommer.

Kontroll mot den godkända ursprungliga 2.1-diffen:

```sh
node scripts/production-lines.mjs \
  5ae9906b152307eae0d79eec719d4303a042742c \
  73d221c9b7e002b70262a3186b76fea876d6ad01
```

Uppmätt: **550 produktion**, 2 366 test, 393 399 dokumentation, 388 binärfiler.
Den kontrollen jämför #880:s godkända implementation mot dess egen bas.
Att jämföra #881 mot samma bas skulle även räkna dess tillkomna arkiverings-CI
och vore fel kontroll för just 550.

Aktuell mätning:

```sh
node scripts/production-lines.mjs e90a70a028c5d46b41f3dea26644de67fddb6529
```

Utan HEAD ingår staged, unstaged, ospårat och borttagningar. Efter commit kan exakt
slutlig HEAD anges som andra argument. Resultatet listar varje fil och dess klass.
CI kör riktade prov och importkontroll mot `HEAD^ HEAD`; vid PR-körningen är
checkout GitHubs provmerge och dess första förälder är PR-basen.
Den uttryckliga uppdragsbudgeten mäts separat mot ovanstående fasta e90-bas.

## Varför återstoden inte är en fristående extrafunktion

| Kvarstående del, utifrån kod vid e90 | Bedömda ändrade produktionsrader |
| --- | ---: |
| Fryst kontext i fullständigt kommando; kort förberedelse med befintlig authorize/replay/snapshot | 24–38 |
| Tvåfas-enqueue: verklig rendering utanför skrivtransaktionen, atomisk kontroll och bindning, bevarad replay | 58–88 |
| Färsk asynkron identitetskontroll med beständigt konfliktspår och oförändrad retrygren | 18–30 |
| Verklig adapter: validerad snapshotavkodning, faktura/avi, PDF/mejl och exakt body | 125–180 |
| Återanvänd fakturamejlsbyggare och deklarera adapter i kodidentiteten | 12–25 |
| r22-krav i CI och faktisk exekvering | 20–39 |
| Återstående totalt | **257–400** |

Samma kedja måste bära det frysta underlaget från kommando till återproducerbara
mejlbyte. Att ta bort exempelvis fullkommando-replay, typavkodning eller atomisk
slutkontroll skulle försvaga just den beställda garantin.

Orderns historiska beskrivning av saknad resursbindning har kontrollerats:
`DeliveryDecisionCommand.resources/team`, full JSONB-replay och SQL-bindningen
till samma beslutstransaktion finns redan. Den föreslagna lösningen återanvänder dem;
ingen ny bindningstabell eller omskrivning av gammal migration behövs för detta.

## Instrumentets prov och granskningsfynd

**33/33 riktade Node-prov godkända**, inklusive den delade källskannerns kanarier.

Repots två skannervakter passerade också: check-guard-preprocessors granskade 58
skript, 53 med delad skanner och noll handrullade lexer-former.
check-source-scan-canaries verifierade 17 fallande mutationer över 13 skannerlägen.
Proven använder små egna tillfälliga Git-repon; inga riktiga kund- eller DB-data.

En separat granskare reproducerade fem konkreta fel i första utkastet. Alla fick
rättningar och negativa prov:

1. Borttagen produktionsnådd kod under docs måste räknas från basens graf också.
2. En symlänk fick inte dölja en testfil eller ge olika arbetskopia-/committal.
3. Python `from pkg import helper_test` måste följa både paket och submodul.
4. Workspace-exporters typgren får inte dölja en deklarerad runtime-testgren.
5. Kolon i filnamn får inte få felrapporten att filtrera bort en verklig testimport.

En avsiktlig beteendemutation i separat tillfällig kopia slog av testimportspärren.
Provet för oförändrad helper/barrel föll med AssertionError och exit 1.
Kopian städades; ordinarie källfil muterades inte och den hela sviten blev åter
33/33 grön. Detta är räknarens negativa kontroll, **inte** den beställda r22-kontrollen.

Räknaren granskar det statiskt upplösbara importnätet, inklusive oförändrade filer,
tsconfig-alias, workspace-exporter och Python-importer. Dynamiska laddare, eval,
underprocesser och resursläsningar särredovisas som analysgränser.
Aktuell inventering har 1 165 lästa källor, noll importfel och 320 sådana observationer;
historikmåttet har 1 253 källor, noll importfel och 312 observationer.
Grönt betyder inte bevis för alla möjliga runtime-laddningar. Regler och begränsningar
finns i `docs/production-lines.md`.

## Vad som ännu inte har utförts

De 14 r22-facitraderna i `kontrakt-och-facit.md` är frysta förväntningar.
**Samtliga är ännu oimplementerade och okörda.** Därför finns ingen ny DB-körning,
ingen ny Chromium-reproduktion av ett beslut, ingen r22-beteendemutation och ingen
röd r22-CI-kanarie att rapportera. Ingen testdatabas skapades för detta stoppunderlag.

2a-provfilen är byteidentisk mot e90-basen:
`764fee9c3753dd8ea4bd9d288ed2b8a88b7c3ec29c33c324a256e85da9fa7f62` (SHA-256).
Dess 17 facit har inte anpassats. Historiska skillnader före e90 omfattar byte från
Jest-expect till node:assert i tre setupkontroller; de ingår redan i den godkända basen.

CI-status och länk för exakt slutlig HEAD lämnas i PR och slutrapport.
En grön körning på detta stoppunderlag är **inte** ett bevis för steg 2.2-adaptern.
Den befintliga listan med 70 obligatoriska id är oförändrad.

Det finns ingen dokumenterad historisk orsak till att den fullständiga frysta
renderingskontexten saknades: **INGEN DOKUMENTERAD ORSAK**.

## Kvarstående produktbegränsningar

Snapshot-/resursbindningens beständighet bevisar inte i sig att varje PDF framställts
korrekt. Verklig rendereradapter och dess prov återstår. Den deklarerade miljön måste
vara oföränderlig under framställningen. PROVIDER_ACCEPTED är API-acceptans, inte
mottagarleverans eller läsning. Den redan lanseringsdokumenterade luckan 2b-26 består.
Ingenting i detta instrument aktiverar skyddet i produktionen.
