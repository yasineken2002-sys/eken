# #406 — dör de kvarvarande fallen i fönstret eller hos domaren?

> MÄTNING, INGEN FIX. Ingen produktionsregel, tröskel, lagtext eller domarprompt
> ändrad. `GROUNDING_TOP_K` lästes, aldrig flyttades: K = 5/10-frågan besvaras
> genom att räkna på den fuserade listan.
> Genererad av `apps/api/scripts/measure-406-judge-vs-window.ts` mot korpus N = 427, main efter PR4.

## Varför frågan måste ställas

Efter PR4 passerar samtliga answerable-fall grinden, och de fem som ändå missar
fälls alla av relevansdomaren. Bakom det gemensamma utfallet `miss` döljer sig två
problem som kräver motsatta åtgärder:

- **Facit saknas i fönstret** → fusionsproblem. Domaren kan inte välja en paragraf
  den aldrig ser. Åtgärden ligger på den semantiska sidan.
- **Facit finns i fönstret, domaren säger ändå NEJ** → domarproblem.

Fönstret är `retrieval.fused` topp-3 — det är vad `evaluateLegalCandidate` lämnar
vidare som `retrieved`, och exakt de chunkarna som byggs in i domarprompten.

## 1. Svaret i en tabell

| fall                             | facit                            | facit i fönstret? | fused-rank för facit | domare (10 körningar) | stabilt?                                           | flaskhals    | avsedd miss?           |
| -------------------------------- | -------------------------------- | ----------------- | -------------------- | --------------------- | -------------------------------------------------- | ------------ | ---------------------- |
| `paminnelseavgift-vad-galler`    | inkassokostnadslagen 2 §         | JA                | 1                    | 8× NEJ, 2× JA         | **FLAKAR** (8 JA / 59 NEJ över 67 kända körningar) | **domaren**  | **nej — verkligt mål** |
| `hyresgastval-diskriminering`    | diskrimineringslagen 12 §        | **NEJ**           | 6                    | 10× NEJ, 0× JA        | stabilt (10/10 NEJ)                                | **fönstret** | **nej — verkligt mål** |
| `besittningsskydd-andrahand-2ar` | hyreslagen 45 §                  | **NEJ**           | 16                   | 10× NEJ, 0× JA        | stabilt (10/10 NEJ)                                | **fönstret** | ja                     |
| `drojsmalsranta-sen-hyra`        | ranteslagen 4 §, ranteslagen 6 § | JA                | 2 / 5                | 10× NEJ, 0× JA        | stabilt (10/10 NEJ)                                | **domaren**  | ja                     |
| `besittningsskydd-lokal`         | hyreslagen 57 §                  | **NEJ**           | 6                    | 10× NEJ, 0× JA        | stabilt (10/10 NEJ)                                | **fönstret** | ja                     |

## 2. Fönstrets faktiska innehåll, per fall

`kanal` visar varifrån platsen kom: lexikal rank, semantisk rank, eller båda.
RRF-bidraget är `1/(60 + rank)` per kanal — en chunk som bara finns i EN kanal kan
alltså aldrig få mer än hälften av vad en chunk med samma placering i båda får.

### `paminnelseavgift-vad-galler`

> Vad gäller för påminnelseavgift på en sen hyra?

Facit: **inkassokostnadslagen 2 §**. Verkligt mål.

Domarens 10 verdikt i ordning: JA · NEJ · NEJ · NEJ · NEJ · NEJ · JA · NEJ · NEJ · NEJ

| #   | chunk                    | BM25 | täckning | cosine | lex-rank | sem-rank | RRF     | i fönstret? | facit? |
| --- | ------------------------ | ---- | -------- | ------ | -------- | -------- | ------- | ----------- | ------ |
| 1   | `inkassokostnadslagen 2` | 23.0 | 0.60     | 0.413  | 1        | 4        | 0.03202 | JA          | **JA** |
| 2   | `bostadsrattslagen 7:23` | 0.5  | 0.20     | 0.444  | —        | 1        | 0.01639 | JA          |        |
| 3   | `bostadsrattslagen 7:16` | 1.1  | 0.20     | 0.437  | —        | 2        | 0.01613 | JA          |        |
| 4   | `inkassokostnadslagen 4` | 12.1 | 0.60     | —      | 2        | —        | 0.01613 | nej         |        |
| 5   | `hyreslagen 44`          | 0.9  | 0.20     | 0.430  | —        | 3        | 0.01587 | nej         |        |
| 6   | `hyreslagen 55`          | 5.2  | 0.40     | —      | 3        | —        | 0.01587 | nej         |        |
| 7   | `hyreslagen 21`          | 5.0  | 0.40     | —      | 4        | —        | 0.01563 | nej         |        |
| 8   | `hyreslagen 22`          | 0.0  | 0.00     | 0.407  | —        | 5        | 0.01538 | nej         |        |
| 9   | `hyreslagen 66`          | 4.7  | 0.40     | —      | 5        | —        | 0.01538 | nej         |        |
| 10  | `hyreslagen 40`          | 4.6  | 0.40     | —      | 6        | —        | 0.01515 | nej         |        |

