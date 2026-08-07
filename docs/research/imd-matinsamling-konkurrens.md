# IMD – mätinsamlingstjänster, konkurrens & etappindelning

> **Status:** research-underlag (dokumentation, inte beslut). Sammanställt 2026-06-13
> från deep-research-utredning (102 agenter: 5 web-searchers, 20 source-extractors,
> 75 verifierar-röster). Slutsatserna nedan är vad som klarade adversariell
> verifiering. Källvärden (priser, kontaktuppgifter, partner-villkor) ska
> dubbelkollas direkt mot leverantören innan affärsbeslut — de kan ha ändrats.
>
> Relaterat: `docs/legal/45-imd-forbrukningsdebitering-momsfragor.md` (öppna
> momsfrågor), `apps/api/src/consumption/` (den färdiga, källagnostiska motorn).

---

## 1. Svenska mätinsamlingstjänster att integrera mot

Marknadens mönster: en liten SaaS bygger **inte** egen mätinsamling — den
integrerar mot en mätinsamlare som redan har hårdvaran och insamlingen.

### Loggamera — primär kandidat för Evenos målgrupp (1–50 enheter)

- **Profil:** småkundsvänlig SaaS med **öppen, publik prislista** — ovanligt i
  branschen där priser annars kräver offert.
- **Pris (per mätare/mån, EX MOMS):** 1:a mätaren **10 kr**, 2:a **7 kr**,
  3:e och fler **4,90 kr**.
- **Insamling:** aggregerar via gateways från **Elvaco, MIVO och Piigab** över
  **M-Bus och LoRa**.
- **Ekosystem:** 30+ systemintegrationer + certifieringar; **Hogia DinHyresvård
  integrerar redan mot Loggamera** (se §2).
- **Hårdvara/installation = fastighetsägarens investering, INTE Evenos.**
  Loggamera erbjuder **ej totalentreprenad** och **rekommenderar att kunden anlitar
  egen elektriker** för installation.
- **Kontakt:** 08-446 81 800, kontakt@loggamera.se.
- ⚠️ **Partner-villkor för Eveno-API-tillgång är OKÄNDA** — måste efterfrågas
  direkt. Den publika prislistan gäller slutkund/mätare, inte nödvändigtvis en
  reseller-/integrationspartners villkor.

### Elvaco — också realistisk (REST)

- Infrastrukturleverantör (M-Bus/insamling), tekniskt mest öppna.
- **EVO Metering API (REST)** i molnportalen med dokumenterade endpoints + auth.
- **REST-API direkt på gatewayen CMe3100** — läs mätvärden utan molnmellanhand
  (alternativ väg för små hyresvärdar med egna M-Bus-mätare).

### Infometric — störst, men trögare att komma igång med

- Marknadsledare, 340 000+ mätpunkter, riktar sig mot både BRF och hyresvärd.
- **Öppet publicerad OpenAPI 3.0-spec** (Panorama API v1.0.0, 8 endpoints,
  OAuth2) på `api.infometric.se/docs`.
- ⚠️ **Verifierat och refuterat i utredningen:** specen kan läsas fritt, MEN det
  finns **ingen sandbox/självregistrering** — man måste ha namn/lösenord från
  Infometric för att faktiskt anropa API:et, dvs **partner-/kundavtal krävs före
  test**. (Påståendet att integrationen kunde utvärderas utan föregående avtal
  refuterades av alla tre verifierar-rösterna.)

### Techem — filimport, inte API

- 70+ år i branschen, helhetstjänst för flerbostadshus.
- Levererar **debiteringsfil till förvaltaren/hyresadministrationen** — alltså
  **filimport-adapter**, inte ett REST-API. Full service-modell.

### Sensor-Online — aggregator-genväg

- Samlar M-Bus-masters (Elvaco/Piigab/EcoGuard) + LoRaWAN bakom **ett gemensamt
  API** med IMD-modul (förbrukning per lägenhet i svenskt fastighetssystem-format).
- Kan vara enklaste vägen för att slippa N separata integrationer.

### Sammanfattande rekommendation (etapp 2)

