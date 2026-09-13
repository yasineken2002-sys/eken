## Rättning av autentiseringskontraktet — 2026-09-13

Kandidaten kräver nu `API_RELEASE_RAILWAY_TOKEN_KIND=project|oauth`, utan
standardvärde eller fallback. Saknad/okänd typ nekas före nätanrop, artefaktläsning
och migratorstart. `project` använder enbart `Project-Access-Token`; `oauth`
använder enbart `Authorization: Bearer`. GitHub behåller sin separata token.
Det tidigare generiska tokenkontraktet skickade alltid Bearer: rätt för OAuth,
fel för projekttoken. Det var inte bevis för att varje Bearer-anrop var fel.

Det här uttrycker autentiseringsprotokollet. Det kan inte verifiera en tokens
faktiska ursprung, scopes eller behörighet till rätt resurs. Att märka en token
`oauth` gör den inte läsande. Inga credentials har tillförts eller provats mot
Railway, och `migrate-and-start.sh` är oförändrad.

Officiella källor kontrollerade 2026-09-13:
[Railway Public API](https://docs.railway.com/integrations/api) anger headern per
tokentyp och projektets miljöavgränsning.
[OAuth-scopes](https://docs.railway.com/integrations/oauth/scopes-and-user-consent)
anger läsåtkomst med `project:viewer` för valda projekt.
Projekt-tokenstöd är inget godkännande att lägga skrivbehörighet i appcontainern;
servicebegränsad läsrätt är inte visad. Account/workspace erbjuds inte som
konfigurationsalternativ. OAuth-förnyelse och driftens scope-verifiering återstår
som egna införandefrågor.

Prov 21/22 går genom en riktig lokal HTTP-server med skilda syntetiska tokens
och en ofarlig processport; servern avvisar fel header/credential. Prov 23 kräver
noll nät- och processanrop vid ogiltig typ. Prov 24 nekar HTTP 401/403 och GraphQL-
fel även när svaret samtidigt innehåller ett deploymentobjekt. Samtliga 24 ID:n
är obligatoriska i CI:s hårdkodade kravlista. Verklig Railway-behörighet eller
migrering bevisas inte av dessa lokala adapterprov.