### `hyresgastval-diskriminering`

> Får jag välja bort en sökande hyresgäst på grund av etnicitet eller ålder?

Facit: **diskrimineringslagen 12 §**. Verkligt mål.

Domarens 10 verdikt i ordning: NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ

| #   | chunk                         | BM25 | täckning | cosine | lex-rank | sem-rank | RRF     | i fönstret? | facit? |
| --- | ----------------------------- | ---- | -------- | ------ | -------- | -------- | ------- | ----------- | ------ |
| 1   | `diskrimineringslagen 2:12 b` | 7.6  | 0.29     | 0.503  | 3        | 6        | 0.03102 | JA          |        |
| 2   | `diskrimineringslagen 2:13 b` | 8.7  | 0.29     | 0.483  | 1        | 10       | 0.03068 | JA          |        |
| 3   | `diskrimineringslagen 2:14 b` | 8.3  | 0.29     | 0.483  | 2        | 9        | 0.03062 | JA          |        |
| 4   | `diskrimineringslagen 2:9`    | 5.7  | 0.29     | 0.592  | —        | 1        | 0.01639 | nej         |        |
| 5   | `diskrimineringslagen 2:10`   | 4.7  | 0.29     | 0.558  | —        | 2        | 0.01613 | nej         |        |
| 6   | `diskrimineringslagen 2:12`   | 0.0  | 0.00     | 0.534  | —        | 3        | 0.01587 | nej         | **JA** |
| 7   | `diskrimineringslagen 2:1`    | 0.0  | 0.00     | 0.514  | —        | 4        | 0.01563 | nej         |        |
| 8   | `bostadsrattslagen 2:10`      | 7.3  | 0.29     | —      | 4        | —        | 0.01563 | nej         |        |
| 9   | `diskrimineringslagen 2:15`   | 3.3  | 0.14     | 0.513  | —        | 5        | 0.01538 | nej         |        |
| 10  | `ranteslagen 3`               | 7.3  | 0.29     | —      | 5        | —        | 0.01538 | nej         |        |

**Facit ligger på fused-plats 6** (lexikal rank —, semantisk rank 3, cosine 0.534).

- Vid `GROUNDING_TOP_K = 5`: fortfarande utanför.
- Vid `GROUNDING_TOP_K = 10`: **hade kommit med**.

### `besittningsskydd-andrahand-2ar`

> Min andrahandshyresgäst — när får hon besittningsskydd mot mig?

Facit: **hyreslagen 45 §**. AVSEDD MISS (invariant 2 — §45 ligger utanför fused topp-8 i båda kanalerna för den här formuleringen; dokumenterad känd begränsning, ärlig miss är det säkra utfallet).

Domarens 10 verdikt i ordning: NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ

| #   | chunk                    | BM25 | täckning | cosine | lex-rank | sem-rank | RRF     | i fönstret? | facit? |
| --- | ------------------------ | ---- | -------- | ------ | -------- | -------- | ------- | ----------- | ------ |
| 1   | `bostadsrattslagen 7:11` | 17.3 | 0.42     | —      | 1        | —        | 0.01639 | JA          |        |
| 2   | `hyreslagen 28`          | 0.0  | 0.00     | 0.475  | —        | 1        | 0.01639 | JA          |        |
| 3   | `hyreslagen 39`          | 12.6 | 0.33     | —      | 2        | —        | 0.01613 | JA          |        |
| 4   | `hyreslagen 47`          | 7.4  | 0.25     | 0.466  | —        | 2        | 0.01613 | nej         |        |
| 5   | `bostadsrattslagen 7:10` | 12.5 | 0.33     | —      | 3        | —        | 0.01587 | nej         |        |
| 6   | `hyreslagen 31`          | 1.6  | 0.17     | 0.454  | —        | 3        | 0.01587 | nej         |        |
| 7   | `hyreslagen 42`          | 8.2  | 0.42     | 0.453  | —        | 4        | 0.01563 | nej         |        |
| 8   | `bostadsrattslagen 1:8`  | 11.9 | 0.25     | —      | 4        | —        | 0.01563 | nej         |        |
| 9   | `hyreslagen 27`          | 0.0  | 0.00     | 0.451  | —        | 5        | 0.01538 | nej         |        |
| 10  | `hyreslagen 65 c`        | 11.7 | 0.33     | —      | 5        | —        | 0.01538 | nej         |        |

