# Luckregel för avläsningsgranskning

> **Historisk första iteration vid 8c6f8501.** Kalenderregeln nedan är ersatt efter en bredare mätning. Aktuellt designval, fullständig före/efter-tabell och begränsningar finns i [datumrymdsrapporten](agent3-luckregel-858/date-space.md).

Bas: #858, codex/agent3-forbrukningsgranskning, 9295e013303c4de21f8eb947e3812e05d6f693e3.
Egen gren: codex/agent3-luckregel-858. Endast denna gren ändras.

Kontrakt före kod:

- Typbyte bryter alltid trendkedjan.
- CUMULATIVE: en positiv differens täcker tiden mellan periodsluten. Datumlucka bryter inte; dagsnämnaren är fortsatt tiden mellan ställningarna.
- PERIOD_VOLUME: behåll befintlig dygnsadjacens. Tillåt dessutom jämförelse mellan observerade månadsfönster: båda börjar den första vid UTC-midnatt, slutar på ett UTC-datum inom sin egen månad och tillhör direkt efterföljande kalendermånader.
- Tröskeln är alltså kalenderföljd, inte ett godtyckligt antal tolererade luckdagar. Formuläret skapar första→idag och det kräver ett kalenderbegrepp. En helt utebliven månad bryter periodvolymserien.
- Ingen interpolation: omätta mellandagar räknas inte in i volym eller dagsnämnare. trendAssessed betyder jämförda observationer, inte komplett mätning.
- Datumformen kan inte skilja 1:a→1:a som månadsfönster från en enskild dagsobservation. Kalenderformen styr även detta fall; vi lovar inte att alla glesa dagliga avsikter går att identifiera.
- OVERLAP, DECREASE, ogiltiga data, organisation/mätare, tre tidigare jämförelser och faktor tre är oförändrade.
- Upprepade månadsfönster inom samma månad överlappar fortsatt. Det är inte en luckregel och ändras inte här.

Fixturer hämtar periodStart/periodEnd genom verklig ReadingForm, fryst UTC-klocka, verkligt submit/schema och oförändrade datumfält. Dagliga/andra manuella perioder matas genom samma formulär. Värden är syntetiska dagsmedel med oberoende facit: 10 enheter/dag och ett sista hopp till 270. Inga verkliga avläsningar eller externa anrop.

Separat läsande designgranskning stödjer kontraktet och krävde att första-dagen-tvetydigheten och omätta mellandagar redovisas uttryckligen. Grenmätningen har reproducerat felet i 19 grenar (152 formulärfall) och bevarade kontroller i 76 fall. Tidigaste introduktion är #858:s egen commit. Detaljer och slutprov redovisas nedan.

## Mätning av grenarna före rättningen

Frysta Git-objekt mättes 2026-09-12T20:05:03.402Z. Samma åtta formulärfall (två typer × slutdag 2/10/15/28) missar hoppet på alla 19 bärande grenar. Fyra kontrollfall per gren (dagliga och hela månader × båda typerna) ger HIGH_RATE på rätt sista rad och trendAssessed=1. Totalt 152 reproducerade fel och 76 fungerande kontroller.

| Gren efter origin/codex/            | Exakt HEAD                               | Analysfil                                               |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| agent3-api-underlag                 | a16b2e33d17bfd8688cc1f41e3a16bac99ff0fc4 | packages/shared/src/utils/reading-review.ts             |
| agent3-assistent-status             | d2ca0c1a5485879535d30f62d269dfab8b062b5c | packages/shared/src/utils/reading-review.ts             |
| agent3-assistent-underlag           | 57538a0e72600a849f5d2d465b8a665600ec8d90 | packages/shared/src/utils/reading-review.ts             |
| agent3-automatisk-uppfoljning       | 82e4c4a0bfd022dd6855d553d6ea8b301e351c41 | packages/shared/src/utils/reading-review.ts             |
| agent3-bedomningar                  | 46c77508c52b38439b26cb47b8815991301fec88 | packages/shared/src/utils/reading-review.ts             |
| agent3-bekraftelsetext-867          | 03612cf160ff91f3887814b0d4ce77de7361c6b6 | packages/shared/src/utils/reading-review.ts             |
| agent3-debiteringsgrind             | 9f879291dd039e404ba80b7266fbd53842a0b42b | packages/shared/src/utils/reading-review.ts             |
| agent3-forbrukningsgranskning       | 9295e013303c4de21f8eb947e3812e05d6f693e3 | apps/web/src/features/consumption/lib/reading-review.ts |
| agent3-granskningsko                | d22d1fbd910f6b491d6010689f379e951912f049 | packages/shared/src/utils/reading-review.ts             |
| agent3-granskningsunderlag          | 55de3341c494a1edb1be86266009feac5e99a4bc | apps/web/src/features/consumption/lib/reading-review.ts |
| agent3-rendering-2-1                | 73d221c9b7e002b70262a3186b76fea876d6ad01 | packages/shared/src/utils/reading-review.ts             |
| agent3-rendering-2-1-compact        | e90a70a028c5d46b41f3dea26644de67fddb6529 | packages/shared/src/utils/reading-review.ts             |
| agent3-rendering-2-2                | 0d048101f291cf352a730100ec96d6b042ed98a4 | packages/shared/src/utils/reading-review.ts             |
| agent3-rendering-2-2-real           | 561b382b6cbddfccba719613a5ea3aa2f0f7e695 | packages/shared/src/utils/reading-review.ts             |
| agent3-statusfakta                  | dbabac2c44e82a13a2678a987bb48e04665f3c77 | packages/shared/src/utils/reading-review.ts             |
| agent3-svarsgrind                   | 3fa4b55128143d5bd70f696178679f2a99f22f29 | packages/shared/src/utils/reading-review.ts             |
| agent3-utskicksgrind                | 0973272d5eb8f6f8285ec8c98f039a47f6ec568b | packages/shared/src/utils/reading-review.ts             |
| agent3-utskicksgrind-2b             | 5ae9906b152307eae0d79eec719d4303a042742c | packages/shared/src/utils/reading-review.ts             |
| agent3-utskicksgrind-2c-inventering | e8ed5e7256393c9f0b8821c1f2c8c2f21030e72f | packages/shared/src/utils/reading-review.ts             |

