# Oberoende inventering av runtime-bevisberoenden för kompakt 2.1

Granskad fryst källa: `73d221c9b7e002b70262a3186b76fea876d6ad01`.
Bas: `5ae9906b152307eae0d79eec719d4303a042742c`.
Samtliga kodrader nedan avser **73d221c9**, inte den nya arbetskopians innehåll.

Verifierad ny arbetsplats före inventeringen:
`/workspaces/eken-fran-mac-20260909/arbete/agent3-rendering-2-1-compact`,
gren `codex/agent3-rendering-2-1-compact`, HEAD exakt 5ae, tom gitstatus.
Alla källor har lästs med `git show`/`git ls-tree` från denna arbetsplats.
Inga äldre worktrees, grenar, PR:er eller produktionsfiler har ändrats.
Inga Jest-, Chromium-, PostgreSQL-, installations- eller typecheck-körningar
har utförts. Detta avsnitt beskriver den oberoende inventeringen före överföringen.

## Slutsats och exakt behållningsmängd

Behåll de sex hela resurskatalogerna och två aktiva fångstdrivrar nedan på
deras befintliga relativa sökvägar. De utgör **234 filer, 6 808 775 bytes**.
Där ingår båda ursprungliga `logo.png` trots att just dessa fristående
logofiler inte läses av Jest: de hör till de oförändrade råa föreserierna.
Lägg till de tre ursprungliga fångst-/fixturkällor vars SHA-256 faktiskt
anges i föremanifesten: **237 filer, 6 840 454 bytes totalt**.

| Grupp under `docs/granskning/agent3-rendering-2-1/` | Filer | Bytes | Varför hela gruppen behövs |
| --- | ---: | ---: | --- |
| `before-final-1/` | 68 | 1 550 200 | Manifest + 66 manifestrefererade råartefakter + ursprunglig logo |
| `before-final-2/` | 68 | 1 550 200 | Den andra självständiga föreserien; inget alias till den första |
| `extra-mail-before-utc/` | 27 | 102 848 | Manifest, fixtur, fyra råresultat, 21 frysta källblobbar |
| `extra-mail-before-stockholm/` | 27 | 102 944 | Samma fullständiga struktur för den synliga datumskillnaden |
| `font-environment/` | 42 | 3 479 632 | 8 TTF, 32 `conf.d`-filer, `fonts.conf`, `LICENSE-DejaVu` |
| `capture-after.cjs`, `capture-extra-mail.cjs` | 2 | 22 951 | Aktiva Node-subprocesser; extra-drivern importeras även som jämförelsehjälpare |
| `capture-before.cjs`, `fixture-source-before.ts.txt`, `capture-extra-mail-before.cjs` | 3 | 31 679 | Exakta historiska källor identifierade av föremanifesten |

Den maskinläsbara leveranslistan finns i [retained-files.json](retained-files.json).
Dess 237 poster med rollerna `runtime-fixture`, `provenance` och de två
capture-drivarna motsvarar mängden ovan. Varje post har ursprunglig sökväg,
Git-blob/mode, byteantal, omräknad SHA-256 och beroendemotivering.
Alla manifestrefererade artefakters längd/hash och alla 42 arkiverade
mejlkällkopiors Git-blobbar har kontrollerats mot råa 73d-blobbar.
Ingen ny fångst eller normalisering användes för inventeringen.

Detta är minsta rekommenderade **runtime- och råproveniensmängd**, inte hela
leveransens dokumentationskrav. Kontrakt/facit, regressionsdeklaration,
lanseringsnotering, granskarfynd, visuella fynd, röd/grön negativkontroll och
exakt grön CI måste fortfarande vara åtkomliga i en kort sammanställning
och/eller oföränderligt arkiv. Att en fil inte läses av proven är inte ett tillstånd att kasta historiken.

## Härledd läskedja

### Verkliga rendererprov och två nya efterprocesser