**Facit ligger på fused-plats 16** (lexikal rank —, semantisk rank 8, cosine 0.448).

- Vid `GROUNDING_TOP_K = 5`: fortfarande utanför.
- Vid `GROUNDING_TOP_K = 10`: fortfarande utanför.

### `drojsmalsranta-sen-hyra`

> Vilken dröjsmålsränta får jag ta ut på en sen hyra?

Facit: **ranteslagen 4 §, ranteslagen 6 §**. AVSEDD MISS (invariant 7 — domaren fäller 6/6 även när rätt paragraf ligger i kandidatmängden; ärlig miss ELLER grundad med rätt källa är båda tillåtna utfall).

Domarens 10 verdikt i ordning: NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ

| #   | chunk                      | BM25 | täckning | cosine | lex-rank | sem-rank | RRF     | i fönstret? | facit? |
| --- | -------------------------- | ---- | -------- | ------ | -------- | -------- | ------- | ----------- | ------ |
| 1   | `ranteslagen 5`            | 11.4 | 0.33     | 0.525  | 2        | 4        | 0.03175 | JA          |        |
| 2   | `ranteslagen 6`            | 10.3 | 0.33     | 0.500  | 3        | 5        | 0.03126 | JA          | **JA** |
| 3   | `inkassokostnadslagen 4 a` | 5.8  | 0.17     | 0.548  | 9        | 2        | 0.03062 | JA          |        |
| 4   | `ranteslagen 2`            | 8.1  | 0.33     | 0.487  | 4        | 8        | 0.03033 | nej         |        |
| 5   | `ranteslagen 4`            | 6.6  | 0.33     | 0.495  | 6        | 6        | 0.03030 | nej         | **JA** |
| 6   | `hyreslagen 55 e`          | 6.8  | 0.50     | 0.486  | 5        | 9        | 0.02988 | nej         |        |
| 7   | `ranteslagen 7`            | 5.5  | 0.17     | 0.557  | —        | 1        | 0.01639 | nej         |        |
| 8   | `ranteslagen 9`            | 15.6 | 0.50     | —      | 1        | —        | 0.01639 | nej         |        |
| 9   | `ranteslagen 3`            | 5.0  | 0.17     | 0.530  | —        | 3        | 0.01587 | nej         |        |
| 10  | `hyreslagen 28`            | 6.3  | 0.33     | —      | 7        | —        | 0.01493 | nej         |        |

### `besittningsskydd-lokal`

> Har min lokalhyresgäst (ett företag) besittningsskydd?

Facit: **hyreslagen 57 §**. AVSEDD MISS (invariant 7 — kräver inferens ur regel-FRÅNVARO (lokal har inget direkt besittningsskydd); ärlig miss är ett tillåtet och säkert utfall).

Domarens 10 verdikt i ordning: NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ · NEJ

| #   | chunk                   | BM25 | täckning | cosine | lex-rank | sem-rank | RRF     | i fönstret? | facit? |
| --- | ----------------------- | ---- | -------- | ------ | -------- | -------- | ------- | ----------- | ------ |
| 1   | `hyreslagen 28`         | 0.0  | 0.00     | 0.436  | —        | 1        | 0.01639 | JA          |        |
| 2   | `hyreslagen 50`         | 9.5  | 0.43     | —      | 1        | —        | 0.01639 | JA          |        |
| 3   | `hyreslagen 31`         | 0.9  | 0.14     | 0.422  | —        | 2        | 0.01613 | JA          |        |
| 4   | `bostadsrattslagen 1:8` | 9.0  | 0.29     | —      | 2        | —        | 0.01613 | nej         |        |
| 5   | `hyreslagen 18 i`       | 0.0  | 0.00     | 0.415  | —        | 3        | 0.01587 | nej         |        |
| 6   | `hyreslagen 57`         | 8.5  | 0.43     | —      | 3        | —        | 0.01587 | nej         | **JA** |
| 7   | `hyreslagen 30`         | 0.0  | 0.00     | 0.415  | —        | 4        | 0.01563 | nej         |        |
| 8   | `hyreslagen 47`         | 7.0  | 0.29     | —      | 4        | —        | 0.01563 | nej         |        |
| 9   | `hyreslagen 2`          | 2.3  | 0.14     | 0.414  | —        | 5        | 0.01538 | nej         |        |
| 10  | `hyreslagen 58 a`       | 6.9  | 0.29     | —      | 5        | —        | 0.01538 | nej         |        |

**Facit ligger på fused-plats 6** (lexikal rank 3, semantisk rank —, cosine —).

- Vid `GROUNDING_TOP_K = 5`: fortfarande utanför.
- Vid `GROUNDING_TOP_K = 10`: **hade kommit med**.

## 3. Den särskilda hypotesen: `hyresgastval-diskriminering`

