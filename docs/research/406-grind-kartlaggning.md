# #406 — kartläggning av grind-halvan

> MÄTNING, INGEN FIX. Ingen produktionsregel, tröskel eller lagtext ändrad.
> Genererad av `apps/api/scripts/measure-406-gate.ts` mot korpus N = 427.

## Frågan

Finns ett lexikalt ingrepp som lyfter **inkassokostnadslagen 2 §** (rätten till
ersättning för skriftlig betalningspåminnelse) över grindens golv, utan att lyfta
**4 a §** (förseningsersättning mellan näringsidkare — fel regel för en
bostadshyresgäst) och utan att rasera golvets kalibrering för resten av korpusen?

## Varianter

| Variant    | Vad den gör                       |
| ---------- | --------------------------------- |
| `BASLINJE` | dagens stem()/tokenize()          |
| `A10`      | sammansättningsdelning, minLen 10 |
| `A12`      | sammansättningsdelning, minLen 12 |
| `A14`      | sammansättningsdelning, minLen 14 |
| `B`        | söktermer i chunk-metadata        |

`A10/A12/A14` är samma regel vid tre minsta-sammansättningslängder. Regeln hämtar
sin vokabulär ur korpusen och delar girigt på längsta kända prefix med valfritt
foge-s; frigjorda led blir själva vokabulär (fixpunkt), vilket är nödvändigt —
`påminnelse` finns inte som eget ord i korpusen, bara i `betalningspåminnelse`.

### Indexets form per variant

| Variant    | avgLength | unika stammar | Δ avgLength |
| ---------- | --------- | ------------- | ----------- |
| `BASLINJE` | 52.32     | 2845          | +0.00       |
| `A10`      | 71.24     | 3096          | +18.92      |
| `A12`      | 63.32     | 3011          | +11.00      |
| `A14`      | 57.92     | 2938          | +5.60       |
| `B`        | 52.48     | 2861          | +0.17       |

## 1. De åtta inkassokostnadsfallen

### `BASLINJE` — dagens stem()/tokenize()

| fall                               | facit | BM25 topp-3 (score/cov)                                           | cosine | grind               | 2 § rank/score | 4 a § rank/score | 2 § > 4 a §?          | domarens fönster (fused topp-3) |
| ---------------------------------- | ----- | ----------------------------------------------------------------- | ------ | ------------------- | -------------- | ---------------- | --------------------- | ------------------------------- |
| `paminnelseavgift-ratten`          | 2 §   | hyresl:20 18.7/0.71<br>bostad:16 13.5/0.43<br>hyresl:55 11.7/0.57 | 0.506  | kandidat            | — / 0.00       | 16 / 6.82        | **NEJ — 4 a § högre** | bostad · hyresl · hyresl        |
| `paminnelseavgift-lagens-egna-ord` | 2 §   | inkass:2 14.4/0.75<br>inkass:4 11.6/0.75<br>inkass:3 7.0/0.50     | 0.629  | kandidat            | 1 / 14.44      | — / 0.00         | JA                    | **2 §** · **4 §** · **3 §**     |
| `paminnelseavgift-taket`           | 4 §   | hyresl:55 e 1.8/0.50                                              | 0.417  | miss:weak-retrieval | — / 0.00       | — / 0.00         | = (båda 0)            | **4 §** · hyresl · bostad       |
| `paminnelseavgift-avtalskravet`    | 2 §   | bostad:14 6.4/0.50<br>bostad:16 5.9/0.50<br>bostad:15 5.6/0.25    | 0.465  | miss:weak-retrieval | — / 0.00       | 29 / 2.02        | **NEJ — 4 a § högre** | bostad · bostad · **2 §**       |
| `paminnelseavgift-vad-galler`      | 2 §   | hyresl:55 5.2/0.67<br>hyresl:21 5.0/0.67<br>hyresl:66 4.7/0.67    | 0.444  | miss:weak-retrieval | — / 0.00       | 109 / 1.07       | **NEJ — 4 a § högre** | bostad · hyresl · bostad        |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | bostad:25 6.5/0.25<br>hyresl:8 6.3/0.75<br>hyresl:25 a 5.9/0.50   | 0.456  | miss:weak-retrieval | — / 0.00       | — / 0.00         | = (båda 0)            | hyresl · bostad · **2 §**       |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | hyresl:38 8.9/0.57<br>hyresl:19 8.3/0.43<br>bostad:13 7.5/0.29    | 0.409  | miss:weak-retrieval | 59 / 2.72      | — / 0.00         | JA                    | hyresl · **4 §** · hyresl       |
| `kravbrev-avgift`                  | 3 §   | inkass:3 6.6/0.50<br>bostad:14 5.6/0.50<br>bostad:15 5.6/0.50     | 0.461  | miss:weak-retrieval | — / 0.00       | — / 0.00         | = (båda 0)            | **3 §** · bostad · bostad       |

> Fetstil i fönsterkolumnen = en inkassokostnadslagsparagraf; övriga visas med lagprefix.
> Fönstret är det domaren faktiskt ser. En paragraf som klättrar i den lexikala
> listan men inte når fused topp-3 kan per konstruktion inte bli ett grundat svar.

### `A10` — sammansättningsdelning, minLen 10

