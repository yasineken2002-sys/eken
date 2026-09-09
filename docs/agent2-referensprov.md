# Agent 2 — referenser före fördelning, experiment

## Resultat och beslut

En fristående, återkopplad Python-simulering av samma frysta 2 000 syntetiska
betalningar ger **1 970 korrekta automatiska beslut (98,5 %), noll felaktiga
automatiska beslut och 30 granskningsbetalningar** med gemensam referenskontroll
och strukturerat periodstöd. Samma beslut och allokeringar i båda ordningarna
inom bankdagen. **Målet högst 20 är underkänt.**

Det här implementerar en experimentpolicy, inte produktionsmatcharen eller
betalningsagenten. Ingen databas, bokföringstjänst, bankanslutning, modell eller
extern kö kördes. Inga produktionsfiler har ändrats. Den tidigare uttryckliga
gränsen runt `apps/api/src/reconciliation/` har bevarats.

| Mätning per 2 000 betalningar | Korrekt automatisk | Fel/kontrollbrist automatiskt | Granskning/åtgärd |
| --- | ---: | ---: | ---: |
| Tidigare produktionskod i lokal DB, grundordning | 1 890 (94,5 %) | 19 | 110 |
| Tidigare produktionskod i lokal DB, omvänd inom dagen | 1 880 (94,0 %) | 19 | 120 |
| Simulering: gemensam referenskontroll | 1 890 (94,5 %) | 0 | 110 |
| Simulering: referenser + hyresperiod/avtal | 1 970 (98,5 %) | 0 | 30 |
| Simulering: dessutom unikt OCR per avi | 1 970 (98,5 %) | 0 | 30 |

De två första raderna är historiska DB-resultat från #868, inte nya körningar.
Simuleringens tre varianter kördes i båda ordningarna: sex körningar men bara
2 000 unika grundbetalningar. Liknande slutresultat från olika körvägar bevisar
inte att produktionsintegrationen redan fungerar.

## De 30 som återstår

- 10 saknar identifierande information i bankraden.
- 10 har motstridiga identiteter mellan OCR och avinummer/fullnamn.
- 10 har 25 kr i överskott för en uttryckligen angiven avi, utan beslutad
  hantering av överskottet.

Alla ligger kvar i nämnaren och originalfacit. Vi har inte kallat en automatisk
köplacering, notifiering eller ett felaktigt beslut för en lyckad matchning.
De 80 nya matchningarna är 60 namn/period-fall och 20 felskrivna OCR med tydligt
namn/period. Fullnamn och period är unika i detta material; det är inte belägg
för deras förekomst eller tillräcklighet hos riktiga kunder.

Nästa sak att utforma om målet är 20: separat, spårbar överskottshantering för
de tio identifierade överbetalningarna. Att kalla dem färdiga utan sådan
hantering skulle byta kraven efteråt. Ingen sådan bokföringsmodell byggdes här.

## Vad som prövades

1. Samlad identitetskontroll före allokering. Både betalda och öppna avier finns
   i identitetsregistret; en tidigare betalning kan inte ta bort en konflikt.
2. Explicit lagrad hyresmånad/år, avtal och hyresgäst skiljs från förfallodatum
   och bankdatum. Namn/period-stödet är deterministiska regler för en snäv
   svensk textform, inte ett AI-svar. Kandidat-/promptändringar i produktion
   återstår att bygga och prova.
3. En tydligt separat variant där korrekt inmatade vanliga hyror och
   delbetalningar använder avins unika numeriska referens. **1 635 bankreferenser
   ändras i denna variant**; detta är en antagen framtida betalningsväg, inte
   förbättring på oförändrad bankindata. Betalningssätt, leverans, bankformat och
   kunders faktiska kopieringsbeteende har inte verifierats.

Unikt OCR gav ingen extra täckning i de 2 000 grundfallen: varje hyresgäst har
ett avtal där. Separata kontrollprov visar att ett unikt avireferensuppslag
kan skilja lägenhet från garage samma månad, medan delat OCR och månad lämnar
det oklart. Nya referenser måste i en verklig lösning ha ett gemensamt,
organisationsbundet register som inte krockar med äldre OCR. Experimentets
numeriska sekvens är endast testdata, inte en migrationsdesign.

## Kontroller och begränsningar

- **28/28 unittest-prov**: aktuellt avinummer trots gammal skuld, fel hyresgäst,
  betald OCR-ägare, namn-/avtalskollisioner, referenskonflikter, periodkonflikter,
  avvikande förfallodatum, framtida avier, organisationsgräns, felaktiga belopp,
  delbetalning, samlingsbetalning och motsägande text.
- **150/150 delbetalningar och 75/75 samlingsbetalningar** godkända i varje arm.
- Hela betalningsbeloppet fördelas exakt i ören eller lämnas helt ofördelat.
  Ingen allokering får överstiga kvarvarande skuld. Restskulden följer med till
  nästa betalning; ingen simulerad mänsklig korrigering nollställer den.
- Ursprungligt kund/facit och historiska råresultat verifieras mot SHA-256 i
  det tidigare manifestet. Facit används först för efterbedömning. Ett särskilt
  prov byter hela facit mot skräp och visar identiska projicerade bankunderlag.
  Beslut fungerar också när logiska identiteter ersätts av opaka ID:n.
- Oberoende omräkning av samtliga 12 000 körningsrader, belopp, grupper och
  källhashar: godkänd. Inte 12 000 oberoende kundfall.
- Negativkontroll i minnet återinförde OCR-fördelning före referenskontroll:
  båda utvalda proven föll som avsett, utan tekniska fel. Inga filer ändrades.
- Noll modell-/API-anrop, **0 kr i externa modellavgifter för detta prov**.
  Lokal datorkostnad har inte mätts. Detta är ingen driftkostnad per matchning.
- Inga nya Jest-/TypeScript-körningar: ändringarna gäller endast Python och
  dokumentation. CI kontrollerar repot; Pythonproven är körda lokalt och ingår
  inte automatiskt i den befintliga CI-sviten.

Simuleringen testar inte bokföringsverifikat, transaktionslås, samtidighet,
återimport/deduplicering, reverseringar, fakturor/depositioner eller godtycklig
fritext. Den gamla policyn äldst-först behålls för ett identifierat ensamt
avtal utan uttrycklig avihänvisning; det är fortfarande en policy, inte bevis
för betalarens avsikt. Fler avtal eller osäker text kan ge fler granskningsfall
utanför denna testblandning. **Ingen garanti om oförsämrad produkt eller
99,98 % träffsäkerhet i drift har därmed bevisats.**

## Reproduktion

Från reporoten, Python 3 med enbart standardbibliotek:

```sh
python3 -m unittest discover -s apps/api/scripts -p test_referensprov.py -v
python3 apps/api/scripts/eval_referensprov.py /tmp/ny-referensprov-rapport.json
```

Resultatet skrivs aldrig över. Rårapport och kontrolloggar ligger i
`docs/eval/referensprov/`. `manifest.json` anger hash för uppackad rapport.
Experimentkoden frystes i `241efd4` före sammanställningen.
