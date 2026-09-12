# Bekräftelsetext — avgränsad rättning av #867 b

Fast bas: 561b382b6cbddfccba719613a5ea3aa2f0f7e695 (#883).
Egen gren: codex/agent3-bekraftelsetext. Äldre grenar förblir frysta.

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

### Före, efter och negativ kontroll

Facit och tester committades före produktionsändringen i 307e1225. Produktionsändringen säkrades i a95c048f99d629120d4539cf53b27d65f080ea94 före negativkontrollen.

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
node scripts/production-lines.mjs 561b382b6cbddfccba719613a5ea3aa2f0f7e695 HEAD
```

### Pushstopp

Efter explicit fetch av refs/heads/main till refs/remotes/origin/main var origin/main 3b71e905d866f461f6b07211bc89b3fa88505200 och merge-base 27a720d4b6fb194fed83c760ce713c6aa70a0ad5. Kontrollens diff omfattar 462 filer: våra sju filer plus 455 ärvda filer. Samtliga 455 är byteoförändrade mellan den fasta basen och vår HEAD.

Användarens regel kräver stopp när diffen mot main innehåller filer vi inte rört. Tidigare undantag för inventeringen återanvänds inte som generellt tillstånd. Ingen push eller ny PR har därför genomförts; ingen ny CI-status kan redovisas. Färdigt förslag är en utkast-PR från codex/agent3-bekraftelsetext mot codex/agent3-rendering-2-2-real, efter uttryckligt undantag för dessa oförändrade ärvda filer. Ingen merge.

Slutlig lint och formatering är gröna. Webbens sex prov och typkontroll kördes åter efter rättningen av testets typimport, utan fel.