| fall                               | facit | BM25 topp-3 (score/cov)                                            | cosine | grind               | 2 § rank/score | 4 a § rank/score | 2 § > 4 a §?          | domarens fönster (fused topp-3) |
| ---------------------------------- | ----- | ------------------------------------------------------------------ | ------ | ------------------- | -------------- | ---------------- | --------------------- | ------------------------------- |
| `paminnelseavgift-ratten`          | 2 §   | hyresl:20 19.8/0.56<br>bostad:16 17.8/0.44<br>inkass:4 12.5/0.33   | 0.506  | kandidat            | 6 / 10.90      | 28 / 6.17        | JA                    | bostad · hyresl · bostad        |
| `paminnelseavgift-lagens-egna-ord` | 2 §   | inkass:2 25.8/0.83<br>inkass:4 21.5/0.83<br>bostad:33 7.9/0.50     | 0.629  | kandidat            | 1 / 25.76      | 9 / 5.59         | JA                    | **2 §** · **4 §** · **3 §**     |
| `paminnelseavgift-taket`           | 4 §   | inkass:2 7.8/0.25<br>inkass:4 6.3/0.25<br>bostad:14 5.7/0.25       | 0.417  | miss:weak-retrieval | 1 / 7.82       | — / 0.00         | JA                    | **4 §** · **2 §** · bostad      |
| `paminnelseavgift-avtalskravet`    | 2 §   | bostad:14 6.7/0.50<br>bostad:16 a 6.1/0.50<br>bostad:5 6.1/0.50    | 0.465  | miss:weak-retrieval | — / 0.00       | 93 / 1.16        | **NEJ — 4 a § högre** | bostad · bostad · **2 §**       |
| `paminnelseavgift-vad-galler`      | 2 §   | inkass:2 7.8/0.20<br>inkass:4 7.5/0.40<br>hyresl:19 6.5/0.60       | 0.444  | miss:weak-retrieval | 1 / 7.82       | 138 / 1.02       | JA                    | **2 §** · bostad · bostad       |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | hyresl:25 a 10.9/0.50<br>hyresl:8 10.8/0.63<br>hyresl:19 10.5/0.63 | 0.456  | kandidat            | 30 / 7.82      | — / 0.00         | JA                    | hyresl · hyresl · hyresl        |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | hyresl:19 13.5/0.50<br>bostad:13 11.5/0.30<br>hyresl:38 11.1/0.50  | 0.409  | kandidat            | 5 / 10.10      | — / 0.00         | JA                    | **2 §** · hyresl · **4 §**      |
| `kravbrev-avgift`                  | 3 §   | inkass:3 11.3/0.50<br>bostad:14 5.7/0.25<br>diskri:10 5.7/0.25     | 0.461  | kandidat            | — / 0.00       | — / 0.00         | = (båda 0)            | **3 §** · bostad · bostad       |

> Fetstil i fönsterkolumnen = en inkassokostnadslagsparagraf; övriga visas med lagprefix.
> Fönstret är det domaren faktiskt ser. En paragraf som klättrar i den lexikala
> listan men inte når fused topp-3 kan per konstruktion inte bli ett grundat svar.

### `A12` — sammansättningsdelning, minLen 12

| fall                               | facit | BM25 topp-3 (score/cov)                                          | cosine | grind               | 2 § rank/score | 4 a § rank/score | 2 § > 4 a §?          | domarens fönster (fused topp-3) |
| ---------------------------------- | ----- | ---------------------------------------------------------------- | ------ | ------------------- | -------------- | ---------------- | --------------------- | ------------------------------- |
| `paminnelseavgift-ratten`          | 2 §   | hyresl:20 19.6/0.56<br>bostad:16 17.5/0.44<br>inkass:4 12.2/0.33 | 0.506  | kandidat            | 7 / 10.69      | 27 / 6.29        | JA                    | bostad · hyresl · bostad        |
| `paminnelseavgift-lagens-egna-ord` | 2 §   | inkass:2 25.3/0.83<br>inkass:4 21.1/0.83<br>bostad:33 8.1/0.50   | 0.629  | kandidat            | 1 / 25.26      | 52 / 3.04        | JA                    | **2 §** · **4 §** · **3 §**     |
| `paminnelseavgift-taket`           | 4 §   | inkass:2 7.7/0.25<br>inkass:4 6.2/0.25<br>bostad:14 5.7/0.25     | 0.417  | miss:weak-retrieval | 1 / 7.67       | — / 0.00         | JA                    | **4 §** · **2 §** · bostad      |
| `paminnelseavgift-avtalskravet`    | 2 §   | bostad:16 a 6.7/0.50<br>bostad:17 6.5/0.50<br>bostad:16 6.4/0.50 | 0.465  | miss:weak-retrieval | — / 0.00       | 58 / 1.67        | **NEJ — 4 a § högre** | bostad · bostad · bostad        |
| `paminnelseavgift-vad-galler`      | 2 §   | inkass:2 7.7/0.20<br>inkass:4 7.3/0.40<br>hyresl:19 6.3/0.60     | 0.444  | miss:weak-retrieval | 1 / 7.67       | 135 / 1.04       | JA                    | **2 §** · bostad · bostad       |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | inkass:2 7.7/0.17<br>hyresl:25 a 6.9/0.33<br>bostad:14 6.6/0.33  | 0.456  | miss:weak-retrieval | 1 / 7.67       | — / 0.00         | JA                    | **2 §** · bostad · hyresl       |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | bostad:13 11.6/0.33<br>hyresl:19 11.2/0.44<br>inkass:2 10.1/0.22 | 0.409  | miss:weak-retrieval | 3 / 10.10      | — / 0.00         | JA                    | **2 §** · bostad · **4 §**      |
| `kravbrev-avgift`                  | 3 §   | inkass:3 7.0/0.50<br>bostad:14 5.7/0.50<br>bostad:5 5.4/0.50     | 0.461  | miss:weak-retrieval | — / 0.00       | — / 0.00         | = (båda 0)            | **3 §** · bostad · bostad       |

