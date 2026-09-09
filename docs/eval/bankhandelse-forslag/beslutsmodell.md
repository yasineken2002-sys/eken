# Beslutsmodell före bygge — oapplicerat ändringsförslag efter #874

Bas: fa15d0d9f3eae17d04afc4d46165cb45205373fa. #874 och dess CI
34415107029 är verifierat gröna på exakt denna HEAD (61 kontroller).
Main 27a720d4b6fb194fed83c760ce713c6aa70a0ad5 integreras inte; bara tidigare
StrictString-tillägg i confirm-import.dto.ts skiljer relevanta produktfiler.
Arbetskopia ren vid start, 2,2 GB disk ledigt, inga Jest/tsc-jobb.

Ingen frigivning finns för apps/api/src/reconciliation/**. Därför blir hela
kandidaten ett samordnat patchartefakt, inklusive oapplicerad lagring/migration
och indataflöde. Inga halvt inkopplade produktionsdelar checkas in. SQL-delens
egenskaper provas separat i den befintliga isolerade PostgreSQL-riggen; detta
är inte en verifierad ändrad produktionsimport eller bokföringsintegration.

| Underlag | Beslut | Ekonomisk hantering |
| --- | --- | --- |
| Samma verifierade bankidentitet, samma oförändrade betalningsinnehåll | En händelse, ytterligare spårbar observation | Samma betalningsrad. Redan avslutat hanteringsförsök körs inte igen. |
| Olika ID inom ett verifierat stabilt namespace och samma verifierade bankkonto | Två händelser även vid samma dag/belopp/OCR | Två betalningsrader; vardera högst ett importinitierat hanteringsförsök. |
| Olika verifierade bankkonton | Skilda händelser även om lokala ID är lika | Organisation och konto hålls åtskilda; inga belopp kvittas mellan dem. |
| Fil/API eller nytt samtycke utan verifierad identitetsbrygga | Identiteten är oklar; aldrig automatiskt "dubblett" på likhet | Båda observationer bevaras; den obestyrkta får ingen ny ekonomisk effekt. |
| Samma verifierade ID med ändrat belopp/referens/status | Ny observation och innehållskonflikt | Gammal betalning/allokering lämnas orörd; inget nytt belopp eller automatisk rättelse. |
| Äldre betalning utan styrkt konto/namespace | Inget påhittat samband | Ingen ny effekt för möjlig återimport. En verifierad brygga eller granskad övergångsavgränsning krävs. |

## Vad "verifierad" måste betyda

En serverförvaltad bindning kopplar organisation + provider + samtycke + det
faktiskt hämtade providerkontot till ett kanoniskt bankkonto/ID-namespace.
Namespace-registret måste bära källa, kontraktsversion och bevis för ID:ns
stabilitet, slutligt bokföringsdatum/innehåll samt kontinuitet över samtycken.
Det får inte skapas från klientens flagga, OCR, kontonamn eller enbart en
strängkombination. Nytt samtycke utan verifierad bindning förblir obundet.
Olika namespaces är inte automatiskt olika pengar: samma bankkonto via två
providers kräver en verifierad brygga, annars hålls överlapp öppet.

I verklig anslutning är dessa kontrakt ännu okända. De nuvarande parser-/API-
argumenten innehåller inte detta bevis. Originalfallen får inga nya påhittade
bankfält. Positiva SQL-prov använder separat, uttryckligt syntetiskt verifierat
underlag; oförändrade originalfält provas även utan denna tilläggsinformation.
Utan underlag kan båda hundralapparna bevaras som observationer men inte kallas
två säkert frigivna betalningar. Säkert styrkta nya händelser ska gå automatiskt.

## Lagring, övergång och avbrott

Minsta modell: en oföränderlig observationslogg, ett serverförvaltat register
för identitetsbindningar och en bankhändelse med unik identitet, länk till
befintlig BankTransaction och beständigt tillstånd för importens vidare hantering.
BankTransaction:s gamla externalId-index lämnas för äldre rader; nya rader
använder den nya händelselänken och lagrar original-ID på observation/händelse.
Ingen backfill eller ändring av historiska betalnings-/allokeringsrader.

En verifierad övergång måste antingen styrka kopplingen till en äldre rad eller
visa att nya händelser ligger utanför tidigare importerad historik. En datumgräns
får användas endast med granskad övergång och styrkt oföränderligt bankdatum;
migrationstid ensam är inget bevis. Saknat övergångsbevis ger väntande observation,
inte en ny betalning. Registerpopulation ingår inte i migrationen.

Observation, unik händelse, eventuell ny betalning och PENDING sparas atomiskt.
Ett atomiskt anspråk PENDING → STARTED släpper fram ett importinitierat försök.
Krasch före anspråket kan återupptas säkert. Efter anspråket kan koden ha hunnit
matcha eller köa: STARTED/UNCERTAIN får inte automatiskt återförsökas vid import.
Det är ett synligt granskningsbehov, inte färdig hantering eller exakt-en-gång.
Normal lyckad körning avslutar försöket; exakt återimport gör inget nytt anrop.
Andra automatiska vägar måste respektera oavslutat försök så att de inte blir
ett dolt återförsök. Befintliga allokeringslås läses men certifieras inte om av
ett förenklat SQL-prov. Riktig Prisma/kö/matchning kräver senare integrationstest.

OCR-extraktion, aviuppslag, äldre OCR, del- och samlingsbetalning ska lämnas
oförändrade. Cursor/sidindelning hålls som separat känd uppgift. Inga anrop till
banker, modell-API:er eller utskick. Alla original- och #874-underlag hashbevaras.
