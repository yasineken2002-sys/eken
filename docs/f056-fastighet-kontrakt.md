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
  toppnivån.
- Land: **beteendet är ändrat, inte bara gjort valfritt.** `POST` utan land får
  fortsatt `SE` — defaulten flyttades bara från den gemensamma adressklassen till
  skapandets egen, så den ligger kvar där den hör hemma. En `PATCH` som skickar
  en adress men INTE nämner landet BEVARAR nu det lagrade landet; tidigare
  nollställdes det till `SE`, så en fastighet med `NO` tappade sitt land av en
  redigering som bara ändrade staden. Ett explicit land följer det befintliga
  delade schemat: tomt land är fortsatt tillåtet och sparas som tom sträng,
  `null` avvisas. Tomsträngen likställs alltså inte med frånvaro, och något nytt
  landskrav införs inte.
- Area: API:ts befintliga minimum **1 m²** gäller även i formulär och delat schema.
  Detta öppnar ingen ny area under 1; sådana POST/PATCH avvisades redan av API:t.
- Byggår: valfritt heltal 1800–innevarande år. Tomt formulärfält utelämnas.
  Utelämnat fält i PATCH bevarar värdet; explicit `null` avvisas. Någon funktion
  för att tömma ett sparat byggår tillkommer inte.

Ingen migration eller automatisk ändring av äldre värden ingår. Ett historiskt
ogiltigt värde syns oförändrat i formuläret och ger ett fältfel vid full submit;
användaren måste rätta det för att spara formuläret. En partiell HTTP-PATCH av
andra fält fungerar och lämnar det historiska värdet orört — det gäller också ett
historiskt landvärde. Explicit inskickade ogiltiga värden avvisas också på äldre
rader.

## AI-verktygets skapa-väg

`create_property` i `tool-executor.service.ts` anropar `PropertiesService.create`
direkt och passerar varken DTO:n eller ValidationPipe. Fälten castades tidigare
(`toolInput.name as string`), och ett cast gör ingen kontroll — verktyget kunde
alltså skapa NYA rader med ett 201 tecken långt namn eller postnumret `abc`,
alltså exakt den rad resten av F056 finns för att förhindra. Kroppen går nu genom
samma delade `CreatePropertySchema` före skrivningen, på samma sätt som
`create_inspection` redan gjorde i samma fil. Avslaget är ett svenskt
`{ success: false }` som namnger fält och regel och sker FÖRE varje DB-effekt;
ett giltigt anrop skapar fastigheten som förut, på anropets egen organisation.
`country` och `totalArea` sätts fortsatt av verktyget — de står inte i
verktygsdefinitionen, och att låta modellen fylla dem vore en vidgning av vad
AI:n får göra, inte en validering.

`import/import.service.ts` skriver fortfarande via Prisma direkt och ligger
utanför både HTTP-kontraktet och den här rättningen. Den vägen är inventerad men
oförändrad; ingen historisk backfill ingår.

## Reproducerbar regression

Kör med repots vanliga beroenden, byggda `@eken/ui` och `@eken/shared` samt en
isolerad lokal PostgreSQL med repots migrationer och syntetiska data. På det
gemensamma Codespacet ska samtliga tunga körningar och DB-livscykeln hållas under
`arbete/byggledning-3fix-20260917/tungt.lock`.

```sh
# apps/api, DATABASE_URL måste peka på egen testdatabas
pnpm exec jest --runInBand src/properties/properties-http.db.spec.ts src/properties/property-designation-unique.db.spec.ts
pnpm exec jest --runInBand src/ai/tools/create-property-kontrakt.db.spec.ts
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

Varje bärande skydd har en egen avgränsad negativkontroll. Alla körs först efter
commit av samtliga ändringar, muterar EN namngiven fil åt gången och återställer
enbart den filen från en kopia vars SHA-256 verifierats före och efter — och vars
innehåll dessutom jämförts mot den committade versionen. Ett kompileringsfel
räknas inte som motprov; mutationen ska kompilera och falla på BETEENDET.

| Kontroll | Mutation | Namngivet prov som ska falla |
|---|---|---|
| Ursprunglig | tar bort `@PropertyField(CreatePropertySchema.shape.name)` i `create-property.dto.ts` | `F056 rejects a 201-character create before it can trap a later form edit` — **201 i stället för 400** |
| NK-A | kopplar bort `CreatePropertySchema.safeParse` i `create_property` i `tool-executor.service.ts` | `F056 avvisar ett 201-teckensnamn från verktyget före DB-effekt` — raden skapas i stället för att avvisas |
| NK-B | återinför `= 'SE'` som initierare på den gemensamma `AddressDto.country` | `F056 address PATCH without country preserves a stored non-SE country` — `NO` skrivs om till `SE` |