> Fetstil i fönsterkolumnen = en inkassokostnadslagsparagraf; övriga visas med lagprefix.
> Fönstret är det domaren faktiskt ser. En paragraf som klättrar i den lexikala
> listan men inte når fused topp-3 kan per konstruktion inte bli ett grundat svar.

### `A14` — sammansättningsdelning, minLen 14

| fall                               | facit | BM25 topp-3 (score/cov)                                           | cosine | grind               | 2 § rank/score | 4 a § rank/score | 2 § > 4 a §?          | domarens fönster (fused topp-3) |
| ---------------------------------- | ----- | ----------------------------------------------------------------- | ------ | ------------------- | -------------- | ---------------- | --------------------- | ------------------------------- |
| `paminnelseavgift-ratten`          | 2 §   | hyresl:20 19.3/0.56<br>bostad:16 17.6/0.44<br>bostad:15 12.2/0.33 | 0.506  | kandidat            | 6 / 10.62      | 27 / 6.37        | JA                    | bostad · hyresl · bostad        |
| `paminnelseavgift-lagens-egna-ord` | 2 §   | inkass:2 25.0/0.83<br>inkass:4 20.5/0.83<br>bostad:33 8.5/0.50    | 0.629  | kandidat            | 1 / 24.95      | 48 / 3.14        | JA                    | **2 §** · **4 §** · **3 §**     |
| `paminnelseavgift-taket`           | 4 §   | inkass:2 7.5/0.25<br>inkass:4 6.0/0.25<br>bostad:14 5.7/0.25      | 0.417  | miss:weak-retrieval | 1 / 7.54       | — / 0.00         | JA                    | **4 §** · **2 §** · bostad      |
| `paminnelseavgift-avtalskravet`    | 2 §   | bostad:16 6.7/0.50<br>bostad:14 6.4/0.50<br>bostad:5 6.4/0.50     | 0.465  | miss:weak-retrieval | — / 0.00       | 37 / 1.89        | **NEJ — 4 a § högre** | bostad · bostad · bostad        |
| `paminnelseavgift-vad-galler`      | 2 §   | inkass:2 7.5/0.20<br>inkass:4 7.1/0.40<br>hyresl:19 6.2/0.60      | 0.444  | miss:weak-retrieval | 1 / 7.54       | 135 / 1.04       | JA                    | **2 §** · bostad · bostad       |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | inkass:2 7.5/0.17<br>hyresl:25 a 6.8/0.33<br>bostad:14 6.6/0.33   | 0.456  | miss:weak-retrieval | 1 / 7.54       | — / 0.00         | JA                    | **2 §** · bostad · hyresl       |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | bostad:13 11.6/0.33<br>hyresl:19 11.1/0.44<br>inkass:2 10.2/0.22  | 0.409  | miss:weak-retrieval | 3 / 10.20      | — / 0.00         | JA                    | **2 §** · bostad · **4 §**      |
| `kravbrev-avgift`                  | 3 §   | inkass:3 6.8/0.50<br>bostad:14 5.7/0.50<br>bostad:5 5.5/0.50      | 0.461  | miss:weak-retrieval | — / 0.00       | — / 0.00         | = (båda 0)            | **3 §** · bostad · bostad       |

> Fetstil i fönsterkolumnen = en inkassokostnadslagsparagraf; övriga visas med lagprefix.
> Fönstret är det domaren faktiskt ser. En paragraf som klättrar i den lexikala
> listan men inte når fused topp-3 kan per konstruktion inte bli ett grundat svar.

### `B` — söktermer i chunk-metadata