Hypotesen: fallet släpps in ENBART på cosine (0,592 över golvet 0,52; BM25 8,7
under golvet 9), fönstret domineras av svaga lexikala hyreslagsträffar, och
diskrimineringslagen 12 § når aldrig topp-3 trots att semantiken hittat den — det
strukturella problem RRF skapar för en chunk som är stark i bara EN kanal.

**Uppmätt:**

- Fönstrets tre platser kommer från: 3 chunk(ar) i BÅDA kanalerna, 0 enbart lexikal, 0 enbart semantisk.
- Facit (diskrimineringslagen 12 §) har semantisk rank 3 (cosine 0.534), lexikal rank — (BM25 0.0), och hamnar på fused-plats 6.
- Fönstrets tre chunkar kommer alla från: diskrimineringslagen. De är alltså inte hyreslagsträffar.

**Hypotesen är BEKRÄFTAD i sin strukturella del och FÖRKASTAD i sin mekanism.**

Bekräftat: facit når inte fönstret, och orsaken är exakt den RRF-effekt hypotesen
pekar ut. Facit finns BARA i den semantiska kanalen (BM25 0,0 — noll lexikal
poäng), så den kan som mest samla ett kanalbidrag. De tre som tar fönstret sitter
i BÅDA kanalerna och får därmed två bidrag var. En chunk som är bäst i en kanal
förlorar strukturellt mot chunkar som är medelmåttiga i två.

Förkastat: fönstret domineras INTE av svaga lexikala hyreslagsträffar. Alla tre
platserna hålls av diskrimineringslagen — men av GRANNPARAGRAFER (12 b, 13 b,
14 b) i stället för av 12 § själv. Diagnosen "fel lag drar in sig" stämmer inte;
den rätta är "rätt lag, fel paragraf, och den rätta paragrafen är osynlig för
BM25". Skillnaden spelar roll för åtgärden: ett filter på lagnivå hade inte
hjälpt.

## 4. Svaret

**Olika för de två verkliga målen — och det är hela poängen med att mäta i stället
för att gissa. Ett gemensamt `miss` dolde två motsatta problem.**

- **`paminnelseavgift-vad-galler` → DOMAREN.** Facit ligger på fused-plats 1 av 3, alltså ÖVERST i fönstret. Domaren ser rätt paragraf och fäller den ändå i 8 av 10 körningar (2 JA). Ingen fusionsändring i världen kan flytta det här fallet.
- **`hyresgastval-diskriminering` → FÖNSTRET.** Facit ligger på fused-plats 6 och når aldrig domaren. Verdiktet NEJ säger därför ingenting om domarens omdöme — den bedömde tre andra paragrafer.

De tre avsedda missarna bekräftar sina egna invarianter och är inte problem:

- `besittningsskydd-andrahand-2ar`: facit UTANFÖR fönstret, 10/10 NEJ — förenligt med invariant 2.
- `drojsmalsranta-sen-hyra`: facit I fönstret, 10/10 NEJ — förenligt med invariant 7.
- `besittningsskydd-lokal`: facit UTANFÖR fönstret, 10/10 NEJ — förenligt med invariant 7.

### Sidofynd som inte fick förbli osagt: domaren är inte deterministisk

Vid temperature 0 har 1 av 5 fall gett OLIKA verdikt mellan körningar: `paminnelseavgift-vad-galler` (59× NEJ, 8× JA över 67 körningar).

Den aktuella körningen gav 8× NEJ / 2× JA — ett enhetligt stickprov kan alltså inträffa och betyder inte att fallet är stabilt.

Det betyder att gate-evalens `domare`-kolumn för dessa fall är ett stickprov, inte
ett faktum, och att kvoten 21/26 kan röra sig utan att en enda rad kod ändras. Fyra
tidigare eval-körningar gav alla NEJ på `paminnelseavgift-vad-galler` — den serien
såg stabil ut och var det inte. Ett gränsfall nära domarens beslutsgräns är exakt
där temperature 0 slutar räcka som determinismgaranti.

Konsekvensen för invariant 5 är att golvet bör läsas som ett golv, inte som en
förväntad nivå — vilket är precis hur det är formulerat.

**Hela dagens stickprov för `paminnelseavgift-vad-galler`**, samlat ur alla
körningar med samma domarprompt (verifierat identisk indata via fused-pariteten).
Raderna under den första är observationer ur andra körningar, inte tal den här
mätningen räknat fram — de står med för att de ändrar tolkningen:

| serie                                                    | JA    | NEJ    |
| -------------------------------------------------------- | ----- | ------ |
| den här mätningen (10 körningar)                         | 2     | 8      |
| förstudiens 3 körningar (samma skript, `JUDGE_RUNS = 3`) | 2     | 1      |
| fem tidigare 10-körningar med samma inställning          | 4     | 46     |
| 4 fullständiga `knowledge:eval`-körningar 2026-08-13     | 0     | 4      |
| **summa**                                                | **8** | **59** |

