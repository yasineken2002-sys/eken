# Manuell granskning av Agent 3:s statussvar

2026-09-09. Konstruerade avläsningar och statusrader, separat utvecklingsnyckel,
produktionsprompt och hela verktygsmenyn. Ingen databas eller skrivande åtgärd
är ansluten till riggarna. Svaren nedan är utvecklingsprov, inte ett oberoende
facit, en garanti eller ett mått på driftprecision.

## Utfallet är inte ett godkännande av modellens fritext

Kodens läsning, behörigheter, datum och tillstånd är separat verifierade.
Fritexten har förbättrats men har fortfarande sakfel. **Driftsättningsgranskaren
ska inte behandla grön CI som ett godkännande av de semantiska svaren.**
Fortsatt arbete behöver särskilt hindra falska slutsatser om uteblivna notiser;
ytterligare fria promptformuleringar har inte gett ett tillräckligt skydd.

## Körningar

| Fil | Frågor | Verktygsflöde enligt riggen | Observation |
| --- | --- | --- | --- |
| [Språk före](agent3-status-sprak-fore.json) | 3 | 3/3 | Samma tidigare frågor på #864. En bekräftad avvikelse beskrevs som korrekt uppmätt. |
| [Språk efter](agent3-status-sprak-efter.json) | 3 | 3/3 | Alla tre sparroller angavs. Andra kontroller utan trendhistoria förklarades, men trendtäckning blandades med varningar. |
| [Första statusprovet](agent3-status-modellprov-mellan.json) | 8 | 8/8 | Fel tidszon, påslagsdatum kallat avstängning, passerad schematid kallad nästa körning. Detta gav formattering och tidsberäkning i kod. |
| [Andra statusprovet](agent3-status-modellprov-andra.json) | 10 | 9/10 | Tiderna förbättrades. Ett begreppssvar sade automatiskt godkänd; andra svar hittade på fysisk maxgräns och redigerbart schema. |
| [Tredje statusprovet](agent3-status-modellprov-tredje.json) | 10 | 9/10 | Ingen automatisk godkännandeförklaring i begreppssvaret, men påhittade månads-/årsjämförelser och manuell omkörning. |
| [Slutprov](agent3-status-modellprov-slut.json) | 10 | 9/10 | Rätt status, lokaltider och planerad tid. Metod, roller och omkörningsgräns förbättrades. Sakfel återstår enligt tabellen nedan. |

`executionOk` mäter verktygsflödet, inte sanningshalt. Den enda frågan utan
verktygsanrop i de tre tiokörningarna är `normal_trend_no_finding`. Modellen
besvarade den som en begreppsfråga och erbjöd därefter att läsa aktuell data.
Riggen kräver ett läsanrop och returnerar därför exitkod 1. Kravet har inte
ändrats för att få ett grönt tal; inget aktuellt organisationsunderlag har
verifierats av det svaret.

## Slutprov, fråga för fråga

| Fall | Vad som är belagt | Kvar att granska/rätta |
| --- | --- | --- |
| Avstängt med historik | Av, rätt senaste påslag och lyckad kontroll, ingen nästa planerad tid. | Uttalandet om att avstängning skedde efter den lyckade kontrollen är en slutsats; avstängningstid finns inte lagrad. |
| Väntande, ägare | På, väntande, rätt nästa tid; ingen manuell omkörning för någon roll. | Schemat formuleras ibland som ett löfte om framtida körning. Det är en planerad tid. |
| Lyckad men ingen notis | Rätt lyckad kontroll och nästa tid; inget friskbesked om avläsningar. | **Fel:** säger att utebliven notis betyder att kontrollerna inte gav utslag. Varken leverans eller historiskt varningsantal är känt. |
| Misslyckad | Skiljer senaste lyckade kontroll från registrerat fel och anger rätt roller. | Kallar felstämpeln ett schematillfälle trots att schemat är 07.15. Ger också möjliga orsaker utan underlag. |
| Försenad | Rätt datum och 26-timmarsgräns, inget påstående om aktuell varningsmängd. | Ett planerat försök är inte en garanti om utförande. |
| Status kan inte läsas | Okänt läge; inget påhittat av/på och inget erbjudande om AI-skrivning. | Inloggad ADMIN hänvisas ibland hypotetiskt till om användaren har Ägare-rollen. |
| Ingen trendhistoria | Noll trendjämförelser skiljs från andra kontroller; tre jämförelseperioder anges. | Avslutningen om fullständig kontroll med mer historik är för vid. Mer framtida data friskförklarar inte äldre avläsningar. |
| Bedömning och reglage | Alla tre sparroller, bara OWNER för reglaget, inga AI-skrivningar. | Inget sakfel identifierat i denna körning; en körning är ingen garanti. |
| Trendbedömd utan varning | Rätt begrepp och uttryckligen inget godkännande. | Inget läsanrop. Uttrycket grönt ljus ger ändå fel ton; DATA används också som samlingsnamn för flera separata kontroller. |
| Låg förbrukning | Enbart ökningskontroll, tre perioder och median, rätt räknare och inget retroaktivt friskbesked. | Lägger till en osourcad riskförklaring om varför låg förbrukning inte kontrolleras. |

## Vad som faktiskt skyddas av kod

- Samma fyra DB-fält och tillstånd som människans granskningsvy.
- Svensk tidszon, framtida schematid och ingen nästa tid när reglaget är av.
- Strikt tom input, sessionsorganisation och fem tillåtna läsroller.
- Ingen exekveringsväg för av/på, omkörning, bedömning, avläsning eller debitering
  i det nya verktyget. Det kan inte leverera de skrivningar modellen kan hitta på.
- Rollinformation jämförs mot HTTP-grindarna. Schemat jämförs mot registrerad cron.
- Oförändrad avläsningsanalys: 500 konstruerade serier gav identiska resultat.

Modellprov saknar produktionens extra portfölj- och minneskontext, och frågorna
har använts under utvecklingen. Slutfilen bär en hash av den systemprompt som
faktiskt laddades. Oberoende verkliga fall och stabilare begränsning av fritext
återstår; dessa resultat får inte omvandlas till en uppgiven träffsäkerhet.