| fall                               | facit | BM25 topp-3 (score/cov)                                           | cosine | grind               | 2 § rank/score | 4 a § rank/score | 2 § > 4 a §? | domarens fönster (fused topp-3) |
| ---------------------------------- | ----- | ----------------------------------------------------------------- | ------ | ------------------- | -------------- | ---------------- | ------------ | ------------------------------- |
| `paminnelseavgift-ratten`          | 2 §   | hyresl:20 18.7/0.71<br>bostad:16 13.5/0.43<br>hyresl:55 11.7/0.57 | 0.506  | kandidat            | 4 / 9.69       | 18 / 6.79        | JA           | bostad · hyresl · **2 §**       |
| `paminnelseavgift-lagens-egna-ord` | 2 §   | inkass:2 15.7/0.75<br>inkass:4 10.4/0.75<br>inkass:3 6.6/0.50     | 0.629  | kandidat            | 1 / 15.67      | — / 0.00         | JA           | **2 §** · **4 §** · **3 §**     |
| `paminnelseavgift-taket`           | 4 §   | inkass:2 6.7/0.50<br>inkass:4 5.4/0.50<br>hyresl:55 e 1.8/0.50    | 0.417  | miss:weak-retrieval | 1 / 6.73       | — / 0.00         | JA           | **4 §** · **2 §** · bostad      |
| `paminnelseavgift-avtalskravet`    | 2 §   | inkass:2 7.0/0.50<br>inkass:6 6.3/0.50<br>bostad:14 6.1/0.50      | 0.465  | miss:weak-retrieval | 1 / 7.03       | 36 / 1.88        | JA           | **2 §** · bostad · bostad       |
| `paminnelseavgift-vad-galler`      | 2 §   | inkass:2 6.7/0.33<br>inkass:4 6.5/0.67<br>hyresl:55 5.2/0.67      | 0.444  | miss:weak-retrieval | 1 / 6.73       | 130 / 0.97       | JA           | **2 §** · bostad · bostad       |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | inkass:2 6.7/0.25<br>bostad:25 6.5/0.25<br>hyresl:8 6.3/0.75      | 0.456  | miss:weak-retrieval | 1 / 6.73       | — / 0.00         | JA           | **2 §** · hyresl · bostad       |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | inkass:2 9.1/0.29<br>hyresl:38 8.8/0.57<br>inkass:4 8.6/0.29      | 0.409  | miss:weak-retrieval | 1 / 9.13       | — / 0.00         | JA           | **2 §** · **4 §** · hyresl      |
| `kravbrev-avgift`                  | 3 §   | inkass:3 12.0/1.00<br>bostad:14 5.3/0.50<br>inkass:2 5.3/0.50     | 0.461  | kandidat            | 3 / 5.31       | — / 0.00         | JA           | **3 §** · **2 §** · bostad      |

> Fetstil i fönsterkolumnen = en inkassokostnadslagsparagraf; övriga visas med lagprefix.
> Fönstret är det domaren faktiskt ser. En paragraf som klättrar i den lexikala
> listan men inte når fused topp-3 kan per konstruktion inte bli ett grundat svar.

### Attribution: den semantiska kanalens egen rangordning

Fönstret är RRF över två kanaler. Utan kanalernas separata rangordning går det
inte att säga om ett lyft är den lexikala variantens förtjänst eller semantikens.
Semantiken är IDENTISK i alla varianter (ingen av dem rör chunk-texten eller
frågesträngen), så den här tabellen gäller alla fem.

| fall                               | facit | semantisk rank: 2 § | semantisk rank: facit-§ | topp-cosine |
| ---------------------------------- | ----- | ------------------- | ----------------------- | ----------- |
| `paminnelseavgift-ratten`          | 2 §   | 4                   | 4                       | 0.506       |
| `paminnelseavgift-lagens-egna-ord` | 2 §   | 1                   | 1                       | 0.629       |
| `paminnelseavgift-taket`           | 4 §   | 3                   | 1                       | 0.417       |
| `paminnelseavgift-avtalskravet`    | 2 §   | 1                   | 1                       | 0.465       |
| `paminnelseavgift-vad-galler`      | 2 §   | 4                   | 4                       | 0.444       |
| `paminnelseavgift-vad-sager-lagen` | 2 §   | 2                   | 2                       | 0.456       |
| `paminnelseavgift-hogre-i-avtal`   | 6 §   | 2                   | 6                       | 0.409       |
| `kravbrev-avgift`                  | 3 §   | 3                   | 2                       | 0.461       |

## 2. Score-förskjutning över alla eval-fall

30 fall totalt (26 `answerable` — kvotens nämnare — samt 3 `needs-jurist` och 1 `no-clear-rule`).

