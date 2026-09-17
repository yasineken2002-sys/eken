# F056 – fastighetens skapa-/redigeringskontrakt

Bas: `d642f3700e6a0c7de6ababe28fe7f396e38230a2`.

Det verkliga formuläret kunde skapa en fastighet med ett 201 tecken långt namn
eller postnumret `abc`. POST genom Fastify, produktionspipen, DTO, controller,
tjänst och PostgreSQL lyckades. GET och direkt radläsning bekräftade värdena.
Enbart ändrad stad genom samma formulär stoppades sedan av webbens PATCH-grind:
noll HTTP-anrop, oförändrad stad i databasen. Kontrollfallet med 200 tecken gav
ett PATCH-anrop och sparad stad. Partiell HTTP-PATCH fungerade även på de
avvikande raderna: felet blockerade full formulärredigering, inte all redigering.

Formuläret använder nu de delade fältreglerna, och POST har samma kontraktsgrind
som PATCH. DTO:erna använder samma fältscheman genom en lokal class-validator-
dekorator. Whitelist, metadata, autentisering, roller och organisationskontroll
ligger kvar på sina befintliga platser.

- Namn: 1–200 tecken, utan trunkering.
- Beteckning: den befintliga tjänstetrimmen beaktas före minsta längd, så enbart
  blanksteg inte kan bli en tom lagrad beteckning.
- Adress: obligatoriska gatu-/stadsfält och befintlig svensk postnummerregel.
  Adress är fortfarande en hel adress när den skickas; PATCH är partiell på
  toppnivån. Utelämnat land blir `SE`. Tomt land är fortsatt tillåtet enligt
  befintligt delat schema och sparas nu också vid PATCH.
- Area: API:ts befintliga minimum **1 m²** gäller även i formulär och delat schema.
  Detta öppnar ingen ny area under 1; sådana POST/PATCH avvisades redan av API:t.
- Byggår: valfritt heltal 1800–innevarande år. Tomt formulärfält utelämnas.
  Utelämnat fält i PATCH bevarar värdet; explicit `null` avvisas. Någon funktion
  för att tömma ett sparat byggår tillkommer inte.

Ingen migration eller automatisk ändring av äldre värden ingår. Ett historiskt
ogiltigt värde syns oförändrat i formuläret och ger ett fältfel vid full submit;
användaren måste rätta det för att spara formuläret. En partiell HTTP-PATCH av
andra fält fungerar och lämnar det historiska värdet orört. Explicit inskickade
ogiltiga värden avvisas också på äldre rader. Direkta interna tjänsteanrop och
importvägar går fortsatt utanför HTTP-kontraktet; de inventeras eller ändras
inte av F056.

## Reproducerbar regression

Kör med repots vanliga beroenden, byggda `@eken/ui` och `@eken/shared` samt en
isolerad lokal PostgreSQL med repots migrationer och syntetiska data. På det
gemensamma Codespacet ska samtliga tunga körningar och DB-livscykeln hållas under
`arbete/byggledning-3fix-20260917/tungt.lock`.

```sh
# apps/api, DATABASE_URL måste peka på egen testdatabas
pnpm exec jest --runInBand src/properties/properties-http.db.spec.ts src/properties/property-designation-unique.db.spec.ts
pnpm exec jest --runInBand src/accounting/dto-contract.spec.ts
# apps/web
pnpm exec vitest run src/features/properties/components/PropertyForm.test.tsx
```

HTTP-proven använder verkliga JWT-/rollgrindar, DTO-metadata, produktionspipens
inställningar, controller, tjänst och PrismaService. Fastifys HTTP-injektion
kör rutterna utan en lyssnande port. De startar inte hela appens externa
integrationer, cron eller köer. DB-proven kräver `DATABASE_URL`; vanliga CI:s
Tests-jobb tillhandahåller den och kontrollerar att inga prov hoppas över.
Webbproven renderar det riktiga formuläret och använder de riktiga
request-grindarna; transporten spioneras där. Basreproduktionen körde dessutom
formulär och verklig lokal HTTP/DB tillsammans.

Den avgränsade negativkontrollen tar bort endast
`@PropertyField(CreatePropertySchema.shape.name)` i `create-property.dto.ts`.
Provet `F056 rejects a 201-character create before it can trap a later form edit`
ska då falla på HTTP-status **201 i stället för 400**, inte på kompilering.
Kör först efter commit av alla ändringar och återställ enbart den filen från
en kopia vars SHA-256 verifierats före och efter.
