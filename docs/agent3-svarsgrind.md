# Agent 3: kontroll av svaret före visning och lagring

Bygger på #866. Där kunde modellen säga ”ingen notis betyder inga varningar”
och först därefter visa ett korrekt faktablock. Nu passerar svaret en gemensam
kontroll innan vanlig chatt eller SSE visar det. Verktygsstatus skickas löpande;
texten väntar tills kontrollen är klar. Det ändrar väntetiden även för SSE-svar
som senare visar sig handla om andra ämnen.

## Vad koden gör

- Samlar enbart faktiskt utförda förbrukningsläsningar, bundna till anrops-id
  och omgång. Parallella läsningar får ingen påhittad inbördes tidsordning.
- Ger varje textstycke ett id. Modellen klassar ämne och saklighet. Koden
  accepterar bara ett fullständigt svar med giltiga, unika id:n och etiketter.
  Modellen får inte skriva en ersättningstext.
- Behåller godkända stycken och separata stycken om andra ämnen. Ett avvisat
  stycke tas bort i sin helhet. Om ett stycke blandar ett korrekt besked med
  ett fel kan även den korrekta delen försvinna; detta är en kvarvarande gräns.
- Visar ett meddelande och kodbyggda granskningsräknare när text avvisas.
  Statusfakta från #866 ligger kvar. Reservsvaret väljer ingen godtycklig
  vinnare mellan motstridiga parallella granskningsresultat.
- Vid timeout, kostnadstak, för stort underlag, trunkering eller ogiltig dom
  visas reservsvaret. Ett misslyckande släpper inte igenom utkastet.
- Sparar exakt det kontrollerade svaret i både `content` och `blocks`, och
  skickar samma text till minnesextraktionen. Avvisad text sparas inte som
  ett dolt alternativ. Juridiska källor och turtaksmarkeringar bevaras.
- Skrivbekräftelser följer den befintliga vägen. Ingen ny ekonomisk eller
  annan domänåtgärd, roll, migration, notis eller aktivering tillkommer.

Ingången utan verktygsanrop är en heuristik över fråga, svar och sex senaste
historikposter. Ett faktiskt förbrukningsverktyg aktiverar alltid kontrollen.
Heuristiken bevisar inte täckning för godtyckliga omskrivningar eller äldre
elliptiska följdfrågor. Domaren är också en modell, inte en sanningsgaranti.

## Modell, budget och kostnad

De billigare domarna missade fel eller avvisade korrekta stycken. Den valda
profilen använder Opus 5, 4096 som tokentak och `effort: low`, utan
temperaturparameter. Det är högst ett kontrollanrop per avslutat svar,
30 sekunders timeout och inga automatiska återförsök. Hela underlaget måste
rymmas inom 48 000 tecken och 80 stycken; inget trunkeras för att få ett ja.

Kostnaden loggas på organisation och användare som `consumption-judge` och
räknas mot dygnets kostnadstak. Den förbrukar inte en extra meddelande-credit.
Månadsgrind, planvy, användningshistorik och användningsvarningar använder
samma avgränsning. Kostnaden finns kvar i historiken även när kontrollanropet
inte räknas som en extra fråga.

## Vad modellproven faktiskt visar

Alla indata är konstruerade eller återanvända syntetiska verktygsresultat.
Inga produktionsdata, produktionsskrivningar eller agentflaggor har använts.

| Mätning                                                   | Resultat                 | Tolkning                                                                      |
| --------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| Fast utvecklingsprov, slutkontroll                        | 36/36                    | Samma förhandsbestämda påståenden och facit genom modellbytena                |
| Separata nya formuleringar och verktygsbyggd sidindelning | 12/12 i båda körningarna | Utmaningsmaterial efter promptarbetet, fortfarande skapat av Codex            |
| Tio tidigare långa svar, senaste återspel                 | 9/10                     | Alla 10 utpekade sakfel stoppades; 43 av 44 utpekade korrekta stycken behölls |

Det kvarvarande avvisandet gäller stycke 10 i `low_rate_no_warning`.
Facit för det stycket har **inte** ändrats för att få en grön siffra. Hela
återspelsprovet är därför fortfarande rött. Övriga stycken utan förhandsmarkering
är inte facitgranskade och ingår inte i måtten. De här resultaten är inte
98 eller 100 procents träffsäkerhet i drift.

Tidigare försök finns kvar: det första JSON-formatet gav 0/36 användbara domar,
Haiku därefter 29/36, Sonnet 32/36 och 35/36, samt tidiga återspel 4/10 och 7/10.
Det första formatförsöket sparade inte usage vid parsefel; dess kostnad kan
därför inte summeras från rapporten. Senare körningar sparar usage och rå dom.

Slutprofilens uppmätta kontrolltid låg kring några sekunder per anrop; varje
rapport innehåller individuell tid och tokenantal. Detta är extra väntetid
utöver själva svaret och verktygen. Det är ett produktmässigt byte som behöver
granskas, inte en gratis förbättring.

Se [slutkontrollen](eval/agent3-svarsgrind-slutkontroll.json),
[utmaningen](eval/agent3-svarsgrind-utmaning-slut.json) och
[de långa svaren](eval/agent3-svarsgrind-langsvar-logik.json).
Arkiverade körningar hänvisar med SHA-256 till [gemensamma indata](eval/agent3-svarsgrind-underlag.json); avdupliceringen är förlustfri och alla referenser har verifierats. En ny körning skriver kompletta indata i sin egen rapport.

Skript: `eval-consumption-reply-guard.ts` och `eval-consumption-reply-replay.ts`
i `apps/api/scripts`. De kräver `EVAL_CONSUMPTION_LIVE=1` och utvecklingsnyckel.
Utmaningsmaterialet väljs med `EVAL_CASE_SET=challenge`. Kör aldrig proven mot
kunddata genom att byta ut fixtures utan ett uttryckligt beslut om underlaget.

## Granskningsstatus

Detta är ett utkast, **inte driftgodkännande av hela Agent 3**. Före merge
behöver Claude granska särskilt filtrering av korrekta stycken, blandade frågor,
SSE-väntetiden och kostnadsräkningen. Innan drift behövs oberoende verkligt
granskat underlag och en kontrollerad pilot. Användaren bekräftade 2026-09-09
att sådant underlag inte finns ännu.

Lokala tester täcker normal chatt, SSE före första text, återspelad historik,
minnen, blandade svar, fel, kostnadstak, iterationstak, roller och skrivbekräftelser.
194 lokala tester har passerat i 13 berörda sviter (en rättad testfixture kördes om separat). API-typkontroll och lint är gröna. 15 relevanta vakter är gröna före/efter utan nya undantag. Full CI måste vara
grön på publicerad HEAD; grön CI ersätter inte ovanstående semantiska granskning.

Samlad avgränsning och återstående beslut finns i
[Agent 3:s slutkontroll](agent3-slutkontroll.md).
