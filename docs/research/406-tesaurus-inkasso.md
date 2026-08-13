# #406 — löser en saknad tesaurusgrupp de fem kvarvarande fallen?

> MÄTNING, INGEN FIX. Ingen produktionsregel, tröskel eller lagtext ändrad.
> Genererad av `apps/api/scripts/measure-406-tesaurus.ts` mot korpus N = 427.
> Spegeln som mäts i är densamma som i `406-grind-kartlaggning.md`
> (`scripts/lib/legal-retrieval-mirror.ts`) och verifieras numeriskt mot
> produktionen före varje mätning.

## Hypotesen

`CONCEPT_GROUPS` har 16 grupper och ingen för påminnelse/krav/inkassokostnad.
BM25-score är en summa över frågans sökstammar, så oexpanderade frågor skulle
systematiskt få lägre summa — och de fem kvarvarande fallen är alla inkassofrågor.

En tesaurusgrupp är en FRÅGESIDIG ändring: indexet (`docFreq`, `avgLength`, `N`)
rörs inte, bara de frågor som utlöser gruppen. Därav riskbildens asymmetri —
score kan bara stiga (BM25 summerar icke-negativa termbidrag), medan TÄCKNINGEN
kan falla, eftersom nämnaren är antalet sökstammar efter expansion.

## 1. Baslinje: bär antalet sökstammar poängen?

30 eval-fall (26 `answerable`, 3 `needs-jurist`, 1 `no-clear-rule`). 29 passerar ingångsgrinden `isLegalQuestion` och har alltså en BM25-mätning alls.

`stammar` = sökstammar efter expansion; `scorade` = de som är ≥ 4 tecken och därmed
kan bidra till poängen (nämnaren i täckningen). `via grupp` = hur många av de scorade
stammar som tillkom genom tesaurus-expansion, mätt som differensen mot `NOEXP`.

| fall                                   | scorade stammar | varav via grupp | utlösta grupper | topp-BM25 | täckning | topp-paragraf |
| -------------------------------------- | --------------- | --------------- | --------------- | --------- | -------- | ------------- |
| `besittningsskydd-forstahand-1ar`      | 13              | 8               | #0 #14          | 18.67     | 0.46     | hyresl:58 a   |
| `besittningsskydd-andrahand-2ar`       | 12              | 10              | #1 #3           | 17.29     | 0.42     | bostad:7:11   |
| `besittningsskydd-lokal`               | 7               | 4               | #1              | 9.51      | 0.43     | hyresl:50     |
| `besittningsskydd-eget-behov`          | 11              | 5               | #0              | 15.96     | 0.45     | hyresl:58 a   |
| `uppsagningstid-bostad-tillsvidare`    | 13              | 9               | #0 #14          | 25.61     | 0.62     | hyresl:6      |
| `uppsagningstid-lokal`                 | 14              | 9               | #0 #14          | 23.90     | 0.50     | hyresl:6      |
| `uppsagning-skriftlig-form`            | 10              | 6               | #0 #11          | 15.95     | 0.60     | hyresl:8      |
| `delgivning-uppsagning`                | 14              | 9               | #0 #7           | 15.96     | 0.36     | hyresl:58 a   |
| `kontrakt-skriftligt`                  | 7               | 3               | #11 #14         | 11.56     | 0.86     | hyresl:8      |
| `kontrakt-tidsbestamt-forlangning`     | 8               | 2               | #14             | 8.01      | 0.38     | hyresl:47     |
| `hyra-forfallodag`                     | 6               | 3               | #13             | 22.79     | 1.00     | hyresl:20     |
| `drojsmalsranta-sen-hyra`              | 6               | 3               | #6              | 15.58     | 0.50     | rantes:9      |
| **`paminnelseavgift-ratten`**          | 7               | 3               | #13             | 18.69     | 0.71     | hyresl:20     |
| **`paminnelseavgift-lagens-egna-ord`** | 4               | 1               | #11             | 15.67     | 0.75     | inkass:2      |
| **`paminnelseavgift-taket`**           | 2               | 0               | —               | 6.73      | 0.50     | inkass:2      |
| **`paminnelseavgift-avtalskravet`**    | 4               | 0               | —               | 7.03      | 0.50     | inkass:2      |
| **`paminnelseavgift-vad-galler`**      | 3               | 0               | —               | 6.73      | 0.33     | inkass:2      |
| **`paminnelseavgift-vad-sager-lagen`** | 4               | 0               | —               | 6.73      | 0.25     | inkass:2      |
| **`paminnelseavgift-hogre-i-avtal`**   | 7               | 2               | #14             | 9.13      | 0.29     | inkass:2      |
| **`kravbrev-avgift`**                  | 2               | 0               | —               | 12.02     | 1.00     | inkass:3      |
| `forverkande-obetald-hyra`             | 12              | 6               | #2              | 21.34     | 0.67     | hyresl:44     |
| `storning-uppsagning`                  | 14              | 8               | #0 #8           | 28.67     | 0.43     | hyresl:25 a   |
| `andrahand-utan-samtycke`              | 10              | 4               | #3              | 18.83     | 0.60     | bostad:7:11   |
| `hyreshojning-formkrav`                | 4               | 0               | —               | 6.82      | 0.50     | hyresl:44     |
| `hyressattning-bruksvarde`             | 4               | 0               | —               | 5.82      | 0.50     | hyresl:39     |
| `tilltrade-arbeten`                    | 6               | 3               | #12             | 15.77     | 0.83     | hyresl:26     |
| `hyresgastval-diskriminering`          | 7               | 0               | —               | 8.66      | 0.29     | diskri:2:13 b |
| `deposition-storlek`                   | 6               | 1               | #5              | 9.70      | 0.33     | hyresl:28     |
| `altan-utan-lov-tvist`                 | 14              | 5               | #0              | 20.46     | 0.50     | hyresl:58 a   |

**Korrelation antal scorade stammar → topp-BM25:** Pearson r = 0.75 (R² = 0.57), Spearman ρ = 0.76 över 29 fall. Utan de åtta inkassofallen: r = 0.74.

### Motexemplen inifrån målgruppen

En korrelation över blandade frågor kan drivas av att långa frågor råkar handla om
välrepresenterade ämnen. Det som avgör hypotesens mekanism är i stället par med
SAMMA stamantal och olika utfall — och de finns i själva inkassofamiljen:

| fall                               | scorade stammar | topp-BM25 | grind i dag         |
| ---------------------------------- | --------------- | --------- | ------------------- |
| `kravbrev-avgift`                  | 2               | 12.02     | kandidat            |
| `paminnelseavgift-taket`           | 2               | 6.73      | miss:weak-retrieval |
| `paminnelseavgift-lagens-egna-ord` | 4               | 15.67     | kandidat            |
| `paminnelseavgift-avtalskravet`    | 4               | 7.03      | miss:weak-retrieval |
| `paminnelseavgift-vad-sager-lagen` | 4               | 6.73      | miss:weak-retrieval |
| `hyreshojning-formkrav`            | 4               | 6.82      | kandidat            |
| `hyressattning-bruksvarde`         | 4               | 5.82      | kandidat            |
| `besittningsskydd-lokal`           | 7               | 9.51      | kandidat            |

### Vad är expansionen värd där den FINNS? (diagnostik `NOEXP`)

Hypotesens mekanism prövas bäst genom att stänga av tesaurusen helt och mäta vad
som faller. Tabellen visar bara de fall som utlöser minst en grupp i dag.