main (3b71e905) och agent3-api-release-grind (316507fd) saknar analysmodulen på de två kända sökvägarna. Detta betecknas ABSENT, inte gröna beteendeprov. Tidigaste introduktionscommit är 9295e013, samma commit som #858:s HEAD. Ingen rättning läggs på toppen av kedjan.

branches.json innehåller alla exakta SHA och källhashar. Riggen läser endast dessa Git-objekt och kontrollerar källhasharna. Den exekverar de AST-extraherade today/firstOfMonth-deklarationerna ur respektive faktisk ReadingForm med styrd klocka. Den sekundära grenmätningen renderar inte React; den nya formulärspecen ovan gör det.

Reproducera inventeringen från en checkout med installerade beroenden och manifestets Git-objekt:

```sh
node docs/granskning/agent3-luckregel-858/branch-audit.test-helpers.cjs "$PWD" docs/granskning/agent3-luckregel-858/branches.json
```

Riggen hämtar inget och ändrar inga refs, arbetskopior eller databaser. Saknade Git-objekt ger fel. Manifestet och riggen bevarar det ursprungliga felet på frysta grenar; efterprovet kör den rättade arbetskopian separat. Inga upprepade råfixturer eller binärer läggs till.

## Prov och granskning

Facit och kontrakt committades före produktionsändringen i 28783794. Före: 47 prov, 35 gröna och 12 avsedda beteendefel, med alla 21 äldre prov gröna. Efter första rättningen: 47/47. Separat kodgranskning fann två provluckor, inte kodfel: kalenderundantaget behövde nås över årsskifte och ett tidigare icke-månadsfönster behövde avvisas. Efter tilläggen: 21 äldre + 29 nya = 50/50 gröna.

Före kanarien committades fix och prov i 249aff2e8edd4f3c02759f25958dd2aef882fc9d. Endast reading-review.ts återställdes till basen: 14/29 formulärprov blev röda, exakt de 12 ursprungliga felen plus båda nya prefixproven över årsskifte. Inga start- eller riggfel räknades. Endast samma fil återställdes från säkringscommitten, med SHA-256 6d71bd4e51af82885a71733a575ef725d0db3bec0df41af8fc4bde984e693f37; omkörningen gav 50/50.

Produktionsändringen är avgränsad till reading-review.ts: monthWindowIndex/consecutiveMonthWindows uttrycker observerade UTC-månadsfönster; start sparas på föregående rad; det gemensamma luckvillkoret ersätts av ett typberoende villkor. Mängd/dagsnämnare och de tidigare strukturella spärrarna är oförändrade. Formuläret och dess validering ändras inte.

Ingen merge, aktivering eller framåtpropagering till senare grenar har utförts. Detta ändrar läsanalysen; det ger inget nytt debiteringsklartecken eller bevis för fullständigt mätt förbrukning.

## Leveranskontroll

Webbens typkontroll och riktad ESLint för de två TypeScript-filerna är gröna. De två specarna kördes sekventiellt med en worker; före varje tung körning kontrollerades att inga andra Jest/TypeScript/Vitest-processer körde. Inga API-, databas-, leverantörs- eller produktionsanrop användes i proven.

Reproducera de rättade beteendeproven från repots rot:

```sh
pnpm --filter @eken/web exec vitest run src/features/consumption/lib/reading-review.test.ts src/features/consumption/lib/reading-review.form.test.tsx --maxWorkers=1 --minWorkers=1
pnpm --filter @eken/web typecheck
```

Den oförändrade radräknaren från #882 (0d048101f291cf352a730100ec96d6b042ed98a4) kördes med explicit arbetsrot och bas. Resultat: 38 ändrade produktionsrader (34 tillagda, 4 borttagna), 462 testrader och noll binärer; errors=[]. Testklassningen omfattar 238 rader formulärprov och 224 rader fristående grenrigg. Verktygets befintliga begränsningslista för dynamiska anrop redovisas inte som ett bevis för all runtime-modulladdning.

Pushkontrollen mot origin/codex/agent3-forbrukningsgranskning ger **5 egna filer**. Den ursprungliga formen mot merge-base med origin/main ger **10 filer**, varav **5 ärvda** och oförändrade mellan basen och leveransen. origin/main var 3b71e905d866f461f6b07211bc89b3fa88505200; merge-base var 27a720d4b6fb194fed83c760ce713c6aa70a0ad5. Ingen fil filtrerades bort för att få en kortare diff.

Ändringspunkter: reading-review.ts:18 (kalendergräns), :61 (föregående start), :121 (typberoende luckregel); reading-review.form.test.tsx:47 (verkligt formulär), :125 (beteendeprov); branch-audit.test-helpers.cjs och branches.json (fryst greninventering). GitHub CI:s slutstatus hör till exakt pushad HEAD och redovisas i PR:en, inte som ett antagande i detta dokument.
