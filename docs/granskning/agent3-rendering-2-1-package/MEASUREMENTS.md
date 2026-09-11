# Fryst mätning av förpackningen

Källa: `73d221c9b7e002b70262a3186b76fea876d6ad01`. Bas:
`5ae9906b152307eae0d79eec719d4303a042742c`.
Git-mätningen här gäller första förpackningscommitten
`3c0648aac4f20d2793e397e9ee6e65542e47f3b0`. Den avslutande committen tillför
kvitto och rapporter; exakta slutvärden och slutlig HEAD finns i
[PR #881:s leveransrapport](https://github.com/yasineken2002-sys/eken/pull/881).
De 269 originalfilernas och arkivets mängder påverkas inte av rapportcommitten.
[measurement-first.json](measurement-first.json) bevarar de fullständiga
aggregerade mätvärdena för denna commit och per arkiverat experiment.

Mått: faktiska logiska filbytes per path, inte filsystemets allokerade block.
Text är UTF-8 utan NUL (med kända binära signaturer undantagna); rader är LF
plus eventuell sista icke-tom rad utan LF. Binärtyp bestäms av filsignatur.
HTML med NUL klassas öppet separat: det är befintliga råfiler, inte en
normalisering eller rättning. Git-storlek är unika nåbara objekts okomprimerade
payload sedan basen; det är inte packstorlek, klonstorlek eller frigjort diskutrymme.
Engångsmätningen bygger inte någon produktionsradsgrind; det hör till senare order.

## Filmängder i leveransen

| Mängd | Filer | Bytes | Textrader | Binärfiler |
| --- | ---: | ---: | ---: | ---: |
| Godkänd #880: berörda filer | 1 547 | 61 592 048 | 413 683 | 388 |
| Behållna originalfiler | 269 | 7 794 524 | 44 499 | 46 |
| Utflyttad originalbevisning | 1 278 | 53 797 524 | 369 184 | 342 |
| Nya förpackningsfiler i första commit | 8 | 649 337 | 14 658 | 0 |
| Beskuren leverans: berörda filer i första commit | 277 | 8 443 861 | 59 157 | 46 |

| Behållen funktion | Filer | Bytes | Textrader | Binärfiler |
| --- | ---: | ---: | ---: | ---: |
| Godkänd produktion och befintlig CI | 13 | 511 606 | 11 640 | 0 |
| Frysta kontrakt och lanseringsnotering | 4 | 99 514 | 579 | 0 |
| Historiska fångst-/fixturkällor | 3 | 31 679 | 665 | 0 |
| Nödvändiga golden-/font-/mejlfixturer | 232 | 6 785 824 | 22 716 | 46 |
| Aktiv testkod inklusive två .cjs-drivare | 17 | 365 901 | 8 899 | 0 |

Nya förpackningsfiler i första commit: två CI-kodfiler (173 rader,
7 256 bytes), en testfil (140 rader, 7 097 bytes) och fem manifest/rapporter
(14 345 rader, 634 984 bytes). Dessa kodtillägg är redovisade och granskade;
inget kodtillägg göms som dokumentation. Ursprungliga aktiva testdrivare,
specar och CI-assertionskontroll förblir identiska. Arkivmanifestet anger
ursprungliga storlekar och experiment för samtliga 1 278 utflyttade filer,
inklusive historiska körskript, rapporter och upprepade resurser.

## Binärfiler i berörda leveransfiler

| Typ | #880: antal / bytes | Behållna: antal / bytes | Arkiverade: antal / bytes |
| --- | ---: | ---: | ---: |
| HTML-with-NUL | 38 / 280 699 | 4 / 29 914 | 34 / 250 785 |
| PDF | 257 / 16 760 257 | 32 / 2 112 760 | 225 / 14 647 497 |
| PNG | 61 / 4 632 092 | 2 / 290 | 59 / 4 631 802 |
| TTF | 32 / 13 567 136 | 8 / 3 391 784 | 24 / 10 175 352 |

En gemensam fontmiljö med åtta TTF och en licens ligger kvar. Tre överflödiga
miljöers sammanlagt 24 TTF och deras licenser finns i arkivet.

## Hela slutträdet, inklusive oförändrad bas

| Träd | Filer | Bytes | Textrader | Binärfiler |
| --- | ---: | ---: | ---: | ---: |
| #879-bas | 2 092 | 31 772 584 | 543 105 | 16 |
| #880 godkänt slutträd | 3 615 | 92 541 828 | 939 012 | 404 |
| Första beskurna commit | 2 345 | 39 393 641 | 584 486 | 62 |

De oförändrade basfilerna rensas inte. Basens 16 binärer består av fem PDF,
två PNG, åtta WOFF2 och en ICO. Lägg dessa till den behållna typmängden ovan
för det nya hela trädet. Maskinläsbara totalsummor per typ finns i mätfilen.

## Nåbara Git-objekt sedan basen

| Objekt | #880: antal / bytes | Första beskurna commit: antal / bytes |
| --- | ---: | ---: |
| blob | 411 / 35 048 927 | 182 / 8 048 478 |
| tree | 120 / 143 158 | 32 / 30 721 |
| commit | 8 / 2 420 | 1 / 312 |

Mätningens Git-kommandon, körda för båda huvudrevisionerna:

```bash
git rev-list --objects --no-object-names HEAD ^5ae9906b152307eae0d79eec719d4303a042742c | sort -u | git cat-file --batch-check='%(objectname) %(objecttype) %(objectsize)'
git log --format='%H %P' 5ae9906b152307eae0d79eec719d4303a042742c..HEAD
git merge-base HEAD 73d221c9b7e002b70262a3186b76fea876d6ad01
```

Första committen har exakt 5ae som enda förälder. Ingen av #880:s åtta
commits sedan basen ingår i den nya kedjan, och merge-base mot #880 är 5ae.
Samtliga nya committräd kontrolleras, inte bara sluttipset. Inga av de
1 278 arkivsökvägarna har funnits i något av dem, och tar-filen har aldrig
committats. Den avslutande kedjan verifieras igen före slutleverans.

De 1 278 arkivsökvägarna motsvarar **335 unika blobbar**. Av dessa behövs
114 även under behållna sökvägar i det nya trädet. 19 av dessa är redan
nåbara från basen; 95 tillkommer som nödvändigt delat innehåll. De återstående
**221 exklusiva arkivblobbarna har noll träffar bland den nya historiens
objekt**. Inga har smugit in via en tidigare ny commit. Listorna går att
återhärleda genom `gitBlob` i de två manifesten och `git ls-tree -r HEAD`;
identiska blob-ID:n betyder exakt identiska bytes, oavsett sökväg.

Gamla GitHub-objekt, #880-grenen och befintliga kloner finns fortfarande.
Det gemensamma lokala objektlagret innehåller dem också. Detta bevis visar
vad den nya grenens historia inför sedan basen, inte fysisk radering.

## Arkivets faktiska lagring

1 278 medlemsfiler: 53 797 524 bytes; deterministisk tar: **55 121 920 bytes**.
Nedhämtad GitHub-ZIP: **26 372 439 bytes**. Både ZIP-digest och tar-digest
har verifierats efter faktisk nedhämtning, liksom varje medlem.
Se [archive-receipt.json](archive-receipt.json) för adress, kommandon,
API-metadata och verifiering. Faktisk utgångstid är
**2026-12-10 19:37:00 UTC** (begärd retention 90 dagar); åtkomsten kan
upphöra tidigare om körningen/artefakten tas bort. Detta är inte permanent lagring.