`apps/api/src/invoices/rendering.real.spec.ts:46` bestämmer evidensroten och
`:51` fontkatalogen. `beforeAll` vid `:109` sätter `FONTCONFIG_FILE`/`PATH`,
och `:120` startar två separata Node-processer med `ts-node/register/transpile-only`,
`capture-after.cjs`, aktuell API-katalog som cwd och TZ=UTC. De skriver nya
`process-1/run-1` och `process-2/run-1` under `RENDERING_EVIDENCE_DIR` eller
`apps/api/test-results/rendering/<pid>`; `:138` läser de **nya** manifesten.
CI förbjuder återanvändning genom `RENDERING_CAPTURED_BEFORE_JEST` vid `:113`.

`capture-after.cjs:10` gör `createRequire` från API:ets `package.json`;
`:11`–`:19` laddar de riktiga fem PDF-tjänsterna, MailService, MailRenderer,
renderingsidentiteten och `rendering.test-fixtures.ts`. Inga historiska
efterfiler används som input. Logo läses ur testfixturens explicita bytes
(`:25`); syntetisk lagring tillåter endast dess givna nyckel (`:26`).
PDF-kärnorna körs vid `:67`–`:85`, sex riktiga mejl vid `:87`–`:115`.
`:117`–`:130` läser installerade font-/motorfiler och rapporterar faktisk miljö.
`:119` läser drivarens egna bytes och `git rev-parse HEAD`; `:120` läser den
aktuella testfixturfilen. Därför kan gamla `after-development`, `after-proof-*`,
`behavior-red` och `behavior-restored` flyttas till arkiv utan att ändra
denna testväg.

### Två auktoritativa före-serier, exakt 66 artefakter per serie

`rendering.real.spec.ts:183`–`:197` läser båda `before-final-1/2` och kräver
ursprungligt bas-/source-SHA. `rendering.golden.test-helpers.ts:57`–`:73`
läser varje `manifest.json`, kräver samma hårdkodade ordning av 22 fall
(`:6`–`:29`), 16 PDF:er och 11 rena dokument, och följer varje
`records[].{input,pdf,html,text,envelope}.file` med `readArtifact`.
`:51`–`:55` kontrollerar rå längd och SHA-256; `assertGoldenPair` vid `:126`
jämför samtliga 66 artefakter, inklusive rå input-JSON och mejlens kuvert.

De två 14-siffriga Info-fälten ligger i `comparablePdf` vid `:76`–`:108`.
PDF-bilagor finns även som base64 i mejlens kuvert; `:110`–`:124` verifierar
kanonisk base64, unik rå bilageförekomst och samma smala PDF-undantag.
Att bara behålla PDF:erna eller HTML/text räcker alltså inte. Att ersätta den
andra föreserien med en nygenererad kopia förstör den godkända proveniensen.
Fristående `logo.png` är ursprunglig råresurs; dess hash motsvarar
manifestets `resources.sha256`, även om aktuellt Jest läser fixturens
base64 i stället för just den filen.

### InvoiceReminder: båda före-mapparnas källarkiv är aktiva input

`rendering.real.spec.ts:562`–`:578` startar `capture-extra-mail.cjs` i
**after**-läge två gånger, med separata processer och TZ=UTC/Europe/Stockholm.
`:579` importerar samma `.cjs` med `createRequire` och `:590`–`:595`
skickar båda frysta extra-förekatalogerna till `assertExtraMailComparison`.

Drivarens `sourcesFromArchive` vid `capture-extra-mail.cjs:68` läser
`extra-mail-before-utc/manifest.json` och alla dess `sourceBlobs[].source.file`.
`:74` kräver den oberoende pinnade, ordnade listdigest som deklareras vid
`:16`; `:77`–`:79` verifierar varje arkiverad råkällas SHA-256/längd och
Git-blob. Detta sker även i after-läge genom `:115`, innan aktuella
applikationskällor läses vid `:118`. **Det finns ingen Git-reservväg för
ett saknat eller beskuret UTC-arkiv.**

`readExtraMailCapture` vid `:218`–`:237` läser sedan varje fångsts manifest,
fixtur, samtliga 21 källblobbar och bägge HTML-/textresultaten. Detta gäller
även Stockholm-före, trots att dess källbytes är identiska med UTC-före.
För after jämförs källblobben också med aktuell riktig källfil (`:232`).
`:240`–`:265` kontrollerar olika processer inom paren, full rå UTC-identitet,
identiska efterbytes mellan tidszonerna och endast en exakt deklarerad
Stockholm-ersättning `12 september 2026` → `11 september 2026` per rå fil.

