# Runbook: bevisrigg mot riktig Postgres

Mall för att bevisa ett **penningfel** (bokföring, betalningsallokering, statusflipp)
mot en riktig databas med de skarpa service-klasserna — inte mot attrapper.

Riggen har byggts från noll fyra gånger (#288, #290, #293, #297). Den här filen finns
för att det inte ska ske en femte. Kopiera skelettet, byt ut scenarierna.

> **Riggen committas inte.** Den lever i `apps/api/.proof-<issue>/` under arbetet och
> raderas före PR — enhetstesterna är det som blir kvar i repot. Det som ska överleva
> är uppställningen, och den står här.

---

## Varför riktig Postgres

Attrapper utplånar gärna just den distinktion testet bygger på. Tre gånger i rad har
samma klass av fel sluppit förbi en grön svit:

| Fall | Attrappen som gjorde testet blint                                                         |
| ---- | ----------------------------------------------------------------------------------------- |
| #288 | `$transaction: (cb) => cb(prisma)` — `tx` och `prisma` blev samma mock                    |
| #290 | `invoicePayment.create → {}` — allokerings-id `undefined` → nyckeln `...:undefined`       |
| #293 | depositionsbelopp == restskuld i all testdata → `deposit.amount` vs `outstanding` osynlig |
| #297 | (fångades av riggen) makuleringens reversering är en **no-op** — syns bara i huvudboken   |

En riktig databas har FK:er, unika index, radlås och en huvudbok man kan summera.
Den avslöjar det attrappen inte vet om.

---

## Uppställning

### 1. Databas

```bash
docker compose up -d postgres            # eken-postgres-1, port 5432
psql "postgresql://eken:eken@localhost:5432/postgres" \
  -c "DROP DATABASE IF EXISTS eken_<issue>" \
  -c "CREATE DATABASE eken_<issue> OWNER eken"

cd apps/api
DATABASE_URL="postgresql://eken:eken@localhost:5432/eken_<issue>" npx prisma migrate deploy
```

> Startar containern inte (`failed to start shim: ... file exists`): `docker rm -f eken-postgres-1`
> och kör `docker compose up -d postgres` igen. Volymen är kvar.

### 2. Jest-konfig — `apps/api/.proof-<issue>/jest.config.js`

Egen konfig **krävs**: huvudkonfigens `rootDir` är `src`, så riggen plockas aldrig
upp av den vanliga sviten (och ska inte göra det — den kräver en DB som CI inte har).

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  testRegex: '.*\\.e2e\\.ts$',
  moduleFileExtensions: ['ts', 'tsx', 'js'],
  testTimeout: 180000,
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          target: 'ES2022',
          module: 'CommonJS',
          jsx: 'react-jsx',
        },
      },
    ],
  },
}
```

Kör: `cd apps/api && npx jest --config .proof-<issue>/jest.config.js --runInBand`

### 3. Skelett — `apps/api/.proof-<issue>/proof.e2e.ts`

```ts
// I/O-kanterna MÅSTE mockas: @aws-sdk och puppeteer kraschar annars under ts-jest.
// Ingen av dem rör bokföring, belopp eller status.
jest.mock('../src/invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../src/storage/storage.service', () => ({ StorageService: class {} }))

import { PrismaClient, Prisma } from '@prisma/client'
import { DepositsService } from '../src/deposits/deposits.service'
import { AccountingService } from '../src/accounting/accounting.service'
import { VerifikationsnummerService } from '../src/accounting/verifikationsnummer.service'
import { InvoicesService } from '../src/invoices/invoices.service'
import { InvoiceEventsService } from '../src/invoices/invoice-events.service'

const prisma = new PrismaClient({
  datasources: { db: { url: 'postgresql://eken:eken@localhost:5432/eken_<issue>' } },
})

