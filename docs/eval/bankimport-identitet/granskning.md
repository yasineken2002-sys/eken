# Separata AI-granskningar av bankimportprovet

Rolltexter i den aktuella worktreens `.claude/agents` används bara som
ämnesbakgrund. Granskarna är Codex-underagenter, GPT-6 Astra xhigh, utan
påstådda anställningar eller personliga yrkesmeriter. Inga Claude-anrop.
Högst två samtidiga granskare; läsning av frysta Git-objekt, inga filändringar,
databasskrivningar, externa meddelanden, bank-/modell-API-anrop eller egna tester.

## Tidig säkerhetsgranskning

Separat agent `/root/bankimport_tidig_sakerhet` granskade HEAD
`159497f03048cffa2818c55275294011e91717f9` innan harnessbygget var färdigt.
Underlag: `.claude/agents/security-auditor.md` och provplanen. Ingen uppgift
om rollhierarki från rolltexten överfördes till detta prov.

| Självständigt fynd | Root:s bedömning och åtgärd |
| --- | --- |
| Provplan:31 lovar oförändrade metodkroppar; generell dekoratorborttagning kan ändra kod. | Tillämpat: exakta strängar/antal, tre borttagningar; original-, mellan- och slutkod hashkontrolleras i `bankimport_loader.cjs:78`. |
| `reconciliation.service.ts:514` fångar beroendefel; enbart kast kan döljas som importerad. | Tillämpat: extern förbjudet-markör som kontrolleras efter varje fall; separat körd kontroll visar att catch inte döljer markören. |
| `reconciliation.service.ts:470` saknar filfilter; en välvillig mock kan dölja dubblettfelet. | Tillämpat: riktiga SQL-predikat från faktiskt where, spårade svar och oberoende omräkning; negativa kontrollen med dold bred träff nekas. |
| `schema.prisma:2607` har unik org+externalId men dedup bara index. | Tillämpat: testtabellens faktiska SQL-unikhet; P2002 endast från SQLSTATE 23505. Ingen allmän Prisma-certifiering. |
| Provplan:58, `psd2-sync.service.ts:39`: facit/etiketter får inte skapa kontoinformation. | Tillämpat: exekveraren läser bara indata; F-parens faktiskt skickade argument, DB-utgångsläge och utfall jämförs identiska. Konto räknas bara om fältet finns i sparad post. |
| `psd2-sync.service.ts:117`: svarskö kan dölja fel cursor; B-fel sker före import av A. | Tillämpat: provider svarar på faktisk konto/cursor, DB-cursor återanvänds, och partiellt tillstånd sparas vid kast. |

Bevis vid denna tidiga granskning var läst kod. Agenten gjorde inget anspråk
på körbarhet eller verklig banksemantik; det senare är fortfarande okänt.

## Slutgranskningar

Separata agenter `/root/bankimport_tidig_sakerhet` (säkerhet) och
`/root/bankimport_slut_pengar_kod` (bokförings-/kodtestperspektiv) läste samma
frysta `36b046d5ad5dbe4ed27cc85a90da6f0ffdfaac4c`. Den senare använde
`.claude/agents/bokforings-expert.md` och `code-reviewer.md` som ämnesbakgrund.
De gav självständiga slutsatser innan de fick se den andres svar. Alla fynd
nedan var statiskt härledda; granskarna körde inga mutationer eller databaser.
Säkerhetsgranskaren kontrollerade dessutom manifestets 88 filhashar och två
observationshashar mot den frysta commiten.

| Granskare och konkret fynd i 36b046d5 | Root:s åtgärd och verifiering |
| --- | --- |
| Säkerhet: `eval_bankimport.cjs:62`, `audit_bankimport.py:150` accepterade fel consent-ID vid rätt konto; gemensam syntetisk token räckte inte för org-kopplingen. | Scope binds nu till aktiv organisation även för status/kontolista; audit kontrollerar omgång och consent. Mutation med fel consent nekas. |
| Båda: `audit_bankimport.py:124,150` band inte providersvar till importargument. Borttagen leverans kunde fortfarande ge fyra sparade poster; ändrade filargument jämfördes bara på org. | Kedjan provider → import → SQL-data kontrolleras med omgångsintervall, org, ID, belopp och referenser. Mutationer med borttagen leverans, ändrat importargument och ändrade argument i båda F-par nekas. |
| Kodtest: `audit_bankimport.py:136,150` kunde godta ett påstått cursorfel efter att anropet ändrats till giltig cursor. | Varje anrop binds till föregående lagrad cursor; felorsak prövas mot frysta sidor; misslyckad omgång måste bevara hela DB-snapshot. Motsvarande negativa prov nekas. |
| Säkerhet: `bankimport_repository.cjs:93` gjorde explicit null till texten 'null'. De frysta filfallen utelämnade ID och berördes inte. | Korrigerad SQL-NULL-semantik, egen Node-kontroll samt separat riktig PG-kontroll: två rader med två null-ID/null-nycklar och 300 öre. Inte två extra bankfall. |
| Båda: `audit_bankimport.py:102,169` bevakade inte I13:s explicita `matchError`. | Injicerat fel måste ge exakt observerad felmarkering och inget köanrop; borttagen markering nekas. Host-Error får VM-prefixet `Error:` vid produktens fångst. |

Båda granskare fann att ursprungliga observationer stöder huvudrapportens
belopp och 11/20-fördelning. Inget fynd visar felaktig kundbetalning eller
kundförlust. Samtliga relevanta fynd tillämpades; inga avvisades som oviktiga.

## Återkontroll och root:s slutprov

Båda läste därefter samma korrigeringscommit
`ebc87b85c095e627988912e4b92c42401523570a` och bedömde sina ursprungliga fynd
åtgärdade för bevisversion 2. Två ytterligare kontrolluckor återstod:

- Säkerhet, `audit_bankimport.py:208`: omgångens feltext jämfördes inte med
  providerfelet. Root lade till likhetskontroll och en nekad feltextmutation.
- Kodtest, `audit_bankimport.py:57,190,279`: borttagen versionsmarkering kunde
  stänga av de nya länkkontrollerna. Root kräver nu version 2 som standard;
  äldre fångster kräver explicit CLI-arkivläge. Kombinerad nedgradering och
  borttagen leverans nekas av den nya kontrollen.

Root körde de oförändrade 31 fallen igen i en ny isolerad PostgreSQL samt
den separata null-kontrollen. Resultatet blev samma 11 PASS/20 FAIL för
produktkraven. 5/5 Node-kontroller och 18/18 negativa omräkningskontroller
passerade. De sista två auditändringarna återanvänder den hashfrysta SQL-fångsten;
ingen fjärde identisk databaskörning behövs för att kontrollera dessa mutationer.
Kvarstående begränsningar: testfasad för Prisma, ersatt matchning/kö/provider,
sekventiellt prov och obekräftade verkliga bankkontrakt. Ingen produktionsfix.

Båda granskare gjorde en sista läsande kontroll på samma frysta
`74491a695b87abac83e75ca3eecd90e79b242b70`. Säkerhetsgranskaren bekräftade
feltextkontrollen (`audit_bankimport.py:210`) och hade inga kvarstående fynd.
Kodtestgranskaren bekräftade externt styrt arkivläge (`:57,303,319`),
nedgraderingskontrollen (`:290,294`) och separat auditorhash (`:321`); inget
kvarstående hinder från de granskade fynden. Körningsutfallet verifierades av
root, inte genom påstådda testkörningar hos granskarna. Därefter tillkom enbart
denna dokumentation av deras slutsatser.
