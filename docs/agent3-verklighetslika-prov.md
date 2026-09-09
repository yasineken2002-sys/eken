# Agent 3: verklighetslika, konstruerade avläsningar

2026-09-09. Användaren saknar verkligt underlag och bad om påhittade fall som
kan likna verkligheten. Därför finns nu 18 fiktiva scenarier med riktiga
kalendermånader, vattenvolymer och ett facit bestämt före modellprovet.
De är inte ett statistiskt urval av kunders avläsningar.

## Fall och facit

| Fall                                 | Förväntat resultat från granskningsregeln                 |
| ------------------------------------ | --------------------------------------------------------- |
| Olika månadslängd, samma dagstakt    | 1 trendbedömd, ingen varning                              |
| Fyrdubblad vattenförbrukning         | 1 HIGH_RATE; orsaken är okänd för agenten                 |
| Borttappat decimaltecken             | 1 HIGH_RATE; originalet krävs för en rättning             |
| Exakt tre gånger medianen            | 1 HIGH_RATE                                               |
| Strax under gränsen                  | Ingen varning; visningsavrundning ändrar inte beslutet    |
| Tom lägenhet med låg förbrukning     | Ingen lågförbrukningsvarning; vakans kan inte fastställas |
| Tre nollmånader                      | Ingen trendbedömning; positiv median saknas               |
| Nyinstallation, två månader          | Ingen trendbedömning                                      |
| Två saknade månader                  | Ingen jämförelse över luckan                              |
| Överlappande import                  | 1 OVERLAP                                                 |
| Negativ historisk periodvolym        | 1 DATA                                                    |
| Omvända datum                        | 1 DATA                                                    |
| Kumulativ ökning                     | 1 HIGH_RATE från differensen, inte hela ställningen       |
| Mätarbyte under samma ID             | 1 DECREASE; faktiskt byte är inte bevisat                 |
| Mätarbyte med nytt ID                | Ingen sammanblandning av historiken                       |
| Gradvis säsongsökning                | 3 trendbedömda, ingen varning; ingen årsjämförelse        |
| Två värden med samma periodslut      | 2 OVERLAP; inget godtyckligt val av rätt värde            |
| Två lägenheter med olika förbrukning | 1 HIGH_RATE för rätt mätare, 2 trendbedömda               |

Den påhittade verkliga orsaken, till exempel en rinnande toalett, ligger i
testens `scenario`. Den skickas inte till modellen. Modellen får bara frågan
och resultatet från produktionsverktygets läsning av de syntetiska raderna.
Rätt svar kan vara en varning med okänd orsak, även när testförfattaren känner
orsaken. Att gissa den rätta dolda orsaken räknas inte som ett styrkt besked.

## Ett verkligt beräkningsfel hittades

9,3 m³ i januari, 8,4 i februari och 9,3 i mars motsvarar matematiskt
0,3 m³/dag. 27 m³ i april ger exakt 0,9 m³/dag och ska ge HIGH_RATE.
Binär division av historiken kunde göra den beräknade tröskeln lite högre än
0,9. Då uteblev varningen. Uttryckt i liter gav samma förlopp en varning.

Före rättningen: **69/72 prov passerade**; exakt-gräns-fallet föll i tre av
fyra varianter. Efter rättningen: **79/79 nya prov passerar**. Det är 18
grundfall i fyra varianter (ursprung, omvänd indataordning, annan volymenhet,
förskjutna datum) plus sju särskilda gränsprov. Det är inte 79 oberoende fall.

Medianordning och gränsjämförelse görs nu genom exakta decimalbråk och
korsmultiplikation. Kumulativa differenser bildas före konvertering tillbaka
till visningstal. Ingen epsilon, avrundningsmarginal eller ändrad faktor
läggs till. Gränsproven omfattar både värden under/på/över gränsen, stora
DB-giltiga mätarställningar och en representerbar skillnad mindre än 0,001.
Visade dagstal och trösklar bildas från förkortade bråk så att exempelvis
0,9 vid gränsen också redovisas som 0,9. Övriga valideringar och manuella
debiteringsfunktioner ändras inte.

Regelversionen ändras till `consumption-review-v2`. **Fingeravtryck från v1
blir inaktuella även där en tidigare varning fortfarande finns.** Bedömningar
och avläsningar skrivs inte om, men befintliga bedömningar behöver omprövas
mot nytt underlag. Nya varningar kan visas i den befintliga granskningskön
och ingå i en redan aktiverad uppföljning. Ingen uppföljning aktiveras här.

## Utförd verifiering och återstående modellprov

- 210/210 API-prov i sju berörda sviter, inklusive de 79 nya proven.
- 40/40 befintliga webbprov i tre granskningssviter.
- Shared-bygge, API-typkontroll, lint och diffkontroll är gröna.
- 15 befintliga vakter passerar utan nya undantag. Webbkontrakt: 6 kända
  poster i 5 filer; DTO-placering: 0; strikt koercion: 0.
- Ett extra försök med det gamla namnet `check-strict-boolean.mjs` gav
  MODULE_NOT_FOUND. CI visar att den ersatts av `check-strict-koercion.mjs`,
  som passerade. Den saknade filen har inte redovisats som en grön kontroll.

Modellriggen har två avgränsade lägen: `assertions` med 18 par av korrekta
och felaktiga påståenden, samt `conversations` med åtta fria frågor. Ordningen
på rätt och fel varierar i parproven. Fria svar måste sakgranskas separat;
lyckat verktygsflöde eller domarens eget ja räknas inte som ett sanningsfacit.
Rapporter sparar råa svar, råa domar, faktiska modellprofiler, prompthashar,
fixturehash, användning, fel och återstående okörda fall.

**Ingen ny modellkörning har genomförts.** Automatisk godkännandegranskning
stoppade användningen av utvecklingsnyckeln från en annan worktrees `.env`
för anrop till Anthropic. Godkännande för den konkreta användningen behövs.
Riggen har typkontrollerats, men dess liveutfall är ännu inte uppmätt.

Det tidigare återspelsprovet på 9/10 och dess överfiltrering kvarstår.
De nya beräkningsproven bevisar varken bättre fritext eller precision i drift.
Verkligt granskat underlag, Claudes granskning och kontrollerad pilot återstår.

Filer: `apps/api/src/ai/testing/consumption-realistic.fixtures.ts`,
`apps/api/src/ai/consumption-realistic.spec.ts` och
`apps/api/scripts/eval-consumption-realistic.ts`. Efter godkännande körs riggen
med `EVAL_CONSUMPTION_LIVE=1`, en utvecklingsnyckel i miljön och
`EVAL_REALISTIC_MODE=assertions` respektive `conversations`. Ingen DB-klient
eller skrivande verktygsimplementation skapas av riggen.

Ett lokalt tidsprov på 6 000 konstruerade avläsningar gav median 39,18 ms
före och 84,61 ms efter rättningen, tre omgångar per implementation.
Exakt jämförelse kostar alltså mer CPU i detta prov. Samma 500 varningar
och 5 850 trendbedömda avläsningar erhölls; materialet innehåller inga
gränsnära avläsningar. Detta är ingen mätning av svarstid i drift.
Se `docs/eval/agent3-verklighetslika-tid.json`.
