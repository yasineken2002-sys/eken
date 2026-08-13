# Har eval-golvet 21 någon marginal?

> MÄTNING, INGEN FIX. Ingen tröskel, lagtext, tesaurusgrupp eller domarprompt
> ändrad. 13 fullständiga `knowledge:eval`-körningar mot main `38f6b71`
> (korpus N = 427), samma kommando och samma indata varje gång.

## Frågan

`eval-legal-knowledge.ts` invariant 5 kräver `answerableHits >= 21` av 26. Den
texten skrevs om i #427 sedan relevansdomaren visat sig icke-deterministisk vid
`temperature: 0` (8 JA / 59 NEJ över 67 körningar på samma prompt,
`406-domare-vs-fonster.md`). Omskrivningen konstaterade att golvet sitter **exakt
på sitt uppmätta värde** och därmed saknar marginal, och lämnade uttryckligen
frågan om en sänkning som ett eget beslut som skulle mätas.

Det här är den mätningen.

## 1. Utfallet: kvoten rörde sig inte alls

| kvot      | antal körningar |
| --------- | --------------- |
| 21/26     | **13 av 13**    |
| min       | 21              |
| max       | 21              |
| spridning | **0**           |

**Noll flakande fall.** Samtliga 29 bedömda fall gav identiskt verdikt i alla 13
körningar — 23 stabila JA, 6 stabila NEJ.

## 2. Fyndet som ändrar tolkningen: instabiliteten pekar inte nedåt

De sex fall som får NEJ:

| fall                             | utfall | förväntad miss? | JA av 13 |
| -------------------------------- | ------ | --------------- | -------- |
| `besittningsskydd-andrahand-2ar` | miss   | nej             | **0**    |
| `besittningsskydd-lokal`         | miss   | nej             | **0**    |
| `drojsmalsranta-sen-hyra`        | miss   | nej             | **0**    |
| `paminnelseavgift-vad-galler`    | miss   | nej             | **0**    |
| `hyresgastval-diskriminering`    | miss   | nej             | **0**    |
| `deposition-storlek`             | miss   | JA              | **0**    |

**Det kända instabila fallet är en MISS.** `paminnelseavgift-vad-galler` är det
fall som flakar i ~12 % av dragningarna — och det räknas inte in i de 21. Dess
flip-riktning är alltså NEJ → JA, vilket tar kvoten från 21 till **22**. Den kan
per konstruktion inte fälla golvet.

Detsamma gäller de fyra övriga answerable-missarna. Hela golvets exponering
ligger på de **21 träffarna**, och där observerades noll vändningar över
21 × 13 = **273 falldragningar**.

Det är en annan bild än "golvet sitter på observationen utan marginal". Påståendet
är aritmetiskt sant, men den instabilitet vi faktiskt har belagt verkar i den
riktning som gör kvoten **högre**, inte lägre.

## 3. Vad 13 körningar inte kan visa

Att `paminnelseavgift-vad-galler` gav NEJ i 13 av 13 **motsäger inte** den
uppmätta andelen ~12 % JA. Sannolikheten för noll JA i 13 dragningar vid p = 0,12
är 0,88¹³ ≈ **0,19** — alltså fullt väntat ungefär var femte gång man kör en
serie på 13. Serien är i sig en illustration av varningen i invariantens text:
en enhällig serie inträffar och betyder inte att fallet är stabilt.

Samma osäkerhet gäller åt andra hållet, och den är den viktiga:

> Noll fall av kvot < 21 över 13 körningar ger, enligt trestegsregeln
> (95 %-övre gräns ≈ 3/n), en övre gräns på **≈ 21 % per körning** för att minst
> en av de 21 träffarna vänder. 13 körningar kan inte pressa den gränsen längre.

Ett fall bland de 21 kan alltså ligga nära domarens beslutsgräns utan att den här
serien avslöjat det. Det är inte ett skäl att sänka golvet — det är ett skäl att
inte kalla noll observerade fall för bevisad stabilitet.

## 4. Vad grinden faktiskt kostar när den blir röd

`knowledge:eval` förekommer **inte i någon workflow** under `.github/workflows/`.
Den är en manuell grind: en ogynnsam dragning stoppar ingen merge och släcker
ingen deploy — den ger en röd körning för den som kör den för hand.

Det ändrar avvägningen. Argumentet för marginal är starkast när varje ogynnsam
dragning bränner en blockerad pipeline. Här är kostnaden i stället att någon
felsöker något som inte är sönder, och mot det svarar invariantens text redan:
kör om före felsökning, jämför fördelningar över ≥ 10 körningar.

## 5. Slutsats

**Golvet 21 bör stå kvar.** Skälen, i ordning:

1. Den kända instabiliteten kan bara höja kvoten, aldrig sänka den (avsnitt 2).
2. Noll vändningar observerade bland träffarna över 273 falldragningar.
3. Grinden är manuell; en ogynnsam dragning kostar en omkörning, inte en merge.

En sänkning till 20 hade köpt marginal mot en vändning som ingen mätning ännu
sett, och samtidigt gjort golvet blint för en verklig regression av ett fall.
Det bytet är inte motiverat av det som mätts här.

**Det som däremot bör skrivas in i invarianten** är riktningsfyndet: att de fem
answerable-missarna, inklusive det kända flakande fallet, bara kan flytta kvoten
uppåt. Utan det läser "golvet sitter på sitt uppmätta värde utan marginal" som en
större risk än den är.

## 6. Reproducera

```bash
cd apps/api
for i in $(seq 1 13); do
  node --env-file-if-exists=.env -r ts-node/register scripts/eval-legal-knowledge.ts \
    > /tmp/eval-runs/run-$(printf %02d $i).log 2>&1
done
grep -ho 'rätt källa: [0-9]*/[0-9]*' /tmp/eval-runs/*.log | sort | uniq -c
```

Per-fall-verdikten ligger i femte kolumnen på varje falls rad (`JA`/`NEJ`). Ett
fall är domarbrus om den kolumnen inte är enhällig över körningarna; är den
enhällig men fel jämfört med journalen är det en regression.
