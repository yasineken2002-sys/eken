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

## Leverans och avgränsning

Fryst PR-bas: `316507fd8b5acaece65608b9cacd7c045d6d4e34` (#886).
Granskad kod-/testcommit: `a894c2830cd2ac8071f7284645900d41b5767428`.

Två fulla lokala körningar: 24/24 prov, 195 positiva assertions vardera.
Fel projektheader fällde api-release-21 med REMOTE_HTTP_ERROR; endast detta prov
valdes i mutationskörningen. Exakt fil återställdes från kodcommiten och tom
fildiff krävdes före den andra fulla gröna körningen. ESLint och diffkontroll
passerade. Inga databasprov behövs för headerändringen; ingen migrering kördes.
De befintliga 20 proven är bevarade, med uttrycklig tokentyp i adapterprovet.

Oberoende läsgranskare kontrollerade kod, båda gröna körningar och röd kanarie.
Ett fel i testets förväntade GitHub-anropsantal och en TypeScript-typ rättades
före slutbeviset. Inga kvarstående blockerande fynd inom det granskade omfånget.
Det är inte ett produktions- eller scopebevis.

Pinnad radräknare från #882 mäter 13 ändrade produktionsrader och 136 testrader,
inga binärer. Fyra egna filer mot #886:s gren; main-formen visar 14 filer,
varav tio enbart ärvda från #886. Inga andra grenars ändringar är införda.
CI för slutlig dokumentations-HEAD redovisas i PR-texten.

Reproduktion i denna worktree:
`pnpm --dir apps/api exec jest --runInBand src/release/api-release-gate.spec.ts --json --outputFile=/tmp/api-token.json`,
därefter `node apps/api/scripts/check-release-tests.cjs /tmp/api-token.json`.
Kontrollera först att ingen annan Jest/tsc kör på den delade maskinen.

SHA-256 för lokala provrapporter (de fulla körningarna ligger utanför repot):

- api-token-gron-1.json: `c7e0a9bd67d078e36e4d575529a61751fae8a963d3473cc607a13b0f9c1bc205`
- api-token-rod.json: `c0090b5a510440bc3324da49fd0fd8d03ac0f91215b089d8fbe1c1fddabdb36d`
- api-token-slutlig.json: `f09679210f24cbfcfcf44b98be45fa9ae34f3f4c653ae7f314c0c2fa7b7fce4e`
