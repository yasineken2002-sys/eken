# BAS-kontoplan 2024 — fastighetsfokus

> Källa: BAS-kontogruppen (BAS Intressenter AB), bas.se
> Anpassad för Eveno — fastighetsförvaltning, hyresfastighet, BRF (separat regelverk)

BAS är de facto-standard för svensk redovisning, accepterad av Skatteverket, Bolagsverket och alla större revisionsbyråer. Eveno ska aldrig avvika från BAS utan tydlig motivering — det skapar onödig friktion för revisorer och redovisningskonsulter.

## Konto-struktur (övergripande)

BAS-kontoplanen är hierarkisk med 4 siffror per konto. Första siffran avgör klass:

| Klass  | Område                                       | Exempel             |
| ------ | -------------------------------------------- | ------------------- |
| 1xxx   | **Tillgångar** (anläggnings + omsättning)    | 1119, 1510, 1930    |
| 2xxx   | **Eget kapital och skulder**                 | 2010, 2440, 2611    |
| 3xxx   | **Rörelsens intäkter**                       | 3911, 3913, 3920    |
| 4xxx   | **Material och varor**                       | 4010 (sällsynt här) |
| 5-6xxx | **Övriga externa rörelsekostnader**          | 5010, 5070, 5170    |
| 7xxx   | **Personalkostnader**                        | 7010, 7510, 7610    |
| 8xxx   | **Finansiella och andra intäkter/kostnader** | 8113, 8313, 8410    |

## Klass 1 — Tillgångar

### 1110-1119 — Byggnader

| Konto | Namn                            | Användning                             |
| ----- | ------------------------------- | -------------------------------------- |
| 1110  | Byggnader                       | Anskaffningsvärde fastighetens byggnad |
| 1111  | Byggnader på egen mark          | Som ovan, separat när det är relevant  |
| 1112  | Byggnader på annans mark        | Tomträtt, etc.                         |
| 1119  | Ack. avskrivningar på byggnader | Motsvarar 1110 — visar nedskrivning    |

**Eveno:** vid förvärv av fastighet → debet 1110/1111, kredit 1930 (bankkonto) eller 2350 (lån)

### 1130-1139 — Mark

| Konto | Namn         | Användning                   |
| ----- | ------------ | ---------------------------- |
| 1130  | Mark         | Marken som byggnaden står på |
| 1131  | Mark, tomter | Obebyggd tomtmark            |

Mark **avskrivs ej** — endast byggnaden.

### 1140-1149 — Tomträtt och liknande

### 1150-1159 — Markanläggningar

Vägar, planteringar, parkering på egen mark. Avskrivs.

### 1180-1189 — Pågående ny-/till-/ombyggnad

Aktiveras vid större investeringar innan färdigställande.

### 1200-1299 — Maskiner och inventarier

| Konto | Namn                           | Användning               |
| ----- | ------------------------------ | ------------------------ |
| 1220  | Inventarier och verktyg        | Möbler, datorer, verktyg |
| 1229  | Ack. avskrivningar inventarier |                          |

### 1500-1599 — Kundfordringar

| Konto    | Namn                                     | Användning                                   |
| -------- | ---------------------------------------- | -------------------------------------------- |
| **1510** | **Kundfordringar**                       | **Huvudkonto för utestående hyresfakturor**  |
| 1511     | Kundfordringar (gemensamt med utländska) | Sällsynt för bostadshyra                     |
| 1515     | Osäkra kundfordringar                    | Vid förfallna obetalda fakturor överförd hit |
| 1518     | Ej reskontraförda kundfordringar         | Bokföringsmässiga periodiseringar            |
| 1519     | Värdereglering kundfordringar            | Nedskrivning av osäkra fordringar            |

**Eveno-flöde:**

1. Hyresfaktura skapas → debet 1510, kredit 3911/3913 (+ 2611 om moms)
2. Betalning kommer → debet 1930, kredit 1510
3. Förfallodatum + 90 dagar utan betalning → omföring debet 1515, kredit 1510 (osäker fordran)
4. Konstaterad förlust → debet 6352 (kundförluster), kredit 1515

### 1700-1799 — Förutbetalda kostnader och upplupna intäkter

| Konto | Namn                                                | Användning                                                                    |
| ----- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1730  | Förutbetalda försäkringspremier                     | T.ex. fastighetsförsäkring betald i förskott                                  |
| 1740  | Förutbetalda räntekostnader                         |                                                                               |
| 1790  | Övriga förutbetalda kostnader och upplupna intäkter | T.ex. upparbetad men ej fakturerad hyra (sällsynt — hyror är oftast förskott) |

### 1900-1999 — Likvida medel

