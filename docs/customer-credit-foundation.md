# Kundtillgodo – förberedande produktkärna

Arbetet utgår från `main` på `9c17daec`, i grenen
`codex/agent2-kundtillgodo`. Kärnan är **avstängd**: tjänsten är inte registrerad
i en produktionsmodul och har ingen route, bankimporthook eller automatisk
anropare. Migrationerna ändrar ingen historisk bankallokering. Policyn för en
organisation är avstängd som standard.

Den här etappen innehåller datamodell, transaktionell mottagning och användning
av tillgodo, bokföringsmetoder samt presentation på avin. Den innehåller inga
nya matchningsprocent och ingen ny körning av 2 000 betalningar. Experimentet i
[#869](https://github.com/yasineken2002-sys/eken/pull/869) är separat evidens från
syntetiska data och en tidigare prototyp; det bevisar inte denna integration.

## Vad kärnan gör

- **Sparar en skuld till hyresgästen.** En entydig överbetalning binds till
  organisation, hyresgäst, avtal, källavi, banktransaktion, betalningsallokering
  och verifikat. Tillgängligt tillgodo härleds från ursprungsbeloppet minus
  bokförda användningar. Unika nycklar, databaslås och saldokontroll hindrar
  dubbel användning.
- **Bevarar källunderlaget.** `sourceProofHash` binder de kontrollerade
  bankuppgifterna och källallokeringen. Mottagningsreplay och användning måste
  stämma med underlaget. Belopp och levande källverifikat kontrolleras; att
  enbart ett verifikat finns är inte tillräckligt.
- **Skiljer mottagning från användning.** Mottaget överskott bokförs som bank
  mot en uttryckligen vald skuld. Användning minskar skulden och hyresfordran
  utan en andra bankinbetalning och utan ändrad hyresintäkt eller moms.
  Verifikat och tillgodohändelse skrivs i samma transaktion. Kontovalet är
  ännu inte ett godkänt produktionsbeslut.
- **Visar rätt betalningsbelopp.** Hyra 9 775 kr och använt tillgodo 25 kr ger
  9 750 kr i PDF, OCR-rad och mejl samt raden ”Tillgodo använt”. Endast
  allokeringar med källan `CUSTOMER_CREDIT` avräknas här. Originalavins
  befintliga hantering av historiska bankbetalningar och manuella betalningar
  ändras inte. `rentNoticePayableTotal` ändras inte globalt.

En defensiv återläsning stoppar utskicket om tillgodosumman ändrats under
PDF-renderingen; befintlig retry renderar då om. Den är **inte en atomisk
utskicksreservation**. Intervallet mellan återläsning och mejlkö måste stängas
innan automatisk integration.

## Kvar före produktionskoppling

1. Ett uttryckligt uppdrag som tillåter ändringar i `reconciliation` krävs.
   Den tidigare skyddade katalogen är orörd i denna etapp.
2. Bankimporthooken måste anropa kärnan i samma transaktion som ordinarie
   betalningsallokering och bokföring. Gemensamma förhandslås måste tas före
   bank- och avilåsen så att mottagning och användning följer samma låsordning.
3. En atomisk utskicksreservation måste samordna tillgodo, rendering, mejlkö
   och avins status. Helt täckta avier behöver ett uttryckligt dokument- och
   leveransflöde; att sätta `PAID` är inte ett bevis på att hyresgästen fått
   information.
4. Annulleringsrace och avmatchning behöver en sammanhängande rättelse av
   bankallokering, tillgodoreskontra och verifikat. Främmande nycklar och
   rättelsespärrar hindrar vissa osammanhängande ingrepp, men ersätter inte
   denna kundväg.
5. Återbetalning saknar en riktig bankbevisport och en komplett domänlivscykel
   med reservation, bekräftelse och avvisad utbetalning. En bokföringsmetod
   eller ett manuellt besked är inte bevis på att pengar har betalats ut.
6. Revisor behöver uttryckligen välja skuldkontot och bekräfta kopplingen
   mellan bankkontot och bokföringens `1930`. Testkonton är inga godkända
   standardval och depositionskontot används inte som automatisk ersättning.
7. Fortnox-stödet för de nya `customer-credit-*`-källorna och deras
   kontomappning återstår. Ett lokalt balanserat verifikat bevisar inte att
   exporten stöder källan.
8. Organisationsradering och bevarandepolicy måste hantera de nya tabellerna
   uttryckligen; befintligt raderingsskript känner ännu inte till dem.
9. Hela CI och Claudes granskning krävs före merge. Detta är ett utkast och
   aktiverar inte automatisk tillgodo eller ett komplett kundflöde.

## Avgränsad verifiering

Mätt lokalt 2026-10-15, Node 24.19.0 / Prisma 5.22.0 / PostgreSQL 16.15:

- 8 riktade bokförings-/aviseringssviter: **116/116 prov**, grönt.
- Verklig PostgreSQL, 1 svit: **33/33 prov**, grönt. Inkluderar två
  samtidiga transaktioner, omkörning, felaktigt källunderlag, direkt försök att
  kringgå tjänstens saldokontroll, periodlås och kronologiska gränsfall.
- Totalt **149 godkända prov**, inte 149 oberoende kundbetalningar och inte
  ett mått på automatisk matchningsträffsäkerhet.
- 202 migrationer applicerade på separat syntetisk lokal databas. Schema
  validerat och egen Prisma-klient genererad; inga andra arbetskopior berörda.
- Kontrakts-, DTO-placerings-, koercions-, append-only-, aktörs- och kritiska
  indexvakter: gröna. Dagens koercionsvakt heter `check-strict-koercion.mjs`;
  det äldre filnamnet `check-strict-boolean.mjs` finns inte längre på main.
- Full API-typecheck slog i den satta heapgränsen 1536 MB. Ingen godkänd full
  typecheck påstås lokalt; CI måste verifiera hela projektet. De riktade
  Jest-körningarna använde ordinarie ts-jest med typkontroll.

[Råa provloggar](eval/customer-credit-foundation/) sparas med utkastet.
Inga modell-, bank- eller produktionsanrop har gjorts.

Kör från repositoryts rot. Maskinen delas med andra arbeten och har två
kärnor. Före varje Jest- eller typecheck-körning:

```sh
pgrep -af "[j]est|[t]sc"
```

Vänta om ett annat sådant arbete pågår. Kör testerna med en arbetare. Om en
ny worktree saknar byggda workspacepaket eller genererad Prisma-klient behöver
`@eken/shared`, `@eken/ui` och Prisma-klienten förberedas först.

De två testerna utan databas:

```sh
pnpm --filter @eken/api exec jest --runInBand --runTestsByPath \
  src/accounting/accounting.customer-credit.spec.ts \
  src/avisering/avisering.customer-credit-display.spec.ts
```

Databastestet använder riktig lokal Postgres och ordinarie bokföring, men
skapar enbart syntetiska organisationer, avier och betalningar. Bankimportens
förutsättning byggs uttryckligen i testet; själva importhooken testas inte.
Testet behåller sina bokföringsbevis och stänger inte av append-only-skydd.

Sätt `DATABASE_URL` till en **separat syntetisk testdatabas** på
`127.0.0.1:56432`, med ett namn som börjar `eveno_bank2000_credit_` och enbart
små bokstäver, siffror eller understreck efter prefixet. Använd testdatabasens
egna inloggningsuppgifter; inga nycklar eller lösenord ska läggas i dokumentet.
`ALLOW_SYNTHETIC_BANK_WRITES=1` är en uttrycklig lokal testmarkering.

Följande kontroll körs före både migration och test och avbryter vid annan
databasmiljö:

```sh
(
  set -e
  : "${DATABASE_URL:?Sätt DATABASE_URL till den isolerade lokala testdatabasen}"
  export ALLOW_SYNTHETIC_BANK_WRITES=1
  node -e '
    const u = new URL(process.env.DATABASE_URL);
    if (u.protocol !== "postgresql:" || u.hostname !== "127.0.0.1" ||
        u.port !== "56432" || !/^\/eveno_bank2000_credit_[a-z0-9_]+$/.test(u.pathname) ||
        process.env.ALLOW_SYNTHETIC_BANK_WRITES !== "1") {
      throw new Error("Endast den uttryckligt isolerade lokala testdatabasen tillåts");
    }
  '
  pnpm --filter @eken/api exec prisma migrate deploy --schema prisma/schema.prisma
  pnpm --filter @eken/api exec jest --runInBand --runTestsByPath \
    src/customer-credit/customer-credit.db.spec.ts
)
```

Specen har dessutom en egen miljögrind. I CI tillåter den den befintliga
engångscontainern på `localhost:5432/eken_dev` endast när `GITHUB_ACTIONS=true`.
Utan godkänd testmiljö faller ett uttryckligt förutsättningsprov; överhoppade
databasfall får inte rapporteras som godkända.
