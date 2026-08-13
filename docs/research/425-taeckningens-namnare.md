# #425 — täckningens nämnare: räknas den på frågan eller på tesaurusen?

> MÄTNING, INGEN FIX. Ingen tröskel, lagtext, tesaurusgrupp eller domarprompt ändrad.
> Genererad av `apps/api/scripts/measure-425-coverage-denominator.ts` mot korpus N = 427, main efter #406 PR4.
> Grindens band: `score < 12 && coverage < 0.4` → fäll. Golvet: `score >= 9`.

## 0. Varianten rör inte en enda score

Uppmätt över samtliga 30 eval-frågor × 427 chunkar: **max |Δscore| = 0.00e+0** mellan PROD och V1.

Det är förutsättningen för att läsa resten som en grindmätning. Eftersom täckningens enda produktionskonsument är bandet i `legal-grounding.ts`, och ingen score flyttas, kan varianten varken röra den lexikala rangordningen, fusionen, cosine eller vilka chunkar domaren ser. Hela dess verkan är insläppet.

## 1. Hur många frågor rör varianten?

| fall                                | egna stammar | efter expansion | tillagda | utlösta grupper |
| ----------------------------------- | ------------ | --------------- | -------- | --------------- |
| `besittningsskydd-forstahand-1ar`   | 6            | 15              | **+9**   | #1, #15         |
| `besittningsskydd-andrahand-2ar`    | 4            | 14              | **+10**  | #2, #4          |
| `besittningsskydd-lokal`            | 3            | 7               | **+4**   | #2              |
| `besittningsskydd-eget-behov`       | 7            | 13              | **+6**   | #1              |
| `uppsagningstid-bostad-tillsvidare` | 4            | 15              | **+11**  | #1, #15         |
| `uppsagningstid-lokal`              | 5            | 16              | **+11**  | #1, #15         |
| `uppsagning-skriftlig-form`         | 4            | 12              | **+8**   | #1, #12         |
| `delgivning-uppsagning`             | 6            | 17              | **+11**  | #1, #8          |
| `kontrakt-skriftligt`               | 4            | 7               | **+3**   | #12, #15        |
| `kontrakt-tidsbestamt-forlangning`  | 6            | 8               | **+2**   | #15             |
| `hyra-forfallodag`                  | 3            | 6               | **+3**   | #14             |
| `drojsmalsranta-sen-hyra`           | 4            | 7               | **+3**   | #7              |
| `paminnelseavgift-ratten`           | 4            | 9               | **+5**   | #14, #17        |
| `paminnelseavgift-lagens-egna-ord`  | 3            | 6               | **+3**   | #12, #17        |
| `paminnelseavgift-taket`            | 2            | 4               | **+2**   | #17             |
| `paminnelseavgift-avtalskravet`     | 4            | 7               | **+3**   | #17             |
| `paminnelseavgift-vad-galler`       | 4            | 6               | **+2**   | #17             |
| `paminnelseavgift-vad-sager-lagen`  | 4            | 6               | **+2**   | #17             |
| `paminnelseavgift-hogre-i-avtal`    | 5            | 15              | **+10**  | #15, #17, #19   |
| `kravbrev-avgift`                   | 2            | 4               | **+2**   | #18             |
| `forverkande-obetald-hyra`          | 7            | 13              | **+6**   | #3              |
| `storning-uppsagning`               | 7            | 16              | **+9**   | #1, #9          |
| `andrahand-utan-samtycke`           | 8            | 12              | **+4**   | #4              |
| `hyreshojning-formkrav`             | 4            | 4               | 0        | —               |
| `hyressattning-bruksvarde`          | 4            | 4               | 0        | —               |
| `tilltrade-arbeten`                 | 3            | 6               | **+3**   | #13             |
| `hyresgastval-diskriminering`       | 7            | 7               | 0        | —               |
| `deposition-storlek`                | 5            | 6               | **+1**   | #6              |
| `altan-utan-lov-tvist`              | 11           | 17              | **+6**   | #1              |

**26 av 29** juridiska eval-frågor utlöser minst en grupp som tillför stammar. För resten är V1 och PROD identiska per konstruktion.

## 2. Täckning och lexikalt insläpp

Täckningen avser topp-chunken i den lexikala listan — det är den grinden läser. `NOEXP` står med som diagnostik: där faller både score och täckning bort, så den är inte ett alternativ till V1 utan referensen som visar vad expansionen köper.

