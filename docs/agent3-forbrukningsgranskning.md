# Agent 3: första granskningsvyn

Första delen är en läsande, regelbaserad granskning i Förbrukning → Granskning.
Den fungerar utan agentflaggor och utan modellnyckel. Den är inte hela agent 3.
Befintliga registrerings- och debiteringsflöden används som tidigare.

Granskningen hämtar alla tillgängliga avläsningar via befintlig organisationsscopad
GET /consumption/readings, oberoende av avläsningsflikens filter. Den sparar inget.
Ingen API-, databas-, bokförings- eller reconciliation-kod ändras.

Kontrollerna visar ogiltig data, överlappande perioder, dubbla periodslut,
minskande kumulativ mätarställning och förbrukning per dag som är minst tre gånger
medianen för de tre föregående jämförbara perioderna. Periodvolym räknar inklusive
start- och slutdag; kumulativ förbrukning använder skillnaden mellan ställningarna
och tiden mellan periodsluten. Jämförelser hålls isär per organisation och mätare.
Luckor, byte av avläsningstyp och tvetydig data bryter trendhistoriken. En minskande
ställning kan fortfarande visas efter en lucka. Nollmedian ger ingen trendbedömning.
Första kumulativa avläsningen saknar differens och trendbedöms därför inte.

Gränsen är en begriplig första heuristik, inte ett statistiskt bevis på fel.
Säsong, mätarbyte och ändrad användning behöver mänsklig bedömning. Ingen
träffsäkerhet i verklig drift har mätts. Avsaknad av varningar är inget klartecken.
API:t har i denna bas ingen sidindelning; införs sådan måste fullständig historik
säkerställas innan granskningen fortsätter kallas fullständig.

## Verifiering

- 21 regelprov: tröskel, normalisering, kumulativa differenser, luckor, nollhistorik,
  isolering, avläsningstyp, ogiltig data, överlappning, tidszonssortering och oförändrad indata.
- 6 renderade komponentprov: laddning, tomhet, omläsning efter fel, 403,
  otillräckligt underlag och förklaring med mätare/period. Hooken mockas i dessa prov;
  verklig databas och inloggning ingår inte i denna lokala mätning.
- Förhandsvisning av den riktiga granskningskomponenten med konstruerade data i
  webbläsare, 1150 respektive 390 pixlars bredd.

Nästa del efter granskning av denna PR: validera signalerna mot verkliga godkända
exempel och bestäm hur avvikelser ska följas upp. Automatiska korrigeringar,
modellförslag, inkorgskoppling och debitering ingår inte här.