| Konto     | Namn                         | Användning                                     |
| --------- | ---------------------------- | ---------------------------------------------- |
| 1910      | Kassa                        | Fysisk kassa (sällan idag)                     |
| **1930**  | **Företagskonto/checkkonto** | **Huvudkonto för svenska företagskontot**      |
| 1931-1939 | Bank-/postgiro               | Specifika konton (t.ex. 1931 separat plusgiro) |
| 1940-1949 | Övriga bankkonton            | Specialkonton, depositum-konto                 |
| 1950      | Bankcertifikat               |                                                |

**Eveno:** alla inkommande hyresbetalningar debet 1930 (eller specifikt bank-konto), kredit 1510

## Klass 2 — Eget kapital och skulder

### 2010-2099 — Eget kapital

| Konto | Namn                           | Användning    |
| ----- | ------------------------------ | ------------- |
| 2010  | Eget kapital                   | Enskild firma |
| 2080  | Aktiekapital                   | Aktiebolag    |
| 2086  | Reservfond                     |               |
| 2091  | Balanserad vinst eller förlust |               |
| 2099  | Årets resultat                 |               |

### 2300-2399 — Lån och kontokrediter

| Konto | Namn                                           | Användning                |
| ----- | ---------------------------------------------- | ------------------------- |
| 2350  | Andra långfristiga skulder till kreditinstitut | Fastighetslån (vanligast) |
| 2390  | Övriga långfristiga skulder                    |                           |

### 2400-2499 — Kortfristiga skulder

| Konto | Namn               | Användning                                          |
| ----- | ------------------ | --------------------------------------------------- |
| 2440  | Leverantörsskulder | Obetalda leverantörsfakturor (renovation, städ, el) |

### 2600-2699 — Moms och särskilda skatter

| Konto    | Namn                                    | Användning                                           |
| -------- | --------------------------------------- | ---------------------------------------------------- |
| **2611** | **Utgående moms 25%**                   | **Lokalhyra med frivillig skattskyldighet**          |
| 2612     | Utgående moms 12%                       | Sällsynt för fastighet                               |
| 2613     | Utgående moms 6%                        | Sällsynt för fastighet                               |
| 2614     | Utg. moms omvänd skattskyldighet 25%    | Vid byggtjänster (omvänd byggmoms)                   |
| **2641** | **Debiterad ingående moms 25%**         | **Avdragsgill ingående moms på leverantörsfakturor** |
| 2645     | Beräknad ingående moms på unionsförvärv | EU-inköp                                             |
| 2650     | Redovisningskonto för moms              | Avstämningskonto vid momsdeklaration                 |

**KRITISKT för Eveno:**

- **Bostadshyra** (ML 3 kap 2 §) → **ingen** moms. Endast 3911, ingen 2611.
- **Lokalhyra utan frivillig skattskyldighet** → ingen moms. Endast 3913, ingen 2611.
- **Lokalhyra med frivillig skattskyldighet** (ML 9 kap) → 25% moms. 3913 (netto) + 2611 (moms).

### 2700-2799 — Personalrelaterade skulder (lön, sociala avgifter)

### 2800-2899 — Övriga kortfristiga skulder

| Konto | Namn                                | Användning |
| ----- | ----------------------------------- | ---------- |
| 2820  | Kortfristiga skulder till anställda |            |
| 2890  | Övriga kortfristiga skulder         |            |

### 2900-2999 — Upplupna kostnader och förutbetalda intäkter

| Konto    | Namn                           | Användning                                           |
| -------- | ------------------------------ | ---------------------------------------------------- |
| 2960     | Upplupna räntekostnader        |                                                      |
| 2970     | Förutbetalda intäkter          | Allmänt                                              |
| **2972** | **Förutbetalda hyresintäkter** | **Hyror fakturerade i förskott för kommande period** |
| 2990     | Övriga upplupna kostnader      |                                                      |

**Eveno-flöde (periodisering vid bokslut):**

- 31 dec, vi har fakturerat Q1 nästa år i förskott i december →
  debet 3911 (minska intäkten), kredit 2972 (skuld till hyresgästen i form av förskott)
- 1 jan, ny period börjar →
  debet 2972, kredit 3911 (vänd tillbaka, intäkten hör nu till perioden)

## Klass 3 — Rörelsens intäkter

### 3900-3999 — Övriga rörelseintäkter (fastighet)