Elvaco (REST) och Loggamera (öppen prislista, småkundsprofil) är tekniskt och
affärsmässigt de mest realistiska första integrationerna. Infometric är störst
men kräver partneravtal innan test. Techem = filimport. Sensor-Online = genväg
för att aggregera flera källor bakom ett API. Överväg även **Allmännyttans
fastAPI-standard** (Vitec/Momentum/FAST2, se §2) som integrationskontrakt.

---

## 2. Marknadsmönster — hur konkurrenterna löser det

- **Ingen liten aktör bygger egen mätinsamling.** Det validerar Evenos modell
  (källagnostisk motor + integration mot leverantör).
- **Hogia DinHyresvård** bygger **inte** egen insamling — **integrerar mot
  Loggamera**; debiteringsunderlag kopplas automatiskt till rätt hyresobjekt och
  hamnar på avin. Exakt den partner-modell Eveno överväger. (Hogia prissätts
  från ~1 800 kr/mån.)
- **Vitec** (marknadsledare): IMD som **integrerad egen modul** (Vitec
  Energiuppföljning/Vitec Hyra) — hela kedjan mätdata → validering → tariff →
  debitering på hyresavin. Referenspunkten Eveno jämförs mot.
- **Vitec + Momentum + FAST2** har enats om ett **öppet standard-API
  (Allmännyttans fastAPI)** för sensorer/mätdata — relevant för hur Eveno bör
  forma sin integrationsyta i stället för proprietära format.
- **Avy(-Tmpl):** öppet ekosystem ovanpå fastighetssystemen, visar förbrukning
  för hyresgästen — men IMD-debiteringen sker via underliggande system/
  IMD-leverantörer, inte egen insamling.

---

## 3. Juridik & GDPR

### Vad får debiteras

- **JB 12 kap 19 § (hyreslagen):** hyran ska vara bestämd till beloppet, **men**
  undantag för ersättning för uppvärmning, kyla, varmvatten, el samt vatten/avlopp
  — _om beräkningsgrunden anges i avtalet_ (eller fastställts i
  förhandlingsöverenskommelse). Detta är den rättsliga grunden Evenos debitering
  måste valideras mot: **beräkningsgrund dokumenterad per avtal**.
- **Självkostnadsprincipen:** vidaredebitering sker **till självkostnad — inget
  påslag/vinst** (Fastighetsägarnas och SABO/trepartens rekommendationer). IMD
  får inte bli förtäckt hyreshöjning; grundhyran ska sänkas när förbrukning lyfts
  ur hyran. Tvister prövas av **hyresnämnden**.
- **IMD-kraven (Boverket/EED):** individuell mätning av värme/tappvarmvatten
  obligatorisk i flerbostadshus över viss energiprestanda och vid ombyggnad
  (sedan 2021); kostnaden separeras från varmhyran och debiteras efter faktisk
  förbrukning.

### GDPR för förbrukningsdata per lägenhet