Den aktuella CI-vägen behöver Git-binären för HEAD/status (`:177`–`:179`),
men **behöver inte det historiska 5ae-Git-objektet**: after använder arkivet
och läsaren använder pinnad listdigest. Endast frivilligt before-läge
(`:35`–`:49`) kör `git ls-tree/show` på 5ae. Denna skillnad mot den äldre
fångstdrivern är viktig vid en grund checkout eller extern arkivering.

### Fontmiljö och licens

`rendering.real.spec.ts:115`–`:116` väljer den lokala miljön; `:264` och
`:638` kopierar hela katalogen för faktiska negativa identitetsprov.
`font-environment/fonts.conf:26` väljer den relativa `fonts`-katalogen,
`:98` läser `conf.d` och `:107` använder en separat temporär fontcache.
`rendering-context.ts:162`–`:200` kör faktisk `fc-list`/`fc-conflist`, följer
listade font-/konfigurationsfiler och binder deras bytes. Det finns alltså
både en rekursiv kopieringsväg och underliggande Fontconfig-läsningar.
Behåll alla 32 konfigurationsfiler och 8 typsnitt; ett borttaget till synes
oanvänt typsnitt är en ändring av den frysta testmiljön.

`LICENSE-DejaVu:20`–`:21` anger att copyright-/varumärkes-/tillståndsnotisen
ska medfölja fontkopiorna. Licensfilen hör kvar intill TTF-filerna även om
ingen assertion söker efter just dess filnamn.

### Testhjälpare, andra ändrade specs och paketens dynamiska läsningar

En konservativ statisk genomgång utgick från 14 ändrade spec-/hjälparfiler
(12 `.spec.ts` + 2 `.test-helpers.ts`), följde 742 relativa import/export/
require/import()-kanter till 259 källfiler och hade noll olösta relativa
imports. Genomgången inkluderar typ-/oanvända imports och är därför en
övermängd av det som faktiskt körs. Läsanrop och docs-referenser granskades;
utanför rendererfilernas kedjor är de hittade docs-referenserna kommentarer,
inte runtime-läsningar. Paketimporter och beräknade require hanteras nedan,
inte genom att anta att en regex över statiska importsträngar räcker.

`rendering.routing.test-helpers.ts:7`–`:17` importerar tjänster,
`testPersonalNumberService`, `rendering-context` och TS-fixturer. Riktig
PdfService används vid `:106`; mockportarna bär syntetiska bytes. Inga
extra docs-resurser läses här. `rendering.test-fixtures.ts:7` använder
`@eken/shared`, och logon är data vid `:12`–`:17`, inte en fs-läsning.
Steg 1:s återanvändbara portprov kommer från
`consumption/delivery-execution.test-ports.ts` (real-spec `:14`).

`rendering-context.ts:78`–`:139` har en deklarerad applikationsfilgräns,
`require.resolve` och rekursiv `installationFiles` (`:69`). Den inkluderar
alla filer under de verkliga `mail/templates` och `common/branding`,
upplöst `@eken/ui`, relevanta byggda `@eken/shared`-filer, genererad Prisma,
Node-binären samt faktiska paketinstallationer och deras dependencies/
peers/optionalDependencies. Dynamisk React SSR ingår via paketets bytes;
`r21-16` söker och muterar den verkliga `react-dom`-filen (`real.spec:512`).
Inga av dessa rekursiva app-/paketkataloger pekar på den historiska docs-
evidensroten. Flytta därför historiska kopior i docs, inte appkällor eller
installerade paket. Avsaknad av byggda shared/UI/Prisma-filer är inte något
som återläggning av gamla efter-PDF:er kan kompensera.

DB-specarna läser **samtliga** numeriskt namngivna migrationskatalogers
`migration.sql` i sorterad ordning och skickar dem till `psql`:
`delivery-decisions.db.spec.ts:74`–`:80` och
`delivery-execution.db.spec.ts:93`–`:99`. r21-17–21 gör dessutom dynamisk
import av riktig renderingsidentitet och testfixtur (`:1928`, `:2016`,
`:2102`, `:2213`, `:2325`). Deras kommentarer om 2a/2b-facit är inte
fs-läsningar. Migrationsfiler/Prisma och oförändrade steg 1-prov ska alltså
bevaras i kodträdet; ingen extra historisk rendererlogg behövs för DB-körning.