| fall                                | förväntat     | BASLINJE   | A10                | A12                | A14                | B                 |
| ----------------------------------- | ------------- | ---------- | ------------------ | ------------------ | ------------------ | ----------------- |
| `besittningsskydd-forstahand-1ar`   | answerable    | 18.67/0.46 | 24.46/0.53 (+5.8)  | 21.10/0.50 (+2.4)  | 21.57/0.50 (+2.9)  | 18.67/0.46 (+0.0) |
| `besittningsskydd-andrahand-2ar`    | answerable    | 17.28/0.42 | 24.68/0.40 (+7.4)  | 25.03/0.40 (+7.8)  | 25.36/0.40 (+8.1)  | 17.30/0.42 (+0.0) |
| `besittningsskydd-lokal`            | answerable    | 9.51/0.43  | 14.04/0.56 (+4.5)  | 14.55/0.56 (+5.0)  | 14.61/0.56 (+5.1)  | 9.52/0.43 (+0.0)  |
| `besittningsskydd-eget-behov`       | needs-jurist  | 15.94/0.45 | 21.58/0.54 (+5.6)  | 16.76/0.45 (+0.8)  | 16.29/0.45 (+0.4)  | 15.96/0.45 (+0.0) |
| `uppsagningstid-bostad-tillsvidare` | answerable    | 25.61/0.62 | 38.22/0.60 (+12.6) | 35.63/0.61 (+10.0) | 35.92/0.61 (+10.3) | 25.61/0.62 (+0.0) |
| `uppsagningstid-lokal`              | answerable    | 23.89/0.50 | 34.05/0.47 (+10.2) | 31.45/0.47 (+7.6)  | 31.05/0.47 (+7.2)  | 23.90/0.50 (+0.0) |
| `uppsagning-skriftlig-form`         | answerable    | 15.93/0.60 | 17.25/0.60 (+1.3)  | 16.65/0.60 (+0.7)  | 16.41/0.60 (+0.5)  | 15.95/0.60 (+0.0) |
| `delgivning-uppsagning`             | answerable    | 15.94/0.36 | 21.58/0.44 (+5.6)  | 17.95/0.29 (+2.0)  | 17.35/0.29 (+1.4)  | 15.96/0.36 (+0.0) |
| `kontrakt-skriftligt`               | answerable    | 11.55/0.86 | 15.58/0.88 (+4.0)  | 14.55/0.88 (+3.0)  | 12.68/0.86 (+1.1)  | 11.56/0.86 (+0.0) |
| `kontrakt-tidsbestamt-forlangning`  | answerable    | 8.02/0.38  | 11.30/0.44 (+3.3)  | 8.95/0.38 (+0.9)   | 8.35/0.38 (+0.3)   | 8.01/0.38 (-0.0)  |
| `hyra-forfallodag`                  | answerable    | 22.80/1.00 | 24.03/1.00 (+1.2)  | 23.86/1.00 (+1.1)  | 23.40/1.00 (+0.6)  | 22.80/1.00 (-0.0) |
| `drojsmalsranta-sen-hyra`           | answerable    | 15.57/0.50 | 21.11/0.50 (+5.5)  | 19.62/0.44 (+4.0)  | 19.53/0.44 (+4.0)  | 15.58/0.50 (+0.0) |
| `paminnelseavgift-ratten`           | answerable    | 18.71/0.71 | 19.76/0.56 (+1.1)  | 19.63/0.56 (+0.9)  | 19.29/0.56 (+0.6)  | 18.69/0.71 (-0.0) |
| `paminnelseavgift-lagens-egna-ord`  | answerable    | 14.44/0.75 | 25.76/0.83 (+11.3) | 25.26/0.83 (+10.8) | 24.95/0.83 (+10.5) | 15.67/0.75 (+1.2) |
| `paminnelseavgift-taket`            | answerable    | 1.76/0.50  | 7.82/0.25 (+6.1)   | 7.67/0.25 (+5.9)   | 7.54/0.25 (+5.8)   | 6.73/0.50 (+5.0)  |
| `paminnelseavgift-avtalskravet`     | answerable    | 6.43/0.50  | 6.74/0.50 (+0.3)   | 6.69/0.50 (+0.3)   | 6.70/0.50 (+0.3)   | 7.03/0.50 (+0.6)  |
| `paminnelseavgift-vad-galler`       | answerable    | 5.20/0.67  | 7.82/0.20 (+2.6)   | 7.67/0.20 (+2.5)   | 7.54/0.20 (+2.3)   | 6.73/0.33 (+1.5)  |
| `paminnelseavgift-vad-sager-lagen`  | answerable    | 6.50/0.25  | 10.89/0.50 (+4.4)  | 7.67/0.17 (+1.2)   | 7.54/0.17 (+1.0)   | 6.73/0.25 (+0.2)  |
| `paminnelseavgift-hogre-i-avtal`    | answerable    | 8.86/0.57  | 13.52/0.50 (+4.7)  | 11.58/0.33 (+2.7)  | 11.61/0.33 (+2.8)  | 9.13/0.29 (+0.3)  |
| `kravbrev-avgift`                   | answerable    | 6.58/0.50  | 11.26/0.50 (+4.7)  | 7.02/0.50 (+0.4)   | 6.81/0.50 (+0.2)   | 12.02/1.00 (+5.4) |
| `forverkande-obetald-hyra`          | answerable    | 21.30/0.67 | 27.45/0.71 (+6.1)  | 22.91/0.67 (+1.6)  | 22.26/0.67 (+1.0)  | 21.34/0.67 (+0.0) |
| `storning-uppsagning`               | answerable    | 28.65/0.43 | 29.67/0.43 (+1.0)  | 30.08/0.43 (+1.4)  | 29.71/0.43 (+1.1)  | 28.68/0.43 (+0.0) |
| `andrahand-utan-samtycke`           | answerable    | 18.81/0.60 | 26.12/0.64 (+7.3)  | 26.45/0.64 (+7.6)  | 26.79/0.64 (+8.0)  | 18.83/0.60 (+0.0) |
| `hyreshojning-formkrav`             | answerable    | 6.82/0.50  | 8.48/0.75 (+1.7)   | 8.30/0.75 (+1.5)   | 7.25/0.75 (+0.4)   | 6.83/0.50 (+0.0)  |
| `hyressattning-bruksvarde`          | answerable    | 5.82/0.50  | 8.31/0.33 (+2.5)   | 5.70/0.50 (-0.1)   | 5.89/0.50 (+0.1)   | 5.82/0.50 (+0.0)  |
| `tilltrade-arbeten`                 | answerable    | 15.75/0.83 | 21.67/0.88 (+5.9)  | 22.58/0.88 (+6.8)  | 22.55/0.88 (+6.8)  | 15.77/0.83 (+0.0) |
| `hyresgastval-diskriminering`       | answerable    | 8.65/0.29  | 8.64/0.29 (-0.0)   | 8.54/0.29 (-0.1)   | 8.61/0.29 (-0.0)   | 8.66/0.29 (+0.0)  |
| `deposition-storlek`                | no-clear-rule | 9.70/0.33  | 9.62/0.25 (-0.1)   | 9.75/0.33 (+0.1)   | 9.85/0.33 (+0.2)   | 9.70/0.33 (+0.0)  |
| `altan-utan-lov-tvist`              | needs-jurist  | 20.45/0.50 | 26.10/0.56 (+5.7)  | 21.56/0.50 (+1.1)  | 20.93/0.50 (+0.5)  | 20.46/0.50 (+0.0) |
| `agandeform-skatt-paketering`       | needs-jurist  | ej-jur     | ej-jur             | ej-jur             | ej-jur             | ej-jur            |