| Konto    | Namn                                          | Användning                                                    |
| -------- | --------------------------------------------- | ------------------------------------------------------------- |
| **3911** | **Hyresintäkter, bostäder**                   | **Bostadshyror — undantagna moms**                            |
| **3912** | **Hyresintäkter, parkeringsplatser**          | **Carport, garage (oftast undantagna, ibland momspliktiga)**  |
| **3913** | **Hyresintäkter, lokaler**                    | **Kommersiella lokaler — moms vid frivillig skattskyldighet** |
| 3914     | Hyresintäkter, övriga                         | T.ex. förråd, vindar                                          |
| 3915     | Garagehyra                                    |                                                               |
| 3916     | Hyresgästavtal (extraordinära avtal)          |                                                               |
| 3917     | Förskott från kunder                          | Sällsynt — använd 2972 istället                               |
| 3918     | Lägenhetsöverlåtelseavgifter (BRF)            | För bostadsrättsföreningar                                    |
| 3920     | Hyresgästers el-/värmeersättning              | Vidaredebitering av el och värme                              |
| 3921     | Hyresintäkter, p-platser, momspliktiga        | Separat när moms tillämpas                                    |
| 3960     | Värme- och kylakostnader, vidaredebitering    | Specifik för individuell debitering                           |
| 3970     | Vatten- och avloppsavgifter, vidaredebitering |                                                               |
| 3990     | Övriga rörelseintäkter                        |                                                               |

**Eveno-konteringsexempel:**

Bostadshyra 10 000 kr (ingen moms):

```
Debet  1510 Kundfordringar                  10 000
Kredit 3911 Hyresintäkter, bostäder         10 000
```

Lokalhyra 25 000 kr + 25% moms (frivillig skattskyldighet):

```
Debet  1510 Kundfordringar                  31 250
Kredit 3913 Hyresintäkter, lokaler          25 000
Kredit 2611 Utgående moms 25%                6 250
```

Inkommande hyresbetalning:

```
Debet  1930 Företagskonto                   10 000
Kredit 1510 Kundfordringar                  10 000
```

## Klass 5-6 — Övriga externa rörelsekostnader

| Konto | Namn                                     | Användning                                                  |
| ----- | ---------------------------------------- | ----------------------------------------------------------- |
| 5010  | Lokalhyra                                | Egna förhyrda lokaler (Eveno-kontoret, ej hyresfastigheten) |
| 5020  | El för belysning                         | Allmänna utrymmen                                           |
| 5040  | Vatten och avlopp                        | Fastighetens egen kostnad                                   |
| 5050  | Värme                                    |                                                             |
| 5060  | Renhållning                              |                                                             |
| 5070  | Reparation och underhåll av lokaler      | **Stor post för fastighetsförvaltning**                     |
| 5090  | Övriga fastighetskostnader               |                                                             |
| 5170  | Reparation och underhåll, byggnader      |                                                             |
| 5190  | Andra fastighetsspecifika kostnader      |                                                             |
| 6071  | Representation, ej avdragsgill           |                                                             |
| 6110  | Kontorsmateriel                          |                                                             |
| 6212  | Telekommunikation                        |                                                             |
| 6310  | Företagsförsäkringar                     | **Fastighetsförsäkring → här**                              |
| 6352  | Konstaterade förluster på kundfordringar | Definitiva förluster (efter inkasso)                        |
| 6420  | Ersättningar till revisor                |                                                             |
| 6530  | Redovisningstjänster                     | Externa redovisningskonsulter                               |
| 6570  | Bankkostnader                            |                                                             |

## Klass 7 — Personalkostnader

| Konto | Namn                          | Användning           |
| ----- | ----------------------------- | -------------------- |
| 7010  | Löner till kollektivanställda |                      |
| 7210  | Löner till tjänstemän         | Förvaltningspersonal |
| 7510  | Lagstadgade sociala avgifter  | Arbetsgivaravgifter  |
| 7610  | Utbildning                    |                      |

## Klass 8 — Finansiella och andra intäkter/kostnader

### 8000-8199 — Finansiella intäkter

| Konto | Namn                      | Användning                             |
| ----- | ------------------------- | -------------------------------------- |
| 8113  | Ränteintäkter från bank   |                                        |
| 8131  | Ränteintäkter från kunder | **Dröjsmålsränta debiterad hyresgäst** |
| 8170  | Diskonteringskostnader    |                                        |

### 8300-8499 — Räntekostnader

| Konto | Namn                          | Användning                         |
| ----- | ----------------------------- | ---------------------------------- |
| 8313  | Räntor från kunder            | Vanlig benämning för intäktsräntor |
| 8410  | Räntekostnader för lån        | **Fastighetslånets ränta**         |
| 8420  | Räntekostnader för korta lån  |                                    |
| 8440  | Räntekostnader till anställda |                                    |

### 8800-8899 — Bokslutsdispositioner

### 8900-8999 — Skatter på årets resultat

| Konto | Namn                    | Användning |
| ----- | ----------------------- | ---------- |
| 8910  | Skatt på årets resultat |            |

## Vanliga Eveno-konteringsscenarier

### 1. Månadsfakturering, bostadshyra

