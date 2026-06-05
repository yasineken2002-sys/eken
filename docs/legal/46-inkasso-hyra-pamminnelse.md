# Påminnelse → inkasso-ready för hyra: juristspår + öppen revisorfråga

> **Status:** juridiken VERIFIERAD av jurist (avgränsning + tidslinje + bokföring
> nedan är fastställda). Detta dokument är ett spår för kusin/revisor — det är
> **ingen AI-skriven lagtolkning som facit**, utan en hänvisning till juristens
> svar plus den enda kvarstående frågan som ska bekräftas med revisor.
> Uppdateras när revisorn svarat.

## Avgränsning (juristens hårda gräns)

Eveno bygger **endast skuld-sidan**: avi → påminnelse → dröjsmålsränta →
inkasso-ready → export till externt inkassobolag. **Inget eget inkassosystem.**
**Förverkande, uppsägning och avhysning byggs INTE** — det är hyresvärdens egen
juridiska process. Eveno går aldrig längre än att lämna ett färdigt,
dokumenterat ärende redo för överlämning.

## Fastställda regler (per jurist — hänvisning, inte härledning)

Dessa är inmatade som **konfiguration/data**, aldrig hårdkodade i logiken:

- **Påminnelse:** dag 7 efter förfallodag. Påminnelseavgift 60 kr, **momsfri**,
  konfigurerbar per fastighetsägare (`Organization.reminderFeeSek`,
  `rentReminderDay`). Lagstöd: lag (1981:739) om ersättning för inkassokostnader.
- **Inkasso-ready:** 14 dagar efter påminnelsen (`rentInkassoDaysAfterReminder`).
- **Dröjsmålsränta:** referensränta + 8 procentenheter, från dagen efter
  förfallodag. Referensräntan fastställs halvårsvis och lever i tabellen
  `ReferenceInterestRate` — **aldrig hårdkodad**. Lagstöd: räntelagen (1975:635)
  6 § och 9 §.
- **Dokumentation som gör ett ärende "inkasso-ready":** avi-PDF, påminnelse-PDF,
  utskickslogg, betalningshistorik, leveransstatus, gäldenär- + fordringsdata.
  Inga juridiska formkrav på avi/påminnelse i sig, men allt ovan ska bevaras
  (BFL 1999:1078 — räkenskapsinformation, 7 år).

## Bokföring (per bokföringsexpert — fastställd kontering)

- **Påminnelseavgift:** 1510 D / 3593 K (momsfri rörelseintäkt).
- **Dröjsmålsränta:** 8131 (finansiell intäkt) — **INTE** 3593. (8313 seedad
  parallellt; se öppen fråga 2 nedan.)
- **Kundförlust:** 1515 (befarad) → 6352 (konstaterad).

## Öppna frågor till revisor

### Fråga 1 — Momsåterkrav vid kundförlust på LOKALhyra

Bostadshyra är momsfri (ML 3 kap 2 §) → ingen utgående moms, ingen
momskomplikation vid kundförlust. **Lokalhyra under frivillig skattskyldighet**
(ML 9 kap) är däremot momspliktig: utgående moms har redovisats på avin. När en
sådan fordran blir konstaterad kundförlust ska den tidigare redovisade utgående
momsen normalt få **minskas/återkrävas**.

**Att bekräfta med revisor:** vid konstaterad kundförlust på momspliktig
lokalhyra — ska nedskrivningen bokföras så att utgående moms (2611) reduceras,
och i så fall mot vilket underlag/vilken period? Detta avgör konteringen i
**PR 5** (kundförlust). Tills svar finns bokför PR 5 enbart momsfri bostadshyra
mot 1515 → 6352; lokalhyrans momsdel hålls öppen och spikas inte i kod.

### Fråga 2 — 8131 (primärt) för dröjsmålsränta, 8313 seedat som reserv

**8131 är det tekniskt starkare valet** och fastställd regel: kontogrupp
8100–8199 (Ränteintäkter och utdelning) är rätt hemvist för en finansiell
intäkt som dröjsmålsränta på kundfordringar. 8313 ligger i kontogruppen
8300-serien (räntekostnader och liknande finansiella poster) och är ett svagare,
icke-standardiserat val — det seedas parallellt enbart som reserv om en
specifik kundönskan/revisorpraxis kräver det. Båda är seedade i kontoplanen
(PR 1 bokför inget). **Att bekräfta med revisor:** att PR 3 posterar
dröjsmålsräntan mot **8131** (inte att fritt välja mellan kontona). Påverkar
enbart kontovalet i PR 3 — ingen annan mekanik.

## Beslutslogg

| Datum | Fråga | Svar    | Beslutad av |
| ----- | ----- | ------- | ----------- |
| –     | 1     | _öppen_ |             |
| –     | 2     | _öppen_ |             |