8 av 67 körningar gav JA, alltså ~12 %. Poängen är inte den exakta andelen utan att den
inte går att uppskatta ur en handfull körningar: de tre första gav 2 JA av 3 och
de fyra eval-körningarna 0 av 4. Båda serierna hade lästs som "stabila" var för
sig, åt motsatta håll.

### Vad mätningen INTE säger

- **Att domaren ska mjukas upp.** Dess strikthet är ett medvetet designförsvar: den
  fällde PR2:s regression, och invariant 3 pekar ut den som det enda som håller
  `deposition-storlek` ute (cosine 0,605 ligger över golvet). En uppluckring är en
  GLOBAL ändring och kräver egen mätning mot negativkontrollerna. Fyndet rapporteras;
  ingen lättnad föreslås.
- **Att `GROUNDING_TOP_K` ska höjas.** K = 10 hade tagit in facit i
  `hyresgastval-diskriminering`, men ett bredare fönster ger domaren fler chanser att
  hitta något som ser relevant ut — det är samma ratt som skyddar negativkontrollerna,
  vriden åt andra hållet. Också en egen mätning.
- **Något om prod-trafik.** Fem fall ur ett konstruerat eval-set.

## 5. Domarens exakta indata

Prompten nedan är ordagrant den som skickades, byggd av
`buildRelevanceJudgePrompt` ur `candidate.retrieved` — samma väg som produktionen.
Modell: `claude-haiku-4-5-20251001`, temperature 0, max_tokens 8.

<details><summary><code>paminnelseavgift-vad-galler</code> — domarprompt</summary>

```text
Du är en strikt relevansdomare i ett juridiskt RAG-system för svenska hyresvärdar.

ANVÄNDARENS FRÅGA:
"""
Vad gäller för påminnelseavgift på en sen hyra?
"""

HÄMTAD LAGTEXT (kandidater):
[1] Lag (1981:739) om ersättning för inkassokostnader m.m., 2 §:
## 2 §

Gäldenären är skyldig att utge ersättning för skriftlig betalningspåminnelse rörande skulden, om avtal därom har träffats senast i samband med skuldens uppkomst.

[2] Bostadsrättslagen (1991:614), 23 §:
## 23 §

Är nyttjanderätten enligt 18 § 1 a förverkad på grund av dröjsmål med betalning av årsavgift eller avgift för andrahandsupplåtelse, och har föreningen med anledning av detta sagt upp bostadsrättshavaren till avflyttning, får han eller hon på grund av dröjsmålet inte skiljas från lägenheten

1. om avgiften – när det är fråga om en bostadslägenhet – betalas inom tre veckor från det att<ol class="bokstavslista"><li id="K7P23S1N1Na" about="https://lagen.nu/1991:614#K7P23S1N1Na" data-ordinal="a">bostadsrättshavaren på sådant sätt som anges i 27 och 28 §§ har delgetts underrättelse om möjligheten att få tillbaka lägenheten genom att betala avgiften inom denna tid, och
2. meddelande om uppsägningen och anledningen till denna har lämnats till socialnämnden i den kommun där lägenheten är belägen, eller </li><li id="K7P23S1N2" about="https://lagen.nu/1991:614#K7P23S1N2" data-ordinal="2">om avgiften – när det är fråga om en lokal – betalas inom två veckor från det att bostadsrättshavaren på sådant sätt som anges i 27 och 28 §§ har delgetts underrättelse om möjligheten att få tillbaka lägenheten genom att betala avgiften inom denna tid.</li></ol>

Är det fråga om en bostadslägenhet får en bostadsrättshavare inte heller skiljas från lägenheten om han eller hon har varit förhindrad att betala avgiften inom den tid som anges i första stycket 1 på grund av sjukdom eller liknande oförutsedd omständighet och avgiften har betalats så snart det var möjligt, dock senast när tvisten om avhysning avgörs i första instans.

Första stycket gäller inte om bostadsrättshavaren, genom att vid upprepade tillfällen inte betala avgiften inom den tid som anges i 18 § 1 a, har åsidosatt sina förpliktelser i så hög grad att han eller hon skäligen inte bör få behålla lägenheten.

Beslut om avhysning får meddelas tidigast tredje vardagen efter utgången av den tid som anges i första stycket 1 eller 2.

Regeringen eller den myndighet som regeringen bestämmer fastställer formulär till underrättelse och meddelande som avses i första stycket. Lag (2014:319).

[3] Bostadsrättslagen (1991:614), 16 §:
## 16 §

Om bostadsrättshavaren inte i rätt tid betalar insats eller upplåtelseavgift som skall betalas innan lägenheten får tillträdas och sker inte heller rättelse inom en månad från anmaning, får föreningen häva upplåtelseavtalet. Detta gäller inte om lägenheten tillträtts med styrelsens medgivande.

Om avtalet hävs, har föreningen rätt till ersättning för skada.

I 18--25 §§ finns bestämmelser om förverkande när avgifter betalas för sent efter tillträdet.

UPPGIFT: Avgör om den hämtade lagtexten innehåller den MATERIELLA regel
som behövs för att besvara frågans juridiska kärna.
- Svara JA om minst EN kandidatparagraf innehåller regeln frågan gäller,
  helt eller till väsentlig del.
- Att texten bara rör samma allmänna ämnesområde räcker INTE för JA.
- Procedur-/formregler (t.ex. hur en uppsägning delges) besvarar INTE en
  fråga om RÄTTEN att säga upp — och tvärtom.
- Är du tveksam till om regeln verkligen finns i texten: svara NEJ.

Svara med EXAKT ett ord: JA eller NEJ.
```