### Hur mycket rörs korpusen UTANFÖR inkassofallen?

BM25 är korpus-globalt: en ändrad tokenisering flyttar N-oberoende storheter som
`avgLength` och `docFreq` och därmed HELA skalan. Måttet nedan är den största
rörelsen bland de juridiska fall som INTE är inkassofall — alltså hur mycket
varianten stör det som redan fungerar.

| Variant | max \|Δscore\| utanför inkasso | median \|Δ\| | fall med \|Δ\| > 1,0 |
| ------- | ------------------------------ | ------------ | -------------------- |
| `A10`   | 12.62                          | 5.54         | 19 av 21             |
| `A12`   | 10.03                          | 1.60         | 15 av 21             |
| `A14`   | 10.32                          | 1.05         | 11 av 21             |
| `B`     | 0.03                           | 0.01         | 0 av 21              |

### Kalibrering: golvets referenspunkter

Mängderna hålls FASTA vid baslinjens klassificering — definieras de om per variant
blir gapet tomt per konstruktion och analysen säger ingenting. `behåll` = fall som
passerar lexikalt i dag (får inte tappas). `fäll` = fall som fälls lexikalt i dag
MED täckning ≥ 0,4, alltså sådana som måste fällas av POÄNGEN — bandet kan inte
hjälpa dem. Det är exakt de två storheter grindens kalibreringskommentar bokför.

`behåll` (18 fall): `besittningsskydd-forstahand-1ar`, `besittningsskydd-andrahand-2ar`, `besittningsskydd-lokal`, `besittningsskydd-eget-behov`, `uppsagningstid-bostad-tillsvidare`, `uppsagningstid-lokal`, `uppsagning-skriftlig-form`, `delgivning-uppsagning`, `kontrakt-skriftligt`, `hyra-forfallodag`, `drojsmalsranta-sen-hyra`, `paminnelseavgift-ratten`, `paminnelseavgift-lagens-egna-ord`, `forverkande-obetald-hyra`, `storning-uppsagning`, `andrahand-utan-samtycke`, `tilltrade-arbeten`, `altan-utan-lov-tvist`

`fäll` (7 fall): `paminnelseavgift-taket`, `paminnelseavgift-avtalskravet`, `paminnelseavgift-vad-galler`, `paminnelseavgift-hogre-i-avtal`, `kravbrev-avgift`, `hyreshojning-formkrav`, `hyressattning-bruksvarde`

| Variant    | svagast `behåll`             | starkast `fäll` (cov ≥ 0,4)               | intervall         | golvet 9 mellan dem? |
| ---------- | ---------------------------- | ----------------------------------------- | ----------------- | -------------------- |
| `BASLINJE` | besittningsskydd-lokal 9.51  | paminnelseavgift-hogre-i-avtal 8.86/0.57  | tomt: 8.86–9.51   | JA                   |
| `A10`      | besittningsskydd-lokal 14.04 | paminnelseavgift-hogre-i-avtal 13.52/0.50 | tomt: 13.52–14.04 | **NEJ**              |
| `A12`      | besittningsskydd-lokal 14.55 | paminnelseavgift-hogre-i-avtal 11.58/0.33 | tomt: 11.58–14.55 | **NEJ**              |
| `A14`      | kontrakt-skriftligt 12.68    | paminnelseavgift-hogre-i-avtal 11.61/0.33 | tomt: 11.61–12.68 | **NEJ**              |
| `B`        | besittningsskydd-lokal 9.52  | kravbrev-avgift 12.02/1.00                | **överlappar**    | **NEJ**              |

⚠ `fäll`-mängden innehåller fem av #406:s egna målfall. Att en variant lyfter dem
över `fäll`-raden är därför inte i sig ett fel — det är delvis den avsedda
effekten. Kolumnen mäter att SKALAN flyttas, inte att något gick sönder. Den
bindande frågan ställs i svepet nedan, som bara håller de två negativkontrollerna
som "måste ut".

### Lösningsutrymme: finns ett golv som gör allt på en gång?

Svepet prövar varje golv 0,50–40,00 i steg om 0,05 och frågar om det samtidigt
(a) behåller alla 18 fall som passerar lexikalt i dag, (b) håller BÅDA
negativkontrollerna ute och (c) släpper in #406:s åtta inkassofall. Bandet
(12 / 0,4) hålls fast vid produktionens värden — svepet prövar golvet, inte
grindens form.