// Skarpa klasser. PrismaClient går rakt in där PrismaService förväntas (`as never`)
// — services använder bara Prisma-metoderna.
const accounting = new AccountingService(
  prisma as never,
  new VerifikationsnummerService(prisma as never),
)
const notificationsStub = { createForAllOrgUsers: jest.fn(), create: jest.fn() }
const deposits = new DepositsService(
  prisma as never,
  accounting as never,
  notificationsStub as never,
)
const invoices = new InvoicesService(
  prisma as never,
  new InvoiceEventsService(prisma as never),
  {} as never, // pdf
  { sendCustomEmail: jest.fn() } as never, // mail
  accounting as never,
  notificationsStub as never,
  {} as never, // ocr
  { enqueue: jest.fn() } as never, // pdfQueue
)
```

**Använd de skarpa vägarna även för förberedelserna.** Makulera med
`invoices.transitionStatus(...)`, inte med en `prisma.invoice.update` som härmar den —
annars bevisas bara din egen tolkning av vad makulering gör. (Det var precis så #297
upptäckte att reverseringen är en no-op.)

### 4. Seed

```ts
const BAS: Array<[number, string, string]> = [
  [1510, 'Kundfordringar', 'ASSET'],
  [1930, 'Företagskonto', 'ASSET'],
  [2890, 'Övriga kortfristiga skulder', 'LIABILITY'],
  [2611, 'Utgående moms 25%', 'LIABILITY'],
  [3011, 'Hyresintäkter bostäder', 'REVENUE'],
  [3040, 'Skadeersättningar', 'REVENUE'],
]
// Organization → Account[] → User → Property → Unit → Tenant → Lease.
// EN EGEN ORG PER SCENARIO — då kan huvudboken summeras per org utan korsprat.
```

Fallgropar som kostat tid:

- `TenantType` är `INDIVIDUAL`/`COMPANY` (inte `PRIVATE`).
- `JournalEntryLine`-relationen heter `journalEntry`, inte `entry`.
- `Lease` kräver **både** `startDate` och `tenancyStartDate`.
- 3-månadersspärren i `deposits.create()`: 20 000 kr deposition kräver `monthlyRent >= 6 667`.

### 5. Mät huvudboken, inte bara statusen

```ts
/** Debet/kredit per kontonummer för en org. */
async function ledger(organizationId: string) {
  const lines = await prisma.journalEntryLine.findMany({
    where: { journalEntry: { organizationId } },
    include: { account: { select: { number: true } } },
  })
  const per = new Map<number, { debit: number; credit: number }>()
  for (const l of lines) {
    const cur = per.get(l.account.number) ?? { debit: 0, credit: 0 }
    cur.debit += Number(l.debit)
    cur.credit += Number(l.credit)
    per.set(l.account.number, cur)
  }
  return per
}
```

Snapshotta `ledger()` + `journalEntry.findMany()` före den handling som ska vara
verkningslös och jämför efteråt med `toEqual` — det fångar **allt** som skrevs, även
det du inte tänkte på att hävda.

Ren tavla i `beforeAll`:

```ts
await prisma.$executeRawUnsafe(
  `TRUNCATE TABLE "JournalEntryLine","JournalEntry","JournalEntrySequence","InvoicePayment",
   "InvoiceEvent","InvoiceLine","Invoice","InvoiceNumberSequence","Deposit","Lease","Tenant",
   "Unit","Property","User","Account","Organization" RESTART IDENTITY CASCADE`,
)
```

---

## Diskriminerande testdata

**Håll storheterna åtskilda.** Om depositionsbeloppet, fakturans total och det redan
inbetalda är samma siffra kan ingen kontroll se skillnad på dem — och en trasig
implementation råkar bokföra "rätt" belopp. #293 föll på exakt det.

I #297:s S4 blev det två delallokeringar på 12 500 + 7 500 mot en deposition på 20 000:
summan stämmer, men ingen enskild siffra sammanfaller med depositionsbeloppet.

---

## Negativkontroll (obligatorisk)

Ett grönt test bevisar ingenting förrän du sett det falla.

```bash
cp apps/api/src/<fil>.ts /tmp/orig.ts
#  … ta bort fixen (skriptat, exakta ankare — inte för hand) …
npx jest --config .proof-<issue>/jest.config.js --runInBand   # ska FALLA
npx jest src/<modul> --runInBand                              # ska FALLA
cp /tmp/orig.ts apps/api/src/<fil>.ts                         # återställ
```

Kontrollera två saker: att **rätt** tester faller, och att de tester som beskriver
_oförändrat_ beteende förblir **gröna**. Faller allt är riggen trubbig.

Mät sedan skadan direkt i databasen medan fixen är borttagen — det blir PR-beskrivningens
starkaste stycke:

```bash
psql "postgresql://eken:eken@localhost:5432/eken_<issue>" -c "
SELECT o.name AS org, d.status AS deposition, i.status AS faktura,
       (SELECT count(*) FROM \"InvoicePayment\" p WHERE p.\"invoiceId\"=i.id) AS allokeringar,
       (SELECT count(*) FROM \"JournalEntry\" j
         WHERE j.\"organizationId\"=o.id AND j.source='PAYMENT') AS betalningsverifikat
FROM \"Deposit\" d
  JOIN \"Organization\" o ON o.id=d.\"organizationId\"
  LEFT JOIN \"Invoice\" i ON i.id=d.\"invoiceId\" ORDER BY o.name;"
```

---

## Databasen svarar på designfrågor

Ett scenario som **inte går att sätta upp** är också ett resultat.

#297 skulle testa "fakturan saknas" genom att radera raden — `Deposit_invoiceId_fkey`
sa nej (`23503`). En hängande referens är alltså omöjlig, och "saknad faktura" kan i
praktiken bara betyda _faktura i en annan organisation_. Grinden visade sig därmed
vara en tenant-isolationsspärr, och testet blev ett annat — och bättre — test.

Lyssna på felkoden i stället för att tvinga fram uppställningen med `$executeRawUnsafe`.

---

## Städa

```bash
rm -rf apps/api/.proof-<issue>
psql "postgresql://eken:eken@localhost:5432/postgres" -c "DROP DATABASE IF EXISTS eken_<issue>"
```

Sammanfatta scenarierna och negativkontrollen i PR-beskrivningen — det är den delen
som ska gå att granska när riggen är borta.
