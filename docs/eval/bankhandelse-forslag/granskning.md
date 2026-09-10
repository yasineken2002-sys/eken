# Läsande AI-granskningar av ändringsförslaget

Alla granskare är Codex-AI utan personliga yrkesmeriter. Rollbeskrivningar i
aktuell worktree är ämnesbakgrund, inte behörigheter eller verifierade fakta.
Inga granskare får ändra filer, skriva databaser, köra tester/API:er, skicka
något externt eller merga. Högst två samtidigt; oberoende slutsatser innan de
ser varandras svar.

## Tidig säkerhets-/dataintegritetsgranskning

`/root/bankhandelse_integritet`, GPT-6 Astra xhigh, granskade fryst
`b1e5e7caaffaf199cf83aaf0d7a8d331dc8c718b` läsande. Källor:
`.claude/agents/security-auditor.md`, `code-reviewer.md` och aktuell produktkod.
Fem konkreta villkor accepterades av huvudagenten:

- `reconciliation.service.ts:1978`, `shadow-sweep.service.ts:176`,
  `payment-shadow.service.ts:118`: spärrade PENDING/STARTED/UNCERTAIN får inte
  återstartas genom andra automatiska vägar. Kandidaten ger urvals-/utförandegrind
  och samma identitetslås innanför befintliga allokeringstransaktioner.
- Statistik/färskhet/periodkontroll måste se observationer utan betalningsrad.
  `getStats:1941`, `psd2-sync.service.ts:140`, `accounting-period.service.ts:1074`,
  `payment-freshness.service.ts:98` visar luckorna. Kandidaten ger separata mått,
  held/resumed-utfall och identitetsgrind även när genomdatum är null.
- `reconciliation.service.ts:450`: status/valutakonflikt får inte avvisas före
  observationslagring. SQL bevarar signalen och konflikt spärrar anspråk; separat
  verkligt samtidighetsprov kontrollerar konflikt som får låset först.
- `psd2-sync.service.ts:119`: bevara verkligt hämtat kontosammanhang. Endast ett
  serverförvaltat, bevisbundet register kan styrka namespace/samtyckeskontinuitet.
  Inga verkliga bankkontrakt eller registreringar hittas på.
- Äldre betalningar lämnas orörda; gammalt unikt index behålls och bred P2002-
  fångst återanvänds inte. SQL-proven har oförändrad äldre rad som invariant.

Granskaren ansåg riktningen säker med dessa villkor, **ingen produktionsacceptans**.
Slutsatserna grundas på läsning, inte egen körning av tester eller bankintegration.

## Slutgranskning

Två självständiga granskningar av **samma frysta**
`6264d3ad74997d4db97c62d7c6407b686b1d46ca` genomfördes via Git-objekt.
`/root/bankhandelse_integritet` och `/root/bankhandelse_pengar_slut`, båda
GPT-6 Astra xhigh. Den andra läste bokforings-expert/code-reviewer som bakgrund.
Båda begärde ändringar; deras slutsatser kom före att de såg varandras svar.