| Variant    | säkert golvintervall (a+b) | max inkassofall in inom det | vid vilket golv | vid dagens golv 9 |
| ---------- | -------------------------- | --------------------------- | --------------- | ----------------- |
| `BASLINJE` | 0.50–9.50                  | **7/8**                     | 0.50            | 2/8 in            |
| `A10`      | 0.50–14.00                 | **6/8**                     | 0.50            | 5/8 in            |
| `A12`      | 0.50–14.50                 | **4/8**                     | 0.50            | 2/8 in            |
| `A14`      | 0.50–12.65                 | **4/8**                     | 0.50            | 2/8 in            |
| `B`        | 0.50–9.50                  | **5/8**                     | 0.50            | 3/8 in            |

## 3. Negativkontrollerna

`deposition-storlek` och `hyresgastval-diskriminering` ska förbli ute.

| Variant    | deposition-storlek | lexikalt ute? | hyresgastval-diskriminering | lexikalt ute? |
| ---------- | ------------------ | ------------- | --------------------------- | ------------- |
| `BASLINJE` | 9.70/0.33          | JA            | 8.65/0.29                   | JA            |
| `A10`      | 9.62/0.25          | JA            | 8.64/0.29                   | JA            |
| `A12`      | 9.75/0.33          | JA            | 8.54/0.29                   | JA            |
| `A14`      | 9.85/0.33          | JA            | 8.61/0.29                   | JA            |
| `B`        | 9.70/0.33          | JA            | 8.66/0.29                   | JA            |

> Grindutfallet för `deposition-storlek` är `kandidat` även i baslinjen: cosine 0,605
> ligger över 0,52. Den fälls av DOMAREN, inte av golvet — kolumnen mäter därför
> den lexikala vägen, som är den enda dessa varianter kan flytta.

## 4. Fall som flippar

| Variant | flippar in (miss → kandidat)                                                            | flippar ut (kandidat → miss) |
| ------- | --------------------------------------------------------------------------------------- | ---------------------------- |
| `A10`   | `paminnelseavgift-vad-sager-lagen`, `paminnelseavgift-hogre-i-avtal`, `kravbrev-avgift` | —                            |
| `A12`   | —                                                                                       | —                            |
| `A14`   | —                                                                                       | —                            |
| `B`     | `kravbrev-avgift`                                                                       | —                            |

Lexikala flippar (bortsett från cosine-insläppet, som ingen variant kan flytta):

| Variant | lexikalt in                                                                                                                 | lexikalt ut |
| ------- | --------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `A10`   | `kontrakt-tidsbestamt-forlangning`, `paminnelseavgift-vad-sager-lagen`, `paminnelseavgift-hogre-i-avtal`, `kravbrev-avgift` | —           |
| `A12`   | —                                                                                                                           | —           |
| `A14`   | —                                                                                                                           | —           |
| `B`     | `kravbrev-avgift`                                                                                                           | —           |

## 5. Sidofynd: stammaren splittrar `påminnelse` och `påminnelsen`

`paminnelseavgift-avtalskravet` är det enda fall där ingen A-variant ger 2 § någon
poäng alls. Två oberoende orsaker, ingen av dem i sammansättningsdelningen:

1. **Frågan innehåller ingen sammansättning att dela.** Den skriver "en avgift för
   påminnelsen", inte "påminnelseavgift" — A har inget att bita i.
2. **Stammaren skiljer de två formerna åt**, så inte ens det gemensamma ordet bär:

| ord                    | stam               | via suffix |
| ---------------------- | ------------------ | ---------- |
| `påminnelse`           | `påminn`           | -else      |
| `påminnelsen`          | `påminnels`        | -en        |
| `betalningspåminnelse` | `betalningspåminn` | -else      |
| `påminnelseavgift`     | `påminnelseavgift` | — (orörd)  |
| `avgift`               | `avgift`           | — (orörd)  |
| `avgiften`             | `avgift`           | -en        |

Suffixlistan prövas i ordning och `else` står före `en`, så `påminnelse` kapas till
`påminn` medan `påminnelsen` kapas till `påminnels`. De två formerna av samma ord
får alltså OLIKA stammar och kan aldrig matcha varandra — hur ordet än delas.
Frågan i `avtalskravet` skriver "påminnelsen jag skickade"; lagtexten skriver
"betalningspåminnelse". Det är ett tredje, oberoende lexikalt hål.

## Slutsats

**Ja, det finns ett lösningsutrymme — men det ligger inte där frågan antog.**

### 1. Grinden är inte det enda hindret, och för huvudfallet inte hindret alls

`paminnelseavgift-ratten` — #406:s mätsticka — passerar grinden REDAN i dag
(BM25 18.71, grind `kandidat`). Den fälls inte av något golv.
Den fälls av att 2 § aldrig kommer in i domarens fönster: baslinjens fused topp-3 är
`bostadsrattslagen:7:16 · hyreslagen:20 · hyreslagen:44`, och 2 § har BM25-score 0,00.
Ett högre eller lägre golv kan per konstruktion inte ändra det.