</details>

<details><summary><code>hyresgastval-diskriminering</code> — domarprompt</summary>

```text
Du är en strikt relevansdomare i ett juridiskt RAG-system för svenska hyresvärdar.

ANVÄNDARENS FRÅGA:
"""
Får jag välja bort en sökande hyresgäst på grund av etnicitet eller ålder?
"""

HÄMTAD LAGTEXT (kandidater):
[1] Diskrimineringslagen (2008:567), 12 b §:
## 12 b §

Förbudet mot diskriminering i 12 § som har samband med ålder

1. hindrar inte tillämpning av bestämmelser i lag som föreskriver viss ålder,
2. gäller inte tillhandahållande av försäkringstjänster,
3. hindrar inte tillämpning av nedre åldersgränser för tillträde till serveringsställen för yrkesmässigt bedriven servering av spritdrycker, vin, starköl och andra jästa alkoholdrycker för vilka näringsidkaren har serveringstillstånd, och
4. hindrar inte heller annan särbehandling på grund av ålder om särbehandlingen har ett berättigat syfte och de medel som används är lämpliga och nödvändiga för att uppnå syftet.

_Lag (2012:673)_.

[2] Diskrimineringslagen (2008:567), 13 b §:
## 13 b §

Förbudet mot diskriminering i 13 § som har samband med ålder hindrar inte

1. tillämpning av bestämmelser i lag som föreskriver viss ålder, eller
2. annan särbehandling på grund av ålder om särbehandlingen har ett berättigat syfte och de medel som används är lämpliga och nödvändiga för att uppnå syftet. _Lag (2012:673)_.

## Socialförsäkringssystemet, arbetslöshetsförsäkringen och studiestöd

[3] Diskrimineringslagen (2008:567), 14 b §:
## 14 b §

Förbudet mot diskriminering i 14 § som har samband med ålder hindrar inte

1. tillämpning av bestämmelser i lag som föreskriver viss ålder, eller
2. annan särbehandling på grund av ålder om särbehandlingen har ett berättigat syfte och de medel som används är lämpliga och nödvändiga för att uppnå syftet. _Lag (2012:673)_.

## Värnplikt och civilplikt

### Värnplikt och civilplikt samt annan motsvarande militär utbildning inom Försvarsmakten

UPPGIFT: Avgör om den hämtade lagtexten innehåller den MATERIELLA regel
som behövs för att besvara frågans juridiska kärna.
- Svara JA om minst EN kandidatparagraf innehåller regeln frågan gäller,
  helt eller till väsentlig del.
- Att texten bara rör samma allmänna ämnesområde räcker INTE för JA.
- Procedur-/formregler (t.ex. hur en uppsägning delges) besvarar INTE en
  fråga om RÄTTEN att säga upp — och tvärtom.
- Är du tveksam till om regeln verkligen finns i texten: svara NEJ.

Svara med EXAKT ett ord: JA eller NEJ.
```

</details>

<details><summary><code>besittningsskydd-andrahand-2ar</code> — domarprompt</summary>

