# Betalningsfärskhet: misslyckad första import till verklig påminnelse

Status: **reproduktion, inte rättning. Får inte mergas med röda säkerhetsprov.**
Fryst produktbas: `3b71e905d866f461f6b07211bc89b3fa88505200`.
Testkod för två slutkörningar: `b86cd2ae4e42a316b6ddeb8400f679322f25d0ff`.
Datum: 2026-09-13 (Europe/Stockholm). Codespace: solid-halibut, egen gren
`codex/betalningsfarskhet-reproduktion`. Inga produktions-, schema-, migrations-
eller CI-ändringar. Ingen verklig bank, AI, e-post, merge eller driftändring.

## Resultat i båda slutkörningarna

| ID | Verkligt anrop med syntetiskt underlag | Datum efter import | Cron/DB-utfall | Prov |
|---|---|---|---|---|
| F01 | Ingen import eller consent | NULL | REMINDED, avgift 60 kr, ett avgiftsverifikat och köavsikt | Grönt nulägesprov; inget manuellt godkännande bevisat |
| F02 | PDF: parsern kastar efter registrering | NULL, FAILED finns | Samma effekt som F01 | Rött: säkerhetskravet kräver paus |
| F03 | PSD2: aktivt samtycke, listAccounts kastar | NULL, lastSyncedAt NULL | Samma effekt som F01 | Rött |
| F04 | CSV: bara ogiltiga datum | NULL, radfel, ingen importrad | Samma effekt som F01 | Rött |
| F05 | BgMax: ogiltigt belopp | NULL, importen kastar | Samma effekt som F01 | Rött |
| F06 | CSV: daterat uttag, ingen inbetalning | 2026-09-13 | Samma effekt som F01; nytt cronanrop dubblerar inte avgiften | Grön positiv kontroll |
| F07 | CSV: gammalt daterat uttag | 2026-09-01 | NONE, pausedStale=1, noll avgift/event/verifikat/köavsikt | Grön negativ kontroll |
| F08 | PDF-fel, därefter färskt CSV-uttag | 2026-09-13; FAILED finns kvar | Samma effekt som F01 | Grönt återhämtningsprov |
| F09 | PDF-signatur avvisas före parser | NULL, ingen importrad | Cron körs inte i detta källspårsprov | Grönt |
| F10 | PSD2: lyckad tom hämtning | NULL, lastSyncedAt sätts, CONFIRMED/api skapas | Cron körs inte i detta källspårsprov | Grönt |

10 prov per körning: **6 passerar, 4 faller**. Alla fyra faller i
`expectPaused`, efter verifierad importfelväg och verklig cron med `errors=0`.
De har inte vänt eller hoppat över säkerhetskravet för att få grönt.
Kontrollparet F06/F07 körs före felproven. Det visar att riggen kan observera
både beständig effekt och verklig paus. Detta är falsifiering mot oförändrad
produktkod, ingen artificiell produktionsmutation.

Ren `evaluate(org)` diagnostiseras separat som `evaluateStale`. Det är inte
beviset för hela grinden: det beviset är det faktiska cronanropets summering och
de efterföljande DB-läsningarna.

## Vad som faktiskt kördes

Riktiga `ReconciliationService.importBankStatement/importBgMaxFile`,
`BankStatementImportService.uploadAndParsePdf`, `Psd2SyncService.syncOrganization`,
`PaymentFreshnessService`, `RentReminderService.escalateOverdueRentNotices`,
`RentDebtService`, `RentInterestService`, `AccountingService`,
`VerifikationsnummerService` och `RentNoticeEventsService` med riktig Prisma.

Fixturen skapar organisation, fastighet, lägenhet, hyresgäst, avtal och förfallen
hyresavi. Hyra 9 000 kr, inga betalningar, överenskommet avgiftsvillkor från
2026-01-01 och tre konton. Egen referensränta säkras utan att återanvända en äldre
fixtur. Före varje cronanrop kontrolleras att det inte finns någon främmande
kandidat och att vår skuld är 9 000 kr. Inga banktransaktioner har importerats.
F06 kontrollerar även 1510 debet / 3593 kredit 60 kr och ett nytt cronanrop.