| fall                                | topp-score | täckn. PROD | täckn. V1 | täckn. NOEXP | lex. insläpp PROD → V1 | grind PROD → V1                    |
| ----------------------------------- | ---------- | ----------- | --------- | ------------ | ---------------------- | ---------------------------------- |
| `besittningsskydd-forstahand-1ar`   | 18.7       | 0.46        | 0.40      | 0.40         | passerar               | kandidat                           |
| `besittningsskydd-andrahand-2ar`    | 17.3       | 0.42        | 0.00      | —            | passerar               | kandidat                           |
| `besittningsskydd-lokal`            | 9.5        | 0.43        | 0.00      | 0.33         | **passerar → fälls**   | **kandidat → miss:weak-retrieval** |
| `besittningsskydd-eget-behov`       | 16.0       | 0.45        | 0.33      | 0.50         | passerar               | kandidat                           |
| `uppsagningstid-bostad-tillsvidare` | 25.6       | 0.62        | 0.75      | 0.75         | passerar               | kandidat                           |
| `uppsagningstid-lokal`              | 23.9       | 0.50        | 0.40      | 0.60         | passerar               | kandidat                           |
| `uppsagning-skriftlig-form`         | 15.9       | 0.60        | 1.00      | 0.75         | passerar               | kandidat                           |
| `delgivning-uppsagning`             | 16.0       | 0.36        | 0.40      | 0.60         | passerar               | kandidat                           |
| `kontrakt-skriftligt`               | 11.6       | 0.86        | 1.00      | 0.50         | passerar               | kandidat                           |
| `kontrakt-tidsbestamt-forlangning`  | 8.0        | 0.38        | 0.33      | 0.17         | fälls                  | kandidat                           |
| `hyra-forfallodag`                  | 22.8       | 1.00        | 1.00      | 1.00         | passerar               | kandidat                           |
| `drojsmalsranta-sen-hyra`           | 15.6       | 0.50        | 0.33      | 0.67         | passerar               | kandidat                           |
| `paminnelseavgift-ratten`           | 25.9       | 0.44        | 0.25      | 0.50         | passerar               | kandidat                           |
| `paminnelseavgift-lagens-egna-ord`  | 29.8       | 0.83        | 1.00      | 1.00         | passerar               | kandidat                           |
| `paminnelseavgift-taket`            | 23.0       | 0.75        | 0.50      | 0.50         | passerar               | kandidat                           |
| `paminnelseavgift-avtalskravet`     | 30.0       | 0.71        | 0.50      | 0.50         | passerar               | kandidat                           |
| `paminnelseavgift-vad-galler`       | 23.0       | 0.60        | 0.33      | 0.33         | passerar               | kandidat                           |
| `paminnelseavgift-vad-sager-lagen`  | 23.0       | 0.50        | 0.25      | 0.25         | passerar               | kandidat                           |
| `paminnelseavgift-hogre-i-avtal`    | 43.3       | 0.53        | 0.40      | 0.40         | passerar               | kandidat                           |
| `kravbrev-avgift`                   | 24.4       | 1.00        | 1.00      | 1.00         | passerar               | kandidat                           |
| `forverkande-obetald-hyra`          | 21.3       | 0.67        | 0.50      | 0.50         | passerar               | kandidat                           |
| `storning-uppsagning`               | 28.7       | 0.43        | 0.33      | 0.33         | passerar               | kandidat                           |
| `andrahand-utan-samtycke`           | 18.8       | 0.60        | 0.50      | 0.83         | passerar               | kandidat                           |
| `hyreshojning-formkrav`             | 6.8        | 0.50        | 0.50      | 0.50         | fälls                  | kandidat                           |
| `hyressattning-bruksvarde`          | 5.8        | 0.50        | 0.50      | 0.50         | fälls                  | kandidat                           |
| `tilltrade-arbeten`                 | 15.8       | 0.83        | 1.00      | 1.00         | passerar               | kandidat                           |
| `hyresgastval-diskriminering`       | 8.7        | 0.29        | 0.29      | 0.29         | fälls                  | kandidat                           |
| `deposition-storlek`                | 9.7        | 0.33        | 0.40      | 0.40         | **fälls → passerar**   | kandidat                           |
| `altan-utan-lov-tvist`              | 20.5       | 0.50        | 0.44      | 0.33         | passerar               | kandidat                           |

## 3. Vändningarna

**2 fall ändrar lexikalt insläpp:**

| fall                     | riktning             | täckn. PROD → V1 | topp-score | negativkontroll? | facit i lex. topp-3? |
| ------------------------ | -------------------- | ---------------- | ---------- | ---------------- | -------------------- |
| `besittningsskydd-lokal` | passerar → **fälls** | 0.43 → 0.00      | 9.5        | nej              | ja                   |
| `deposition-storlek`     | fälls → **passerar** | 0.33 → 0.40      | 9.7        | **JA**           | nej                  |

Skillnaden mellan lexikalt insläpp och GRIND är inte formalia: grinden släpper in på lexikal **eller** semantisk väg. En lexikal vändning som maskeras av ett semantiskt insläpp ändrar ingenting i produktionen.

