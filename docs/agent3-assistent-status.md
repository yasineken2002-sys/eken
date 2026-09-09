# Agent 3: assistenten läser automatisk uppföljning

Fortsättning efter #864. Assistenten kan läsa om förbrukningsuppföljningen är
påslagen, väntar på sin första körning, har misslyckats eller är försenad.
`get_consumption_follow_up` finns i operatörens verktygsmeny. Det läser samma
fyra statusfält som HTTP-endpointen via `loadReadingReviewFollowUp`.

## Samma besked i chatten och granskningsvyn

Tillstånd och etiketter bor i shared. Webbens klocka och assistentens aktuella
läsögonblick använder samma beräkning, inklusive 26-timmarsgränsen och
prioriteringen av avstängt och misslyckat. En gammal lyckad körning visar inte
att en avstängd uppföljning fortfarande är på. Ett oförändrat DB-svar kan bli
försenat när tiden går. Schemat hämtas från samma konstanter som cronjobbet. Tider formateras i svensk
lokaltid i shared. Nästa planerade schematid beräknas efter läsögonblicket med
Stockholms faktiska UTC-offset, även vid sommartidsbyte; avstängt ger ingen
nästa tid. Detta är en planerad tid, inte en garanti att jobbet lyckas.
Påslagsdatum får inte tolkas som avstängningsdatum, som inte finns lagrat.

Status läses separat från avläsningsanalysen. En bruten granskningsrapport
hindrar därför inte en fungerande organisationsläsning från att visa status.
Fel i själva statusläsningen ger fel, aldrig ett påhittat avstängt läge.
Tidsstämplarna visar senaste lagrade kontroll, inte att assistenten just
körde analysen. En statusläsning startar inget jobb.

Resultatet berättar inte varför en körning misslyckades, om en notis nått en
användare eller hur många aktuella varningar som finns. För varningar används
`get_consumption_review`. Utebliven notis och lyckad körning friskförklarar
inte avläsningar och godkänner ingen debitering.

## Behörigheter och sidoeffekter

Samma fem roller som HTTP får läsa. Okänd roll nekas. Verktygsinput är ett
strikt tomt objekt; organisation kommer från sessionen, aldrig från modellen.
Assistenten kan inte ändra reglaget, starta om kontrollen eller spara en
bedömning. Den mänskliga vägen är Förbrukning → Granskning. Endast OWNER kan
ändra reglaget; OWNER, ADMIN och MANAGER kan spara bedömningar. Rollinformationen
i verktygssvaren jämförs mot respektive HTTP-rollgrinds metadata i prov.

Organisationsfrågan väljer bara de fyra statuskolumnerna, inte revisionen
eller någon annan organisationsuppgift. Inga nya DB-kolumner, HTTP-endpoints,
notiser, skrivverktyg, agentdelegationer eller produktionsaktiveringar tillkommer.
Det befintliga cronjobbet behåller kl. 07.15 i Europe/Stockholm.

## Granskningsspråk

Det befintliga granskningsverktyget lämnar en explicit lista över sparroller
och skiljer trendkontrollen HIGH_RATE från DATA, OVERLAP och DECREASE. Prov
visar att var och en av de tre senare kan hitta avvikelser när trendtäckningen
är NONE. Prompten skiljer dessa begränsningar och roller från uppföljningens
ägarreglage. Formuleringarnas riktighet kräver fortfarande granskning av
faktiska modellsvar; fungerande verktygsflöde är inget semantiskt mått.

## Verifiering

Enhetsprov täcker status, tidsgräns, schema, behörighet, strikt inputgrind,
utebliven DB-rad och misslyckad läsning. ToolExecutor-provet läser om en
förändrad rad och visar att ett fel inte får någon statusdata. DB-sviten från
#864 utökas med faktisk API-paritet, organisationsisolering och oförändrade
organisations-, notis- och domänrader mot Postgres i CI.

`apps/api/scripts/eval-consumption-follow-up.ts` kör tio konstruerade frågor
med produktionsprompt och verktygsmeny, separat provkontext och attrappad DB.
Bara förbrukningens två läsverktyg kan köras. Ingen databas ansluts och ingen
ekonomisk eller annan skrivande åtgärd har en exekveringsväg. Riktiga modellprov
kräver uttryckligt live-val och separat utvecklingsnyckel och körs aldrig i CI.
Den befintliga riggens tre frågor används också före och efter ändringen.

Modellproven saknar produktionens extra portfölj- och minneskontext. Frågorna
är utvecklingsmaterial, inte ett oberoende facit eller ett precisionsmått.
Oberoende verkliga fall och driftmätning återstår för Agent 3.


Lokalt passerar 162 API-prov i elva relevanta sviter och 75 webbprov i nio
sviter. UI/shared-bygge, API-/webbtypkontroll och ändrad kods lint är gröna. 15 relevanta vakter mättes före och efter utan nya undantag.
Full CI och den utökade Postgres-sviten krävs på publicerad HEAD före merge.

Mellanproven fångade felaktig tidszon, ett påslagsdatum kallat avstängning,
en passerad tid kallad nästa körning och otydlig avgränsning av trendkontrollen.
Därför tillkom färdigformaterade lokaltider, nästa planerade tid i kod och
uttrycklig avgränsning av vad statusen kan bevisa. Svaren och den manuella
genomgången sparas under docs/eval, inklusive bristerna före ändringen.


Senare modellprov fångade också "automatiskt godkänd" om trendjämförelse utan
varning, ett påhittat fysiskt maxvärde och påståendet att ägaren kunde ändra
schemat. Prompt och kapacitetsfält förtydligar att ingen av dessa förmågor finns.
Samma tio frågor körs om; det underkända mellanprovet finns kvar för granskning.
Se [den manuella modellgranskningen](eval/agent3-status-granskning.md).


Trendens antal jämförelseperioder och tröskelfaktor har lyfts till konstanter
som används av både den befintliga beräkningen och verktygssvaret. Inga gränser
ändrades. 500 deterministiskt konstruerade serier gav exakt samma varningar,
källunderlag och räknare före och efter utbrytningen. Prov visar även en
trendjämförelse utan varning, både för oförändrad och minskad förbrukning.


**Slutlig språkbedömning: inte godkänd för drift.** I slutkörningen användes
rätt läsverktyg för nio frågor; begreppsfrågan besvarades utan läsning. Modellen
kan fortfarande felaktigt tolka utebliven notis som noll varningar och lägga
för mycket innebörd i kontrolltid eller trendtäckning. Exakta kvarvarande fel
står i den manuella genomgången. Kodens verifiering och modellens sanningshalt
är två skilda mätningar; denna PR får inte beskrivas som tio felfria modellsvar.

Sex modellkörningar med totalt 44 konstruerade frågor använde 886 014 input-
och 23 152 output-token. Det är utvecklingsprov med sparade mellanresultat,
inte en validering av oberoende fall. Inga produktionsdata användes.