Omvänt gäller för 4 av de sex grindfällda fallen att RÄTT paragraf redan
ligger i fönstret — semantiken har hittat den — men frågan släpps aldrig in:
`paminnelseavgift-taket`, `paminnelseavgift-avtalskravet`, `paminnelseavgift-vad-sager-lagen`, `kravbrev-avgift`.
För dem är grinden hela hindret. #406-planens formulering att "de sex aldrig når
grinden" stämmer alltså inte: de når den och fälls av den, med svaret i handen.

### 2. Kandidat B separerar rätt paragraf — och rör inget annat

- 2 § rankas över 4 a § i **8 av 8** inkassofall (baslinjen: 2 av 8).
- 2 § når domarens fönster i huvudfallet `paminnelseavgift-ratten`: fused topp-3 blir
  `bostadsrattslagen:7:16 · hyreslagen:20 · inkassokostnadslagen:2`. Ingen A-variant klarar det — där stannar 2 § på lexikal
  rank 6–7 och når aldrig fönstret.
- Största rörelse utanför inkassofallen: **0.03 poäng**. Golvet 9 behåller
  exakt sin kalibrering (säkert intervall 0.50–9.50, samma övre gräns som i dag,
  satt av `besittningsskydd-lokal`). Ingen omkalibrering behövs.
- Enda grindflipp: `kravbrev-avgift`, som lyfts av sin EGEN facit-paragraf (3 § på
  lexikal rank 1, täckning 1,00) — en korrekt insläppning, inte en läcka.

### 3. Kandidat A fungerar mekaniskt men flyttar hela skalan

Delningen gör precis vad den ska: `betalningspåminnelse` → `betalning` + `påminnelse`
broar över till frågans `påminnelseavgift`, och 2 § får poäng i 6 av 8 fall där den
förut hade 0. Priset är att skalan flyttas för allt annat: `avgLength` stiger från
52.32 till 71.24 (A10) och enskilda fall rör sig upp till +12,6 poäng.
Golvet 9 slutar då betyda det det mättes till — en ommätning av MIN_TOP_SCORE blir
obligatorisk, och den ommätningen är precis det arbete #400 visade att man inte kan
hoppa över. A är alltså inte fel, men det är ett dyrare ingrepp med samma mål.

### 4. Fällan slog aldrig till

4 a § (förseningsersättning mellan näringsidkare) hamnar i domarens fönster i **noll** av 5 varianter × 8 inkassofall = 40 mätpunkter. Det farliga utfallet invariant 9 spärrar mot materialiseras inte i någon av de mätta varianterna — ingen av dem köper lyftet av 2 § till priset av att 4 a § följer med.

**Men mätningen hittade 4 a § i fönstret på ett HELT ANNAT fall:**
`drojsmalsranta-sen-hyra` — i **samtliga** varianter, baslinjen
inräknad. Det är alltså ett BEFINTLIGT tillstånd på `main`, inte något någon variant
orsakar. Mekanismen är rimlig: 4 a § handlar om dröjsmålsränta, och frågan gäller
dröjsmålsränta — men på en HYRA, där 4 a § (näringsidkare emellan) inte är
tillämplig. Invariant 9 täcker det inte: den gäller bara de åtta inkassofallen.
Invariant 7 kräver miss ELLER räntelagen §4/§6 bland källorna, vilket är uppfyllt
även om 4 a § ligger bredvid. Fyndet hör inte till den här kartläggningens fråga
men bör få ett eget ärende.

### 5. Vad mätningen INTE visar

- **Negativkontrollerna är två.** Svepet säger att golv ända ner mot 0,50 håller båda
  ute — men det är ett påstående om ett instrument med två negativa fall, inte om
  korpusen. Det som faktiskt håller dem ute är TÄCKNINGSBANDET (0,33 resp. 0,29), inte
  golvet. Ett förslag om att sänka golvet kräver därför fler negativkontroller först.
- **B:s söktermer är skrivna av mig.** De är författade per paragraf, inte per
  eval-fråga, och 2 § och 4 § bär båda ordet `påminnelseavgift` just för att mätningen
  ska kunna visa fel utfall. Men den som skriver termerna har sett frågorna. Att B
  lyfter 2 § är därför ett svagare bevis än det ser ut — det starka i mätningen är
  att B lyfter 2 § UTAN att röra resten av korpusen, inte att lyftet sker.
- **B diskriminerar inte mellan paragrafer på egen hand.** I `paminnelseavgift-taket`
  (facit 4 §) rankar B ändå 2 § lexikalt högst; det är semantiken som lägger 4 § först
  i fönstret. Söktermer löser vokabulärgapet, inte frågeförståelsen.
- **Ingen domare kördes.** Mätningen stannar vid fönstret. Att 2 § når fönstret betyder
  att invariant 8 KAN bli grön, inte att den blir det — domaren är ett eget steg.
- **En söktermsrad per chunk är en ändlig uppräkning** — samma kvarstående risk som
  #382/#390 håller öppen. Här är den skriven för 7 chunkar av 427.

## Kontroller

- Baslinjens paritet mot produktionen: **max |Δscore| = 0, max |Δcoverage| = 0**, noll grindavvikelser (30 frågor × 427 chunkar).
- Lagtextens content-hashar: **oförändrade** (427 chunkar).
- Korpus: N = 427, identisk med golvets kalibrerings-N.