```
Debet  1510 Kundfordringar (Anna Andersson)    8 500
Kredit 3911 Hyresintäkter, bostäder              8 500

Verifikation: Hyresfaktura #2026-0142, månadshyra juni 2026, lgh 1204
```

### 2. Månadsfakturering, lokalhyra med moms

```
Debet  1510 Kundfordringar (AB Acme)            31 250
Kredit 3913 Hyresintäkter, lokaler               25 000
Kredit 2611 Utgående moms 25%                     6 250
```

### 3. Inkommande betalning via OCR-matchning

```
Debet  1930 Företagskonto                        8 500
Kredit 1510 Kundfordringar (Anna Andersson)     8 500
```

### 4. Dröjsmålsränta debiterad efter förfallodatum

Hyra 8 500 kr förfallen 2026-05-31, betald 2026-06-30. Referensränta 4,5% (exempel). Ränta = 8 500 × (4,5% + 8%) / 365 × 30 = 87,33 kr.

```
Debet  1510 Kundfordringar (Anna Andersson)       87,33
Kredit 8131 Ränteintäkter från kunder             87,33
```

### 5. Påminnelseavgift

```
Debet  1510 Kundfordringar (Anna Andersson)       60,00
Kredit 3999 Övriga rörelseintäkter                60,00
```

(Påminnelseavgift har särskild status i Inkassoförordningen — max 60 kr.)

### 6. Konstaterad kundförlust efter inkasso

```
Debet  6352 Konstaterade förluster på kundfordringar   8 500
Kredit 1515 Osäkra kundfordringar                       8 500
```

### 7. Inköp av fastighetstjänst (städ, reparation) med moms

Städfaktura 5 000 + 25% moms = 6 250 kr:

```
Debet  5070 Reparation och underhåll av lokaler    5 000
Debet  2641 Debiterad ingående moms 25%            1 250
Kredit 2440 Leverantörsskulder                      6 250
```

### 8. Betalning av leverantörsfaktura

```
Debet  2440 Leverantörsskulder                      6 250
Kredit 1930 Företagskonto                           6 250
```

### 9. Periodisering vid bokslut — förskottsfakturerad hyra

Q1 2027 fakturerad i december 2026 (3 000 kr):

```
Vid bokslut 31 dec 2026:
Debet  3911 Hyresintäkter, bostäder              3 000
Kredit 2972 Förutbetalda hyresintäkter           3 000

1 januari 2027 (omvänd):
Debet  2972 Förutbetalda hyresintäkter           3 000
Kredit 3911 Hyresintäkter, bostäder              3 000
```

### 10. Mottagen deposition

```
Debet  1940 Övriga bankkonton (depositionskonto)    25 500
Kredit 2820 Kortfristiga skulder (deposition)       25 500
```

Depositionen är **skuld** till hyresgästen tills avflyttning.

### 11. Återbetalning deposition efter avflyttning (inget avdrag)

```
Debet  2820 Kortfristiga skulder (deposition)       25 500
Kredit 1940 Övriga bankkonton (depositionskonto)    25 500
```

### 12. Återbetalning deposition med avdrag för städ (5 000 kr)

```
Debet  2820 Kortfristiga skulder (deposition)       25 500
Kredit 1940 Övriga bankkonton                       20 500
Kredit 3999 Övriga rörelseintäkter (städkostnad)     4 000
Kredit 2611 Utgående moms 25% (städkostnad)          1 000
```

(Om städning sker av extern firma som vi vidaredebiterar.)

## BAS-pricniper Eveno måste följa

1. **Endast godkända konton:** använd BAS 2024-konton, inte fantasi-konton
2. **Konsistent kontering:** samma typ av transaktion → samma kontering
3. **Tydlig verifikationstext:** "Hyresfaktura #2026-0142, lgh 1204, juni 2026" — inte bara "fakturering"
4. **Verifikationsnummer:** sekventiella, gap-free, per räkenskapsår
5. **Datum:** transaktionsdatum (när affärshändelsen inträffade), inte bokföringsdatum (när vi loggade)
6. **Debet = Kredit:** alltid per verifikation
7. **Avskrivningar:** byggnader 50 år (2%), inventarier 5-10 år (10-20%)

## När man får avvika från BAS

- **K2-företag** (mindre AB) kan ha förenklade kontoplaner — fungerar med BAS som superset
- **K3-företag** kan ha mer detaljerade kontoplaner men ska kunna mappas till BAS
- **BRF** har specifika konton för medlemmar (3xxx-undergrupp för insatser och årsavgifter) — separat ämne

## Källor

- BAS Intressenter AB — bas.se
- BFN R 4 (Räkenskapsslutskurs)
- BFN R 8 (Värdering av kundfordringar)
- BFN K2 (Årsredovisning i mindre företag)
- BFN K3 (Årsredovisning och koncernredovisning)