| Fynd och fryst fil:rad | Konkret scenario/bevis | Huvudagentens bedömning |
| --- | --- | --- |
| Integritet HIGH: build_patch.py:85–94, kandidat.patch:287/295 | Vattenfallet efter misslyckad enskild avimatch saknar grinden; en emellan committad konflikt kan passeras. Härlett ur aktuell metod :2143–2157, inte kört. | Accepterat. Tredje allokeringskärnan får samma lås. Textkontrollen täcker alla tre och tre borttagna grindar måste nekas. Ingen faktisk allokering påstås körd. |
| Integritet HIGH: storage.sql:73–75 | Samma ID ändrar F-2026-001 till F-2026-002 i description, men den gamla kanoniska jämförelsen såg ingen konflikt. Matchningen använder description på :1008–1010. | Accepterat. Hela description jämförs även för legacy; separat negativt scenarios krav frystes före körning. |
| Båda HIGH/P1: storage.sql:103–107, :164–167 | Styrkt brygga till äldre UNMATCHED 100 kr, ny observation 120 kr: HELD utan eventlänk lämnade bankraden tillåten. Tidigare legacyfixture alltid MATCHED dolde detta. | Accepterat. Skapa beständig konfliktlänk till äldre rad, aldrig omskrivning av den. Extra prov använder uttryckligen syntetisk UNMATCHED-rad och kräver nekad automatik. |
| Båda MEDIUM/P2: kandidat.patch:69–77, helper:76 | Filcallers saknar identity och sparar origin={}, trots känt filnamn/format. | Accepterat. Känd proveniens transporteras separat; okänt bankkonto/namespace lämnas okänt. SQL-fixturernas färdiga origin är inte adapterbevis. |
| Integritet MEDIUM: kandidat.patch:307/315 | Ny bankIdentity-egenskap saknas i ReconciliationStats-returkontrakt. | Accepterat. Explicit IdentitySummary-typ och tillägg i returtypen. Syntax kontrolleras, full typkontroll återstår. |
| Pengar P2: kandidat.patch:468–477 | PENDING återupptas och matchas, men bara resumed ökar; utfallet försvinner ur historik. | Accepterat. Separata resumedMatched/resumedUnmatched och samma metadata i synkhistoriken. Nya och återupptagna räknas separat, inget imported-minus-totalmatched-fel. Adapterkörning återstår. |
| Pengar, osäkerhet: helper:40 | Prisma kan inte antas deserialisera RETURNS void eftersom riggen saknar Prisma. | Accepterat som bevislucka. Projicera till text; separat PG-kontroll, fortfarande inget Prisma-bevis. |

Ingen av granskarna belade tappad eller dubbel betalningsrad i de faktiskt
körda komponentfallen. Båda betonade att syntetiska markörer inte är ekonomisk
färdighantering och att gröna komponentprov inte täckte de hittade kringvägarna.
Samtliga fynd har hanterats i **artefakten**, inga har avvisats för att slippa
rättelse. Inget juridiskt auktoritetspåstående, ingen produktionsacceptans.

Huvudagenten korrigerade även main-jämförelsens för snäva formulering samt
beloppsgränsen i SQL: över numeric(12,2)-kapacitet bevaras observationen avvisad,
istället för att insättningen ska kasta och rulla tillbaka observationsspåret.

## Andra oberoende granskningen

Båda granskade `e94b619e50eb325960704eda0dd47576d1cd888c` via Git-objekt.
Båda begärde ytterligare ändringar, självständigt innan de såg varandras svar:

- `build_patch.py:74`/`kandidat.patch:242` använde `fileName` i CSV/Excel,
  trots att faktisk parameter heter `filename`. Accepterat och rättat; syntax-
  kontrollen kunde inte hitta detta typ-/scopefel. Ingen kandidatadapter påstås körd.
- `storage.sql:99–103`: ogiltig första legacyåterobservation avvisades före
  brygguppslaget. Accepterat: bryggkonflikt bedöms först, även booked=false,
  negativt belopp och annan valuta. Tre separata krav frysta i
  `granskning-komplettering-facit-v2.json` före körning. Fixturebeskrivningen
  görs lika i dessa nya kontrollfall så att endast den prövade signalen skiljer.
- Pengagranskaren: `kandidat.patch:414–421` räknade PDF-index efter att uttag
  filtrerats bort. Accepterat: index följer bevarad finalTx-lista före filtrering.
- Integritetsgranskaren: `build_patch.py:34` valde bort filproveniens när
  identity fanns. Accepterat: separat fileProvenance bevaras i båda vägarna.

De tidigare lås-, beskrivnings-, statistik- och resumed-måttfynden bedömdes
rättade inom den statiska bevisnivån. Void→text och redovisningen 31/30 var
korrekt avgränsade. Inga rättelser applicerade i produktionen. Samtliga nya
fynd accepterade; inga avvisade. Ny fryst slutkontroll följer före leverans.
