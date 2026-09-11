# Beskuret ersättningsförslag för steg 2.1

Detta är en ersättning av leveransförpackningen för PR #880, inte ett nytt
produktgodkännande. Godkänd källa är exakt
`73d221c9b7e002b70262a3186b76fea876d6ad01`; grenen skapas direkt från
`5ae9906b152307eae0d79eec719d4303a042742c` (PR #879), utan #880:s commits som
föräldrar. #877–880, deras grenar och befintliga kloner lämnas kvar.

Ägaren måste senare välja det beskurna ersättningsförslaget för merge för att
undvika att först föra in den stora #880-historiken. Ingen merge, aktivering
eller steg 2.2 ingår här.

## Behållningsgräns

[DEPENDENCIES.md](DEPENDENCIES.md) härleder statiska/dynamiska importer,
filsystemsläsningar, manifest, subprocesser och fontconfig.
[retained-files.json](retained-files.json) anger för varje behållen originalfil
sökväg, Git-mode, blob, bytes, SHA256, funktion och beroendekedja.
Avgränsningen är de 1547 paths som godkänd #880 ändrade sedan basen;
alla oförändrade basfiler ärvs oförändrade. Det är inte en rensning av hela repot.

269 originalfiler behålls: 13 godkända produktions-/CI-filer, 17 aktiva
prov-/hjälpar-/drivarfiler, 232 runtime-fixturer, 3 historiska provenienskällor
och 4 dokument. Av de 232 fixturerna är 136 hela auktoritativa before-final-filer,
54 kompletterande mejlfiler och 42 filer i en gemensam fontmiljö.
De två aktiva capture-drivarna räknas som testkod. Fontmiljön innehåller en
licenskopia, `font-environment/LICENSE-DejaVu`, för sina åtta TTF-filer.
De upprepade miljöerna och deras licenskopior följer med respektive arkivserie.

1278 originalfiler flyttas till arkivet. Före- och efterhistorik, avbrutna
körningar och avsiktligt röda kontroller finns kvar där. En borttagen path
betyder inte alltid borttagna bytes: exempelvis samma font eller fixture kan
fortfarande behövas under en behållen path. Historikmätningen särredovisar detta.

Godkända appfiler, specs, testhjälpare, två aktiva drivers och befintlig `ci.yml`
är byteidentiska med 73d. Ingen renderingsidentitet, datumregel, konfliktregel,
provförväntning eller lista på 70 obligatoriska ID ändras.
Nya kodfiler är en separat arkiv-workflow, dess Python-packare/verifierare och
syntetiska integritetsprov. Detta är redovisad CI-/testkod, inte dokumentation
eller en produktionsradsräknare. Den separata workflowen ändrar inte befintlig
branch protection; leveransen kräver både vanlig CI och arkivjobbet gröna.

## Arkiv och återhämtning

[archive-manifest.json](archive-manifest.json) anger original-SHA, varje path,
Git-mode/blob, filstorlek/SHA256, experiment och arkivets hash.
Arkivet är en deterministisk okomprimerad GNU tar med fasta headerfält.
GitHub Actions komprimerar transporten separat som ZIP; ZIP-digest och tar-hash
är olika mätningar. Arkivet ligger aldrig i den nya grenens committräd.

Två lokala byggen är byteidentiska och samtliga 1278 filer verifierade:
55 121 920 bytes; SHA256
`10a5b90e2860123ee7294627ae73cac5505691d8b6b647677a044ca955390af7`.

CI-artefaktens hämtningsadress, faktiska utgångstid och nedhämtningsbevis införs
när uppladdningen och återhämtningen är genomförda. Tills dess är det ett
förberett arkiv, inte en slutförd extern arkivering.

Workflowen begär 90 dagars retention. Den faktiska `expires_at`-uppgiften ska
läsas från artefakten; detta är **inte permanent lagring**. Inloggat GitHub-konto
med läsåtkomst krävs för nedhämtning. Raderad körning/artefakt kan avsluta
åtkomsten tidigare. [GitHubs dokumentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
beskriver åtkomst och nedhämtning.

Efter hämtning till en ny katalog verifieras tar-filen utan extrahering:

```bash
python3 .github/scripts/rendering-evidence-archive.py verify /tmp/download/agent3-rendering-2-1-evidence-73d221c9.tar
```

Verifieringen behöver bara den nya grenens script och manifest, inte en gammal
worktree, ett gammalt Git-objekt eller lokala efterfångster. Historiska verktyg
som `verify-before.cjs` och `verify-visual-pages.py` är arkiverade tillsammans
med sina indata; de är inte nuvarande CI-entrypoints.

## Frysta resultat och begränsningar

[EXPERIMENTS.md](EXPERIMENTS.md) sammanfattar metod, resultat, begränsning,
käll-SHA och arkivkoppling per experiment, inklusive oväntade misslyckanden.
Ursprungliga kontrakt och det kompletterande mejlets proveniens ligger kvar
byteidentiskt. Deras gamla relativa länkar till utflyttade serier avser nu
arkivets ursprungliga paths; de ska inte tolkas som lokala runtimeberoenden.

73d:s slutgröna CI-bevis fanns i GitHub och utanför dess Git-träd, inte som filer
i 73d. Det påstås därför inte ingå i detta källträdsarkiv:
[CI 34634346933](https://github.com/yasineken2002-sys/eken/actions/runs/34634346933).
Även vissa historiska lokala textloggar som rapporterna nämner saknar blob på
73d; manifestets exakta medlemslista avgör vad som faktiskt arkiverats.
Nya prov ska köras helt från den beskurna grenen med färsk rendering i CI.

Gamla Git-blobbar har inte raderats från GitHub, gamla refs eller delade kloner.
Det som ska bevisas är att utelämnade unika blobbar inte blir nåbara genom
**den nya grenens** commitkedja sedan 5ae. Delat objektlager och runnerns läsande
fetch av 73d är inte commitföräldraskap.