- **Förbrukningsdata = personuppgift** när den kan kopplas till hushåll/individ
  (EDPS TechDispatch #2): förbrukningsmönster avslöjar beteende. Kräver
  dataminimering, **proportionerlig upplösning** (styr hur granulärt timvärden får
  lagras/visas) och begränsad lagringstid.
- **Rättslig grund:** typiskt **fullgörande av avtal** (hyresavtalet), inte samtycke.
- **Biträdesavtal:** integration mot extern mätinsamlare kräver **personuppgifts-
  biträdesavtal** med leverantören.
- **Lagring:** lagringsminimering (IMY) i spänning mot bokföringslagens 7 år för
  underlag. Branschens GDPR-vägledning (Fastighetsägarna + Sveriges Allmännytta)
  är närmaste mall.
- Trepartsrekommendationen: hyresgästen ska kunna **följa sin förbrukning, helst
  i realtid** — styr vad portalen bör visa.

### Öppna momsfrågor (blockerar skarp separatfaktura för bostad)

De tre frågorna i `docs/legal/45-imd-forbrukningsdebitering-momsfragor.md` är
fortfarande **öppna** (väntar på auktoriserad FAR-konsult):

1. Bryter **SEPARATE_INVOICE** hyreskopplingen så att tillhandahållandet blir
   **momspliktigt (25 %)** i stället för momsfritt som hyran?
2. Ska **varmvatten** (uppvärmningskomponent) momsbehandlas/bokföras som värme
   (3920) eller som vatten (3970)?
3. **Bokslutsaccrualens brytdatum** vs 2-månaderslagen — är dagstakt-proration
   en godtagbar estimatgrund, och hur undviks dubbelredovisning?

Tills dessa är besvarade får **separatfaktura för bostad inte släppas skarpt** med
hårdkodad momsregel — `vatStatus` läses enbart från konfiguration (snapshot per
charge).

---

## 4. Etappindelning

### Etapp 1 — MANUELL, komplett (inget externt beroende)

Backend-motorn är **redan källagnostisk** (se §5) — etapp 1 bygger inget nytt
debiteringsflöde, utan **frontend + validering ovanpå den färdiga motorn**:

- **Frontend:** mätare per Unit, manuell avläsningsregistrering, tariffhantering,
  granska DRAFT→CONFIRM-charge, val av leveranssätt (avirad vs separat faktura),
  hyresgästens förbrukningsvy i portalen (uppfyller trepartens "följa sin
  förbrukning").
- **Validering:** självkostnad (inget påslag), beräkningsgrund dokumenterad per
  avtal (JB 12:19), GDPR-proportionerlig upplösning + 7-års arkivering.
- **Blockerare att stänga:** de tre momsfrågorna i `docs/legal/45` (FAR-konsult)
  innan SEPARATE_INVOICE för bostad släpps skarpt.

### Etapp 2 — AUTOMATISK insamlingsadapter (premium)

- En adapter-yta mot mätinsamlare som matar **samma `recordReading(source=API)`**
  — motorn är redan byggd för detta.
- Börja med **Elvaco (REST)** och/eller **Loggamera**; **Techem = filimport-
  adapter**; Infometric kräver partneravtal först. Överväg **fastAPI-standarden**
  som integrationskontrakt.
- Kräver **biträdesavtal** med leverantören (GDPR) och **partner-/API-villkor**
  (för Loggamera ännu okända — måste efterfrågas).
- Premium-paketering matchar konkurrensbilden (Hogia↔Loggamera-modellen).

---

## 5. Kodläget (per 2026-06-13)

- **IMD-motorn (consumption) PR1–5 mergad** — `apps/api/src/consumption/`.
- **Källagnostisk intake:** `recordReading()` tar `MANUAL / IMPORT / API`,
  idempotent (meterId+externalId), CUMULATIVE-differens + PERIOD_VOLUME, moms-
  snapshot, tariffhistorik, DRAFT→CONFIRM-charge, bokföring + bokslutsaccrual.
- **Frontend saknas helt** — det är etapp 1:s arbete.
- Källagnosticiteten är nyckeln: både manuell (etapp 1) och automatisk
  (etapp 2, `source=API`) går genom samma motor utan ombyggnad.

---

## 6. Etapp 1 — frontend-kartläggning & PR-plan (2026-06-15)

> Kartlagt via backend- + web- + portal-genomgång. Backend-API-ytan är
> tillräckligt detaljerad för att bygga mot utan gissningar. Detta avsnitt är
> **planeringsunderlag**, inte beslut.

### Hårda gränser för HELA Etapp 1 (gäller varje PR nedan)

1. **RÖR ALDRIG debiterings-/bokföringskedjan.** Etapp 1 är _enbart presentation
   ovanpå den färdiga motorn_. `recordReading()`, `confirmCharge()`,
   `attachRentNoticeLineCharges()`, `invoiceSeparateCharges()`,
   `runYearEndAccrual()` och all `accounting`-kontering är **orörda**. Frontend
   anropar dem via befintliga endpoints — bygger ingen ny domänlogik i kedjan.
2. **SEPARATE_INVOICE skarp för bostad = UTANFÖR scope.** Blockeras av de tre
   öppna momsfrågorna i `docs/legal/45-imd-forbrukningsdebitering-momsfragor.md`
   tills auktoriserad FAR-konsult svarat. UI får visa leveranssätt, men
   separatfaktura för bostad släpps inte skarpt med hårdkodad momsregel.
3. **Automatisk insamling (`source=API`) = Etapp 2**, inte nu. Etapp 1 är bara
   MANUAL-inmatning.
4. **cancelCharge-reverseringsPR** (retroaktiv momsrättning) = senare, egen PR
   (noterad av bokförings-/security-experterna i motorns PR3).

### Vad som redan är exponerat (frontend behöver inga nya kärn-endpoints)

`/v1/consumption/`-controllern exponerar redan hela kärnflödet:
`GET/POST /meters`, `GET /meters/:id`, `PATCH /meters/:id`;
`GET/POST /tariffs`; `GET/POST /readings`; `GET /charges`, `GET /charges/:id`,
`PATCH /charges/:id/confirm`; `POST /leases/:leaseId/invoice`;
`POST /year-end-accrual`. RBAC: läs = alla roller, muterande = MANAGER+,
bokslut = ACCOUNTANT+. DTO:er och datamodell är fullt kartlagda.
`attachRentNoticeLineCharges()` anropas **enbart internt** under
hyresavi-generering (`avisering.service.ts`) — **ingen frontend-knapp behövs**.

### Mönster att spegla

- **Web:** `apps/web/src/features/invoices/` är mallen (list + create + detail-
  modal + filterflikar + KPI-kort). API-lager = tunna `get/post/patch`-helpers;
  hooks = React Query med **disjunkta** nycklar (`['meters', filters]` för lista
  vs `['meter', id]` för detalj), mutation invaliderar både list och detalj.
  Route via `appPage('/consumption', …)` i `src/app/router.tsx`; nav-item i
  `components/layout/AppLayout.tsx` (NAV_FINANCE). Ingen consumption-frontend
  finns — grönfält.
- **Portal:** `apps/portal/src/pages/DocumentsPage/` är mallen. Portalen kör
  **CSS-moduler per vy** (`*.module.css`) + `styles/tokens.css` — _ingen_ global
  `ev-*`-klasskonvention. React Query finns. Phone-shell (max-width 480px, fixed
  bottom-nav), white `.card` på `#f0f4f0`, grön accent `#1a6b3c`, **ingen
  gradient** (bara Dashboard har gradient/AI-yta). En ny portal-endpoint
  `GET /portal/consumption` i `TenantPortalModule` **måste byggas** (finns ej).

### Rimlighetskontroll (validering)

- **Hård blockering finns redan:** CUMULATIVE lägre än föregående → `400`
  (mätarbyte) i `computeQuantity()` (`consumption.service.ts`). **Rör ej.**
- **Mjuk varning (orimligt hög):** läggs i **frontend** som icke-blockerande
  amber-låda i avläsningsformuläret (`border-amber-200 bg-amber-50 text-amber-800`
  - `AlertTriangle`, `role="note"`) — mönstret finns i `ChangePasswordPage`/
    `CollectionsPage`. **INTE** i DTO (cross-field/historik-beroende passar inte
    class-validator) och **INTE** blockerande i backend (en korrekt men hög
    avläsning ska aldrig avvisas). Inget numeriskt threshold-mönster finns idag.

### Backend-glue som behövs (litet)

- `GET /readings` filtrerar i dag **bara** på `meterId` — för snävt för en
  listvy. Utöka `findReadings`-filter till `{ meterId?, unitId?, periodStart?,
periodEnd? }` (`MeterReading` har redan dessa fält). Liten isolerad ändring.
  **Detta är HELA PR 1.1** — inget mer.
- Preview-delta (föregående värde + delta för varningens tröskel) är **borttaget
  från 1.1** (code-review-beslut: enda konsumenten är 1.4:s amber-varning, och
  tröskeln kan ev. beräknas från listvyn utan extra rundtripp). Utvärderas — och
  byggs bara om det behövs — **i 1.4**, inte tidigare.

### Gap-lista (vad som saknas för komplett manuell förbrukning)

**Backend (små tillägg):**

1. `GET /readings` saknar `unitId`/period-filter (= PR 1.1).
2. Ny portal-endpoint `GET /portal/consumption` i `TenantPortalController` (finns
   inte alls; ägs av PR 1.6, ej @Public).
3. Preview-/delta-fält för varningens tröskel — endast vid behov, i 1.4 (ej 1.1).
4. (Senare, egen PR) `ConsumptionCharge` i `deleteTenantAccount`-flödet:
   pseudonymisera `tenantId`, behåll raden för BFL 7 år (räkenskapsunderlag).

**Web (grönfält — allt saknas):** 4. Hela `features/consumption/` (api/hooks/page/forms). 5. Route + nav-item. 6. Fyra UI-ytor: mätare (CRUD/unit), avläsningar (registrera + lista),
tariffer (skapa + historik), charges (granska DRAFT→confirm→leverans). 7. Mjuk rimlighetsvarning i avläsningsformuläret. 8. Inmatnings-UX: unit→mätare→aktiv lease-koppling, CUMULATIVE/PERIOD_VOLUME-val,
periodväljare.

**Portal (saknas helt):** 9. `pages/ConsumptionPage/` + portal-API-helper + typ + nav-item (hyresgästen
följer sin förbrukning — trepartskravet).

### PR-plan — en sak per PR (granskad av bokforings-expert + security-auditor + code-reviewer 2026-06-15)

| PR      | Innehåll                                                                                                                                                    | Beror på |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **1.1** | Backend-glue: utöka `findReadings`-filter (`unitId`/`periodStart`/`periodEnd`). Ingen ny domänlogik.                                                        | —        |
| **1.2** | Web: mätare + feature-grund. `features/consumption/`-skelett + MeterForm (CRUD/unit) + route + nav-item.                                                    | 1.1      |
| **1.3** | Web: tariffer. Lista (validFrom/validTo-historik) + TariffForm (scope ORG/PROPERTY/UNIT).                                                                   | 1.2      |
| **1.4** | Web: avläsningar. Lista (filter unit/period) + ReadingForm (CUMULATIVE/PERIOD_VOLUME, periodväljare) + mjuk amber-varning.                                  | 1.2      |
| **1.5** | Web: charges-granskning. Lista CONFIRMED/ATTACHED/INVOICED (+DRAFT internt), detalj-modal, "Bekräfta och bokför"-knapp, leveranssätt som **statisk badge**. | 1.4      |
| **1.6** | Portal: hyresgästens förbrukningsvy. Backend `GET /portal/consumption` (i `TenantPortalController`) + ConsumptionPage (DocumentsPage-mönster) + nav.        | 1.2      |

**Ordning (skärpt):** `1.1 → 1.2 → {1.3 ‖ 1.4} → 1.5 → 1.6`. 1.5 beror reellt på
1.4 (kan ej granska charges utan att kunna skapa avläsningar som ger dem) — "1.3–1.6
valfri ordning" var fel. 1.3 och 1.4 är parallella efter 1.2; 1.6 kan köras parallellt
när som helst efter 1.2. Varje PR självständigt verifierbar, följer "föreslå/bekräfta",
rör aldrig debiterings-/bokföringskedjan.

#### Granskningsbeslut per berörd PR (måste implementeras — inte valbart)

**PR 1.1 — code-review:**

- Endast `findReadings`-filtret. **Preview-delta borttaget** (flyttat till 1.4 vid
  behov). Håll PR:n minimal — det är dess styrka; alla web-PR:er beror på den.

**PR 1.2 — code-review:**

- **api/hooks per subdomän:** `meters.api.ts`, `tariffs.api.ts`, `readings.api.ts`,
  `charges.api.ts` (+ motsv. hooks-filer) — INTE en gemensam `consumption.api.ts`.
  Förhindrar merge-konflikt när 1.3/1.4/1.5 byggs parallellt.
- **`/consumption` = EN route med interna flikar** (mätare/tariffer/avläsningar/
  charges som tabbar i `ConsumptionPage`, ej subroutes typ `/consumption/meters`).
  `router.tsx` + `AppPath`-unionen + `AppLayout`-nav rörs **bara i 1.2** — aldrig i
  1.3/1.4/1.5. Speglar `InvoicesPage`/`AviseringPage`.
- Query-nycklar disjunkta list/detalj per `feedback_query_keys`.

**PR 1.3 — bokforings-expert:**

- TariffForm har fält **"Beräkningsgrund"** (fritext) — JB 12:19 kräver att grunden
  för vidaredebitering anges per avtal; hyresnämnden kan begära underlag.

**PR 1.5 — bokforings-expert (HÅRDA krav):**

- Confirm-knappen TRIGGAR bokföring (`createJournalEntryForConsumptionCharge`:
  1510 D / 3920|3970 K + ev. 2611). Den är en **bokföringsåtgärd, inte
  presentation** → UI-text **"Bekräfta och bokför"** (RBAC MANAGER+ oförändrad).
- **Separat-faktura-knappen byggs INTE alls** i Etapp 1 — varken aktiv eller
  inaktiverad. `POST /leases/:leaseId/invoice` exponeras inte i UI. Leveranssätt
  `SEPARATE_INVOICE` visas som **statisk badge** + info-text "Faktura genereras i
  ett kommande steg när juridisk granskning är klar" (förhindrar momsfel
  EXEMPT-bostadsfaktura + manuell parallell dubbeldebitering). Fakturerings-UI
  grindas på besvarad Fråga 1 i `docs/legal/45`.
- Frontend **räknar ALDRIG om belopp** — läser `totalAmount`/`netAmount`/
  `vatAmount`/`vatRate` direkt från charge-objektet (= det bokförda verifikatet).
  Aldrig `quantity × pricePerUnit × …` i klienten.
- Confirm-mutationens `onSuccess` invaliderar **både** `['charges']` och
  `['charge', id]` (annars inaktuell status i öppen detaljmodal).

**PR 1.6 — security-auditor (HÅRDA krav, GDPR — förbrukning = personuppgift):**

- Äger **både** backend (`GET /portal/consumption` i `TenantPortalController`,
  som har `@UseGuards(TenantAuthGuard)`) **och** portal-frontend. Lägg den ALDRIG
  i `TenantAuthController` (`@Public`).
- **Scope-nyckel = `tenantId` från `@CurrentTenant()`** i varje query — aldrig
  `leaseId`/`unitId`/`organizationId` från query-param (IDOR). `unitId` ensam =
  läcka mellan tidigare/nuvarande boende i samma lägenhet.
- Returnera **`ConsumptionCharge`** (redan tenant-scopat + aggregerat per period),
  **inte** `MeterReading` (saknar `tenantId`, rå granularitet = GDPR-läcka + IDOR-risk).
- **Response-DTO med explicit `select`** som döljer interna fält: `organizationId`,
  `deliveryMode`, `invoiceId`, `meterReadingId`, `vatStatus`, `vatRate` och
  (beslut) ev. `pricePerUnit` (marginal/inköpspris). Visa: `meterType`, `quantity`,
  `unitOfMeasure`, `periodStart/End`, `netAmount`, `vatAmount`, `totalAmount`.
- **Dölj `DRAFT`** — visa endast `CONFIRMED`/`ATTACHED`/`INVOICED` (status: notIn DRAFT).
- Periodupplösning (ej dags-/timvärden) räcker GDPR-proportionalitet i Etapp 1.

**Erasure (senare, egen PR — security-auditor):** inkludera `ConsumptionCharge` i
`deleteTenantAccount` — pseudonymisera `tenantId`, **behåll raden** (räkenskaps-
underlag, BFL 7 år, jmf `InvoiceEvent`). Skapa ticket nu, lös separat.

**Utanför Etapp 1 (bekräftat av experterna):** `year-end-accrual`-UI (kräver egen
kontext-UI + öppen Fråga 3 i `docs/legal/45`), skarp SEPARATE_INVOICE-bostadsfaktura,
`source=API`-insamling (Etapp 2), cancelCharge-reverseringsPR.
</content>
