# Portalens lösenordsinloggning och hyresvärdsval

Detta paket rättar API:ts val av konto när samma e-postadress finns hos flera
hyresvärdar. Det är en avgränsad leverans inför klientarbete och belastningsprov,
inte ett godkännande för produktionsaktivering av de preliminära resursgränserna.

## Kontoval och bakåtkompatibilitet

`POST /v1/tenant-portal/login/resolve` använder befintliga `LoginDto` och
`TenantLoginSchema`. Svaret följer `TenantLoginResolveResultSchema`:

- `complete` innehåller sessionstoken, utgångstid och den befintliga begränsade
  hyresgästsammanfattningen när exakt ett konto godkänner lösenordet.
- `choose` innehåller endast ID och namn för de organisationer vars aktiva,
  icke-anonymiserade konton godkänner lösenordet. Ingen session skapas då.

Efter ett val skickas samma uppgifter och `organizationId` till login på nytt.
Valet är ingen fullmakt: aktuell adress, organisation och lösenord verifieras
igen. Ett lösenord hos A ger aldrig behörighet hos B genom kandidatlistan.
Den gamla `/login` behåller sin sessionsform men nekar tvetydighet med samma
generiska 401 som fel lösenord. Den väljer inte längre godtyckligt första raden.

Den kompletta initiala kandidatläsningen definierar försöket. En extra rad
används bara för att upptäcka för stort underlag: hela försöket nekas då, innan
bcrypt körs. Det returneras aldrig en avklippt lista. Konton som skapas efter
läsningen kan synas nästa gång. Efter jämförelser låses matchande rader i stabil
ID-ordning och adress, organisation, hash och aktiveringsstatus läses om före
svar eller sessionsskapande. Detta fryser inte alla framtida e-poständringar.

## Preliminär arbetsbudget

Både gamla login, resolve och login med explicit organisation går genom den
obligatoriska `TenantLoginBudget`. Redisfel öppnar ingen obegränsad reservväg.
Alla siffror nedan är startvärden för verifiering, inte bevisad driftkapacitet.

| Gräns                                           | Startvärde            |
| ----------------------------------------------- | --------------------- |
| Aktiv kedja per API-process                     | 1, ingen väntelista   |
| Kandidater / cost-12-arbetsenheter per försök   | 5 / 5                 |
| Requestkvot per minut: deployment / IP / adress | 120 / 10 / 10         |
| Arbetskvot per minut: deployment / IP / adress  | 60 / 15 / 15          |
| Redis-kommando / hela försöket                  | 1 sekund / 5 sekunder |

Varje hash kostar minst en enhet. Cost 13 kostar två, cost 14 fyra osv.
Lösenord och hashkostnad ändras inte. Alla jämförelser reserveras före den första.
Även en tom kandidatlista debiteras en enhet. Överflöde och okända/otillåtna
hashkostnader ger samma generiska 401 som fel lösenord för att inte införa ett
separat HTTP-statusorakel för dessa kontotillstånd. Kvot, upptagen process,
Redisfel och avbrott ger generiskt 429.

Lua kontrollerar alla tre kvoter atomiskt innan någon debiteras. Adress/IP är
domänseparerade HMAC-värden baserade på gemensam `JWT_SECRET`; råa adresser, IP,
lösenord, hashvärden, kandidatlistor och organisationsnamn sparas inte i Redis.
Nycklarna har 60 sekunders TTL från respektive första godkända debitering.
Det är fasta fönster, inte glidande. Gemensamt Redis och gemensam HMAC-hemlighet
krävs mellan repliker; rotation och Redis-omstart kan nollställa budgethistorik.

En tidsgräns avbryter inte redan körande bcrypt. Kontrollpunkter hindrar nästa
steg och den lokala platsen hålls tills verkligt arbete slutar. Ett sent Redis-
svar kan debitera kvot men startar aldrig det redan nekade arbetet. Ingen kvot
återbetalas vid fel lösenord. Detta begränsar lösenordslogin, inte automatiskt
alla andra bcrypt-vägar eller hela API:ts resursförbrukning.

Ett observerat avbrott före transaktionscommit rullar tillbaka sessionen.
Avbrott under själva commit kan däremot ge klienten ett fel trots att en för
klienten okänd session hunnit sparas. Paketet garanterar inte att sådana rader
aldrig finns; ingen sessionstoken lämnas ut via fel- eller choose-svar.

## Klient och reservväg före aktivering

Klienten ska hålla lösenord och val endast i formulärets kortlivade minne.
De ska aldrig läggas i URL, localStorage, loggar, telemetri eller QueryClient.
Integrera portalens separata sessionsisolering och skydda mot sena svar från
tidigare försök. Ny klientvy ingår inte i detta API-paket.

Visa samma frivilliga reservåtgärder för alla: login i känd hyresvärdskontext
eller befintlig glömt-lösenord-funktion. Publicera ingen e-postbaserad lista
över organisationer. Återställning byter det berörda kontots lösenord och
återkallar dess tidigare sessioner; det är ingen lösenordslös loginlänk.
Starta aldrig automatiskt återställningsmejl eller en retryloop vid nekande.
Väntan löser inte ett permanent för stort kandidatunderlag. För hög historisk
hashkostnad kan även explicit organisationslogin nekas; inventering och mätning
måste lösa detta före skarp användning, inte döljas som ett användarfel.

Sekventiella jämförelser och varierande kvotanvändning ger observerbara
tidsskillnader. Samma generiska feltext eliminerar inte kontouppräkning via tid
eller upprepade kvotobservationer. Paketet lovar inte fullständigt skydd mot detta.

## Verifiering och återstående driftbevis

Domänprov använder riktig PostgreSQL, riktiga transaktioner och bcrypt med låg
testkostnad. HTTP-prov använder produktionens valideringspipe och svarshölje.
Redis-prov använder riktig Lua med separata nyckelprefix. Sådana funktionella
prov bevisar inte cost-12-kapacitet eller svarstider i en kundmiljö.

Den tidigare lokala cost-12-mätningen på Apple M1, 8 rapporterade CPU:er, gav
271–276 ms för en jämförelse och cirka 1,35 s för fem. Den inkluderar inte
databas, Redis, låsväntan eller samtidig trafik och är ingen tvåkärnig p95-mätning.

Före produktionsaktivering krävs:

1. Färdig klient med kontoval, sessionsisolering och fungerande frivillig reservväg.
2. Faktisk inventering av antal relevanta konton per adress och hashkostnader.
3. Cost-12-lastprov på verkliga effektiva två CPU:er med övrig API-last, p95/p99,
   event-loop-gap, accepterade/nekade försök, CPU och minne. Justera gränser med
   mätningen och redovisa maximalt antal repliker.
4. Granskning av helheten och CI på den kod som ska levereras. Syntetiska prov
   ersätter inte driftbevis eller verkliga kundutfall.
