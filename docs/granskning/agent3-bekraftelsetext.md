# Bekräftelsetext — avgränsad rättning av #867 b

Fast PR-bas: 3fa4b55128143d5bd70f696178679f2a99f22f29 (#867, codex/agent3-svarsgrind).
Egen gren: codex/agent3-bekraftelsetext-867. Befintliga grenar förblir orörda.

Facit, skrivet före produktionsändringen:

- En registrerad SSE-bekräftelse får exakt den samlade modelltexten före pending_action.
- En misslyckad pending-registrering lämnar ingen sådan text eller bekräftelse.
- Texten syns bredvid bekräftelsekortet även efter omhämtning av user-historik.
- Texten följer samma pågående åtgärd genom dubbelbekräftelse, men inte ett nytt samtal.
- Avbryt/bekräfta använder oförändrade verktygsindata och serverns bekräftelsevillkor.
- Delade nätverksläsningar, även mitt i JSON eller svensk UTF-8, får inte tappa texten.
- Textlösa förslag fungerar fortsatt. Inget skrivverktyg körs när förslaget visas.

UI-texten är tillfällig och ger ingen ny historik- eller återladdningsgaranti.
POST-vägens tidigare tomma pending-reply ändras inte här.
Global SSE-buffring, förbrukningsgrindens aktiveringsgräns och statuskontrakt
är separata kvarstående fynd. Denna rättning aktiverar inget Agent 3-flöde.

Inga betalda modellanrop, produktionsanrop, migrationer eller mergar ingår.

## Leverans och bevis

Avgränsning: rättning av #867 b, tappad förklaring vid SSE-bekräftelse. Den andra blockeraren, global buffring av svar, är inte löst. Ingen aktivering eller inkoppling av utskicksgrinden ingår.

Ändringar mot den fasta basen:

| Fil:rad                                                     | Beteende                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| apps/api/src/ai/ai-assistant.controller.ts:500              | Samlad förslagstext sänds först efter lyckad registrering, före pending_action. Ingen verktygsexekvering eller ny assistenthistorik. |
| apps/web/src/features/ai/AiPage.tsx:180                     | Synkron textackumulator fångar även delta och pending i samma nätverksläsning. Texten binds till den lokala väntande åtgärden.       |
| apps/web/src/features/ai/AiPage.tsx:276                     | Texten bevaras vid serverkrävd dubbelbekräftelse; serverns nya verktygsindata används. Texten skickas aldrig som bekräftelseindata.  |
| apps/web/src/features/ai/api/ai.api.ts:200                  | Ofullständiga SSE-rader och UTF-8-tecken sammanfogas över nätverksläsningar.                                                         |
| apps/web/src/features/ai/components/ConfirmationCard.tsx:73 | Hela förklaringen visas i en höjdbegränsad, tangentbordsåtkomlig rullningsyta före serverns bekräftelseuppgifter och knappar.        |
| apps/api/src/ai/consumption-follow-up-chat.spec.ts:380      | Fyra nya prov genom den verkliga kontrollern: ordning, väntande registrering, registreringsfel och textlöst förslag.                 |
| apps/web/src/features/ai/AiPage.pending-action.spec.tsx:165 | Sex prov genom verklig AiPage, ConfirmationCard, QueryClient och SSE-läsare med syntetisk HTTP-ström.                                |

### Ursprungliga före-/efterprov och negativ kontroll

Den första arbetskopian utgick från #883. Nedanstående ursprungliga prov kördes där; omproven på rätt PR-bas redovisas separat nedan. Facit och tester committades före produktionsändringen i 307e1225. Produktionsändringen säkrades i a95c048f99d629120d4539cf53b27d65f080ea94 före negativkontrollen.

| Kontroll                | Utfall                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| API före rättningen     | 28 godkända, 2 avsedda fel av 30; de 26 ursprungliga proven gröna.                                                                    |
| Webb före rättningen    | 0/6 godkända: bekräftelsetext saknades och delade SSE-rader tappades.                                                                 |
| API efter rättningen    | 3 sviter, 41/41 godkända: consumption-follow-up-chat, ai-pending-action och ai-double-confirmation.                                   |
| Webb efter rättningen   | 6/6 godkända.                                                                                                                         |
| Beteendenegativkontroll | Återställde endast SSE-parserfilen till basversionen: exakt provet för delad JSON och UTF-8 föll; 5/6 passerade.                      |
| Exakt återställning     | Parserfilen återställdes från a95c048f; SHA-256 7b45ec5a6088fef63e608858f3d06efbdbe89346bf00e6ad7cc4f1d376de380e. Därefter 6/6 gröna. |
| Typkontroll webb        | Grön.                                                                                                                                 |
| Typkontroll API         | Grön med 2600 MB Node-heap. Första försöket med 1800 MB avbröts av minnestaket och räknas inte som godkänt.                           |

Ett inledande API-startförsök hade fel sökväg till testköraren och räknas inte som ett rött beteendeprov. Två efter-prov i webben behövde korrigerade testassertions för React Query:s extra mutationskontext; den fullständiga första argumentkroppen kontrolleras fortfarande exakt. Slutlig lintkontroll krävde en statisk typimport i testet, utan ändrat facit.

Modell, databas och HTTP-svar är ersatta med syntetiska testgränser. Proven bevisar kontrollerns och webbens beteende, inte verklig modellkvalitet eller en produktionsintegration. Inga betalda anrop eller produktionsdata användes.

### Verklig webbläsare

Isolerad Vite-förhandsvisning av verklig AiPage med lokal API-simulering kördes i Chromium. 25 000 tecken bevarades exakt vid 1280×800 och 768×1024. Förklaringsytan var 128 px hög; scrollHeight var 5484 respektive 10969 px. Playwrights trial-klick verifierade att Bekräfta och utför var åtkomlig, utan att exekvera åtgärden: noll bekräftelseanrop. Surfplatteskärmbilden inspekterades visuellt.

Ett försök vid 390×844 stannade före utskick eftersom inmatningsfältet inte var synligt. Det är inte ett godkänt mobilprov och orsaken är inte fastställd här. Skärmbilder och tillfälliga körloggar införs inte i Git. Egen Vite-process och webbläsare stoppades.

### Oberoende granskning och begränsningar

En separat granskare granskade flödet och rättningen. Risken att lång text trängde undan knapparna åtgärdades med rullningsytan och kontrollerades med ovanstående webbläsarprov.

Texten finns endast i den aktuella väntande åtgärdens klienttillstånd. Ingen återladdnings- eller historikgaranti införs. Navigationsproven gäller färdig mottagen ström. Befintliga kapplöpningar där ett sent ström- eller bekräftelsesvar kommer efter navigering är inte lösta. POST-vägen ändras inte. Serverns newline-avslutade SSE-ramar är kontraktet; ofullständiga ramar vid avbruten anslutning får ingen ny garanti.

Texten är ett förslag från modellen, inte bevis på utförd åtgärd. Verktygets registrering, bekräftelsevillkor, hash och explicita bekräftelseindata är oförändrade. Global svarsbuffring och övriga granskningsfynd i Agent 3 återstår.

### Reproduktion

Kör i denna worktree, en tung process åt gången och först efter tom kontroll:

```sh
pgrep -af "[j]est|[t]sc"
cd apps/api
node --max-old-space-size=1400 node_modules/jest/bin/jest.js --runInBand --no-cache --runTestsByPath src/ai/consumption-follow-up-chat.spec.ts src/ai/ai-pending-action.spec.ts src/ai/ai-double-confirmation.spec.ts
cd ../web
node --max-old-space-size=1400 node_modules/vitest/vitest.mjs run src/features/ai/AiPage.pending-action.spec.tsx --maxWorkers=1 --minWorkers=1
cd ../..
git diff --numstat origin/codex/agent3-svarsgrind..HEAD
```

### Flytt till regressionskällan och båda diffmåtten

Användarens besked ändrar målgrenen till #867:s gren, där regressionen infördes. En ny worktree skapades från dess exakta HEAD. Alla tre egna commits behövdes: 850e9f7d ensam innehåller inte hela kodändringen. De applicerades med vanliga cherry-picks:

| Ursprunglig commit                       | Ny commit |
| ---------------------------------------- | --------- |
| 307e12251c1607ebeacf7c9a0cbbcbbf94daee39 | c6beec45  |
| a95c048f99d629120d4539cf53b27d65f080ea94 | 8f6f4924  |
| 850e9f7d318a3357e6e2ba6252e820ac429c6b8a | 37d5763d  |

Alla sex kod- och testfiler är byteidentiska med den tidigare fixen. Ingen befintlig gren har skrivits om. Rapporten uppdateras för korrekt bas och mätning.

Vid mätningen: origin/main = 3b71e905d866f461f6b07211bc89b3fa88505200, merge-base = 27a720d4b6fb194fed83c760ce713c6aa70a0ad5.

```sh
git diff --name-only origin/codex/agent3-svarsgrind..HEAD
# 7 filer: fyra produktionsfiler, två testfiler och denna rapport.

git diff --name-only "$(git merge-base HEAD origin/main)"..HEAD
# 134 filer: 7 egna och 127 ärvda.
```

Samtliga ärvda filer är oförändrade mellan PR-basen och denna gren. Ingenting har filtrerats bort för att få en kortare lista. Den rätta stackdiffen innehåller exakt de sju avsedda filerna; inga andra filer följer med rättningen.

En separat läsande återgranskning på 37d5763d gav inga blockerande fynd inom rättningen: 36 tillagda plus 5 borttagna produktionsrader, oförändrad bekräftelsepayload och explicit knapptryck, höjdbegränsad förklaring och inga ärvda borttagningar.

Global SSE-buffring, blockerande fynd 1, kvarstår. Framåtpropagering till #877, #878, #879, #881, #882 och #883 är inte utförd och kräver separat beställning. Ingen merge eller aktivering ingår. Kodgodkännande från ägarens granskare inväntas när utkast-PR finns.

### Omprov på #867-basen

På 37d5763d byggdes egna @eken/ui och @eken/shared från den nya worktreen. Två shared-filer skiljer från #883, så senare grenars byggda shared-paket återanvändes inte. Installerade tredjepartsberoenden återanvändes; paketmanifest och låsfil är oförändrade.

Resultat: 41/41 API-prov i tre sviter, 6/6 webbprov, grön API-typkontroll och grön webbtypkontroll. Processkontrollen var tom före varje tung körning; körningarna var sekventiella. Negativkontrollen och webbläsarbeviset ovan tillhör den första arbetskopian och påstås inte ha körts om här.

Radräknaren finns ännu inte i #867. Den kördes därför läsande via exporten measure(worktree, base) ur #882:s oförändrade verktyg, pinnat till 0d048101f291cf352a730100ec96d6b042ed98a4; både production-lines.mjs och lib/source-scan.mjs verifierades byteidentiska mot Git-objekten. Inget verktyg har kopierats in i denna PR. Utfallet är 41 ändrade produktionsrader (36 + 5), 335 testrader och noll binärfiler. Dokumentationsrader särredovisas i PR-texten.

Slutlig lint, formatering och git diff --check körs före leverans. Lokal verifiering ersätter inte kommande CI eller ägarens kodgranskning.
