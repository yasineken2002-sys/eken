# Offlineprov av bankimportens händelseidentitet

Faktiska importmetoder slår i provet ihop två olika syntetiska API-händelser med
olika `externalId` när organisation, dag, belopp och OCR är lika. En post på
100 kr sparas i stället för två på tillsammans 200 kr. Andra anropet returnerar
`duplicate/via: dedupKey`; endast ett anrop når den ersatta matchningsgränsen.
Detta är en körd reproduktion av kodbeteende med isolerade beroenden, inte ett
bevis på tappade riktiga betalningar eller kundförlust.

## Bas, frysning och avgränsning

- Verifierad bas #873: `c6457aa00f027baa685d7e9b6ec28e8aa264c8e4`, gren
  `codex/agent2-kundklarlaggning-prototyp`, öppet utkast. Dess
  [CI 34407313659](https://github.com/yasineken2002-sys/eken/actions/runs/34407313659)
  hade 61 lyckade kontroller. Ny arbetsgren: `codex/agent2-bankimport-identitet`.
- Main kontrollerades läsande: `27a720d4b6fb194fed83c760ce713c6aa70a0ad5`.
  Importmetoder, PSD2-katalog och schema är oförändrade mot basen. Enda diff i
  granskade kataloger är fyra rader i `reconciliation/dto/confirm-import.dto.ts`
  (`StrictString`), utanför körningen. Main integrerades inte.
- Planen frystes i `159497f03048cffa2818c55275294011e91717f9`, 29 separata
  [indata](eval/bankimport-identitet/indata.json) och
  [krav/facit](eval/bankimport-identitet/facit.json) i `9cd60f8d` före första
  körningen. Två kompletterande återimportfall frystes i `004407e4` före sin
  körning: [indata](eval/bankimport-identitet/tillagg-indata.json) och
  [facit](eval/bankimport-identitet/tillagg-facit.json). De ursprungliga 29 ändrades inte.
- Inga produktionsfiler eller skyddade filer ändrades. Alla historiska filer
  under basens `docs/eval` bytejämförs och SHA-256-kontrolleras. Originalets
  2 000 betalningar/facit/resultat förblir oförändrade och återspelades inte.
  Inga nya procenttal eller påståenden om 99,98 procent.

## Resultat och tolkning

31 fall körda: **11 PASS och 20 FAIL** mot frysta produktkrav. Själva harnessen
och oberoende omräkning är godkända; 5/5 harnesskontroller och 18/18 negativa
kontroller passerar. De första 29 har exakt samma fallmått i två separata
PostgreSQL-körningar; se [jämförelsen](eval/bankimport-identitet/jamforelse.json).
90 filhashar verifieras, däribland 67 historiska underlag och 9 produktkällor.
Kontroll av syntax och `git diff --check` passerade. Inga Jest/tsc-jobb startades;
full appsvit, Prisma och full bankintegration verifieras inte av dessa prov.
Befintliga OCR-proveniens- och testkopplingsvakter passerade med sina självtest.
En separat SQL-kontroll sparade två uttryckliga null-ID:n, sammanlagt 300 öre;
den är ett prov av repository-fasaden och ingår inte i de 31 bankfallen.
De 31 bankfallens mått är oförändrade efter granskningens korrigeringar.
Se [slutverifiering och hashar](eval/bankimport-identitet/verifiering-slut.md).

[Falltabellen](eval/bankimport-identitet/korning-slut/falltabell.md) har exakt en
rad per fall med distinkta händelser, poster, heltalsören, import/dubblett/avvisat,
olösta sparade poster, anrop, synkfel och kontofält.
[Omräkningen](eval/bankimport-identitet/korning-slut/omrakning.json) innehåller även
bevarade referenser/OCR, provider-/API-/filanrop och varje kravavvikelse.
`PASS` gäller bara fallens uttryckliga krav. Det betyder aldrig färdig betalning.
Alla sparade poster är `UNMATCHED` eftersom riktig matchning inte körs.

| Fynd | Observerat och praktisk gräns |
| --- | --- |
| I01 olika ID, lika signaler | 2 avsedda / 1 sparad; 20 000 / 10 000 öre; 1 import + 1 dubblett. SQL-frågan saknar filfilter. |
| I02 exakt återimport | 1 sparad, 1 import + 1 dubblett, endast 1 matchanrop och 1 köanrop. Återimport är inte ett nytt uppdrag att matcha. |
| I03–I04 | Två ID utan OCR respektive två organisationer sparas var för sig. Isolering gäller de körda metodargumenten och SQL-predikaten; HTTP-behörighet körs inte. |
| I05 ändrat innehåll | Samma ID, belopp ändrat 100 → 120 kr: gammal post behålls och nytt anrop kallas dubblett utan särskild ändringssignal. Ingen automatisk ekonomisk rättelse antas. |
| I06–I07, I14 | Pending, negativt belopp och EUR avvisas uttryckligt. Negativt anrop är inte verifierad återföring; fortsatt hantering är utanför provet. |
| I08–I11 referenser | Reference-fallback fungerar. Motstridig OCR/reference/description bevaras till observatören. Tom sträng i OCR undertrycker fallback men reference sparas. Datumliknande prosatext blir inte OCR. Ingen betalningsavsikt avgörs. |
| I12, S-account-local-id | Under hypotetiskt lokalt ID-namespace sparas 1 av 2 händelser, 10 000 av 30 000 öre, genom faktisk SQL-unikhet på org + ID. API:t saknar konto/providerargument; verkligt namespace är okänt. |
| Fyra F-fall, båda ordningar | Samma respektive olika fysiska händelser ger identiska metodindata och utfall: 1 post. Vid samma händelse stämmer antalet, men kodens påstående om identitet saknar bevis. Ingen uttrycklig osäkerhet returneras. |
| Kontovisa cursors, AB och BA | Hypotetiskt kontrakt: 2 av 4 händelser, 30 000 av 100 000 öre. Nästa synk skickar sist sparade kontots cursor till första kontot och kastar. Kontonamnet i felet ändras med ordningen. |
| Kompatibel gemensam cursor, AB och BA | 4 av 4, 100 000 öre; tom tredje synk. Detta kontrollfall visar att gemensam cursor inte alltid tappar händelser. Kontoinformation saknas ändå i alla sparade poster. |
| Två konton, olika ID/lika signaler | 1 av 2 sparas via dedupnyckeln även när båda hämtats från olika konton. Kontoidentiteten försvinner före importen. |
| Nästa-sida-token, ett konto | En synk hämtar en sida: 1 av 2, 10 000 av 40 000 öre. Tre schemalagda synkar når båda, tredje sidan tom. Detta bevisar ingen verklig leverantörs pagineringskontrakt. |
| Tom kontosida | Hypotetiskt kontovis cursoravtal ger 1 av 2, 20 000 av 30 000 öre; nästa synk använder fel cursor. |
| Konto B misslyckas, nytt försök | Första A-svaret är hämtat men ännu inte importerat när B kastar. Ingen cursor/audit uppdateras då. Nytt försök sparar båda; tre levererade råtransaktioner under försöken motsvarar två händelser. |
| Återlevererade kontosidor | Sex leveranser under tre synkar motsvarar två händelser: 2 import + 4 dubbletter, 30 000 öre, endast 2 match-/köanrop. |
| Överlappande sidor | Tre leveranser motsvarar två händelser: 2 import + 1 dubblett, 40 000 öre, endast 2 match-/köanrop. |
| I13 fel vid matchningsgränsen | 1 post kvarstår med explicit `matchError`; återimport ger dubblett utan nytt matchanrop. 0 köanrop. Återhämtning via andra produktvägar är inte provad. |

Alla synkfall har även ett uttryckligt krav på bevarat kontofält. Därför kan
korrekta antal ändå få `FAIL`. Att här slå ihop alla fall till en enda summa
skulle dubbelräkna avsiktligt alternativa försök och olika namespace-antaganden.
Avvisade anrop, saknade händelser och synkfel redovisas separat från antalet
sparade `UNMATCHED`-poster; det senare är inte antal färdiga personalärenden.

## Vad kördes faktiskt?

`reconciliation.service.ts:265,388,445,470` körs från hela originalfilen;
`psd2-sync.service.ts:39,112,117,126,131,150` kör den faktiska mappningen,
kontoloopen, importen och cursoruppdateringen. `schema.prisma:2607` anger
den unikhet som testtabellen återger. Stub/Mock är de lokala implementationerna;
ingen faktisk banks fält, ID-namespace eller cursorsemantik verifierades.

`apps/api/scripts/bankimport_loader.cjs:39` laddar original-TS med befintlig
Node 24.11.1:s type-transform. Exakt två klassdekoratorer och en parameterdekorator
tas bort i minnet med antalskontroller; metodkroppar kopieras inte. Original-,
förbehandlings- och transformationshash sparas. Nest/DI körs inte. VM är ingen
fristående säkerhetsgräns för godtycklig kod; endast dessa lästa, hashkontrollerade
källor och en explicit importlista tillåts. Förbjudna anrop markeras utanför
produktens catch-block och stoppar provet även om undantaget fångas.

`bankimport_repository.cjs:14,58,84` verifierar ny egen PostgreSQL 16-container:
`network=none`, inga portar/värdvolymer, Unixsocket, tom testdatabas, 512 MB,
1 CPU och tmpfs. Endast egna `exp_bank_*`-tabeller används. Faktisk PostgreSQL
utvärderar mottagna `where` och `UNIQUE(org,external_id)`; riktigt SQLSTATE 23505
översätts till en smal P2002-testklass. Ingen extra fil-/organisationsfiltrering
läggs till. Full Prisma-klient, extensions, migrationsschema och generell
Decimalavrundning körs inte. Dessa sekventiella prov bevisar inga konkurrerande
Prisma-transaktioner, databaslås, allokeringar eller bokföringsverifikationer.

`eval_bankimport.cjs:24,62` ersätter matchning och kö med anropsobservatörer.
Mock-providerns faktiska konto-/statusmetoder körs; fetch ersätts av en funktion
av verkligt anropade konto/cursor enligt respektive hypotetiskt kontrakt.
Tokenkryptering ersätts av en fast syntetisk sträng. Filernas gemensamma
`ingestFromFile` körs, men inga CSV/Excel/BgMax/PDF-parsers. Ingen appstart,
Redis, extern bank, AI-tjänst, kunddatabas eller utskick används.

## Reproduktion och kontroller

Från arbetsgrenen i Codespaces, med befintlig Node 24 och redan tillgänglig
PostgreSQL 16-alpine Docker-image; inga installationer. Använd en ny tom
utkatalog för varje databaskörning. Kör sekventiellt. Kontrollera först disk och
`pgrep -af '[j]est|[t]sc'`; vänta om tunga jobb pågår.

```sh
node --experimental-vm-modules apps/api/scripts/test_bankimport_harness.cjs
PYTHONDONTWRITEBYTECODE=1 python3 apps/api/scripts/run_bankimport.py --out /tmp/eveno-bankimport-ny-korning
python3 -B apps/api/scripts/audit_bankimport.py /tmp/eveno-bankimport-ny-korning/observationer.json.gz --out /tmp/eveno-bankimport-ny-korning
python3 -B apps/api/scripts/audit_bankimport.py docs/eval/bankimport-identitet/korning-slut/observationer.json.gz --evidence-commit ebc87b85
git diff --check
```

Omräkningen använder endast Python-standardbibliotek, inga produktions-/loader-
importer. Den bygger om poster från lyckade SQL-skrivningar, kontrollerar faktiska
predikat, org/ID/belopp, anrop och cursors. Arton separata mutationer måste nekas, bland annat:
tappad post, påhittad andra import, dold bred SQL-träff, påhittat kontofält,
saknat matchanrop, fel organisation/samtycke, påhittad cursor/felorsak, bruten
leverans/importkedja, tappad felsignal, dolt förbjudet anrop och nedgraderad
bevisversion. Version 2 krävs som standard; äldre format kräver ett uttryckligt
`--legacy-evidence` och får inte beskrivas som den starkare slutkontrollen.
Filerna `observationer.json.gz`, `manifest.json`, `omrakning.json`, `falltabell.md`
och kort `korning.txt` ger komprimerat underlag utan tusentals utskrivna loggrader.

Första 29-fallskörningen sparas separat i `korning-1`; dess exakta harness finns
i `5dfe1e17`. Den kan räknas om med samma auditkommando, den katalogens observationer
och `--legacy-evidence --evidence-commit 5dfe1e17` (läser arkiverade harnessfiler med `git show`,
ingen checkout). Den ersätts inte i historiken av den utökade körningen. `korning-2` avser
31 fall före granskningskorrigeringarna och kräver `--legacy-evidence
--evidence-commit 36b046d5`. `korning-slut` är den starkare version 2.
Slutfångstens körda harness ligger i `ebc87b85c095e627988912e4b92c42401523570a`;
den efterföljande omräkningens egen SHA-256 sparas i `omrakning.json`.
`--evidence-commit` verifierar förändrade, arkiverade harnessfiler med `git show`;
observationernas hash ändras inte när omräkningen förstärks.

## Minsta nästa produktionsändring att föreslå

1. Hindra att olika API-ID:n tyst klassas som samma händelse enbart genom
   dag/belopp/OCR. Återimport ska använda en verifierad stabil händelseidentitet.
   Behåll likhetssignaler som möjlig konflikt; fil/API kräver styrkt gemensam
   identitet eller synlig granskning. Att bara vända ordningen på två sökningar
   räcker inte. I01, I02 och de fyra identiska F-paren är minsta acceptansprov.
2. Före verklig bankanslutning: fastställ provider-/konto-/consent-namespace och
   cursor-/sidkontrakt; bevara kontots ursprung genom importen. Därefter kan
   separat kontovis fortsättning, återförsök och sidhantering implementeras mot
   ett verifierat kontrakt. De hypotetiska fallen här är kravexempel, inte
   bankcertifiering.
3. Ge samma ID med ändrat innehåll en uttrycklig avvikelseväg och kontrollera
   återhämtningen efter matchningsfel. Ingen tyst ekonomisk uppdatering föreslås.

Ingen av dessa produktionsändringar genomförs i detta uppdrag. Separata
granskningar, provutfall och dispositioner sparas i
[granskningsunderlaget](eval/bankimport-identitet/granskning.md). Claude granskar
utkast-PR:n och avgör senare eventuell merge.
