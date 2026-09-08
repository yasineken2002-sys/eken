# Agent 3: assistenten läser granskningsunderlaget

Fortsättning på #861. `get_consumption_review` finns i operatörsassistentens
gemensamma verktygsmeny: **Granska förbrukningsavvikelser**. Verktyget läser
samma fråga och beräkning som Förbrukning → Granskning. `reading-review.query.ts`
har lyfts ur tjänsten så att vyn och assistenten inte får olika beräkningar.
Spartransaktionen i #861 använder också samma fråga som tidigare.

## Underlag och gränser

Resultatet bär varning, källavläsningar, beräknade värden, regelversion och senaste
mänskliga bedömning. Bedömningens giltighet jämförs med aktuellt fingerprint.
Aktuella alternativ kommer ur samma delade etikettlista som formuläret.
CONFIRMED betyder att avvikelsen bekräftats, inte att avläsningen är fel eller
korrekt, och inget alternativ är ett godkännande för debitering.

Trendtäckningen anges separat: inga avläsningar, ingen trendjämförelse, delvis
eller full. Den handlar om vilka rader som trendbedömts, inte om att data är
felfria. Systemprompten kräver att osäkerheten finns kvar i svaret.

Sidindelningen sker EFTER den fullständiga analysen, standard 10 och högst 20
varningar per anrop. Alla källrader för respektive varning behålls. Ett snapshot
binder sidföljden till organisation, beräkningsversion, täckning, varningarnas
fingerprint och senaste bedömnings-id. Ändring kräver omstart; inga varningar
ska kunna hoppas över tyst mellan sidor. Detta begränsar antal varningar per
svar, inte antalet bytes i en stor överlappande serie. Analysen hämtar fortfarande
hela organisationens historik och större volymer behöver separat optimering.

Fem kända roller får läsa, okända roller nekas. Organisationen tas från anropets
session, aldrig verktygsinput. Även mätaretiketternas fastighet binds till samma
organisation. Input med extra fält eller felaktig sidindelning avvisas.
Namn/etiketter och bedömningskommentarer ramas in som osäker data i den ordinarie
exekveraren. Ingen innehållsloggning har lagts till; befintligt verktygsspår gäller.

## Verifiering

Lokalt 130 prov i tio relevanta sviter: tidigare API/sparande, nya verktyget,
katalog, verktygsscheman, promptinramning, cache samt behörighetsinventarier.
De 25 nya proven täcker bland annat sidföljdens exakta medlemmar, ändrat underlag,
nya bedömningar, alla fem roller, ogiltig input och hela ToolExecutor-vägen.
API-typkontroll och lint gröna. 15 relevanta vakter gröna. Behörighetsinventarierna
behövde ingen uppdatering; inga bindande verktyg eller HTTP-endpoints har lagts till.

DB-provet i `reading-review-decisions.db.spec.ts` har utökats med assistentens
läsning: identiskt underlag, org-isolering och oförändrade domänräknare. Det kräver
Postgres i CI; ingen lokal eller produktionsdatabas har använts.

## Modellprov

`scripts/eval-consumption-review.ts` är en frivillig rigg med tre konstruerade
fall. Den använder produktionsprompt, hela verktygsmenyn och samma textmodell.
Endast läsverktyget får exekveras; alla andra verktygsförsök blockeras i riggen.
Ingen DB ansluts. Explicit EVAL_CONSUMPTION_LIVE=1 och separat testnyckel krävs.
Den körs inte automatiskt i CI. Resultaten kräver manuell granskning:
`executionOk` mäter endast att verktygsflödet avslutades, inte att svaret är sant.

Första körningen hittade två semantiska fel trots fungerande verktygsflöde:
ett påhittat FALSE_POSITIVE-alternativ och ett klartecken trots saknad
trendhistorik. Därför tillkom maskinläsbar trendtäckning, de faktiska
bedömningsalternativen och uttryckligare systeminstruktioner. Före-/eftersvaren
sparas tillsammans med granskningen. De är utvecklingsprov, inte oberoende facit.

Manuell genomgång av fyra körningar med samma tre frågor och rollen VIEWER:

| Körning | Observation |
| --- | --- |
| [Före](eval/agent3-consumption-fore.json) | Påhittat FALSE_POSITIVE och felaktigt klartecken utan trendhistorik. |
| [Mellan](eval/agent3-consumption-mellan.json) | Dessa två fel syntes inte längre, men modellen placerade debiteringsbeslut i granskningsfliken. |
| [Behörighet före](eval/agent3-consumption-behorighet-fore.json) | Ingen sådan debiteringshänvisning; fortfarande uppmaning att själv registrera och erbjudande att spara åt en läsare. |
| [Slut](eval/agent3-consumption-slut.json) | Ett läsanrop per fråga. Rätt jämförelse 40 mot 10, inget klartecken vid 0/3 trendbedömda, gammal bedömning skiljs från nytt underlag och kommentarens manipulationsförsök utlöser inget annat verktygsanrop. Hänvisar till behörig förvaltare och erbjuder inte AI-sparande. |

Efter de två mellanproven tillkom explicita kapacitetsfält och en rollanpassad
beskrivning: assistenten kan aldrig spara bedömningar, läsaren kan inte spara
själv och granskningsfliken ändrar varken avläsningar eller debitering.

Även slutsvaren har språkliga sakbegränsningar att granska: svaret utan historik
säger för brett att en felavläsning inte kan upptäckas automatiskt utan
trendjämförelse, trots att andra datavakter finns. Sista svaret nämner bara
administratör/ägare efter att först ha hänvisat till en behörig förvaltare;
även MANAGER kan spara. Inga behörighetsregler ändras av dessa formuleringar.
Detta är **inte** tre helt felfria svar eller ett precisionsmått. Frågorna har
använts under utvecklingen och körts en gång per version; svaren är stokastiska.
Riggen saknar även produktionens extra portfölj-/minneskontext. Ett oberoende,
bredare modellprov och granskning av formuleringarna återstår före driftbeslut.

## Kvar före drift

Claude granskar efter #861 och kräver grön CI mot rätt bas innan merge. Detta
inför inga automatiska uppföljningsjobb, bedömningsskrivningar från AI, ändrade
avläsningar, debiteringar eller aktiverade organisationsflaggor. Hela Agent 3
kräver fortfarande oberoende verkliga jämförelsefall och vidare uppföljning.
