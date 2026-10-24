# Agent 2 — fristående överskottsprov

## Resultat

**Högst 20 mänskliga granskningsbetalningar nås inte.** Den nya policyn ger
1 980 korrekta allokeringsbeslut och noll felaktiga i båda ordningarna, men
30 betalningar har fortsatt mänskligt granskningsbehov. Tio av dem har fått
en korrekt simulerad uppdelning med tillgodo och är fortfarande inte färdiga
ekonomiskt. Allokeringstäckningen 99,0 % är därför inte färdig hantering.

Det gamla måttet är separat och oförändrat: **1 970 korrekta automatiska,
noll felaktiga och 30 granskning (98,5 %)** vid ny körning av originalpolicyn
på alla 2 000 i båda ordningarna. Originalfacit har inte skrivits om.

| Nytt experimentmått, per 2 000 händelser | Grundordning | Omvänd inom dagen |
| --- | ---: | ---: |
| Betalningar med korrekta allokeringar enligt nya kontraktet | 1 980 | 1 980 |
| Betalningar med felaktiga allokeringar | 0 | 0 |
| Korrekta allokeringsrader | 2 055 | 2 055 |
| Avier med noll kvarvarande skuld i simuleringen | 1 980 | 1 980 |
| Separata spårbara tillgodoposter | 10 | 10 |
| Tillgodo totalt | 250 kr | 250 kr |
| Hyresgäster med tillgodo | 1 | 1 |
| Identitetskonflikter | 10 | 10 |
| Oidentifierade betalningar | 10 | 10 |
| Betalningar som behöver identifiering/allokeringsgranskning | 20 | 20 |
| Ytterligare betalningar med tillgodo att granska | 10 | 10 |
| Faktiska granskningsbetalningar totalt | **30** | **30** |
| Samlade tillgodoärenden för identifierad hyresgäst | 1 | 1 |
| Olösta betalningsärenden utan fastställd ägare | 20 | 20 |
| Arbetsärenden totalt (inte antal oberoende kunder) | 21 | 21 |

De tio tillgodoposterna är `betalning-57-0` till och med `betalning-57-9`:
varje betalning på 9 800 kr allokerar 9 775 kr till sin angivna avi och
behåller 25 kr separat. Tio månader ger 250 kr för **en** hyresgäst.
Ingen senare betalning använder det äldre tillgodot.

Hela beloppet bevaras i båda körningarna:
`1 542 574 750 = 1 522 999 000 + 25 000 + 19 550 750` öre
(bankbelopp = allokerat + tillgodo + ofördelat). Kvarvarande aviskuld är
19 550 750 öre. Beloppslikheten mellan ofördelade bankrader och skuld ger
ingen rätt att kvitta dem eller fastställa betalare.

När det nya beteendet i stället bedöms mot **originalfacit** blir det
1 970 korrekta automatiska, **tio automatiska avvikelser från originalfacit**
och 20 utan allokering. Avvikelserna är exakt de tio förhandsdefinierade
överskottsfallen; de är godkända uppdelningar endast under det nya kontraktet.
Originalets gamla resultat och det nya beteendets originalbedömning blandas inte.

## Policy och granskningsmått

Detta är en Python-simulering av identifiering, allokering och separat tillgodo.
Ingen produktionsimplementation, kontoplan eller bokföringsintegration ingår.

Inventeringen sparades först i `aefa21b0`. Experimentpolicyn och dess förväntningar
frystes därefter i `e30b8518`, före implementation och körning:
[`policy-v1.json`](eval/overskottsprov/policy-v1.json).
Originalet #869 ligger på `ca29554ae4033b9546d3fb42687a7ad2a8414fdb`.

Den nya regeln tillåter att högst aktuell skuld på **en uttryckligen angiven,
entydig avi** allokeras, först efter de befintliga referens- och konfliktkontrollerna.
Resten får en separat tillgodopost med organisation, hyresgäst, avtal,
ursprungsbankhändelse, avi, belopp, datum, policyversion och kvarvarande beslut.
Inget tillgodo används på annan avi, återbetalas eller kvittas automatiskt.
Vanliga del- och samlingsbetalningar behåller den tidigare referens-/periodpolicyn;
den befintliga fördelningen av samlingsbetalningar är inte användning av tillgodo.

Tre frågor hålls isär: identifierad betalning, reglerad avi i simuleringen och
kvarvarande tillgodobelopp. Beloppsuppdelningen använder heltalsören och enbart
symboliska flödesroller, aldrig riktiga bokföringskonton eller verifikat.

**Tillgodo kräver fortsatt mänsklig granskning.** De förhandsbestämda måtten
skiljer därför betalningar utan godkänd allokering från betalningar med
allokering men kvarvarande tillgodoärende. Varje ursprungsbetalning räknas
högst en gång i den samlade granskningsmängden. Köplacering räknas aldrig som
lyckad allokering. Ett tillgodoärende får samla flera betalningar men får inte
sänka antalet granskningsbetalningar.

## Indata och beslutets gräns

Alla 2 000 frysta bankhändelser och originalfacit är oförändrade.
En vitlista skapar samma publika projektion som #869:s referens-/periodarm
(`unique=False`); ingen variant med ändrade OCR används. Projektionen är ett
experimentunderlag: den återger den frysta generatorns inskickade OCR, inte en
ny verifiering av produktionsimportens `rawOcr`-extraktion. Kända årtalsproblem
i importen från #868 blir inte lösta av detta prov.

