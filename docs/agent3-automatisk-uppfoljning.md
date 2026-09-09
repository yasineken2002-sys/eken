# Agent 3: daglig uppföljning av granskningskön

Fortsätter på #863. Ett dagligt jobb kl. 07.15 i Europe/Stockholm läser hela
organisationens granskningsunderlag och använder samma `TO_ASSESS`-urval som
webben och assistenten. Ingen modell anropas. Ingen avläsning, bedömning,
förbrukningspost, faktura eller bokföringsrad ändras.

## Av från början, per organisation

`consumptionReviewFollowUpEnabled` har DB-default `false`. Den är fristående
från skuggagenternas och exekveringsagentens flaggor. Endast en aktiv OWNER i
sessionens organisation får ändra den, med ny DB-kontroll av rollen.
GET får läsas av OWNER, ADMIN, MANAGER, ACCOUNTANT och VIEWER.
PATCH har ett delat Zod-kontrakt, `implements`, `SammaNycklar`, registerpost och
paritetsprov genom produktionspipen. Webbens knapp skickar en boolesk kropp.
`StrictBoolean` behåller husregeln: API:t accepterar även strängen "false"
som false, medan webbens schema kräver boolean. "yes", tal och null avvisas.

Migrationen lägger bara till fem kolumner på Organization. Den aktiverar inget.
Reglaget finns i Granskning och visar serverns bekräftade värde; ett väntande
eller misslyckat svar får inte visas som ett bekräftat byte.

## En samlad notis per dag och mottagare

Aktiva OWNER, ADMIN och MANAGER får en intern SYSTEM-notis när varningar behöver
bedömas. Inga mejl eller externa utskick görs. Notisen innehåller antal och
länk, inga källvärden, personnamn eller motiveringar. Antalet gäller kontrollens
ögonblick; klicket öppnar aktuellt underlag på `/consumption?tab=review`.
Flikvalet finns i routern och överlever omladdning och bakåtnavigering.

Notisens id är en SHA-256-hash över organisation, användare, kalenderdag i
Stockholm och typ (kö/fel). `Notification.id @id` och `createMany(skipDuplicates)`
skyddar även vid samtidiga processer och återförsök. Kö och fel kan alltså ge
högst en notis vardera per dag. En kvarvarande kö påminns nästa dag. Även
bedömda varningar finns kvar i granskningen; CONFIRMED betyder inte åtgärdad
eller godkänd för debitering.

Notis och kontrollstatus skrivs i samma korta transaktion. Ett fel efter
infogningen rullar tillbaka båda. Ingen förhandsmarkör kan förbruka försöket.
Slutskrivning och av/på låser samma organisationsrad. Ett versionsnummer som
ökar vid ändrat reglage stoppar äldre pågående kontroller även efter av/på.
Analysen sker före radlåset så att full historikläsning inte håller låset.
Ett äldre försök får inte ersätta ett nyare lagrat utfall.

## Misslyckat, försenat och genomfört är olika tillstånd

En lyckad kontroll, även utan varningar, lagrar en tidsstämpel. Noll varningar
skickar inget allt-klart-besked. Ett per-org-fel registreras via CronErrorSink,
ger om möjligt en intern felnotis och felstämpel och stoppar inte nästa org.
En senare lyckad kontroll rensar den aktuella felstämpeln; det beständiga
tekniska felspåret finns kvar i ErrorLog.

Webben läser om status varje minut och visar försenat när senaste kontrollen
(eller aktivering i väntan på första) ligger mer än 26 timmar tillbaka.
Marginalen täcker även höstens 25-timmarsdygn. Statuskortet är synligt även om
rapportläsningen misslyckas. En genomförd kontroll godkänner aldrig avläsningar
eller debitering.

Om databasen är nere kan varken användarnotis eller status lagras. Då återstår
felsänkans/larmens reservväg och att webben visar hämtfel eller försenad status.
Ett helt stoppat schema kan inte larma om sig självt. Det här bygget innehåller
inte en extern övervakare, omedelbar omkörning eller ett besked om varför
avläsningar saknas. Tidsstämpeln intygar körningen, inte täckningen av verkliga
mätare. Läsningens trendtäckning visas fortsatt separat.

## Verifiering och gränser

Lokalt: 760 API-prov i nio relevanta sviter och 87 webbprov i tio sviter gröna.
API-/webbtypkontroll, shared-/UI-bygge, ändrad kods lint och nio relevanta
vakter är gröna. Behörighetsinventariet växer från 219 till 221 med bara de två
nya endpointsen; objektscopningsinventariet är oförändrat.

Webbköraren hade först en oläsbar installerad jsdom-fil; samma versions fil
återställdes i den lokala arbetskopians beroenden. En avbruten fork-körning
ersattes av en seriell trådkörning av alla tio berörda sviter, utan fel.
Ingen källkod eller testregel ändrades för att kringgå installationsfelet.


Riktade enhets- och HTTP-prov mäter urval, org/roll, felisolering, av/på under
pågående arbete, gamla resultat, dygnsgräns/DST, kontrakt och webbstater.
DB-proven kör produktionsvägen mot riktig Postgres i CI: konkurrens,
transaktionsrollback, återförsök, flaggans default, av/på under läsning,
aktuell ägarroll och frånvaro av finansiella/domänskrivningar.

Ett nytt Playwright-prov kör ägarens av/på mot riktigt API och DB, omladdning,
notisklick och bakåtnavigering. Bara notislistan i det provet är en attrapp;
cronets faktiska notisskrivning prövas i DB-sviten. CI:s E2E-inventarium går
från 14 till 15. Kontraktsvakten går från 96 till 97 bundna typer utan nya
undantag. Croninventariet går från 34 till 35, alla med beständig felsänka.

Detta är en första automatisk uppföljning av bedömningsarbete. Oberoende
verkligt granskningsfacit, driftmätning och vidare Agent 3-funktioner återstår.
Modellens kvarvarande språkproblem från #862 mäts inte och löses inte av detta
jobb. Ingen produktion har ändrats eller aktiverats av bygget.
