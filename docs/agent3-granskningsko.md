# Agent 3: gemensam granskningskö

Fortsätter på #862. Granskningen kan nu avgränsas till varningar som behöver
bedömas, saknar bedömning, behöver utredas, har ändrat underlag eller har en
aktuell bekräftad/förklarad bedömning. Alla varningar är fortfarande standard.
Ordningen prioriterar ändrat underlag, utredning, utan bedömning, bekräftad,
förklarad. Inom gruppen sorteras på avläsnings-id och varningskod.

## En gemensam beräkning

`reading-review-queue.ts` i shared äger senaste revision, giltighet, urval,
räknare och ordning. Webben och `get_consumption_review` använder samma funktion.
Senaste revisionen väljs även om listan anländer i annan ordning; en äldre
matchande bedömning får aldrig ersätta den senaste som gäller annat underlag.

`TO_ASSESS` omfattar UNASSESSED, NEEDS_INVESTIGATION och CHANGED_EVIDENCE.
Det betyder **bedömningsarbete**, inte alla olösta problem. CONFIRMED betyder
fortfarande att avvikelsen bekräftats; statusen säger inte att problemet är
åtgärdat, avläsningen är felaktig eller debitering godkänd. Även EXPLAINED finns kvar under
Alla varningar och sitt eget urval. Historiken påverkas inte av filtreringen.

Räknarna avser aktuella varningar, inte historikrader. De fem grundstatusarna
delar upp mängden exakt en gång; ALL och TO_ASSESS är överlappande summeringar.
Avläsnings-/trendräknarna gäller fortsatt hela underlaget.

## Sidindelning och öppna formulär

Läsverktygets `reviewFilter` valideras av ett delat Zod-schema. All analys och
statusbestämning sker före filtrering och sidindelning. `page.totalInFilter`
anger urvalets storlek; `summary.totalFindings` anger hela mängden. Snapshot
binder även urvalet, så byte av filter kräver offset 0 utan gammalt snapshot.
Källraderna i varningarna kapas aldrig för att ett urval valts.

Webben räknar om när rapporten läses in igen. En ny källa som ändrar fingerprint
återför en tidigare bedömd varning till kön. Om en uppdatering flyttar en rad
utanför det valda urvalet medan formuläret är öppet, visas raden fortsatt med
en tydlig förklaring. Motiveringen behålls; det gamla underlaget kan inte sparas.
Även ett manuellt filterbyte behåller det öppna formuläret tills det stängs.
Detta är inget beständigt utkastskydd vid sidstängning eller försvunnen varning.

## Verifiering och gränser

- 64 webbprov i sju sviter, varav 12 nya för den delade urvalslogiken och fyra
  nya komponentprov för räknare, historik, ändrat underlag och formulärtext.
- 100 API-prov i åtta relevanta sviter, inklusive filtrering före sidgränsen,
  rätt källor, fullständiga räknare, filterbundet snapshot och ogiltig input.
- UI-/shared-bygge, API-/webbtypkontroll, lint och 15 relevanta vakter gröna.
- Det befintliga Postgres-provet utökas med tom bedömningskö och kvarvarande
  förklarad varning för sparade revisioner. Det körs mot riktig databas i CI.
- Chrome på dator och 390 px mobil med konstruerade API-svar: prioritering,
  filter, tangentbordsfokus, osparad text efter annan persons bedömning,
  spärrat formulär och tomt urval. Inga skrivningar, JS-fel eller horisontell
  överströmning. Skärmbilderna har även granskats visuellt.

Första API-körningen kunde inte starta utan byggt UI-paket i den nya worktreen.
Efter bygget fångade två äldre prov sin förutsättning om fast listposition;
de verifierar nu samma varnings identitet efter prioritering. Slutproven ovan
är gröna. Webbläsarriggens första räknare omfattade även källrader; den
avgränsades till varningskorten och hela flödet kördes om.

Inga nya modellprov eller precisionsmått i detta bygge. Modellbegränsningarna
från #862 kvarstår; detta verifierar urval och underlag, inte alla modellsvar.
Ingen ny migration, skrivande AI-förmåga, notifiering, cron eller agentflagga.
Automatiska uppföljningsjobb och oberoende verkligt facit återstår. Analysen
hämtar fortfarande full historik; urvalet är ingen optimering av DB-volymen.

Claude granskar efter #862. Rikta om till main efter basens merge och kräv ny
grön CI. Codex mergar inte och aktiverar inga produktionsväxlar.