| fall                                | topp med grupper | topp utan | Δ     | täckning med → utan | grind faller? |
| ----------------------------------- | ---------------- | --------- | ----- | ------------------- | ------------- |
| `besittningsskydd-forstahand-1ar`   | 18.67            | 6.71      | 11.97 | 0.46 → 0.40         | **JA**        |
| `besittningsskydd-andrahand-2ar`    | 17.29            | —         | 17.29 | 0.42 → —            | **JA**        |
| `besittningsskydd-lokal`            | 9.51             | 5.93      | 3.58  | 0.43 → 0.33         | **JA**        |
| `besittningsskydd-eget-behov`       | 15.96            | 10.38     | 5.58  | 0.45 → 0.50         | nej           |
| `uppsagningstid-bostad-tillsvidare` | 25.61            | 9.75      | 15.86 | 0.62 → 0.75         | nej           |
| `uppsagningstid-lokal`              | 23.90            | 11.09     | 12.80 | 0.50 → 0.60         | nej           |
| `uppsagning-skriftlig-form`         | 15.95            | 12.07     | 3.88  | 0.60 → 0.75         | nej           |
| `delgivning-uppsagning`             | 15.96            | 10.01     | 5.95  | 0.36 → 0.60         | nej           |
| `kontrakt-skriftligt`               | 11.56            | 7.00      | 4.56  | 0.86 → 0.50         | **JA**        |
| `kontrakt-tidsbestamt-forlangning`  | 8.01             | 5.49      | 2.52  | 0.38 → 0.17         | nej           |
| `hyra-forfallodag`                  | 22.79            | 13.79     | 9.01  | 1.00 → 1.00         | nej           |
| `drojsmalsranta-sen-hyra`           | 15.58            | 6.33      | 9.25  | 0.50 → 0.67         | **JA**        |
| `paminnelseavgift-ratten`           | 18.69            | 10.94     | 7.75  | 0.71 → 0.50         | nej           |
| `paminnelseavgift-lagens-egna-ord`  | 15.67            | 15.67     | 0.00  | 0.75 → 1.00         | nej           |
| `paminnelseavgift-hogre-i-avtal`    | 9.13             | 9.13      | 0.00  | 0.29 → 0.40         | nej           |
| `forverkande-obetald-hyra`          | 21.34            | 8.57      | 12.76 | 0.67 → 0.50         | **JA**        |
| `storning-uppsagning`               | 28.67            | 8.73      | 19.94 | 0.43 → 0.33         | **JA**        |
| `andrahand-utan-samtycke`           | 18.83            | 11.25     | 7.58  | 0.60 → 0.83         | nej           |
| `tilltrade-arbeten`                 | 15.77            | 11.11     | 4.66  | 0.83 → 1.00         | nej           |
| `deposition-storlek`                | 9.70             | 9.70      | 0.00  | 0.33 → 0.40         | nej           |
| `altan-utan-lov-tvist`              | 20.46            | 9.94      | 10.53 | 0.50 → 0.33         | **JA**        |

Tesaurusen är alltså avgörande för **8** av de 21 fall som utlöser en grupp i dag — resten passerar (eller fälls) oavsett.

## 2. Kandidatgruppernas termanatomi

Varje term motiveras av tre mätta storheter: vilka STAMMAR den bidrar med, hur
många chunkar som innehåller stammen (`df` — låg df = hög IDF = stort poängbidrag),
och vilka av inkassokostnadslagens paragrafer den träffar. En term vars stam har
`df = 0` tillför INGEN poäng men växer täckningens nämnare — den gör alltså bara
skada. En term vars stam träffar FEL paragraf drar den paragrafen uppåt i varje
fråga som utlöser gruppen.

### Grupp `inkasso (blandad)` — 8 termer

| term                       | stammar (df)                   | IDF         | träffar i inkassokostnadslagen | utlöses av eval-fall                                                                                          |
| -------------------------- | ------------------------------ | ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `påminnelseavgift`         | `påminnelseavgift` (2)         | 5.14        | 2 §, 4 §                       | på-ratten, på-taket, på-vad-galler, på-vad-sager-lagen, på-hogre-i-avtal                                      |
| `påminnelse`               | `påminn` (1)                   | 5.65        | 2 §                            | på-ratten, på-lagens-egna-ord, på-taket, på-avtalskravet, på-vad-galler, på-vad-sager-lagen, på-hogre-i-avtal |
| `betalningspåminnelse`     | `betalningspåminn` (2)         | 5.14        | 2 §, 4 §                       | på-lagens-egna-ord                                                                                            |
| `kravavgift`               | `kravavgift` (1)               | 5.65        | 3 §                            | —                                                                                                             |
| `krav`                     | `krav` (14)                    | 3.38        | 3 §, 4 §                       | kravbrev-avgift                                                                                               |
| `inkassokostnad`           | `inkassokostnad` (1)           | 5.65        | 1 §                            | —                                                                                                             |
| `ersättning för kostnader` | `ersätt` (70) + `kostnad` (21) | 1.80 / 2.99 | 1 §, 2 §, 3 §, 4 §, 5 §, 6 §   | —                                                                                                             |
| `förfallen skuld`          | `förfall` (12) + `skuld` (11)  | 3.53 / 3.62 | 1 §, 2 §, 3 §, 5 §             | —                                                                                                             |

### Grupp `påminnelse` — 3 termer

| term                   | stammar (df)           | IDF  | träffar i inkassokostnadslagen | utlöses av eval-fall                                                                                          |
| ---------------------- | ---------------------- | ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `påminnelseavgift`     | `påminnelseavgift` (2) | 5.14 | 2 §, 4 §                       | på-ratten, på-taket, på-vad-galler, på-vad-sager-lagen, på-hogre-i-avtal                                      |
| `påminnelse`           | `påminn` (1)           | 5.65 | 2 §                            | på-ratten, på-lagens-egna-ord, på-taket, på-avtalskravet, på-vad-galler, på-vad-sager-lagen, på-hogre-i-avtal |
| `betalningspåminnelse` | `betalningspåminn` (2) | 5.14 | 2 §, 4 §                       | på-lagens-egna-ord                                                                                            |

### Grupp `krav` — 3 termer

| term          | stammar (df)      | IDF  | träffar i inkassokostnadslagen | utlöses av eval-fall |
| ------------- | ----------------- | ---- | ------------------------------ | -------------------- |
| `kravavgift`  | `kravavgift` (1)  | 5.65 | 3 §                            | —                    |
| `kravbrev`    | `kravbrev` (1)    | 5.65 | 3 §                            | kravbrev-avgift      |
| `inkassokrav` | `inkassokrav` (1) | 5.65 | 3 §                            | —                    |

### Grupp `ogiltighet (frasform)` — 5 termer

| term                     | stammar (df)                       | IDF         | träffar i inkassokostnadslagen | utlöses av eval-fall |
| ------------------------ | ---------------------------------- | ----------- | ------------------------------ | -------------------- |
| `avtala om högre`        | `avtal` (68) + `högre` (11)        | 1.83 / 3.62 | 2 §, 6 §                       | —                    |
| `högre än lagens`        | `högre` (11) + `lagens` (2)        | 3.62 / 5.14 | 1 §, 6 §                       | —                    |
| `ogiltigt avtalsvillkor` | `ogiltigt` (6) + `avtalsvillk` (7) | 4.19 / 4.04 | 6 §                            | —                    |
| `utvidgas utöver`        | `utvidgas` (1) + `utöv` (16)       | 5.65 / 3.26 | 6 §                            | —                    |
| `tvingande`              | `tving` (1)                        | 5.65        | 6 §                            | —                    |

### Grupp `ogiltighet (utlösande)` — 4 termer

| term                     | stammar (df)                       | IDF         | träffar i inkassokostnadslagen | utlöses av eval-fall |
| ------------------------ | ---------------------------------- | ----------- | ------------------------------ | -------------------- |
| `avtala om`              | `avtal` (68)                       | 1.83        | 2 §, 6 §                       | på-hogre-i-avtal     |
| `ogiltigt avtalsvillkor` | `ogiltigt` (6) + `avtalsvillk` (7) | 4.19 / 4.04 | 6 §                            | —                    |
| `utvidgas utöver`        | `utvidgas` (1) + `utöv` (16)       | 5.65 / 3.26 | 6 §                            | —                    |
| `tvingande regel`        | `tving` (1) + `regel` (1)          | 5.65 / 5.65 | 6 §                            | —                    |

## 3. Score och täckning före/efter, samtliga fall

Format: `score/täckning (Δscore)`. `ej-jur` = fälls av ingångsgrinden och når
aldrig retrieval.