Lokala ersättningar: PDF-parser, bankprovider, kö, mejl och felsänka. PDF,
storage, notifieringar och andra oanvända sidoeffekter har spärrade testportar.
Kön returnerar en syntetisk jobbidentitet: det visar **avsikt att skicka**, inte
att ett mejl lämnade systemet. HTTP/Nest-start och verklig tidsstyrd schemaläggning
ingår inte. Provet vet inte om hyresgästen verkligen betalat i banken.

Källpunkter i specen
`apps/api/src/payment-freshness/import-reminder-reproduction.db.spec.ts`:
rad 59 (radkontroll), 75 (egen databas), 266 (städbevis), 278 (cron/persistens),
383–492 (F01–F08), 504/525 (F09/F10). Specen anger sin mätgräns i huvudet.

## Isolering, upprepning och proveniens

En ny separat PostgreSQL 16-container skapades med databasen
`eveno_farskhet_test`. **184 verkliga migrationer** tillämpades, ingen seed med
kunddata. Båda slutkörningarna startade och slutade med **106 tabeller / 186 rader**:
184 migrationsrader, en CustomerNumberSequence och en ReferenceInterestRate.
Radkontrollen omfattar alla tabeller i aktuellt schema, också ErrorLog och
TenantAnonymizationLog. Alla egna rader städas i FK-ordning även vid provfel.
Lika antal bevisar inte byteidentiskt innehåll i de tre typerna av basrader.

Workspace-paketen @eken/ui och @eken/shared byggdes från denna worktrees frysta
källa och laddades därifrån i slutkörningarna. Tredjepartsberoenden återanvändes
läsande för att begränsa diskåtgången. Prisma-klientens schema jämfördes bytevis
med vårt schema. Tidiga körningar använde en annan worktrees byggda paket; de
räknas inte som slutbevis. Fil-, logg-, paket- och resultathashar samt fullständiga
radantal finns i [den maskinläsbara sammanfattningen](betalningsfarskhet-reproduktion-resultat.json).

Oberoende granskning ledde till egna byggda paket, radkontroll över alla tabeller,
noll bankrader i varje cronfall och åtskillnad mellan evaluate-diagnostik och
verklig cron. Källspårsproven kompletterar de åtta beställda scenarierna.

## Reproduktion

Skapa en egen tom lokal databas med namnet `eveno_farskhet_test`, sätt
DATABASE_URL till den och tillämpa `apps/api/prisma`s migrationer.
Använd en separat installation eller verifierade beroenden och bygg ui/shared.
Kör inte mot produktionsdata. Specen tillåter endast lokal värd och namngiven
testdatabas, alternativt CI:s egen lokala eken_dev när CI=true.

```sh
pnpm --dir packages/ui build
pnpm --dir packages/shared build
pgrep -af "[j]est|[t]sc"
pnpm --dir apps/api exec jest --runInBand src/payment-freshness/import-reminder-reproduction.db.spec.ts --json --outputFile=/tmp/farskhet-1.json
# Förväntad exit 1: F02–F05 måste vara röda; upprepa med farskhet-2.json.
```

## Slutsats och nästa separata beställning

NULL bevisar inte verifierad banktäckning. Efter CSV/BgMax-fel saknas dessutom
beständigt försöksspår som skulle skilja dem från F01 för den nuvarande grinden.
PDF-försök före validering och PSD2-nätfel har andra spårluckor. En lyckad
PSD2-synk skriver historik men uppdaterar inte automatiskt täckningsdatumet i
det mätta tomfallet. `lastSyncedAt` är därför inte en ersättning för täckning.

Rättning behöver skilja förväntad täckning, verifierad täckning och ett eventuellt
uttryckligt manuellt arbetssätt. Underlaget väljer inte ny bankpolicy, tillåten
ålder eller bokföringsauktoritet. Det bevisar en kodväg, inte faktisk kundskada.
CI-status rapporteras separat mot PR:ens exakta HEAD; röd reproduktions-CI är
aldrig ett mergegodkännande.
