# Agent 3: underlag för en varning

Fortsättning på #858. Varje varning har en utfällbar detalj med de registrerade
avläsningar som beräkningen använde och konkreta kontrollsteg för människan.
Ingen hanteringsstatus, avläsning, faktura eller debitering skrivs.

## Vad detaljen visar

- Hög förbrukning: exakt de tre jämförelseperioderna, aktuell period, förbrukad
  mängd, tidslängd och förbrukning per dag samt median och varningsgräns.
- Kumulativa ställningar: även den tidigare ställningen för varje differens.
  Öppningsställningen för den första jämförelseperioden ingår i underlaget.
- Minskning/överlappning: båda berörda avläsningar. Dubbla periodslut: alla
  avläsningar med det periodslutet för samma mätare och organisation.
- Ogiltig data: den registrerade raden, även vid tomt värde eller ogiltigt datum.

Beräkningsresultaten bifogas i samma funktion som skapar varningen. Komponenten
väljer inte själv historik och beräknar inte en andra median. Originalvärden
behålls som strängar när API:t lämnade strängar; numeriska beräkningar visas med
högst sex decimaler. Den befintliga heuristiken och dess begränsningar är kvar.

Underlaget kommer från redan hämtade avläsningar. Uppdaterad data renderas direkt;
ingen separat detaljcache eller status sparas. Utfällningen använder HTML details
med tangentbordsstöd. Ingen ny endpoint, modellkoppling eller agentflagga införs.

## Mätning

38/38 Vitest-prov: 27 tidigare prov plus 7 för evidens och 4 för renderad detalj.
De nya proven täcker bland annat exakta medlemmar i jämförelsen, öppningsställning,
organisationsisolering, oförändrad indata, ogiltiga värden och utbytt data.
Webbtypkontroll, lint och diffkontroll gröna lokalt.

En separat lokal jämförelse mot `9295e01` gav identiska befintliga varningsfält
(kod, avläsning, mätare, förklaring) och räknare i 500 konstruerade serier med
30 avläsningar vardera, totalt 3227 varningar. Det är regressionskontroll mot
förra versionen, inte en mätning av träffsäkerhet mot verkligt facit.

Webbläsarprov med den riktiga granskningskomponenten och konstruerade avläsningar:
1150 och 390 pixlars bredd, öppna/stäng med tangentbord, korrekt kumulativ differens,
ingen horisontell mobilöverströmning, inga JavaScript-fel eller skrivande anrop.
Det provet omfattar inte verklig inloggning eller databas.

Agent 3 är fortfarande inte färdig. Verkligt godkänt jämförelsematerial och ett
beständigt uppföljningsflöde återstår. Inget underlag markeras som granskat bara
för att någon öppnar det.