| fall                                   | facit                         | PROD       | NOEXP              | T1                 | T2                 | T3                 | T4                 | T5                 |
| -------------------------------------- | ----------------------------- | ---------- | ------------------ | ------------------ | ------------------ | ------------------ | ------------------ | ------------------ |
| `besittningsskydd-forstahand-1ar`      | hyresl:45 hyresl:46           | 18.67/0.46 | 6.71/0.40 (-12.0)  | 18.67/0.46 (0)     | 18.67/0.46 (0)     | 18.67/0.46 (0)     | 18.67/0.46 (0)     | 18.67/0.46 (0)     |
| `besittningsskydd-andrahand-2ar`       | hyresl:45                     | 17.29/0.42 | —/— (-17.3)        | 17.29/0.42 (0)     | 17.29/0.42 (0)     | 17.29/0.42 (0)     | 17.29/0.42 (0)     | 17.29/0.42 (0)     |
| `besittningsskydd-lokal`               | hyresl:57                     | 9.51/0.43  | 5.93/0.33 (-3.6)   | 9.51/0.43 (0)      | 9.51/0.43 (0)      | 9.51/0.43 (0)      | 9.51/0.43 (0)      | 9.51/0.43 (0)      |
| `besittningsskydd-eget-behov`          | hyresl:46                     | 15.96/0.45 | 10.38/0.50 (-5.6)  | 15.96/0.45 (0)     | 15.96/0.45 (0)     | 15.96/0.45 (0)     | 15.96/0.45 (0)     | 15.96/0.45 (0)     |
| `uppsagningstid-bostad-tillsvidare`    | hyresl:4                      | 25.61/0.62 | 9.75/0.75 (-15.9)  | 25.61/0.62 (0)     | 25.61/0.62 (0)     | 25.61/0.62 (0)     | 25.61/0.62 (0)     | 25.61/0.62 (0)     |
| `uppsagningstid-lokal`                 | hyresl:4                      | 23.90/0.50 | 11.09/0.60 (-12.8) | 23.90/0.50 (0)     | 23.90/0.50 (0)     | 23.90/0.50 (0)     | 23.90/0.50 (0)     | 23.90/0.50 (0)     |
| `uppsagning-skriftlig-form`            | hyresl:8                      | 15.95/0.60 | 12.07/0.75 (-3.9)  | 15.95/0.60 (0)     | 15.95/0.60 (0)     | 15.95/0.60 (0)     | 15.95/0.60 (0)     | 15.95/0.60 (0)     |
| `delgivning-uppsagning`                | hyresl:8 hyresl:63            | 15.96/0.36 | 10.01/0.60 (-6.0)  | 15.96/0.36 (0)     | 15.96/0.36 (0)     | 15.96/0.36 (0)     | 15.96/0.36 (0)     | 15.96/0.36 (0)     |
| `kontrakt-skriftligt`                  | hyresl:2                      | 11.56/0.86 | 7.00/0.50 (-4.6)   | 11.56/0.86 (0)     | 11.56/0.86 (0)     | 11.56/0.86 (0)     | 11.56/0.86 (0)     | 11.56/0.86 (0)     |
| `kontrakt-tidsbestamt-forlangning`     | hyresl:3                      | 8.01/0.38  | 5.49/0.17 (-2.5)   | 8.01/0.38 (0)      | 8.01/0.38 (0)      | 8.01/0.38 (0)      | 8.01/0.38 (0)      | 8.01/0.38 (0)      |
| `hyra-forfallodag`                     | hyresl:20                     | 22.79/1.00 | 13.79/1.00 (-9.0)  | 22.79/1.00 (0)     | 22.79/1.00 (0)     | 22.79/1.00 (0)     | 22.79/1.00 (0)     | 22.79/1.00 (0)     |
| `drojsmalsranta-sen-hyra`              | rantes:4 rantes:6             | 15.58/0.50 | 6.33/0.67 (-9.2)   | 15.58/0.50 (0)     | 15.58/0.50 (0)     | 15.58/0.50 (0)     | 15.58/0.50 (0)     | 15.58/0.50 (0)     |
| `paminnelseavgift-ratten`              | inkass:2                      | 18.69/0.71 | 10.94/0.50 (-7.8)  | 33.75/0.38 (+15.1) | 25.92/0.44 (+7.2)  | 25.92/0.44 (+7.2)  | 25.92/0.44 (+7.2)  | 25.92/0.44 (+7.2)  |
| `paminnelseavgift-lagens-egna-ord`     | inkass:2                      | 15.67/0.75 | 15.67/1.00 (0)     | 34.53/0.50 (+18.9) | 29.80/0.83 (+14.1) | 29.80/0.83 (+14.1) | 29.80/0.83 (+14.1) | 29.80/0.83 (+14.1) |
| **`paminnelseavgift-taket`**           | inkass:4                      | 6.73/0.50  | 6.73/0.50 (0)      | 30.79/0.45 (+24.1) | 22.96/0.75 (+16.2) | 22.96/0.75 (+16.2) | 22.96/0.75 (+16.2) | 22.96/0.75 (+16.2) |
| **`paminnelseavgift-avtalskravet`**    | inkass:2                      | 7.03/0.50  | 7.03/0.50 (0)      | 37.82/0.50 (+30.8) | 29.99/0.71 (+23.0) | 29.99/0.71 (+23.0) | 29.99/0.71 (+23.0) | 29.99/0.71 (+23.0) |
| **`paminnelseavgift-vad-galler`**      | inkass:2                      | 6.73/0.33  | 6.73/0.33 (0)      | 30.79/0.42 (+24.1) | 22.96/0.60 (+16.2) | 22.96/0.60 (+16.2) | 22.96/0.60 (+16.2) | 22.96/0.60 (+16.2) |
| **`paminnelseavgift-vad-sager-lagen`** | inkass:2                      | 6.73/0.25  | 6.73/0.25 (0)      | 30.79/0.38 (+24.1) | 22.96/0.50 (+16.2) | 22.96/0.50 (+16.2) | 22.96/0.50 (+16.2) | 22.96/0.50 (+16.2) |
| **`paminnelseavgift-hogre-i-avtal`**   | inkass:6                      | 9.13/0.29  | 9.13/0.40 (0)      | 33.18/0.38 (+24.1) | 25.35/0.44 (+16.2) | 25.35/0.44 (+16.2) | 25.35/0.44 (+16.2) | 43.33/0.53 (+34.2) |
| `kravbrev-avgift`                      | inkass:3                      | 12.02/1.00 | 12.02/1.00 (0)     | 36.09/0.50 (+24.1) | 12.02/1.00 (0)     | 24.45/1.00 (+12.4) | 24.45/1.00 (+12.4) | 24.45/1.00 (+12.4) |
| `forverkande-obetald-hyra`             | hyresl:42 hyresl:43 hyresl:44 | 21.34/0.67 | 8.57/0.50 (-12.8)  | 21.34/0.67 (0)     | 21.34/0.67 (0)     | 21.34/0.67 (0)     | 21.34/0.67 (0)     | 21.34/0.67 (0)     |
| `storning-uppsagning`                  | hyresl:25 hyresl:25 a         | 28.67/0.43 | 8.73/0.33 (-19.9)  | 28.67/0.43 (0)     | 28.67/0.43 (0)     | 28.67/0.43 (0)     | 28.67/0.43 (0)     | 28.67/0.43 (0)     |
| `andrahand-utan-samtycke`              | hyresl:39 hyresl:40           | 18.83/0.60 | 11.25/0.83 (-7.6)  | 18.83/0.60 (0)     | 18.83/0.60 (0)     | 18.83/0.60 (0)     | 18.83/0.60 (0)     | 18.83/0.60 (0)     |
| `hyreshojning-formkrav`                | hyresl:54 hyresl:54 a         | 6.82/0.50  | 6.82/0.50 (0)      | 6.82/0.50 (0)      | 6.82/0.50 (0)      | 6.82/0.50 (0)      | 6.82/0.50 (0)      | 6.82/0.50 (0)      |
| `hyressattning-bruksvarde`             | hyresl:55                     | 5.82/0.50  | 5.82/0.50 (0)      | 5.82/0.50 (0)      | 5.82/0.50 (0)      | 5.82/0.50 (0)      | 5.82/0.50 (0)      | 5.82/0.50 (0)      |
| `tilltrade-arbeten`                    | hyresl:26                     | 15.77/0.83 | 11.11/1.00 (-4.7)  | 15.77/0.83 (0)     | 15.77/0.83 (0)     | 15.77/0.83 (0)     | 15.77/0.83 (0)     | 15.77/0.83 (0)     |
| `hyresgastval-diskriminering`          | diskri:12                     | 8.66/0.29  | 8.66/0.29 (0)      | 8.66/0.29 (0)      | 8.66/0.29 (0)      | 8.66/0.29 (0)      | 8.66/0.29 (0)      | 8.66/0.29 (0)      |
| `deposition-storlek`                   | —                             | 9.70/0.33  | 9.70/0.40 (0)      | 9.70/0.33 (0)      | 9.70/0.33 (0)      | 9.70/0.33 (0)      | 9.70/0.33 (0)      | 9.70/0.33 (0)      |
| `altan-utan-lov-tvist`                 | hyresl:24 hyresl:42           | 20.46/0.50 | 9.94/0.33 (-10.5)  | 20.46/0.50 (0)     | 20.46/0.50 (0)     | 20.46/0.50 (0)     | 20.46/0.50 (0)     | 20.46/0.50 (0)     |
| `agandeform-skatt-paketering`          | —                             | ej-jur     | ej-jur             | ej-jur             | ej-jur             | ej-jur             | ej-jur             | ej-jur             |

## 4. De fem kvarvarande — över golvet 9 utan att golvet rörs?

Grinden hålls FAST vid produktionens värden: golv 9, band 12 / täckning 0.4. En rad är grön bara om score ≥ golvet OCH bandet inte fäller den.

