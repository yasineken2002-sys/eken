# Första SQL-körningen: fel i separat testgenerator

Omräkningen stoppade: `11-proven-same-api-file`, newPayments observerat 2, krav 1.
Generatorn sparade samma muterbara stegobjekt i både same- och distinct-fallen.
När distinct-fallet satte E2 ändrades även same-fallet. Motsvarande fel finns i
omvänd ordning. Detta är ett fel i de NYA komponentindata, inte en motivering att
ändra ett produktkrav. Indata och fångst bevaras; V2 får en separat indatafil.
Samma-händelse-fallen ska faktiskt bära E1/E1. Facit (en betalning) ändras inte.
Inga av #874:s frysta filer eller originalets 2 000 berörs.
