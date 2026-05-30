# Bokföring – designbeslut

Levande dokument för redovisningsmodulens icke-uppenbara designval. Granskas av
auktoriserad redovisningskonsult (bokforings-expert) vid varje ändring.

---

## FIX 9 · PR 4 — Gap-free, race-säker verifikationsnummer (LAGBROTT 6)

**Lagrum:** BFL 1999:1078 5 kap 6 § (verifikationsnummer i obruten följd),
5 kap 7 § (verifikationens innehåll), 4 kap 2 § (god redovisningssed),
ML 11 kap 8 § (fakturanummer i fortlöpande serie).

### Beslut

1. **Verifikationsnummer på JournalEntry.** `JournalEntry` saknade tidigare
   nummer helt (endast UUID), vilket bröt BFL 5 kap 6 §. Nya fält:
   `fiscalYear` (räkenskapsår), `series` (default `"A"`), `verNumber`
   (löpnummer 1..N). Unikt per `(organizationId, series, fiscalYear, verNumber)`.

2. **En enda serie "A" för alla poster i denna PR.** Automatverifikat har serie
   `A` enligt SIE4-konventionen (SIE Gruppen 4B). Alla poster — fakturering,
   betalning, hyresavi, manuella AI-poster, påminnelseavgift — använder serie
   `A`. Detta ger EN obruten nummerserie per (org, räkenskapsår), vilket är den
   enklaste och mest revisor-vänliga modellen. `"M"` är reserverad för framtida
   manuella justeringsserier (kräver då separat sekvensrad).

3. **Gap-free via allokering inuti transaktionen.** `JournalEntrySequence`
   (PK `(org, fiscalYear, series)`) räknas upp atomiskt med en UPSERT-increment
   inuti SAMMA `$transaction` som posten skapas. Postgres row-lock serialiserar
   samtidiga allokeringar; en rollback återställer även increment:en → serien
   blir obruten. Empiriskt verifierat: 50 samtidiga allokeringar gav exakt 1..50,
   noll dubbletter, noll hål.

4. **Räkenskapsår = kalenderår som default, men brutet räkenskapsår stöds.**
   `Organization.fiscalYearStartMonth Int @default(1)` (1 = januari = kalenderår,
   tvingande för enskild firma/HB enligt BFL 3 kap 1 §). AB med brutet
   räkenskapsår (t.ex. maj–april, startmånad 5) hanteras av
   `VerifikationsnummerService.fiscalYearFor()`: en post före startmånaden hör
   till föregående kalenderårs räkenskapsår. Räkenskapsåret härleds ur postens
   `date` (affärshändelsens datum, BFL 5 kap 7 §), inte ur skapelsedatum.
   **Begränsning:** det finns ännu inget UI för att sätta `fiscalYearStartMonth`
   — fältet defaultar till 1. Brutet räkenskapsår kräver i nuläget en manuell
   DB-ändring tills inställnings-UI byggs.

5. **Idempotens hårdgjord på DB-nivå.** Unikt index på
   `(organizationId, source, sourceId)`. Postgres behandlar NULL som distinkt, så
   manuella poster (`sourceId = NULL`) tillåts i flera exemplar medan automatiska
   poster (faktura, betalning, avi, reversal, påminnelseavgift) bara kan bokföras
   en gång. Idempotenskontrollen körs dessutom inuti transaktionen
   (TOCTOU-säkert).

6. **Stängd-period-spärr.** `VerifikationsnummerService.allocate()` vägrar
   tilldela nummer om postens datum ligger i en `ClosedAccountingPeriod`
   (ConflictException) — ett stängt räkenskapsår får inte öppnas implicit av en
   efterhandsbokförd post.

7. **Fakturanummer via `InvoiceNumberSequence` (global per org).** Ersätter
   `count()+1` (race- och gap-känsligt) med atomär UPSERT-increment inuti
   faktura-transaktionen. Numret nollställs INTE per år — `F-{år}-{nr}` har
   kosmetiskt år men global obruten sekvens. Detta är medvetet: OCR-numret
   härleds ur sekvensen och måste vara unikt över alla år. Backfill satte
   `lastNumber = COUNT(*)` per org så att nästa nummer fortsätter sömlöst.

8. **SIE4-export använder verkligt verifikationsnummer.** `#VER "A" {verNumber}`
   i stället för tidigare `#VER "AI" {arrayindex+1}` (flyktigt, icke-deterministiskt).
   Exporten hämtar nu ALLA verifikationer i perioden kronologiskt — den gamla
   `getJournalEntries(take:100)` fick aldrig användas för SIE (ofullständig
   räkenskapsinformation).

9. **Konteringsrader oraderbara.** `JournalEntryLine.onDelete` ändrad
   `Cascade → Restrict` — konteringsrader är räkenskapsinformation (BFL 1 kap 2 §
   p.9) och får inte raderas. Append-only: rättelse sker via motverifikat.

### Backfill

Befintliga poster fick retroaktiva verifikationsnummer via
`ROW_NUMBER() OVER (PARTITION BY org, fiscalYear, series ORDER BY date, createdAt, id)`.
Godkänd som retroaktiv tilldelning enligt BFL 5 kap 7 § — systemet saknade
verifikationsnummer före denna migration, så det finns inga lagstadgade nummer
att korrigera mot. Verifierat gap-free per (org, räkenskapsår).

### Öppna följdpunkter (ej i PR 4)

- **UI för `fiscalYearStartMonth`** så att AB-kunder kan välja brutet
  räkenskapsår utan DB-åtgärd.
- **`#RAR`-raden i SIE** bör spegla faktiskt räkenskapsår (start/slut) när
  brutet räkenskapsår stöds fullt ut.
- **Separat serie för manuella justeringsposter** (`"M"`) om revisor vill skilja
  dem från automatverifikat.
- **Backfill av prod-orgens saknade verifikationer** (2 fakturor + 52 hyresavier
  som skapades innan kontoplan fanns) — separat åtgärd.
- **Integrationstest för samtidig allokering.** Gap-free-egenskapen är verifierad
  empiriskt (50 samtidiga allokeringar → 1..50, noll dubbletter/hål) men har inget
  committat test. Enhetstesterna mockar `$transaction` och kan inte fånga
  Postgres-serialisering. CI kör i nuläget inte jest (endast Lint + Typecheck +
  Vercel), så ett DB-beroende test ger ingen CI-signal och skulle bryta lokala
  jest-körningar utan test-DB. Lägg till ett gated integrationstest när en
  test-DB finns i CI.