### `PROD`

| fall                               | facit | score | täckning | ≥ golv 9? | fälls av bandet? | lexikalt insläpp |
| ---------------------------------- | ----- | ----- | -------- | --------- | ---------------- | ---------------- |
| `paminnelseavgift-taket`           | 4 §   | 6.73  | 0.50     | **NEJ**   | nej              | NEJ              |
| `paminnelseavgift-avtalskravet`    | 2 §   | 7.03  | 0.50     | **NEJ**   | nej              | NEJ              |
| `paminnelseavgift-vad-galler`      | 2 §   | 6.73  | 0.33     | **NEJ**   | **JA**           | NEJ              |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | 6.73  | 0.25     | **NEJ**   | **JA**           | NEJ              |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | 9.13  | 0.29     | JA        | **JA**           | NEJ              |

### `T1`

| fall                               | facit | score | täckning | ≥ golv 9? | fälls av bandet? | lexikalt insläpp |
| ---------------------------------- | ----- | ----- | -------- | --------- | ---------------- | ---------------- |
| `paminnelseavgift-taket`           | 4 §   | 30.79 | 0.45     | JA        | nej              | **JA**           |
| `paminnelseavgift-avtalskravet`    | 2 §   | 37.82 | 0.50     | JA        | nej              | **JA**           |
| `paminnelseavgift-vad-galler`      | 2 §   | 30.79 | 0.42     | JA        | nej              | **JA**           |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | 30.79 | 0.38     | JA        | nej              | **JA**           |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | 33.18 | 0.38     | JA        | nej              | **JA**           |

### `T2`

| fall                               | facit | score | täckning | ≥ golv 9? | fälls av bandet? | lexikalt insläpp |
| ---------------------------------- | ----- | ----- | -------- | --------- | ---------------- | ---------------- |
| `paminnelseavgift-taket`           | 4 §   | 22.96 | 0.75     | JA        | nej              | **JA**           |
| `paminnelseavgift-avtalskravet`    | 2 §   | 29.99 | 0.71     | JA        | nej              | **JA**           |
| `paminnelseavgift-vad-galler`      | 2 §   | 22.96 | 0.60     | JA        | nej              | **JA**           |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | 22.96 | 0.50     | JA        | nej              | **JA**           |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | 25.35 | 0.44     | JA        | nej              | **JA**           |

### `T3`

| fall                               | facit | score | täckning | ≥ golv 9? | fälls av bandet? | lexikalt insläpp |
| ---------------------------------- | ----- | ----- | -------- | --------- | ---------------- | ---------------- |
| `paminnelseavgift-taket`           | 4 §   | 22.96 | 0.75     | JA        | nej              | **JA**           |
| `paminnelseavgift-avtalskravet`    | 2 §   | 29.99 | 0.71     | JA        | nej              | **JA**           |
| `paminnelseavgift-vad-galler`      | 2 §   | 22.96 | 0.60     | JA        | nej              | **JA**           |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | 22.96 | 0.50     | JA        | nej              | **JA**           |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | 25.35 | 0.44     | JA        | nej              | **JA**           |

### `T4`

| fall                               | facit | score | täckning | ≥ golv 9? | fälls av bandet? | lexikalt insläpp |
| ---------------------------------- | ----- | ----- | -------- | --------- | ---------------- | ---------------- |
| `paminnelseavgift-taket`           | 4 §   | 22.96 | 0.75     | JA        | nej              | **JA**           |
| `paminnelseavgift-avtalskravet`    | 2 §   | 29.99 | 0.71     | JA        | nej              | **JA**           |
| `paminnelseavgift-vad-galler`      | 2 §   | 22.96 | 0.60     | JA        | nej              | **JA**           |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | 22.96 | 0.50     | JA        | nej              | **JA**           |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | 25.35 | 0.44     | JA        | nej              | **JA**           |

### `T5`

| fall                               | facit | score | täckning | ≥ golv 9? | fälls av bandet? | lexikalt insläpp |
| ---------------------------------- | ----- | ----- | -------- | --------- | ---------------- | ---------------- |
| `paminnelseavgift-taket`           | 4 §   | 22.96 | 0.75     | JA        | nej              | **JA**           |
| `paminnelseavgift-avtalskravet`    | 2 §   | 29.99 | 0.71     | JA        | nej              | **JA**           |
| `paminnelseavgift-vad-galler`      | 2 §   | 22.96 | 0.60     | JA        | nej              | **JA**           |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | 22.96 | 0.50     | JA        | nej              | **JA**           |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | 43.33 | 0.53     | JA        | nej              | **JA**           |

## 5. Täckningsrisken: faller något fall som passerar i dag?

Nämnaren växer med expansionen, så ett fall med score i bandet (< 12) och täckning
nätt och jämnt över 0,4 kan börja fällas. Tabellen listar varje fall som passerar
lexikalt i dag, med dess marginal.

| fall (passerar i dag)               | score | täckning | T1 täckning | T2 täckning | T3 täckning | T4 täckning | T5 täckning | tappas? |
| ----------------------------------- | ----- | -------- | ----------- | ----------- | ----------- | ----------- | ----------- | ------- |
| `besittningsskydd-forstahand-1ar`   | 18.67 | 0.46     | 0.46        | 0.46        | 0.46        | 0.46        | 0.46        | nej     |
| `besittningsskydd-andrahand-2ar`    | 17.29 | 0.42     | 0.42        | 0.42        | 0.42        | 0.42        | 0.42        | nej     |
| `besittningsskydd-lokal`            | 9.51  | 0.43     | 0.43        | 0.43        | 0.43        | 0.43        | 0.43        | nej     |
| `besittningsskydd-eget-behov`       | 15.96 | 0.45     | 0.45        | 0.45        | 0.45        | 0.45        | 0.45        | nej     |
| `uppsagningstid-bostad-tillsvidare` | 25.61 | 0.62     | 0.62        | 0.62        | 0.62        | 0.62        | 0.62        | nej     |
| `uppsagningstid-lokal`              | 23.90 | 0.50     | 0.50        | 0.50        | 0.50        | 0.50        | 0.50        | nej     |
| `uppsagning-skriftlig-form`         | 15.95 | 0.60     | 0.60        | 0.60        | 0.60        | 0.60        | 0.60        | nej     |
| `delgivning-uppsagning`             | 15.96 | 0.36     | 0.36        | 0.36        | 0.36        | 0.36        | 0.36        | nej     |
| `kontrakt-skriftligt`               | 11.56 | 0.86     | 0.86        | 0.86        | 0.86        | 0.86        | 0.86        | nej     |
| `hyra-forfallodag`                  | 22.79 | 1.00     | 1.00        | 1.00        | 1.00        | 1.00        | 1.00        | nej     |
| `drojsmalsranta-sen-hyra`           | 15.58 | 0.50     | 0.50        | 0.50        | 0.50        | 0.50        | 0.50        | nej     |
| `paminnelseavgift-ratten`           | 18.69 | 0.71     | 0.38 ←      | 0.44 ←      | 0.44 ←      | 0.44 ←      | 0.44 ←      | nej     |
| `paminnelseavgift-lagens-egna-ord`  | 15.67 | 0.75     | 0.50 ←      | 0.83 ←      | 0.83 ←      | 0.83 ←      | 0.83 ←      | nej     |
| `kravbrev-avgift`                   | 12.02 | 1.00     | 0.50 ←      | 1.00        | 1.00        | 1.00        | 1.00        | nej     |
| `forverkande-obetald-hyra`          | 21.34 | 0.67     | 0.67        | 0.67        | 0.67        | 0.67        | 0.67        | nej     |
| `storning-uppsagning`               | 28.67 | 0.43     | 0.43        | 0.43        | 0.43        | 0.43        | 0.43        | nej     |
| `andrahand-utan-samtycke`           | 18.83 | 0.60     | 0.60        | 0.60        | 0.60        | 0.60        | 0.60        | nej     |
| `tilltrade-arbeten`                 | 15.77 | 0.83     | 0.83        | 0.83        | 0.83        | 0.83        | 0.83        | nej     |
| `altan-utan-lov-tvist`              | 20.46 | 0.50     | 0.50        | 0.50        | 0.50        | 0.50        | 0.50        | nej     |

**Inget fall som passerar i dag tappas av någon kandidat.**

Täckningen faller likväl: 3 av de 19 fall som passerar i dag utlöser en ny grupp och tappar täckning (lägst uppmätt: 0.38) — `paminnelseavgift-ratten`, `paminnelseavgift-lagens-egna-ord`, `kravbrev-avgift`. Att det ändå inte kostar något beror på att
deras score samtidigt stiger förbi bandets övre kant (12), och över den kanten läser
grinden inte täckningen alls. Skyddet är alltså inte att täckningen håller — det är att
poängen springer ifrån bandet. Det är en annan sak, och den håller bara så länge
expansionen ger ett STORT poänglyft.