```text
Du är en strikt relevansdomare i ett juridiskt RAG-system för svenska hyresvärdar.

ANVÄNDARENS FRÅGA:
"""
Min andrahandshyresgäst — när får hon besittningsskydd mot mig?
"""

HÄMTAD LAGTEXT (kandidater):
[1] Bostadsrättslagen (1991:614), 11 §:
## 11 §

Vägrar styrelsen att ge sitt samtycke till en andrahandsupplåtelse får bostadsrättshavaren ändå upplåta sin lägenhet i andra hand, om hyresnämnden lämnar tillstånd till upplåtelsen. Tillstånd ska lämnas, om bostadsrättshavaren har skäl för upplåtelsen och föreningen inte har någon befogad anledning att vägra samtycke. Tillståndet ska begränsas till viss tid.

I fråga om en bostadslägenhet som innehas av en juridisk person krävs det för tillstånd endast att föreningen inte har någon befogad anledning att vägra samtycke. Tillståndet kan begränsas till viss tid.

Ett tillstånd till andrahandsupplåtelse kan förenas med villkor. Lag (2014:319).

### Bostadsrättshavarens ansvar för lägenhetens skick

[2] Hyreslagen (jordabalken 12 kap.), 28 §:
## 28 §

Är pant eller borgen ställd till säkerhet för att ett avtal om hyra av en lokal fullgörs och försämras säkerheten, är hyresgästen skyldig att på anfordran ställa ny säkerhet med vilken hyresvärden skäligen kan nöja sig. Gör han det ej inom en månad, får hyresvärden säga upp avtalet. Lag (1984:694).

[3] Hyreslagen (jordabalken 12 kap.), 39 §:
## 39 §

Hyresgästen får inte utan hyresvärdens samtycke hyra ut eller på något annat sätt upplåta lägenheten i andra hand till någon annan för självständigt brukande utom i fall som avses i tredje stycket eller i 40 §.

Om det är fråga om en bostadslägenhet som hyresgästen inte använder som bostad i beaktansvärd utsträckning, ska en upplåtelse av lägenheten eller en del av den alltid anses vara för självständigt brukande.

Om en bostadslägenhet har upplåtits till en kommun, får kommunen upplåta lägenheten i andra hand till någon annan för självständigt brukande. Hyresvärden ska genast underrättas om upplåtelsen. Lag (2019:523).

UPPGIFT: Avgör om den hämtade lagtexten innehåller den MATERIELLA regel
som behövs för att besvara frågans juridiska kärna.
- Svara JA om minst EN kandidatparagraf innehåller regeln frågan gäller,
  helt eller till väsentlig del.
- Att texten bara rör samma allmänna ämnesområde räcker INTE för JA.
- Procedur-/formregler (t.ex. hur en uppsägning delges) besvarar INTE en
  fråga om RÄTTEN att säga upp — och tvärtom.
- Är du tveksam till om regeln verkligen finns i texten: svara NEJ.

Svara med EXAKT ett ord: JA eller NEJ.
```

</details>

<details><summary><code>drojsmalsranta-sen-hyra</code> — domarprompt</summary>

```text
Du är en strikt relevansdomare i ett juridiskt RAG-system för svenska hyresvärdar.

ANVÄNDARENS FRÅGA:
"""
Vilken dröjsmålsränta får jag ta ut på en sen hyra?
"""

HÄMTAD LAGTEXT (kandidater):
[1] Räntelagen (1975:635), 5 §:
## 5 §

I fall som avses i 2 § andra stycket beräknas ränta för år enligt en räntefot som motsvarar den vid varje tid gällande referensräntan enligt 9 § med ett tillägg av två procentenheter.

[2] Räntelagen (1975:635), 6 §:
## 6 §

I fall som avses i 3 eller 4 § beräknas ränta för år enligt en räntefot som motsvarar den vid varje tid gällande referensräntan enligt 9 § med ett tillägg av åtta procentenheter. Om det vid bestämmande av skadestånd med anledning av personskada ska avräknas förmåner som en skadelidande har rätt till enligt 5 kap. 3 § 1 skadeståndslagen (1972:207), utgör dock tillägget till referensräntan endast två procentenheter för tiden till dess förmånerna har fastställts slutligt.

Ett avtalsvillkor som innebär att räntan ska beräknas enligt en lägre räntefot än vad som följer av första stycket första meningen är utan verkan mot borgenären i ett förhållande mellan en näringsidkare och en myndighet eller ett annat offentligt organ, när näringsidkaren i sin yrkesmässiga verksamhet tillhandahåller varor eller tjänster mot betalning.

[3] Lag (1981:739) om ersättning för inkassokostnader m.m., 4 a §:
## 4 a §

Om en borgenär i ett förhållande mellan näringsidkare i deras yrkesmässiga verksamhet har rätt till dröjsmålsränta till följd av att en fordran på betalning för en vara eller tjänst inte har betalats i tid, har borgenären också rätt till en förseningsersättning. Detsamma gäller i ett förhållande mellan en näringsidkare och en myndighet eller ett annat offentligt organ, när näringsidkaren i sin yrkesmässiga verksamhet tillhandahåller varor eller tjänster mot betalning.

Förseningsersättning ska betalas med fyrahundrafemtio kronor. Lag (2013:56).

UPPGIFT: Avgör om den hämtade lagtexten innehåller den MATERIELLA regel
som behövs för att besvara frågans juridiska kärna.
- Svara JA om minst EN kandidatparagraf innehåller regeln frågan gäller,
  helt eller till väsentlig del.
- Att texten bara rör samma allmänna ämnesområde räcker INTE för JA.
- Procedur-/formregler (t.ex. hur en uppsägning delges) besvarar INTE en
  fråga om RÄTTEN att säga upp — och tvärtom.
- Är du tveksam till om regeln verkligen finns i texten: svara NEJ.

Svara med EXAKT ett ord: JA eller NEJ.
```