## Exakt ursprunglig proveniens och arkivgräns

Tre hashankare har kontrollerats mot riktiga frysta filbytes:

- `before-final-1/2/manifest.json.captureSourceSha256` = SHA-256 för
  `capture-before.cjs`: `5c66acee5c2681900d0d8946257daedfe2285886cbf550776d286b4f7699e088`.
- `fixtureSourceSha256` = SHA-256 för `fixture-source-before.ts.txt`:
  `713233e2c92864174cd30c88f1fe2b657877b0a2840e3701d7ef8d791f8f642b`.
- Båda extra-föremanifestens `driverSha256` = SHA-256 för
  `capture-extra-mail-before.cjs`:
  `3b3d1412e314fe336984e81ac43d91330df18007e7c7239e2a9c71afd255a9f4`.

Dessa tre läses inte av den aktuella obligatoriska Jest-vägen, men bevarar
vad som faktiskt skapade föreunderlaget. Den gamla fångstdrivern får inte
ersättas med den nuvarande och dess hash får inte skrivas om. Den vanliga
`capture-before.cjs` förutsätter den riktiga gamla 5ae-implementationen;
den ska inte köras i den nya implementationen för att skapa ett nytt facit.

Historiska `verify-before.cjs` är **inte** importerad eller körd från
rendererproven/CI. Dess `:11` och `:44` läser även `before-1/2` och
`before-controlled-1/2`; att låta skriptet ligga kvar som påstått aktivt
lokalt verifieringskommando efter arkivering av dessa mappar ger ENOENT.
Arkivera skriptet tillsammans med dess historiska indata eller märk det
uttryckligen som arkivverktyg. Ändra inte de aktuella goldenproven för detta.

Samma avgränsning gäller `verify-visual-pages.py`: `:11` globbar före-PDF:er,
`:13` läser just `after-proof-4/process-1/run-1`, och `:17` rasteriserar med
`pdftoppm`. Det körs inte av Jest. `verify-behavior-mutation.py:32` startar
aktiv capture men skriver sina egna `behavior-red/restored`-serier; ingen
aktuell spec läser de historiska resultaten. Arkivet måste bära historiskt
visuellt/negativt bevis, men de råfilerna behöver inte ligga som runtime-
input i den kompakta PR:en.

Ingen runtime-kedja från de granskade proven läser `after-development`,
`after-proof-2/3/4`, `before-1/2`, `before-controlled-1/2`, `visual-before`,
`visual-after-proof-4`, `behavior-red/restored`, `verification`,
utkastpatchen, stopploggen eller historiska jämförelser som input. Totalt
1 281 övriga filer under evidensroten återstår utanför denna runtime- och
proveniensmängd. Tre kontraktsdokument behålls i leveranslistan; övriga
1 278 filer finns i arkivmanifestet och sammanfattas i EXPERIMENTS.md.

## Miljö och återstående verifiering efter beskärning

Aktuell CI installerar Poppler och Puppeteers Chrome (`ci.yml:140`–`:143`),
kör riktiga tester (`:145`) och kräver hårdkodade 17 + 30 + 23 ID:n med
genomförda positiva assertions (`:160`–`:202`). `pdftotext`/`pdfinfo` är
verkliga subprocesser i r21-10; `fc-list`, `fc-conflist`, `fc-match` och
`ldd` behövs av capture/identitet, och `psql` av DB-proven. Node, paket,
Chromium, systembibliotek, byggda workspace-paket och genererad Prisma är
miljöberoenden, inte filer som ska ersättas med ett historiskt docs-arkiv.

Det nya absoluta arbetsplatsnamnet kan ge ny renderingsidentitet eftersom
faktiska sökvägar ingår. Färska efterfångster jämför sin identitet med den
aktuella miljön; de ska fortfarande matcha oförändrat rått föreunderlag
med endast de två deklarerade PDF-datumundantagen. Detta är en inventering,
inte en utförd verifiering av den kompakta kandidaten. Huvudagenten måste
köra de oförsvagade proven och kontrollera CI på exakt slutlig HEAD efter
att endast förpackningen ändrats.