**1 fall ändrar grindutfall:**

| fall                     | grind PROD → V1                    | cosine | negativkontroll? |
| ------------------------ | ---------------------------------- | ------ | ---------------- |
| `besittningsskydd-lokal` | kandidat → **miss:weak-retrieval** | 0.436  | nej              |

## 4. Negativkontrollerna

De står här oavsett om de rörde sig. En variant som släpper in en negativkontroll är inte en förbättring även om den räddar ett riktigt fall.

| negativkontroll               | täckn. PROD → V1 | lex. insläpp PROD → V1 | grind PROD → V1     |
| ----------------------------- | ---------------- | ---------------------- | ------------------- |
| `deposition-storlek`          | 0.33 → 0.40      | fälls → passerar       | kandidat → kandidat |
| `hyresgastval-diskriminering` | 0.29 → 0.29      | fälls → fälls          | kandidat → kandidat |

## 5. Reproducerar mätningen #425:s tabell?

Ärendet uppger två rader. Kolumnrubriken där lyder "täckning med → utan expansion" medan brödtexten säger "utan expansion ligger båda på exakt 0,40" — de två läsningarna är oförenliga, och tabellen nedan avgör vilken som gäller.

| fall                             | täckn. MED expansion (PROD) | täckn. UTAN expansion i nämnaren (V1) | #425 uppger |
| -------------------------------- | --------------------------- | ------------------------------------- | ----------- |
| `paminnelseavgift-hogre-i-avtal` | 0.53                        | 0.40                                  | 0,40 → 0,29 |
| `deposition-storlek`             | 0.33                        | 0.40                                  | 0,40 → 0,33 |

## 6. Varför V1 nollar täckningen på vissa fall

2 fall får täckning **exakt 0,00** under V1 — inte lågt, utan noll: ingen enda av frågans egna stammar finns i topp-chunken. Det är svenskans sammansättningar. Hyresvärden skriver ett sammansatt ord, lagen skriver leden isär, och stamningen förenar dem inte.

| fall                             | frågans egna stammar (≥ 4 tecken)               | i topp-chunken? | topp-chunk               |
| -------------------------------- | ----------------------------------------------- | --------------- | ------------------------ |
| `besittningsskydd-andrahand-2ar` | `andrahandshyresgäst`, `besittningsskydd`       | **ingen**       | `bostadsrattslagen:7:11` |
| `besittningsskydd-lokal`         | `lokalhyresgäst`, `företag`, `besittningsskydd` | **ingen**       | `hyreslagen:50`          |

Det är exakt det vokabulärgap #406 handlar om. Tesaurusen finns för att brygga det — och i V1 räknas bryggan bort ur BÅDE täljaren och nämnaren, så måttet blir noll precis där gapet är som störst.

## 7. Svaret

**Variant 1 är motbevisad som fix.** Den räddar inget fall och kostar 1: `besittningsskydd-lokal` tappar lexikalt insläpp och byter grindutfall, trots att facit ligger i den lexikala topp-3:an. Samtidigt släpper den igenom 1 fall lexikalt: `deposition-storlek` — en **negativkontroll**.

Mekanismen ärendet beskriver är verklig: nämnaren styrs i dag av tesaurusen, och 26 av 29 frågor expanderas. Men slutsatsen att nämnaren därför bör vara frågans egna stammar följer inte. Täljaren kommer från samma expansion. Att ta bort expansionen ur kvoten mäter inte "hur väl chunken täcker frågan" utan "hur mycket av användarens ordagranna formulering som råkar stå i lagtexten" — och det är precis det måttet svenska sammansättningar bryter.

Det oavsiktliga skyddet ärendet pekar ut är däremot **bekräftat**: `deposition-storlek` hålls ute lexikalt i dag (täckning 0.33) och släpps in under V1 (0.40, mot ett `<`-villkor vid 0.4). Ingen test bevakar det, och det är en utspädning som råkar peka rätt — inte en design. Att grindutfallet ändå inte rör sig beror på att fallet passerar semantiskt; det är domaren, inte grinden, som håller det ute (invariant 3).

**Vad mätningen inte säger:** ingenting om förslag 2 (bara stammar som finns i korpusen i nämnaren), 3 (rätta stamningen) eller 4 (delsträngsutlösningen). Förslag 3 pekar dessutom rakt mot fyndet i avsnitt 6 — sammansättningsledsdelning hade gjort täckningen meningsfull på exakt de fall där V1 nollar den — men är korpus-global och tvingar fram en omkalibrering av golvet enligt `406-grind-kartlaggning.md`.

## 8. Lagtexten är orörd

Content-hasharna för samtliga 427 chunkar är identiska före och efter mätningen.