</details>

<details><summary><code>besittningsskydd-lokal</code> — domarprompt</summary>

```text
Du är en strikt relevansdomare i ett juridiskt RAG-system för svenska hyresvärdar.

ANVÄNDARENS FRÅGA:
"""
Har min lokalhyresgäst (ett företag) besittningsskydd?
"""

HÄMTAD LAGTEXT (kandidater):
[1] Hyreslagen (jordabalken 12 kap.), 28 §:
## 28 §

Är pant eller borgen ställd till säkerhet för att ett avtal om hyra av en lokal fullgörs och försämras säkerheten, är hyresgästen skyldig att på anfordran ställa ny säkerhet med vilken hyresvärden skäligen kan nöja sig. Gör han det ej inom en månad, får hyresvärden säga upp avtalet. Lag (1984:694).

[2] Hyreslagen (jordabalken 12 kap.), 50 §:
## 50 §

Är frågan om förlängning av hyresavtalet ännu inte avgjord när hyrestiden går ut, har hyresgästen rätt att bo kvar i lägenheten till dess frågan är slutligt avgjord.

Bestämmelsen i första stycket gäller inte om hyresnämnden enligt 13 a § andra stycket lagen (1973:188) om arrendenämnder och hyresnämnder har bestämt att ett beslut om åläggande för hyresgästen att flytta enligt den paragrafens första stycke får verkställas även om det inte har vunnit laga kraft.

För den tid som hyresgästen bor kvar i lägenheten skall de förut gällande hyresvillkoren tillämpas till dess hyresvillkoren för samma tid blir slutligt bestämda. Lag (2002:29).

[3] Hyreslagen (jordabalken 12 kap.), 31 §:
## 31 §

Om hyresgästen försätts i konkurs, får konkursboet säga upp avtalet. Beträffande bostadslägenheter fordras dock att gäldenären samtycker till uppsägningen.

Har lägenheten ej tillträtts när konkursen inträffar och har ej hyresvärden sådan säkerhet för att avtalet fullgörs att han skäligen kan nöja sig, får hyresvärden säga upp avtalet om han ej erhåller sådan säkerhet inom en vecka efter anfordran.

Inträffar i fråga om en lokal konkursen efter tillträdet och har ej hyresvärden sådan säkerhet för att avtalet fullgörs att han skäligen kan nöja sig, får hyresvärden säga upp avtalet,

1. om inte sådan säkerhet ställs inom en månad efter anfordran,
2. om inte konkursboet inom samma tid förklarar sig vilja svara för hyresgästens skyldigheter under hyrestiden, eller
3. om inte, när hyresrätten får överlåtas, överlåtelse sker i enlighet med avtalet.

Sägs avtalet upp enligt första, andra eller tredje stycket, har hyresvärden rätt till ersättning för skada.

Om en hyresvärd uppmanar ett konkursbo att ställa en lokal till hyresvärdens förfogande och konkursboet inte inom en månad gör detta, ansvarar konkursboet för hyran från konkursbeslutet till dess lokalen ställs till hyresvärdens förfogande. Lag (2003:530).

UPPGIFT: Avgör om den hämtade lagtexten innehåller den MATERIELLA regel
som behövs för att besvara frågans juridiska kärna.
- Svara JA om minst EN kandidatparagraf innehåller regeln frågan gäller,
  helt eller till väsentlig del.
- Att texten bara rör samma allmänna ämnesområde räcker INTE för JA.
- Procedur-/formregler (t.ex. hur en uppsägning delges) besvarar INTE en
  fråga om RÄTTEN att säga upp — och tvärtom.
- Är du tveksam till om regeln verkligen finns i texten: svara NEJ.

Svara med EXAKT ett ord: JA eller NEJ.
```

</details>

## Kontroller

- Paritet mot produktionen (variant `PROD`): max |Δscore| = 0, max |Δcoverage| = 0, noll grindavvikelser och noll fused-avvikelser.
- `fuseDetailed` topp-3 jämförd chunk-för-chunk mot produktionens `retrieve().fused`
  för varje målfall — avvikelse avbryter körningen.
- Lagtextens content-hashar: oförändrade (427 chunkar).
- Domarprompten och `GROUNDING_TOP_K` lästes, aldrig skrevs.
