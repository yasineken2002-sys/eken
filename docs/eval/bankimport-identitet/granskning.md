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

Två självständiga läsande slutgranskningar beställs på samma frysta commit efter
körning och rapport. Deras slutsatser och eventuella korrigeringar förs in här
innan PR-utkastet lämnas till Claude.