Beslutsmodulen får bara typade `Bank`/`Notice` och ett stabilt org-bundet
bankhändelse-id. Den importerar varken utvärderaren, förväntningskontraktet eller
facit. Ett kontrollprov ersätter både scenario och facit med oanvändbara objekt
före projektionen och kräver identiska publika indata. Opaka id:n prövas separat.
Förväntningskontrakt och originalfacit läses av bedömningen först efter återspel.

Skuld OCH tillgodo följer hela historiken utan mänskliga korrigeringar i båda
ordningarna inom bankdagen. En andra import av alla 2 000 id:n i varje slutläge
ska lämna samma tillstånd. Rapporten sparar varje beslut, skuld före/efter för
allokerade avier, tillgodohistorik efter varje händelse, ofördelat belopp och
slutläget för samtliga avier. Tidsordnade mellanlägen får skilja sig inom dagen;
beslut per bankhändelse och slutlig skuld/tillgodo jämförs mellan ordningarna.

## Kvarvarande beslut och begränsningar

- Fastställd kontohantering och beständig ekonomisk redovisning saknas fortfarande.
- Ägare och fortsatt hantering av tillgodot måste bekräftas; återbetalning eller
  användning mot en annan avi kräver ett separat beslut.
- Avgifter, ränta, krediterade/annullerade avier, rättelse/avmatchning och
  ommatchning behöver en utökad policy och egna integrationsprov. Ingen ny
  utförandeväg för dessa har byggts här. En redan betald explicit avi stoppas.
- Atomicitet simuleras med oföränderligt minnestillstånd: skuld och kredit
  förbereds innan ett nytt tillstånd returneras. Avbrottsprov kastar före
  publicering. Detta bevisar inte databastransaktioner, lås, samtidighet,
  processkraschbeständighet eller rollback i Postgres.
- Deduplicering simuleras på `(organisation, stabilt bankhändelse-id)`.
  Återimport med förändrat id från en verklig bankkälla är inte verifierad.
- De tio överskotten är tio händelser för **en** syntetisk hyresgäst över tio
  månader. Oidentifierade och motstridiga betalningar grupperas inte med hjälp
  av facit till påhittat identifierade kundärenden. Kvarvarande ärenden är inte
  ett mått på antalet oberoende kunder.
- Inga externa AI-anrop, databas- eller produktionsskrivningar. Varken
  `/workspaces/eken-codex` eller `apps/api/src/reconciliation/**` har använts.
- Syntetisk täckning ger ingen garanti om 99,98 % i drift.

## Reproduktion

Från reporoten, Python 3.10+ och enbart standardbibliotek. Välj en ny katalog;
körningen vägrar skriva över tidigare resultat. Kör seriellt på delad maskin.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/api/scripts -p 'test_*prov.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 apps/api/scripts/eval_overskottsprov.py /tmp/overskottsprov-ny
PYTHONDONTWRITEBYTECODE=1 python3 apps/api/scripts/audit_overskottsprov.py /tmp/overskottsprov-ny /tmp/overskottsprov-ny/oberoende-kontroll.json
```

Den oberoende kontrollen importerar inga policy-/återspels-/bedömningsfunktioner.
Den rekonstruerar publik indata från originalet, kontrollerar källhashar och
räknar om allokeringar, tillgodo, skuld, granskningsbetalningar och ärenden från
alla rader. Nio medvetna fel i separata minneskopior måste avvisas: tappat öre,
fel ägare, fel avi, dubbel kredit, kö som framgång, dolt granskningsbehov,
fel sammanfattning, saknad bankhändelse och förbrukat äldre tillgodo.

## Verifiering och sparat underlag

- **57/57 kontrollprov**: 29 nya och samtliga 28 originalprov. Logg:
  [`kontrollprov.txt`](eval/overskottsprov/kontrollprov.txt).
- Alla 2 000 händelser återspelade med originalpolicy och ny policy i båda
  ordningarna: 8 000 beslutsrader men endast 2 000 unika grundhändelser.
- Återimport av samtliga 2 000 händelser mot vardera nya slutläget:
  4 000 idempotenta återspel, oförändrad skuld och tillgodo i minnet.
- Separat omräkning av alla nya rader, båda originalkörningarnas facitutfall,
  publika indata, källhashar, slutlägen och ärenderäkning: **godkänd**.
  **9/9** avsiktliga resultatfel avvisades med assertionsfel, utan tekniska fel.
- Kontroll av Git-innehåll mot #869: originalpolicy, originaltest, båda gamla
  resultatkatalogerna och frysta källor är oförändrade. Inga produktionsfiler
  ingår i denna fortsättning.
- Python 3.12.1, enbart standardbibliotek. Cirka 2,2 GB ledigt före/efter;
  inga installationer eller tunga parallella körningar. Inga nya Jest- eller
  TypeScript-körningar eftersom ändringen bara gäller Python och dokumentation.
  Pythonproven har körts lokalt; de ingår inte automatiskt i befintlig CI.

Kod för körningen frystes i `a6dcb141`, efter policycommitten `e30b8518`.
Råresultat med källhashar finns i
[`korning-1/`](eval/overskottsprov/korning-1/): `public-input.json.gz`,
`resultat.json.gz`, `manifest.json` och
[`oberoende-kontroll.json`](eval/overskottsprov/korning-1/oberoende-kontroll.json).
Manifestet binder också originalpolicy och originaltest. Rapportens uppackade
SHA-256 är `caeda8ea2039f492ee680e7f8538c6cf9934d28bdafffb37f82dad90dcfb6d0d`.

PR-bas: `codex/agent2-referensprov` (#869), som i sin tur bygger på #868.
Endast utkast för Claudes granskning. Ingen merge eller produktionsaktivering.
