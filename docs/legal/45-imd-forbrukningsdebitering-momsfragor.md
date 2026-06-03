# IMD – förbrukningsdebitering: öppna momsfrågor till konsult

> **Status:** öppna. Mekaniken byggs medan dessa är obesvarade – momsregeln
> spikas inte i kod utan läses som konfiguration (snapshot per lease/unit).
> Uppdatera detta dokument när auktoriserad redovisningskonsult (FAR) svarat.

## Bakgrund

Eken inför individuell mätning och debitering (IMD) av el/vatten/värme. Två
leveranssätt stöds som konfiguration per fastighet/lease:

- **`RENT_NOTICE_LINE`** – förbrukning som rad på hyresavin (stark hyreskoppling).
- **`SEPARATE_INVOICE`** – el/vatten faktureras skilt från hyran.

Bokföringsbedömningen har fastslagit: intäkt bruttoredovisad (3920 el/värme,
3970 vatten, skilt från hyresintäkt 3911), kostnad 5020/5040, mätperiod skild
från fakturadatum, mätunderlag arkiveras 7 år (BFL), bokslutspost upplupen
intäkt (1790).

Momsdefault för bostad är `EXEMPT` (momsfri, ML 3 kap 2 § 2 st). Snapshotas på
varje `ConsumptionCharge` från lease/unit-konfiguration vid skapande.

## Öppna frågor

### Fråga 1 — Bryter separat faktura hyreskopplingen?

`RENT_NOTICE_LINE` har stark koppling till hyran → följer bostadshyrans
momsfrihet (ML 3 kap 2 §). När el/vatten faktureras **skilt** från hyran
(`SEPARATE_INVOICE`) – bryts den starka kopplingen så att tillhandahållandet
blir ett självständigt, **momspliktigt** tillhandahållande (25 %)?

**Konsekvens i kod:** avgör om `SEPARATE_INVOICE` för en bostad alls får ha
`vatStatus = EXEMPT`, eller om mekaniken måste tvinga `TAXABLE_25` för det
leveranssättet. Tills svar finns läses `vatStatus` enbart från konfiguration –
ingen särregel hårdkodas på leveranssättet.

### Fråga 2 — Varmvatten vs kallvatten

Ska varmvatten (uppvärmningskomponent) och kallvatten momsbehandlas lika, och
bokföras på samma intäktskonto (3970), eller ska varmvatten följa
värmeersättning (3920)?

### Fråga 3 — Bokslutsaccrualens brytdatum vs 2-månaderslagen

Förbrukning mäts med ca två månaders förskjutning. Vid räkenskapsårets slut är
december ofta ännu omätt. Bekräfta metod och brytdatum för upplupen intäkt
(1790 D / 3920|3970 K per 31/12, återförs 1/1): ska accrualen estimeras på
senast kända period/tariff, och hur hanteras gränsdragningen mot den 2-mån
förskjutna ordinarie debiteringen så att ingen period dubbelredovisas?

**Implementerad metod (PR 5 — `runYearEndAccrual`), att bekräfta:**

- **Brytdatum:** accrual dateras till räkenskapsårets sista dag (kalenderår →
  31/12), reversal till nästa räkenskapsårs första dag (1/1). Brutet räkenskapsår
  följer `Organization.fiscalYearStartMonth`.
- **Vad som periodiseras:** varje ACTUAL-förbrukning har redan ett eget verifikat
  daterat till sin mätperiod (PR 3) — den är alltså redan i rätt år oavsett när
  den debiteras. Accrualen täcker ENBART **omätt** förbrukning: dagarna från
  mätarens sista avläsning (mätpunkt) fram till årsslutet.
- **Estimat (per mätare):**
  `dagstakt = senaste ACTUAL-chargens quantity / dess periodlängd (dagar)`,
  `gap-dagar = dagar från sista mätpunkten (eller årsstart) t.o.m. årsslut`,
  `estimerat netto = dagstakt × gap-dagar × GÄLLANDE tariffpris vid årsslut`.
  Moms från enhetens config (`vatRateForRent`). Saknas tidigare ACTUAL-charge,
  tariff eller aktivt avtal → ingen accrual (ingen estimatbas).
- **Ingen dubbelredovisning:** posten **återförs 1/1**; när den verkliga (mätta)
  förbrukningen sedan bokförs i nya året tar reversalen ut accrualen. Estimatet
  materialiseras ALDRIG som en charge/avi/faktura — det lever bara i bokföringen.

_Öppen fråga till konsult:_ är dagstakt-proration från senaste perioden en
godtagbar och tillräckligt konsekvent estimatgrund, eller önskas annan bas
(t.ex. rullande 12-månaderssnitt eller normalårskorrigerad förbrukning)?

## Beslutslogg

| Datum | Fråga | Svar    | Beslutad av |
| ----- | ----- | ------- | ----------- |
| –     | 1     | _öppen_ |             |
| –     | 2     | _öppen_ |             |
| –     | 3     | _öppen_ |             |
