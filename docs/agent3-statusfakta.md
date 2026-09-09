# Agent 3: statusfakta som visas och sparas i chatten

Fortsättning efter #865. Ett separat faktablock sammanställs i kod från det
faktiskt körda verktyget `get_consumption_follow_up`. Blocket når både vanlig
chat och SSE via befintlig textkanal, utan ett nytt klientprotokoll.

Fyra ursprungliga statusfält och verktygets lästid valideras. Status, lokaltider
och nästa planerade schematid räknas ur samma shared-funktioner som #865.
Verktygets `message`, färdigformaterade text, rolluppgifter och andra härledda
fält får inte skriva blocket. Ingen modelltext kan få grinden att skapa ett
faktablock om det saknas ett faktiskt utfört statusanrop i den aktuella turen.

Ett fel eller ett felaktigt resultat ger okänd status och kopierar ingen rå
feltext. Ett senare fel ersätter en tidigare lyckad läsning. Samtidiga läsningar
som ger olika status ger ett besked om olika resultat; identiska kolumner
använder senaste lästid för färskheten. Andra verktyg och blandade frågor
behåller sin tidigare väg. Väntande skrivbekräftelser ger inget nytt avslutat
assistentsvar. Turtakets varning står kvar efter faktablocket.

Blocket anger uttryckligen att utebliven notis inte bevisar noll varningar,
att statusen inte bevisar leverans eller historiskt varningsantal, att ett
registrerat fel inte anger orsaken och att en schematid inte är ett löfte.
Det är en läsögonblicksbild, inte en status som uppdateras automatiskt i gamla
chattmeddelanden.

## Sparande och återspelning

Samma faktablock sparas i `AiMessage.content` och som vanligt textblock i
`AiMessage.blocks`. Omladdad chatt och modellens nästa historikläsning får
alltså också underlaget. Inga nya blocktyper eller DB-kolumner införs.
`tool_use` och tankeblock saneras fortfarande bort före sparandet. När turen
når sitt tak sparas även avbrottsmarkeringen i textblocken. Annars hade ett
nytt faktablock gjort att historiken slutade falla tillbaka på den synliga
texten och tappade beskedet om avbrott. Detta regressionstest har setts falla
i båda chattvägarna före rättningen.

## Vad bygget inte löser

**Modellens fria text är fortfarande inte godkänd för drift.** Den strömmas
redan innan faktablocket sammanställs och kan fortfarande innehålla sakfel.
Det nya blocket är kontrollerad motinformation; det är inte ett filter eller
ett bevis för att texten ovanför är sann. Ett prov skickar uttryckligen igenom
ett felaktigt modellsvar och kontrollerar att dess fel inte ändrar faktablocket.
Detta får inte redovisas som att problemet med falska notisslutsatser är löst.

Utan utfört statusverktyg finns inget faktablock. Vid ett avbrutet modellanrop
som går till chattens övergripande felväg sparas inget nytt avslutat svar.
Frågor om trendtäckning och annan förbrukningsanalys omfattas inte av blocket.

## Verifiering

Riktade prov kör formatering, verkligt verktygsresultat, vanlig chatt, SSE,
blandade verktyg, nya turer, återspelad historik, fel efter lyckad läsning,
iterationstak och skrivbekräftelse. Övriga chattprov bevakar juridiska källor,
minnesextraktion, modellval och historikens par-invariant.

Lokalt passerar 116 API-prov i åtta sviter, shared-bygge, API-typkontroll och
lint för ändrad kod. 15 relevanta vakter är gröna före/efter utan nya undantag.
Full CI krävs på publicerad HEAD före granskning. Ingen ny DB-skrivväg eller
migration tillkommer; existerande Postgres-sviter körs i CI.

Ingen ny modellkörning behövs för denna mätning: den nya delen genereras av kod.
Inga nya modellkostnader eller produktionsdata används. Den fria modelltextens
kända begränsningar från #865 kvarstår. Inga nya domänskrivningar, analyser,
roller, verktyg, migrationer, notifieringar eller organisationsflaggor tillkommer.

Aktuellt återstående arbete finns i [bygglistan](agentplan-aterstaende.md).