## 6. Gruppen är global — vilka frågor utlöser den?

| variant | icke-inkassofall som utlöser en ny grupp | max \|Δscore\| utanför inkasso |
| ------- | ---------------------------------------- | ------------------------------ |
| `T1`    | **inga**                                 | 0.00                           |
| `T2`    | **inga**                                 | 0.00                           |
| `T3`    | **inga**                                 | 0.00                           |
| `T4`    | **inga**                                 | 0.00                           |
| `T5`    | **inga**                                 | 0.00                           |

### Men eval-setet kan inte se riskytan

Ingen av eval-setets icke-inkassofrågor innehåller delsträngen `krav` — utlösningen
sker på `lower.includes(term)`, alltså på DELSTRÄNG, inte på ord. `formkrav` och
`kravbrev` matchar därför `krav` lika bra som ordet självt. Sonderingen nedan är
KONSTRUERAD (samma kvarstående svaghet som #390) och mäter bara den lexikala vägen.

| konstruerad fråga                                            | juridisk? | PROD topp             | T1 topp (score/täckning) | T2 topp (score/täckning) | T3 topp (score/täckning) | T4 topp (score/täckning) | T5 topp (score/täckning) |
| ------------------------------------------------------------ | --------- | --------------------- | ------------------------ | ------------------------ | ------------------------ | ------------------------ | ------------------------ |
| Vilka formkrav gäller för en uppsägning?                     | ja        | hyresl:58 a 13.2/0.44 | **inkass:2 30.8/0.26**   | hyresl:58 a 13.2/0.44    | hyresl:58 a 13.2/0.44    | hyresl:58 a 13.2/0.44    | hyresl:58 a 13.2/0.44    |
| Vad ställer lagen för krav på en besiktning vid avflyttning? | ja        | hyresl:26 10.4/0.50   | **inkass:2 30.8/0.29**   | hyresl:26 10.4/0.50      | hyresl:26 10.4/0.50      | hyresl:26 10.4/0.50      | hyresl:26 10.4/0.50      |
| Vilka krav gäller för att få hyra ut i andra hand?           | ja        | bostad:7:11 17.3/0.50 | **inkass:2 30.8/0.26**   | bostad:7:11 17.3/0.50    | bostad:7:11 17.3/0.50    | bostad:7:11 17.3/0.50    | bostad:7:11 17.3/0.50    |
| Kan jag ställa krav på inkomst när jag väljer hyresgäst?     | nej       | diskri:3:10 9.8/0.40  | **inkass:2 30.8/0.36**   | diskri:3:10 9.8/0.40     | diskri:3:10 9.8/0.40     | diskri:3:10 9.8/0.40     | diskri:3:10 9.8/0.40     |

Fetstil = inkassokostnadslagen har tagit förstaplatsen på en fråga som inte handlar
om inkassokostnader.

### Expansionen är också en nämnare — mätt åt båda hållen

Två fall i korpusen avgörs i dag av att en BEFINTLIG grupp lägger till stammar som
inte ger poäng. Båda syns genom att jämföra `PROD` mot `NOEXP`, och de pekar åt
motsatta håll — vilket är själva poängen: täckning är inte en relevanssignal som
bara skyddar, den är ett kvottal som expansionen kan flytta i vilken riktning som
helst.

| fall                             | grupp som utlöses | score | täckning MED grupper | täckning UTAN | lexikalt insläpp med → utan |
| -------------------------------- | ----------------- | ----- | -------------------- | ------------- | --------------------------- |
| `paminnelseavgift-hogre-i-avtal` | #14 (kontrakt)    | 9.13  | 0.29                 | 0.40          | NEJ → **JA**                |
| `deposition-storlek`             | #5 (deposition)   | 9.70  | 0.33                 | 0.40          | NEJ → **JA**                |

Båda landar UTAN expansion på exakt 0,40 — bandets kant, som är ett `<`-villkor. Det är
alltså inte två fall med marginal åt något håll, utan två fall som avgörs på decimalen
av hur många stammar frågan råkar ha. Stammarna, term för term:

| fall                             | stam               | i toppchunken? | från grupp?     |
| -------------------------------- | ------------------ | -------------- | --------------- |
| `paminnelseavgift-hogre-i-avtal` | `avtal`            | ja             | nej (ur frågan) |
| `paminnelseavgift-hogre-i-avtal` | `belopp`           | nej            | nej (ur frågan) |
| `paminnelseavgift-hogre-i-avtal` | `hyresavtal`       | nej            | **ja**          |
| `paminnelseavgift-hogre-i-avtal` | `högre`            | nej            | nej (ur frågan) |
| `paminnelseavgift-hogre-i-avtal` | `kontrakt`         | nej            | **ja**          |
| `paminnelseavgift-hogre-i-avtal` | `lagens`           | nej            | nej (ur frågan) |
| `paminnelseavgift-hogre-i-avtal` | `påminnelseavgift` | ja             | nej (ur frågan) |
| `deposition-storlek`             | `deposition`       | nej            | nej (ur frågan) |
| `deposition-storlek`             | `handpen`          | nej            | **ja**          |
| `deposition-storlek`             | `hyresgäst`        | ja             | nej (ur frågan) |
| `deposition-storlek`             | `kräv`             | nej            | nej (ur frågan) |
| `deposition-storlek`             | `stor`             | nej            | nej (ur frågan) |
| `deposition-storlek`             | `säker`            | ja             | nej (ur frågan) |

## 7. Negativkontrollerna

`deposition-storlek` och `hyresgastval-diskriminering` ska förbli ute. Kolumnen mäter den LEXIKALA vägen — den enda en tesaurus kan flytta.

| variant | deposition-storlek (score/täckning) | ute?                | hyresgastval-diskriminering (score/täckning) | ute? |
| ------- | ----------------------------------- | ------------------- | -------------------------------------------- | ---- |
| `PROD`  | 9.70/0.33                           | JA                  | 8.66/0.29                                    | JA   |
| `NOEXP` | 9.70/0.40                           | **NEJ — släpps in** | 8.66/0.29                                    | JA   |
| `T1`    | 9.70/0.33                           | JA                  | 8.66/0.29                                    | JA   |
| `T2`    | 9.70/0.33                           | JA                  | 8.66/0.29                                    | JA   |
| `T3`    | 9.70/0.33                           | JA                  | 8.66/0.29                                    | JA   |
| `T4`    | 9.70/0.33                           | JA                  | 8.66/0.29                                    | JA   |
| `T5`    | 9.70/0.33                           | JA                  | 8.66/0.29                                    | JA   |

## 8. Golvsvepet: håller golvet 9 sin kalibrering?

Svepet prövar varje golv 0,50–40,00 i steg om 0,05 och frågar om det samtidigt (a)
behåller alla 19 fall som passerar lexikalt i dag och (b) håller båda negativkontrollerna
ute. Bandet hålls fast vid produktionens värden.

| variant | säkert golvintervall (a+b) | max inkassofall in | vid golv | vid dagens golv 9                          |
| ------- | -------------------------- | ------------------ | -------- | ------------------------------------------ |
| `PROD`  | 0.50–9.50                  | **5/8**            | 0.50     | 3/8 in                                     |
| `NOEXP` | **tomt**                   | **0/8**            | —        | 4/8 in, TAPPAR behåll, SLÄPPER IN kontroll |
| `T1`    | 0.50–9.50                  | **8/8**            | 0.50     | 8/8 in                                     |
| `T2`    | 0.50–9.50                  | **8/8**            | 0.50     | 8/8 in                                     |
| `T3`    | 0.50–9.50                  | **8/8**            | 0.50     | 8/8 in                                     |
| `T4`    | 0.50–9.50                  | **8/8**            | 0.50     | 8/8 in                                     |
| `T5`    | 0.50–9.50                  | **8/8**            | 0.50     | 8/8 in                                     |

## 9. Ranking, inte bara insläpp

Ett insläpp utan rättad ranking ger domaren fel paragrafer. Tabellen visar per
inkassofall: den lexikala topp-3, hela lagens paragrafrangordning, och FÖNSTRET
domaren faktiskt ser (RRF-fuserad topp-3 mot samma semantiska kanal).

### `PROD`

| fall                               | facit | lexikal topp-3                                                      | facit lexikal rank | inkassoparagrafernas ordning                      | domarens fönster                         | facit i fönstret? |
| ---------------------------------- | ----- | ------------------------------------------------------------------- | ------------------ | ------------------------------------------------- | ---------------------------------------- | ----------------- |
| `paminnelseavgift-ratten`          | 2 §   | hyresl:20 18.7/0.71<br>bostad:7:16 13.5/0.43<br>hyresl:55 11.7/0.57 | 2 §: 4             | 2 § 9.7 > 4 § 8.8 > 4 a § 6.9 > 1 § 3.6           | bostad:7:16 · hyresl:20 · **inkass:2**   | ja                |
| `paminnelseavgift-lagens-egna-ord` | 2 §   | inkass:2 15.7/0.75<br>inkass:4 10.6/0.75<br>inkass:3 6.6/0.50       | 2 §: 1             | 2 § 15.7 > 4 § 10.6 > 3 § 6.6 > 1 § 2.8 > 6 § 2.8 | **inkass:2** · 4 § · 3 §                 | JA, först         |
| `paminnelseavgift-taket`           | 4 §   | inkass:2 6.7/0.50<br>inkass:4 5.5/0.50<br>hyresl:55 e 1.8/0.50      | 4 §: 2             | 2 § 6.7 > 4 § 5.5                                 | **inkass:4** · 2 § · bostad:7:14         | JA, först         |
| `paminnelseavgift-avtalskravet`    | 2 §   | inkass:2 7.0/0.50<br>inkass:6 6.3/0.50<br>bostad:7:14 6.1/0.50      | 2 §: 1             | 2 § 7.0 > 6 § 6.3 > 3 § 3.4 > 4 a § 1.9 > 4 § 1.4 | **inkass:2** · bostad:7:15 · bostad:7:14 | JA, först         |
| `paminnelseavgift-vad-galler`      | 2 §   | inkass:2 6.7/0.33<br>inkass:4 6.6/0.67<br>hyresl:55 5.2/0.67        | 2 §: 1             | 2 § 6.7 > 4 § 6.6 > 1 § 1.1 > 4 a § 1.0           | **inkass:2** · bostad:7:23 · bostad:7:16 | JA, först         |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | inkass:2 6.7/0.25<br>bostad:7:25 6.5/0.25<br>hyresl:8 6.3/0.75      | 2 §: 1             | 2 § 6.7 > 4 § 5.5 > 1 § 2.2                       | **inkass:2** · hyresl:22 · bostad:7:25   | JA, först         |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | inkass:2 9.1/0.29<br>hyresl:38 8.8/0.57<br>inkass:4 8.7/0.29        | 6 §: 11            | 2 § 9.1 > 4 § 8.7 > 6 § 6.1 > 1 § 5.9             | 2 § · 4 § · hyresl:38                    | **NEJ**           |
| `kravbrev-avgift`                  | 3 §   | inkass:3 12.0/1.00<br>bostad:7:14 5.3/0.50<br>inkass:2 5.3/0.50     | 3 §: 1             | 3 § 12.0 > 2 § 5.3 > 6 § 4.8                      | **inkass:3** · 2 § · bostad:7:15         | JA, först         |

### `T1`

| fall                               | facit | lexikal topp-3                                                 | facit lexikal rank | inkassoparagrafernas ordning                                     | domarens fönster                       | facit i fönstret? |
| ---------------------------------- | ----- | -------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------- | -------------------------------------- | ----------------- |
| `paminnelseavgift-ratten`          | 2 §   | inkass:2 33.7/0.38<br>inkass:1 28.9/0.38<br>inkass:4 24.5/0.38 | 2 §: 1             | 2 § 33.7 > 1 § 28.9 > 4 § 24.5 > 3 § 17.4 > 4 a § 6.9 > 6 § 6.1  | **inkass:2** · hyresl:20 · bostad:7:16 | JA, först         |
| `paminnelseavgift-lagens-egna-ord` | 2 §   | inkass:2 34.5/0.50<br>inkass:1 25.4/0.42<br>inkass:4 24.3/0.50 | 2 §: 1             | 2 § 34.5 > 1 § 25.4 > 4 § 24.3 > 3 § 22.0 > 6 § 6.1              | **inkass:2** · 4 § · 3 §               | JA, först         |
| `paminnelseavgift-taket`           | 4 §   | inkass:2 30.8/0.45<br>inkass:1 25.4/0.45<br>inkass:4 21.2/0.45 | 4 §: 3             | 2 § 30.8 > 1 § 25.4 > 4 § 21.2 > 3 § 17.4 > 6 § 6.1              | 2 § · **inkass:4** · 1 §               | ja                |
| `paminnelseavgift-avtalskravet`    | 2 §   | inkass:2 37.8/0.50<br>inkass:1 25.4/0.36<br>inkass:4 22.6/0.43 | 2 §: 1             | 2 § 37.8 > 1 § 25.4 > 4 § 22.6 > 3 § 20.8 > 6 § 12.4 > 4 a § 1.9 | **inkass:2** · 4 § · 5 §               | JA, först         |
| `paminnelseavgift-vad-galler`      | 2 §   | inkass:2 30.8/0.42<br>inkass:1 26.5/0.50<br>inkass:4 22.2/0.50 | 2 §: 1             | 2 § 30.8 > 1 § 26.5 > 4 § 22.2 > 3 § 17.4 > 6 § 6.1 > 4 a § 1.0  | **inkass:2** · bostad:7:23 · 1 §       | JA, först         |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | inkass:2 30.8/0.38<br>inkass:1 27.6/0.46<br>inkass:4 21.2/0.38 | 2 §: 1             | 2 § 30.8 > 1 § 27.6 > 4 § 21.2 > 3 § 17.4 > 6 § 6.1              | **inkass:2** · hyresl:22 · 1 §         | JA, först         |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | inkass:2 33.2/0.38<br>inkass:1 31.3/0.38<br>inkass:4 24.4/0.38 | 6 §: 8             | 2 § 33.2 > 1 § 31.3 > 4 § 24.4 > 3 § 17.4 > 6 § 12.2             | 2 § · 4 § · **inkass:6**               | ja                |
| `kravbrev-avgift`                  | 3 §   | inkass:2 36.1/0.50<br>inkass:3 29.5/0.50<br>inkass:1 25.4/0.42 | 3 §: 2             | 2 § 36.1 > 3 § 29.5 > 1 § 25.4 > 4 § 21.2 > 6 § 10.9             | 2 § · **inkass:3** · 4 §               | ja                |

### `T2`

| fall                               | facit | lexikal topp-3                                                   | facit lexikal rank | inkassoparagrafernas ordning                        | domarens fönster                         | facit i fönstret? |
| ---------------------------------- | ----- | ---------------------------------------------------------------- | ------------------ | --------------------------------------------------- | ---------------------------------------- | ----------------- |
| `paminnelseavgift-ratten`          | 2 §   | inkass:2 25.9/0.44<br>hyresl:20 18.7/0.56<br>inkass:4 14.4/0.33  | 2 §: 1             | 2 § 25.9 > 4 § 14.4 > 4 a § 6.9 > 1 § 3.6           | **inkass:2** · bostad:7:16 · hyresl:20   | JA, först         |
| `paminnelseavgift-lagens-egna-ord` | 2 §   | inkass:2 29.8/0.83<br>inkass:4 16.1/0.67<br>inkass:3 6.6/0.33    | 2 §: 1             | 2 § 29.8 > 4 § 16.1 > 3 § 6.6 > 1 § 2.8 > 6 § 2.8   | **inkass:2** · 4 § · 3 §                 | JA, först         |
| `paminnelseavgift-taket`           | 4 §   | inkass:2 23.0/0.75<br>inkass:4 11.1/0.50<br>hyresl:55 e 1.8/0.25 | 4 §: 2             | 2 § 23.0 > 4 § 11.1                                 | **inkass:4** · 2 § · bostad:7:14         | JA, först         |
| `paminnelseavgift-avtalskravet`    | 2 §   | inkass:2 30.0/0.71<br>inkass:4 12.5/0.43<br>inkass:6 6.3/0.29    | 2 §: 1             | 2 § 30.0 > 4 § 12.5 > 6 § 6.3 > 3 § 3.4 > 4 a § 1.9 | **inkass:2** · 4 § · bostad:7:15         | JA, först         |
| `paminnelseavgift-vad-galler`      | 2 §   | inkass:2 23.0/0.60<br>inkass:4 12.1/0.60<br>hyresl:55 5.2/0.40   | 2 §: 1             | 2 § 23.0 > 4 § 12.1 > 1 § 1.1 > 4 a § 1.0           | **inkass:2** · bostad:7:23 · bostad:7:16 | JA, först         |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | inkass:2 23.0/0.50<br>inkass:4 11.1/0.33<br>bostad:7:25 6.5/0.17 | 2 §: 1             | 2 § 23.0 > 4 § 11.1 > 1 § 2.2                       | **inkass:2** · hyresl:22 · 4 §           | JA, först         |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | inkass:2 25.4/0.44<br>inkass:4 14.3/0.33<br>hyresl:38 8.8/0.44   | 6 §: 11            | 2 § 25.4 > 4 § 14.3 > 6 § 6.1 > 1 § 5.9             | 2 § · 4 § · bostad:7:14                  | **NEJ**           |
| `kravbrev-avgift`                  | 3 §   | inkass:3 12.0/1.00<br>bostad:7:14 5.3/0.50<br>inkass:2 5.3/0.50  | 3 §: 1             | 3 § 12.0 > 2 § 5.3 > 6 § 4.8                        | **inkass:3** · 2 § · bostad:7:15         | JA, först         |

### `T3`

| fall                               | facit | lexikal topp-3                                                   | facit lexikal rank | inkassoparagrafernas ordning                        | domarens fönster                         | facit i fönstret? |
| ---------------------------------- | ----- | ---------------------------------------------------------------- | ------------------ | --------------------------------------------------- | ---------------------------------------- | ----------------- |
| `paminnelseavgift-ratten`          | 2 §   | inkass:2 25.9/0.44<br>hyresl:20 18.7/0.56<br>inkass:4 14.4/0.33  | 2 §: 1             | 2 § 25.9 > 4 § 14.4 > 4 a § 6.9 > 1 § 3.6           | **inkass:2** · bostad:7:16 · hyresl:20   | JA, först         |
| `paminnelseavgift-lagens-egna-ord` | 2 §   | inkass:2 29.8/0.83<br>inkass:4 16.1/0.67<br>inkass:3 6.6/0.33    | 2 §: 1             | 2 § 29.8 > 4 § 16.1 > 3 § 6.6 > 1 § 2.8 > 6 § 2.8   | **inkass:2** · 4 § · 3 §                 | JA, först         |
| `paminnelseavgift-taket`           | 4 §   | inkass:2 23.0/0.75<br>inkass:4 11.1/0.50<br>hyresl:55 e 1.8/0.25 | 4 §: 2             | 2 § 23.0 > 4 § 11.1                                 | **inkass:4** · 2 § · bostad:7:14         | JA, först         |
| `paminnelseavgift-avtalskravet`    | 2 §   | inkass:2 30.0/0.71<br>inkass:4 12.5/0.43<br>inkass:6 6.3/0.29    | 2 §: 1             | 2 § 30.0 > 4 § 12.5 > 6 § 6.3 > 3 § 3.4 > 4 a § 1.9 | **inkass:2** · 4 § · bostad:7:15         | JA, först         |
| `paminnelseavgift-vad-galler`      | 2 §   | inkass:2 23.0/0.60<br>inkass:4 12.1/0.60<br>hyresl:55 5.2/0.40   | 2 §: 1             | 2 § 23.0 > 4 § 12.1 > 1 § 1.1 > 4 a § 1.0           | **inkass:2** · bostad:7:23 · bostad:7:16 | JA, först         |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | inkass:2 23.0/0.50<br>inkass:4 11.1/0.33<br>bostad:7:25 6.5/0.17 | 2 §: 1             | 2 § 23.0 > 4 § 11.1 > 1 § 2.2                       | **inkass:2** · hyresl:22 · 4 §           | JA, först         |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | inkass:2 25.4/0.44<br>inkass:4 14.3/0.33<br>hyresl:38 8.8/0.44   | 6 §: 11            | 2 § 25.4 > 4 § 14.3 > 6 § 6.1 > 1 § 5.9             | 2 § · 4 § · bostad:7:14                  | **NEJ**           |
| `kravbrev-avgift`                  | 3 §   | inkass:3 24.4/1.00<br>bostad:7:14 5.3/0.25<br>inkass:2 5.3/0.25  | 3 §: 1             | 3 § 24.4 > 2 § 5.3 > 6 § 4.8                        | **inkass:3** · 2 § · bostad:7:15         | JA, först         |

### `T4`

| fall                               | facit | lexikal topp-3                                                   | facit lexikal rank | inkassoparagrafernas ordning                        | domarens fönster                         | facit i fönstret? |
| ---------------------------------- | ----- | ---------------------------------------------------------------- | ------------------ | --------------------------------------------------- | ---------------------------------------- | ----------------- |
| `paminnelseavgift-ratten`          | 2 §   | inkass:2 25.9/0.44<br>hyresl:20 18.7/0.56<br>inkass:4 14.4/0.33  | 2 §: 1             | 2 § 25.9 > 4 § 14.4 > 4 a § 6.9 > 1 § 3.6           | **inkass:2** · bostad:7:16 · hyresl:20   | JA, först         |
| `paminnelseavgift-lagens-egna-ord` | 2 §   | inkass:2 29.8/0.83<br>inkass:4 16.1/0.67<br>inkass:3 6.6/0.33    | 2 §: 1             | 2 § 29.8 > 4 § 16.1 > 3 § 6.6 > 1 § 2.8 > 6 § 2.8   | **inkass:2** · 4 § · 3 §                 | JA, först         |
| `paminnelseavgift-taket`           | 4 §   | inkass:2 23.0/0.75<br>inkass:4 11.1/0.50<br>hyresl:55 e 1.8/0.25 | 4 §: 2             | 2 § 23.0 > 4 § 11.1                                 | **inkass:4** · 2 § · bostad:7:14         | JA, först         |
| `paminnelseavgift-avtalskravet`    | 2 §   | inkass:2 30.0/0.71<br>inkass:4 12.5/0.43<br>inkass:6 6.3/0.29    | 2 §: 1             | 2 § 30.0 > 4 § 12.5 > 6 § 6.3 > 3 § 3.4 > 4 a § 1.9 | **inkass:2** · 4 § · bostad:7:15         | JA, först         |
| `paminnelseavgift-vad-galler`      | 2 §   | inkass:2 23.0/0.60<br>inkass:4 12.1/0.60<br>hyresl:55 5.2/0.40   | 2 §: 1             | 2 § 23.0 > 4 § 12.1 > 1 § 1.1 > 4 a § 1.0           | **inkass:2** · bostad:7:23 · bostad:7:16 | JA, först         |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | inkass:2 23.0/0.50<br>inkass:4 11.1/0.33<br>bostad:7:25 6.5/0.17 | 2 §: 1             | 2 § 23.0 > 4 § 11.1 > 1 § 2.2                       | **inkass:2** · hyresl:22 · 4 §           | JA, först         |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | inkass:2 25.4/0.44<br>inkass:4 14.3/0.33<br>hyresl:38 8.8/0.44   | 6 §: 11            | 2 § 25.4 > 4 § 14.3 > 6 § 6.1 > 1 § 5.9             | 2 § · 4 § · bostad:7:14                  | **NEJ**           |
| `kravbrev-avgift`                  | 3 §   | inkass:3 24.4/1.00<br>bostad:7:14 5.3/0.25<br>inkass:2 5.3/0.25  | 3 §: 1             | 3 § 24.4 > 2 § 5.3 > 6 § 4.8                        | **inkass:3** · 2 § · bostad:7:15         | JA, först         |

### `T5`

| fall                               | facit | lexikal topp-3                                                   | facit lexikal rank | inkassoparagrafernas ordning                        | domarens fönster                         | facit i fönstret? |
| ---------------------------------- | ----- | ---------------------------------------------------------------- | ------------------ | --------------------------------------------------- | ---------------------------------------- | ----------------- |
| `paminnelseavgift-ratten`          | 2 §   | inkass:2 25.9/0.44<br>hyresl:20 18.7/0.56<br>inkass:4 14.4/0.33  | 2 §: 1             | 2 § 25.9 > 4 § 14.4 > 4 a § 6.9 > 1 § 3.6           | **inkass:2** · bostad:7:16 · hyresl:20   | JA, först         |
| `paminnelseavgift-lagens-egna-ord` | 2 §   | inkass:2 29.8/0.83<br>inkass:4 16.1/0.67<br>inkass:3 6.6/0.33    | 2 §: 1             | 2 § 29.8 > 4 § 16.1 > 3 § 6.6 > 1 § 2.8 > 6 § 2.8   | **inkass:2** · 4 § · 3 §                 | JA, först         |
| `paminnelseavgift-taket`           | 4 §   | inkass:2 23.0/0.75<br>inkass:4 11.1/0.50<br>hyresl:55 e 1.8/0.25 | 4 §: 2             | 2 § 23.0 > 4 § 11.1                                 | **inkass:4** · 2 § · bostad:7:14         | JA, först         |
| `paminnelseavgift-avtalskravet`    | 2 §   | inkass:2 30.0/0.71<br>inkass:4 12.5/0.43<br>inkass:6 6.3/0.29    | 2 §: 1             | 2 § 30.0 > 4 § 12.5 > 6 § 6.3 > 3 § 3.4 > 4 a § 1.9 | **inkass:2** · 4 § · bostad:7:15         | JA, först         |
| `paminnelseavgift-vad-galler`      | 2 §   | inkass:2 23.0/0.60<br>inkass:4 12.1/0.60<br>hyresl:55 5.2/0.40   | 2 §: 1             | 2 § 23.0 > 4 § 12.1 > 1 § 1.1 > 4 a § 1.0           | **inkass:2** · bostad:7:23 · bostad:7:16 | JA, först         |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | inkass:2 23.0/0.50<br>inkass:4 11.1/0.33<br>bostad:7:25 6.5/0.17 | 2 §: 1             | 2 § 23.0 > 4 § 11.1 > 1 § 2.2                       | **inkass:2** · hyresl:22 · 4 §           | JA, först         |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | inkass:6 43.3/0.53<br>inkass:2 25.4/0.27<br>inkass:4 14.3/0.20   | 6 §: 1             | 6 § 43.3 > 2 § 25.4 > 4 § 14.3 > 1 § 5.9            | 4 § · 2 § · **inkass:6**                 | ja                |
| `kravbrev-avgift`                  | 3 §   | inkass:3 24.4/1.00<br>bostad:7:14 5.3/0.25<br>inkass:2 5.3/0.25  | 3 §: 1             | 3 § 24.4 > 2 § 5.3 > 6 § 4.8                        | **inkass:3** · 2 § · bostad:7:15         | JA, först         |

## 10. Sammanfattande utfall per kandidat

| variant | de fem över golvet | grindinsläpp totalt (8 inkasso) | facit i fönstret (8) | facit FÖRST i fönstret (8) | tappade fall | max Δ utanför inkasso |
| ------- | ------------------ | ------------------------------- | -------------------- | -------------------------- | ------------ | --------------------- |
| `PROD`  | 0/5                | 3/8                             | 7/8                  | 6/8                        | —            | 0.00                  |
| `T1`    | 5/5                | 8/8                             | 8/8                  | 5/8                        | —            | 0.00                  |
| `T2`    | 5/5                | 8/8                             | 7/8                  | 7/8                        | —            | 0.00                  |
| `T3`    | 5/5                | 8/8                             | 7/8                  | 7/8                        | —            | 0.00                  |
| `T4`    | 5/5                | 8/8                             | 7/8                  | 7/8                        | —            | 0.00                  |
| `T5`    | 5/5                | 8/8                             | 8/8                  | 7/8                        | —            | 0.00                  |

## 11. Svaret

**Ja — en tesaurusgrupp lyfter alla fem över golvet utan att någon tröskel rörs.**
**Men gruppen som föreslogs gör det till priset av sämre ranking och av att dra in
inkassokostnadslagen i frågor som inte handlar om den. Den variant som klarar båda
delarna måste vara både beskuren och riktad mot ett känt facit — vilket gör den till
ett tak för metoden, inte ett generellt svar.**

### Insläppet: ja, utan att en tröskel rörs

Samtliga fem passerar golvet 9 i varje mätt kandidat (5/5 i T1, 5/5 i T3), och det säkra golvintervallet är oförändrat mot produktionen i alla varianter — golvet 9 behåller
sin kalibrering. Ingen negativkontroll släpps in. Inget fall som passerar i dag tappas.

### Men hypotesens mekanism stämmer inte som den formulerades

Korrelationen finns (r = 0.75, ρ = 0.76), men "antal stammar" är inte det som avgör:
`kravbrev-avgift` har 2 scorade stammar och passerar på 12.02, medan
`paminnelseavgift-taket` har lika många och stannar på 6.73. Det som skiljer är inte ANTALET
stammar utan om någon av dem är SÄLLSYNT och finns i rätt paragraf — `kravbrev` har
df = 1, medan takets `myck`/`påminnelseavgift` delas av 4 §. En grupp hjälper alltså
inte genom att vara lång, utan genom att den råkar innehålla en högfrekvent-IDF-stam
som bara målparagrafen har.

Och för ett av de fem är premissen direkt omvänd:
`paminnelseavgift-hogre-i-avtal` UTLÖSER redan en grupp (#14 `kontrakt|hyresavtal|avtal`).
Den ger 0,00 poäng — men sänker täckningen från 0.40 till 0.29, och det är precis det
som fäller fallet i bandet. Med tesaurusen AVSTÄNGD passerar det (9.13 / 0.40).
Fallet fälls alltså inte av en SAKNAD grupp utan av en BEFINTLIG. Samma mekanism åt
andra hållet håller negativkontrollen `deposition-storlek` ute: utan expansion når den 0.40
och släpps in.

### Rankingen: insläppet räcker inte — den måste rättas separat

- **`paminnelseavgift-hogre-i-avtal` (facit 6 §) blir SÄMRE av att släppas in av en ORIKTAD grupp.** 6 § ligger på lexikal rank 11 i T3 och når inte domarens fönster; fönstret blir `inkass:2 · inkass:4 · bostad:7:14`. Kandidaten går alltså in med RÄTTEN (2 §) och TAKET (4 §)
  men utan ogiltighetsregeln — det svar #406:s eval-fall uttryckligen kallar osant.
- **T1 blandar ihop paragraferna.** I `kravbrev-avgift` (facit 3 §) tappar 3 § förstaplatsen till 2 § (lexikal rank 2), och 1 § — tillämpningsparagrafen, aldrig ett svar — tar en lexikal
  topp-3-plats i 8 av 8 inkassofall (i dag: 0). Facit ligger FÖRST i fönstret i 5/8 fall mot 6/8 i dag:
  T1 gör rankingen sämre samtidigt som den öppnar grinden. Det är exakt det utfall
  `kravbrev-avgift` skrevs för att fånga.
- **Separationen (T2/T3) håller ordningen** — 7/8 facit först, 1 § i topp-3 i 0 fall — men lyfter
  inte 6 §: facit når fönstret i 7/8, samma som i dag. En ORIKTAD grupp kan inte veta
  vilken av lagens paragrafer frågan gäller.
- **Riktad grupp kan laga ranking-hålet, men bara riktad.** T5 lyfter 6 § till lexikal rank 1 och in i fönstret (8/8 facit i fönstret mot 7/8 för T3), utan att tappa
  något annat fall (7/8 facit först). Priset är att gruppen är skriven mot ett känt facit —
  och att dess frasform T4 aldrig ens utlöstes: `avtala om högre` är inte en delsträng av
  "avtala om **en** högre", så T4 är bit-för-bit identisk med T3. En tesaurus som ska
  träffa formuleringar den inte sett kan alltså inte förlita sig på fraser.

### Priset ligger utanför eval-setet

T1:s term `krav` utlöses på DELSTRÄNG. Av 4 konstruerade icke-inkassofrågor med "krav" i sig får **4** inkassokostnadslagen som lexikal etta i T1 — en fråga om formkrav vid uppsägning
landar alltså i påminnelseavgiftens paragraf, med score långt över bandets kant så att
täckningen inte kan rädda den. T3 ger 0/4. Eval-setet innehåller ingen sådan fråga och kan
därför inte se skillnaden — det är en mätning av instrumentet, inte av korpusen.

### Vad mätningen INTE visar

- **Ingen domare kördes.** Mätningen stannar vid fönstret. Att facit når fönstret
  betyder att svaret KAN bli grundat i rätt paragraf, inte att det blir det.
- **Sonderingsfrågorna är påhittade.** De visar att riskytan finns, inte hur stor den är i
  prod-trafik. Samma kvarstående svaghet som #390.
- **T5 är skriven av någon som sett facit** och är därför ett tak för vad en riktad
  grupp kan göra, inte ett förslag som kan generaliseras.
- **Bara den lexikala kanalen mättes för sonderingsfrågorna** — ingen cosine hämtades för dem.

## Kontroller

- Paritet mot produktionen (variant `PROD`): **max |Δscore| = 0, max |Δcoverage| = 0**, noll grindavvikelser och noll fused-avvikelser (30 frågor × 427 chunkar).
- Lagtextens content-hashar: **oförändrade** (427 chunkar).
- Korpus: N = 427, identisk med golvets kalibrerings-N.
- Trösklar: `MIN_TOP_SCORE`, `LOW_SCORE_BAND`, `MIN_COVERAGE_IN_BAND` och
  `MIN_TOP_COSINE` lästes, aldrig skrevs. Ingen produktionsfil ändrad av mätningen.
