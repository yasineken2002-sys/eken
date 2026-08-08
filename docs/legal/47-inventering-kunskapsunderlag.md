# 47 — Inventering av juridiska och bokföringsmässiga sakpåståenden i kunskapsunderlaget

**Ärende:** #377
**Upprättad:** 2026-08-07
**Status:** underlag för mänsklig verifiering — **ingen post är bedömd**

## Vad den här listan är

En mekanisk inventering av varje juridiskt och bokföringsmässigt sakpåstående i de underlag som matar AI-assistenten, specialistagenterna och RAG-korpusen, samt i `docs/legal/`.

Listan finns för att **en människa ska kunna verifiera påståendena mot primärkällor**, post för post. Den är avsedd att uppdateras löpande allteftersom verifieringen kommer in — därför lever den som fil i repot och inte som en ärendekommentar: en fil går att bocka av och att diffa.

## Vad den här listan INTE är

**Ingen post är bedömd.** Inget påstående har jämförts mot lagtext, och inget har rättats. Det är avsiktligt: att kontrollera underlagen med hjälp av samma underlag är precis den cirkularitet #377 beskriver. Bakgrunden är att `.claude/agents/bokforings-expert.md` och `.claude/knowledge/standarder/bas-kontoplan.md` pekade på en förordning som upphävdes 2013-03-16, och att FAR-agenten hann granska ett helt arbetsdygn med det i sitt underlag utan att något fångade det.

## Hur klassificeringen gjordes

Rent mekaniskt, med reguljära uttryck:

| Hög   | Kriterium                                                                                |
| ----- | ---------------------------------------------------------------------------------------- |
| **A** | Rad som innehåller **både** en namngiven författning (eller SFS-nummer) **och** `§`      |
| **B** | Rad som innehåller det ena men inte det andra                                            |
| **C** | Rad med belopp, frist, procentsats eller kontonummer **utan** någon författningsreferens |

**Kända felkällor i klassificeringen** — de är mekanikens, inte påståendenas:

- Hög A kräver att författning och `§` står på **samma rad**. Ett påstående vars paragraf står på raden före hamnar i B.
- Hög C fångar varje fyrsiffrigt tal i intervallet 1000–8999, vilket gör att årtal (`2024`, `2026`) och tokenantal (`2048`) hamnar där. Sådana falska träffar är kvar i listan — att plocka bort dem vore en bedömning.
- Undergrupperna i C är satta med samma metod. C4b ("redovisningsbehandling") kräver ett verb eller en pil i raden; C4a är resten.

Lagtextfilerna i `.claude/knowledge/lagar/` är **reproduktioner** av författningstext, inte påståenden om rätten, och är därför inte inventerade paragraf för paragraf. Det verifierbara påståendet där är metadatahuvudets, och det redovisas i egen sektion.

## Klassificering

| Hög | Kriterium                                                   |   Antal |
| --- | ----------------------------------------------------------- | ------: |
| A   | Åberopar namngiven författning **med** paragraf             |      75 |
| B   | Åberopar författning **utan** paragraf, eller bara vid namn |     137 |
| C   | Sakpåstående **utan angiven källa**                         |     370 |
|     | **Totalt**                                                  | **582** |

### Hög C stratifierad (mekaniskt, för triage)

| Undergrupp                 | Antal | Innebörd                                                          |
| -------------------------- | ----: | ----------------------------------------------------------------- |
| C1 belopp i kronor         |    23 | Ett belopp påstås                                                 |
| C2 frist/tidsgräns         |    40 | En tidsfrist påstås                                               |
| C3 procentsats             |    38 | En sats påstås                                                    |
| C4a kontonamn/nummer       |   179 | Vad ett konto heter eller vilket nummer det har — avskrift av BAS |
| C4b redovisningsbehandling |    76 | **När** ett konto ska användas, eller vilken motpost som gäller   |
| C5 säkerhetsklassning      |    14 | CWE/OWASP-koder och statistik                                     |

C1–C3 (101 poster) och C4b (76 poster) är de substantiella påståendena utan angiven källa. C4a är kontoplanens tabeller.

## Yta 5 — RAG-korpusen i produktion

Tabell `LegalChunkEmbedding`, mätt mot prod 2026-08-07: **560 chunks, 6 författningar**, samtliga inbäddade 2026-06-10.

| lawId                | SFS       | Chunks |
| -------------------- | --------- | -----: |
| bostadsrattslagen    | 1991:614  |    156 |
| mervardesskattelagen | 1994:200  |    140 |
| hyreslagen           | 1970:994  |    102 |
| diskrimineringslagen | 2008:567  |     87 |
| bokforingslagen      | 1999:1078 |     62 |
| ranteslagen          | 1975:635  |     13 |

Korpusen härrör från filerna i `.claude/knowledge/lagar/` nedan. **Citationsintegriteten hindrar påhittade lagrum men säger ingenting om upphävda eller ändrade** — ett lagrum som verkligen fanns 2026-05-29 citeras med full trovärdighet även om det ändrats sedan dess.

> **Utfall 2026-08-08 (#382):** raden ovan beskrev en risk. Den realiserades.
> `mervardesskattelagen` (1994:200) upphävdes 2023-07-01 och ersattes av
> 2023:200 med ny struktur och andra paragrafnummer — verifierat mot
> primärkällor av människa. Uppmätt före borttagningen svarade relevansdomaren
> **JA** (3/3) på ML-chunkar för en momsfråga, varpå koden hade tryckt
> källraden "SFS 1994:200, gällande lydelse verifierad 2026-05-29". En ren
> bruksvärdesfråga (`hyressattning-bruksvarde`) grundades dessutom med
> `mervardesskattelagen:10` bland källorna. Ingen sådan fråga hade ställts i
> prod (0 `legal-judge`-anrop t.o.m. 2026-08-07), så exponeringen var latent.
> Lagen är borttagen ur korpusen; korpusen är nu **420 chunks, 5
> författningar**. Ingen ersättningstext har lagts in — 2023:200 kräver
> människoverifiering först. Momsfrågor besvaras därför med ärlighetsblocket
> och hänvisning till revisor.

## Yta 1b — lagtextfilerna (reproduktioner, ej härledda påståenden)

Dessa filer är kopior av författningstext, inte påståenden **om** rätten. Det verifierbara påståendet är metadatahuvudets: att texten var gällande lydelse per angivet datum, hämtad från angiven källa. Varje fil bär en `verifierad_per`-stämpel.

| Fil                         | SFS          | verifierad_per | §-rubriker | Källa                                                  |
| --------------------------- | ------------ | -------------- | ---------: | ------------------------------------------------------ |
| bokforingslagen.md          | 1999:1078    | 2026-05-29     |         62 | lagen.nu                                               |
| bostadsrattslagen.md        | 1991:614     | 2026-05-29     |        156 | lagen.nu                                               |
| diskrimineringslagen.md     | 2008:567     | 2026-05-29     |         87 | lagen.nu                                               |
| hyreslagen.md               | 1970:994     | 2026-05-29     |        102 | lagen.nu (K12)                                         |
| ~~mervardesskattelagen.md~~ | ~~1994:200~~ | ~~2026-05-29~~ |    ~~140~~ | BORTTAGEN 2026-08-08 (#382) — lagen upphävd 2023-07-01 |
| ranteslagen.md              | 1975:635     | 2026-05-29     |         13 | lagen.nu                                               |

Två observationer, utan bedömning:

- Samtliga sex bär **samma** `verifierad_per` (2026-05-29) — de verifierades vid ett tillfälle, inte löpande.
- `mervardesskattelagen.md` anger i titeln "utvalda kapitel". Vilka kapitel som utelämnats framgår inte av huvudet.
- Filnamnet är `ranteslagen.md`; författningen heter Räntelagen.

## Hög A

### `.claude/agents/bokforings-expert.md`

- **rad 10** — åberopar: Hyreslagens, K2, K3, ML
  > Du är auktoriserad av FAR (Föreningen Auktoriserade Revisorer), har 20+ års erfarenhet inom svensk redovisning med specialisering på fastighetsförvaltning. Tidigare partner på BDO och redovisningschef för en av Sveriges största kommersiella fastighetskoncerner. Du har granskat hundratals årsredovisningar enligt K2 och K3, deklarerat moms enligt voluntary tax liability-reglerna i ML 3 kap 3 §, och
- **rad 12** — åberopar: Bokföringslagen
  > Du är **inte** en bokföringsbyråkrat som sätter regler framför verksamhet. Du är en pragmatiker som vet att en god redovisning ska vara begriplig, granskningsbar och i exakt enlighet med Bokföringslagen — varken mer eller mindre. Din ledstjärna är **god redovisningssed** (Bokföringslagen 4 kap 2 §): tydlighet, kontinuitet, försiktighet, konsekvens.
- **rad 25** — åberopar: ML — belopp/frist: 25%
  > - **Moms:** Bostadshyra är **undantagen** från moms (ML 3 kap 2 §). Kommersiell uthyrning är skattefri som default — men kan bli **frivillig skattskyldighet** (ML 3 kap 3 § + 9 kap) om hyresvärd ansöker. Då 25% moms på hyra och möjlighet till avdrag för ingående moms.
- **rad 26** — åberopar: Räntelagen — belopp/frist: 8 procentenhet
  > - **Räntelagen:** Dröjsmålsränta på sena hyror = referensränta + 8 procentenheter (Räntelagen 6 §).
- **rad 28** — åberopar: BFL — belopp/frist: 7 år
  > - **Arkivering:** Räkenskapsinformation ska bevaras i 7 år enligt BFL 7 kap 2 §. Detta påverkar varför vi har `onDelete: Restrict` på vissa Prisma-relationer (se `tidigare-buggar.md` FIX 3).
- **rad 42** — åberopar: BFL, ML
  > Hänvisa **alltid** till specifika paragrafer (t.ex. "BFL 5 kap 6 §" eller "ML 3 kap 2 §") i dina rapporter — aldrig vaga referenser till "lagen säger".
- **rad 54** — åberopar: BFL
  > ### 2. Verifikationskrav (BFL 5 kap 6-9 §)
- **rad 104** — åberopar: RL, Räntelagen
  > ### 7. Räntelagen (RL 6 §)
- **rad 107** — åberopar: RL
  > - Referensränta sätts av Riksbanken halvårsvis (RL 9 §). Hårdkoda inte — hämta aktuell.
- **rad 109** — åberopar: 1981:1057, 1981:739, Inkassoförordningen, Räntelagen — belopp/frist: 1057, 180 kr, 1981, 2013, 60 kr
  > - Påminnelse-/inkassoavgifter (60 kr per påminnelse, 180 kr inkassokrav) regleras av 4 § lagen (1981:739) om ersättning för inkassokostnader — separat från Räntelagen. Taket är tvingande även mot näringsidkare (6 § 1 st). Inkassoförordningen (1981:1057) är UPPHÄVD sedan 2013-03-16.
- **rad 180** — åberopar: BFL
  > **Lagstöd:** BFL 5 kap 6 § (verifikationens innehåll)
- **rad 219** — åberopar: BAS, BFL — belopp/frist: 2024
  > **Lagstöd:** BFL 5 kap 6 § (verifikationens innehåll), BAS 2024 (konteringsval).
- **rad 257** — åberopar: BFL, BFN
  > - **Alltid** hänvisa till lagrum (BFL X kap Y §) eller BFN-rådgivning i varje fynd. Inga vaga "lagen säger".
- **rad 260** — åberopar: ML
  > - **Alltid** kontrollera moms-flöden mot ML 3 kap 2 § (bostadsundantag) och ML 9 kap (frivillig skattskyldighet).
- **rad 262** — åberopar: BFL
  > - **Alltid** kontrollera arkivering: 7 års retention enligt BFL 7 kap 2 §. Sök `onDelete: Cascade` på dessa modeller — det är en bug.

### `.claude/agents/hyresjurist.md`

- **rad 12** — åberopar: JB
  > Du är **inte** en juridisk nitpicker. Du är en pragmatiker som vet att svensk hyresrätt är **tvingande till hyresgästens förmån** (JB 12 kap 1 § 5 st) — avtalsklausuler som försämrar för hyresgästen är ogiltiga, oavsett vad parterna skrev. Din uppgift är att se till att Eveno producerar avtal och flöden som **håller i hyresnämnd och i Hovrätt**.
- **rad 19** — åberopar: JB
  > - Förverkandegrunder och rätten till rättelseanmaning (JB 12 kap 42-44 §)
- **rad 20** — åberopar: JB
  > - Bruksvärdesprincipen vid hyreshöjningar (JB 12 kap 55 §)
- **rad 44** — åberopar: 2008:567, Diskrimineringslagen — belopp/frist: 2008
  > 3. `/workspaces/eken/.claude/knowledge/lagar/diskrimineringslagen.md` — Diskrimineringslagen (2008:567) — särskilt 2 kap 12 § om bostad
- **rad 49** — åberopar: BRL, JB
  > Hänvisa **alltid** till specifika paragrafer (t.ex. "JB 12 kap 42 § 1 st p 1" eller "BRL 7 kap 18 §") — aldrig vaga referenser.
- **rad 57** — åberopar: JB — belopp/frist: 70%
  > - Bostad eller lokal? (JB 12 kap 1 § 4 st — bostad om åtminstone 70% används som bostad)
- **rad 58** — åberopar: JB
  > - Förstahands- eller andrahandsuthyrning? (Andrahandsuthyrning kräver hyresvärdens samtycke, JB 12 kap 39-40 §)
- **rad 59** — åberopar: JB
  > - Tidsbestämt eller tillsvidareavtal? (JB 12 kap 3 §)
- **rad 60** — åberopar: JB — belopp/frist: 9 månader
  > - Korttidsuthyrning < 9 månader bostad? (Då vissa undantag enligt JB 12 kap 45 § sista st)
- **rad 64** — åberopar: JB
  > ### 2. Formkrav på avtal (JB 12 kap 2 §)
- **rad 73** — åberopar: JB
  > - **Förstahandsbostad:** Bruksvärdesprincipen (JB 12 kap 55 §). Hyran ska motsvara hyran för jämförbara lägenheter i orten (förhandlat med Hyresgästföreningen för allmännyttan, eller fri marknadshyra för privat ägd).
- **rad 74** — åberopar: JB — belopp/frist: 15 år, 2006
  > - **Nyproducerad bostad (efter 2006):** Presumtionshyra under 15 år (JB 12 kap 55 c §). Kan avtalas fritt, sedan bruksvärdesprövning.
- **rad 80** — åberopar: JB
  > - **Bostad förstahand (privat):** Förhandling med hyresgäst direkt. Vid oenighet — hyresnämnd. Höjning kräver 1 månads varsel (JB 12 kap 54 §).
- **rad 82** — åberopar: JB
  > - **Lokal:** Fritt om båda parter enas. Vid oenighet och tillsvidareavtal — uppsägning + nytt avtal till nya villkor. Indirekt besittningsskydd skyddar hyresgäst (JB 12 kap 57-60 §).
- **rad 89** — åberopar: JB
  > **Uppsägningsformer (JB 12 kap 8 §):**
- **rad 96** — åberopar: JB
  > **Uppsägningstider — bostad (JB 12 kap 4-5 §):**
- **rad 102** — åberopar: JB
  > **Uppsägningstider — lokal (JB 12 kap 4 §):**
- **rad 108** — åberopar: JB
  > **Hyresvärdens uppsägningsgrunder (JB 12 kap 46 §, för bostad):**
- **rad 114** — åberopar: JB
  > ### 6. Förverkande (JB 12 kap 42-44 §)
- **rad 137** — åberopar: DL, Diskrimineringslagen
  > ### 8. Diskrimineringslagen (DL 2 kap 12 §)
- **rad 148** — åberopar: JB
  > - Avtalsklausul försämrar för bostadshyresgäst (JB 12 kap 1 § 5 st — ogiltig)
- **rad 151** — åberopar: DL
  > - Diskriminerande hyresgästurval (DL 2 kap 12 §)
- **rad 160** — åberopar: JB
  > - Saknad besittningsskyddsklausul i lokalhyresavtal (frivilligt avstående kräver hyresnämndsgodkännande, JB 12 kap 56 §)
- **rad 161** — åberopar: JB
  > - Påminnelseflöde missar rättelseanmaning innan förverkande (störningar — JB 12 kap 25 §)
- **rad 162** — åberopar: JB
  > - Hyreshöjningsbrev saknar de uppgifter som krävs enligt JB 12 kap 54 a §
- **rad 205** — åberopar: JB
  > **Lagrum:** JB 12 kap 42 § 1 st p 1 — förverkande pga betalningsdröjsmål
- **rad 218** — åberopar: JB
  > **Problem:** Denna klausul är **ogiltig** enligt JB 12 kap 1 § 5 st eftersom den försämrar hyresgästens ställning jämfört med JB 12 kap 42-44 §. Förverkande får inte ske utan rättelseanmaning och socialnämndsanmaning.
- **rad 226** — åberopar: JB
  > - JB 12 kap 1 § 5 st (tvingande till hyresgästens förmån)
- **rad 227** — åberopar: JB
  > - JB 12 kap 42 § (förverkandegrunder)
- **rad 228** — åberopar: JB
  > - JB 12 kap 44 § (anmälan till socialnämnd, rättelsefrist)
- **rad 253** — åberopar: JB
  > - **Aldrig** föreslår klausul som försämrar för bostadshyresgäst. Tvingande regler kan **inte** avtalas bort (JB 12 kap 1 § 5 st).
- **rad 256** — åberopar: DL
  > - **Aldrig** rekommenderar diskriminerande hyresgästurval, även om hyresvärd "har frihet att välja". DL 2 kap 12 § gäller.
- **rad 265** — åberopar: BRL, JB, RL
  > - **Alltid** hänvisa till lagrum (JB 12 kap X §, BRL Y kap Z §, RL §) eller praxis (NJA, RH, hyresnämndsbeslut) i varje fynd.
- **rad 268** — åberopar: JB
  > - **Alltid** verifiera uppsägningsfristerna mot JB 12 kap 4-5 §. Förväxla inte bostad (3 mån) med lokal (9 mån).
- **rad 269** — åberopar: JB
  > - **Alltid** kontrollera förverkandeflöden mot JB 12 kap 42-44 §. Kräver rättelseanmaning + socialnämndsanmälan + frist.
- **rad 270** — åberopar: JB
  > - **Alltid** verifiera att hyreshöjningar har korrekt varsel (JB 12 kap 54 §) och innehåller obligatoriska uppgifter (54 a §).
- **rad 272** — åberopar: DL
  > - **Alltid** verifiera diskrimineringsneutralitet i hyresgästurvalsflöden (DL 2 kap 12 §).
- **rad 316** — åberopar: JB
  > Vid osäkerhet: säg det. "Klausulen är gränsfall mot JB 12 kap 19 § — rekommenderar juridisk second opinion av specialiserad hyresrättsadvokat" är legitimt.

### `.claude/agents/security-auditor.md`

- **rad 91** — åberopar: Bokföringslagen — belopp/frist: 7 år
  > - Hyresgästers PII raderas vid kontoborttagning? (Right to erasure — Art 17.) Eller pseudonymiseras för bibehållen bokföringsplikt (7 år enligt Bokföringslagen 7 kap 2 §)?

### `.claude/knowledge/eveno/design-decisions.md`

- **rad 60** — åberopar: Bokföringslagen — belopp/frist: 7 år
  > - **Bokföringslagen 7 kap 2 §** kräver bevarande av räkenskapsinformation i 7 år
- **rad 217** — åberopar: BFL
  > - **BFL 5 kap 6-9 §** kräver att verifikationer ska kunna spåras och är immutable de facto

### `.claude/knowledge/eveno/tidigare-buggar.md`

- **rad 117** — åberopar: Bokföringslagen — belopp/frist: 7 år
  > Prisma-schemat hade `onDelete: Cascade` på relationen `Invoice → InvoiceEvent`. När en faktura raderades försvann hela händelseloggen för den fakturan. Detta bröt mot **Bokföringslagen 7 kap 2 §** (räkenskapsinformation ska bevaras i 7 år) och tog bort vår audit-trail.

### `.claude/knowledge/standarder/bas-kontoplan.md`

- **rad 137** — åberopar: ML — belopp/frist: 2611, 3911
  > - **Bostadshyra** (ML 3 kap 2 §) → **ingen** moms. Endast 3911, ingen 2611.
- **rad 310** — åberopar: 1981:739 — belopp/frist: 1981, 60 kr
  > (Påminnelseavgift har särskild status i 4 § lagen (1981:739) — max 60 kr.

### `apps/api/src/ai/ai-assistant.service.ts`

- **rad 200** — åberopar: JB
  > (t.ex. "12 kap 20 § JB") eller ett exakt belopp som om du vet det säkert.

### `docs/legal/44-digital-delgivning-beslutsunderlag.md`

- **rad 1** — åberopar: JB
  > # Beslutsunderlag: Helt digital delgivning av hyreshöjning (JB 12 kap 54 a §)
- **rad 5** — åberopar: 2010:1045, 2010:1932, 2016:561, JB — belopp/frist: 1045, 1932, 2010, 2014, 2016
  > > **Rättskällor:** JB 12 kap 54 §, 54 a §, 63 §; Delgivningslagen (2010:1932); eIDAS-förordningen (EU) 910/2014; eIDAS-kompletteringslagen (2016:561); Posttjänstlagen (2010:1045)
- **rad 12** — åberopar: JB
  > Nuvarande implementation — e-post utan kvittens → omedelbart `NOTICE_SENT` — är **juridiskt otillräcklig**. Presumtionen i JB 12 kap 63 § inträder inte, tystnadens bindande verkan (54 a § 3 st) inträder inte, och systemet skapar hyreshöjningar som **riskerar att vara ogiltiga**.
- **rad 20** — åberopar: JB
  > ## Kärnproblemet — JB 12 kap 63 §
- **rad 22** — åberopar: JB
  > JB 12 kap 63 § är grundregeln för meddelandedelgivning i hyresförhållanden och täcker uttryckligen 54 § och 54 a §:
- **rad 36** — åberopar: JB
  > Gäller endast delgivning i mål/ärenden hos domstolar och myndigheter (1 §). **Inte** privata hyresvärd–hyresgäst-relationer. E-delgivning (Kivra/Min myndighetspost i myndighetsroll) är därför **inte tillämplig**. Frågan måste lösas helt inom JB 12 kap 63 §.
- **rad 67** — åberopar: JB
  > 63 § är sannolikt en **processuell bevislättnadsregel** (dispositiv), inte tvingande materiellt skydd → kan i princip avtalas. En förhandssamtyckesklausul (digital kanal) stärker hyresvärdens motbevis. **Risk:** osäkert om det håller mot JB 12 kap 1 § 5 st om hyresgästen bestrider att digital kanal ger sämre skydd.
- **rad 128** — åberopar: JB
  > 8. **Förhandssamtyckesklausulens giltighet** mot JB 12 kap 1 § 5 st.
- **rad 136** — åberopar: JB
  > 4. Håller en förhandssamtyckesklausul om digital leveranskanal, eller är den ogiltig mot JB 12 kap 1 § 5 st?

### `docs/legal/45-imd-forbrukningsdebitering-momsfragor.md`

- **rad 20** — åberopar: ML
  > Momsdefault för bostad är `EXEMPT` (momsfri, ML 3 kap 2 § 2 st). Snapshotas på
- **rad 28** — åberopar: ML
  > momsfrihet (ML 3 kap 2 §). När el/vatten faktureras **skilt** från hyran

### `docs/legal/46-inkasso-hyra-pamminnelse.md`

- **rad 23** — åberopar: 1981:739 — belopp/frist: 1981
  > `rentReminderDay`). Lagstöd: 4 § lagen (1981:739) om ersättning för inkassokostnader.
- **rad 45** — åberopar: ML
  > Bostadshyra är momsfri (ML 3 kap 2 §) → ingen utgående moms, ingen

### `docs/legal/cookie-policy.md`

- **rad 25** — åberopar: 2003:389 — belopp/frist: 2003
  > Reglerna om cookies finns i 6 kap. 18 § lag (2003:389) om elektronisk

### `docs/legal/privacy-policy.md`

- **rad 174** — åberopar: Bokföringslagen — belopp/frist: 7 år
  > | Fakturaunderlag och bokföring | 7 år från räkenskapsårets utgång | Bokföringslagen 7 kap. 2 § |

## Hög B

### `.claude/agents/ai-architect.md`

- **rad 16** — åberopar: BAS, JB
  > Och du glömmer aldrig att **Eveno är svenskt**. Modellen ska resonera på svenska, förstå svensk fastighets- och bokföringskontext (BAS-konton, OCR-nummer, JB 12 kap, momsregler) och producera svenska svar som håller Fortnox-standard.
- **rad 41**
  > - **Human-in-the-loop:** AI får föreslå/förbereda kritiska affärsbeslut, inte exekvera dem ensidigt (FIX 7-principen; jfr hyreshöjning som måste gå via 54 a §-flödet).

### `.claude/agents/bokforings-expert.md`

- **rad 3** — åberopar: BAS, Bokföringslagen, K2, K3
  > description: Auktoriserad Redovisningskonsult (FAR) specialiserad på Bokföringslagen, BAS-kontoplanen och svensk fastighetsredovisning. Granskar bokföringsflöden, kontering, momshantering, verifikationskedjor och arkiveringsregler i Eveno. Anropa vid varje ändring av AccountingModule, JournalEntry, Invoice-flöden, momsberäkning eller rapporter (BR, RR, momsdeklaration, K2/K3).
- **rad 14** — åberopar: BFN
  > Ditt jobb i Eveno är att säkerställa att systemet producerar bokföring som **håller för Skatteverkets granskning, BFN:s allmänna råd, och en revisor som ska skriva på årsredovisningen**.
- **rad 18** — åberopar: K2, K3
  > - **Målgrupp:** Svenska hyresvärdar och fastighetsbolag (privata, kommersiella, BRF). Slutanvändaren är revisor eller redovisningskonsult som ska kunna lyfta data direkt till K2/K3-årsredovisning och momsdeklaration.
- **rad 21** — åberopar: BFL
  > - `InvoiceEvent` — **append-only audit log** för fakturahändelser. Aldrig UPDATE/DELETE. Detta är vår "verifikationskedja" enligt BFL 5 kap.
- **rad 22** — åberopar: BAS
  > - `Account` — BAS-konto (1xxx tillgångar, 2xxx skulder, 3xxx intäkter, 4-7xxx kostnader, 8xxx finansiella).
- **rad 24** — åberopar: BAS — belopp/frist: 2024
  > - **BAS-kontoplan:** BAS 2024. Vanligast använda konton för fastighet finns i `standarder/bas-kontoplan.md`.
- **rad 34** — åberopar: 1999:1078, Bokföringslagen — belopp/frist: 1078, 1999
  > 1. `/workspaces/eken/.claude/knowledge/lagar/bokforingslagen.md` — Bokföringslagen (1999:1078) — verifikationer, arkivering
- **rad 36** — åberopar: Räntelagen
  > 3. `/workspaces/eken/.claude/knowledge/lagar/ranteslagen.md` — Räntelagen — dröjsmålsränta
- **rad 37** — åberopar: BAS — belopp/frist: 2024
  > 4. `/workspaces/eken/.claude/knowledge/standarder/bas-kontoplan.md` — BAS 2024 (fastighetsfokus)
- **rad 75** — åberopar: BAS
  > - Kontering följer BAS:
- **rad 83** — åberopar: ML
  > ### 4. Momshantering (ML 3 kap)
- **rad 89** — åberopar: ML — belopp/frist: 25%, 2641
  > - Importerad faktura från leverantör: kontera 2641 Ingående moms 25% om vi är momsregistrerade och har avdragsrätt (ML 8 kap).
- **rad 97** — åberopar: BFL
  > ### 6. Arkivering & immutabilitet (BFL 7 kap)
- **rad 123** — åberopar: Bokföringslagen
  > ### CRITICAL — fixa omedelbart, brott mot Bokföringslagen
- **rad 151** — åberopar: BAS
  > - Konto-namngivning avviker från BAS (men kontonummer är korrekt)
- **rad 157** — åberopar: BAS — belopp/frist: 1510, 1511
  > Avvikelser från praxis som inte är fel men värda att överväga (t.ex. "Konto 1511 används istället för 1510 för kundfordringar — fungerar men 1510 är vanligare i BAS").
- **rad 167** — åberopar: 1994:200, 1999:1078, BAS, BFL, K2, K3, ML — belopp/frist: 1078, 1994, 1999, 2024
  > **Standard:** BAS 2024, K2/K3, BFL 1999:1078, ML 1994:200
- **rad 173** — åberopar: BFL, ML
  > **Verdict:** ✅ Godkänd / ⚠️ Godkänd med villkor / ❌ Avvisa — bryter mot BFL/ML
- **rad 181** — åberopar: BAS — belopp/frist: 1510, 1511, 2024
  > **Standard:** BAS 2024 — konto 1510 vs 1511
- **rad 234** — åberopar: ML
  > - [ ] Implementera frivillig skattskyldighet på lokal-nivå (ML 9 kap)
- **rad 235** — åberopar: K2
  > - [ ] Lägg till K2-rapport: balansräkning per organization
- **rad 247** — åberopar: BFL
  > - **Aldrig** rekommenderar att stänga av audit-logging "tillfälligt" — det bryter mot BFL.
- **rad 249** — åberopar: BFN, K3
  > - **Aldrig** ger råd som avviker från BFN:s allmänna råd utan att uttryckligen kalibrera. (T.ex. "Detta är K3-praxis men BFN R 4 säger annorlunda — välj medvetet.")

### `.claude/agents/hyresjurist.md`

- **rad 3** — åberopar: Bostadsrättslagen, Hyreslagen, JB
  > description: Advokat specialiserad på hyresrätt, bostadsrätt och fastighetsrätt. Granskar avtalsmallar, uppsägningsflöden, hyreshöjningar, deposita, störningshantering och tvistehantering i Eveno mot Hyreslagen (JB 12 kap), Bostadsrättslagen och praxis från hyresnämnderna. Anropa vid varje ändring av LeasesModule, kontraktsgenerering, uppsägning, hyreshöjningsflöden eller besittningsrätt.
- **rad 10** — åberopar: Jordabalken — belopp/frist: 4 år
  > Du är advokat i Sveriges Advokatsamfund med 18+ års specialisering inom hyres- och fastighetsrätt. Tidigare partner på Mannheimer Swartling, hyresråd vid Hyresnämnden i Stockholm i 4 år, och författare till två kommentarer till Jordabalken 12 kap. Du har drivit hundratals tvister i hyresnämnd och Svea hovrätt om bruksvärde, besittningsskydd, störningar och förverkande.
- **rad 26** — åberopar: JB
  > 1. **Bostadshyresgäster** — privatpersoner som hyr bostad. JB 12 kap gäller fullt ut. Tvingande till hyresgästens förmån. Besittningsskydd från dag 1.
- **rad 27** — åberopar: JB
  > 2. **Lokalhyresgäster** — företag/näringsidkare som hyr lokal (kontor, butik, lager). JB 12 kap gäller också, men **vissa regler är dispositiva** för lokal. Indirekt besittningsskydd (ersättning vid uppsägning utan saklig grund).
- **rad 28** — åberopar: 1991:614, Bostadsrättslagen — belopp/frist: 1991
  > - **BRF-segment (framtida):** Bostadsrätter regleras av Bostadsrättslagen (1991:614) + bostadsrättsföreningens stadgar — ej hyresrätt.
- **rad 42** — åberopar: Jordabalken
  > 1. `/workspaces/eken/.claude/knowledge/lagar/hyreslagen.md` — Jordabalken 12 kap (HELA lagen, paragraf-för-paragraf)
- **rad 43** — åberopar: 1991:614, Bostadsrättslagen — belopp/frist: 1991
  > 2. `/workspaces/eken/.claude/knowledge/lagar/bostadsrattslagen.md` — Bostadsrättslagen (1991:614)
- **rad 45** — åberopar: Räntelagen
  > 4. `/workspaces/eken/.claude/knowledge/lagar/ranteslagen.md` — Räntelagen — för dröjsmålsränta på sena hyror
- **rad 62** — åberopar: 2012:978, Privatuthyrningslagen — belopp/frist: 2012
  > - Privatperson eller fysisk person uthyrare? Privatuthyrningslagen (2012:978) gäller då för en bostad åt gången.
- **rad 75** — åberopar: Privatuthyrningslagen
  > - **Privatuthyrningslagen:** Privatperson hyr ut en bostad → fri hyressättning men "skälig hyra" prövbar i hyresnämnd.
- **rad 110**
  > - Förverkande (42 §)
- **rad 118** — belopp/frist: 2 vardagar, 8 vardagar
  > 1. **Hyresdröjsmål mer än vissa dagar** (42 § p 1) — bostad: mer än 8 vardagar efter förfallodag. För lokal: 2 vardagar.
- **rad 121**
  > 4. **Störningar** (p 6) — men kräver först **rättelseanmaning** (25 §)
- **rad 126** — belopp/frist: 3 vardagar
  > - Anmaning om betalning till socialnämnden (44 §) inom 3 vardagar efter förfallodatum för bostad
- **rad 168** — åberopar: Räntelagen
  > - Saknad eskaleringsklausul för räntor i avtalet (men följer lagen ändå via Räntelagen)
- **rad 192** — åberopar: 1975:635, 1991:614, 2008:567, BRL, DL, JB, RL — belopp/frist: 1975, 1991, 2008
  > **Rättskällor:** JB 12 kap, BRL 1991:614, DL 2008:567, RL 1975:635
- **rad 206** — åberopar: 1999:12 — belopp/frist: 1989, 1999
  > **Praxis:** RH 1999:12; NJA 1989 s. 681
- **rad 222**
  > > "Vid utebliven betalning gäller bestämmelserna i 12 kap. 42 § jordabalken. Hyresvärden underrättar socialnämnden enligt 44 § och hyresgästen har möjlighet att rätta till sig inom tre veckor."
- **rad 257** — åberopar: BRL
  > - **Aldrig** blandar ihop hyresrätt och bostadsrätt. Bostadsrätt regleras av BRL + föreningens stadgar — helt annan logik.
- **rad 259** — åberopar: Räntelagen
  > - **Aldrig** uttalar dig om skatterätt utöver Räntelagen — det är revisorn/skattejuristens domän.
- **rad 300** — åberopar: Räntelagen
  > # Räntelagen — kontrollera räntesats

### `.claude/agents/security-auditor.md`

- **rad 3** — åberopar: GDPR
  > description: Senior security engineer specialized in OWASP Top 10, GDPR, and Swedish SaaS compliance. Audits NestJS+Fastify+Prisma multi-tenant code for authentication flaws, authorization gaps, tenant isolation leaks, injection vulnerabilities, secrets handling, and personal-data exposure. Invoke before merging any PR that touches auth, RBAC, multi-tenant queries, file uploads, or PII handling.
- **rad 10** — åberopar: GDPR
  > Du har 15+ års erfarenhet av application security: tidigare Tech Lead Security på Klarna och Spotify, CREST-certifierad pentestare, OSCP, och har granskat säkerhet för svenska fintech/proptech-bolag som hanterar GDPR-känslig data i stor skala. Du sitter med i OWASP Sweden chapter och har bidragit till OWASP ASVS.
- **rad 21** — åberopar: GDPR
  > - **PII:** Personnummer, hemadresser, bankkontonummer, hyresgästers betalningshistorik, e-post, telefon. **GDPR Art 9-känsliga uppgifter** kan förekomma i fritextfält (hälsa, etnisk tillhörighet vid hyresgästkommunikation).
- **rad 36** — åberopar: GDPR
  > Vid GDPR-frågor läs även: `/workspaces/eken/.claude/knowledge/lagar/diskrimineringslagen.md`.
- **rad 88** — åberopar: GDPR
  > ### 6. GDPR & svensk dataskyddslag
- **rad 129** — åberopar: GDPR
  > - GDPR-överträdelse där PII inte raderas vid request
- **rad 243** — åberopar: GDPR
  > - **Alltid** verifiera GDPR-implikationer när PII är inblandat. Default-svar: "Vad händer med denna data vid right-to-erasure?"

### `.claude/knowledge/eveno/arkitektur.md`

- **rad 58** — åberopar: BAS
  > ├── accounting/ # BAS-kontoplan, journalposter, rapporter
- **rad 240** — åberopar: BAS
  > └─ Account (BAS-konto)
- **rad 249** — åberopar: BFL
  > Varje icke-User-entitet har `organizationId`. Cascade-delete vid Organization-borttagning **utom** på audit-modeller (InvoiceEvent, JournalEntry) som har `onDelete: Restrict` enligt FIX 3 (förhindrar förlust av bokföringskedjan vilket bryter mot BFL 7 kap).

### `.claude/knowledge/eveno/design-decisions.md`

- **rad 54** — åberopar: BFL
  > 1. **`onDelete: Cascade`** — enklast, men FIX 3 visade att detta bryter mot BFL
- **rad 69** — åberopar: GDPR
  > - Komplexare återställning vid faktiskt borttagning av kunddata (GDPR right-to-erasure → måste anonymisera istället för radera)
- **rad 73** — åberopar: BFL
  > - Aldrig medan BFL gäller i nuvarande form
- **rad 211** — åberopar: BFL
  > 1. **Full CRUD** — enkelt, men förstör audit-trail och bryter mot BFL
- **rad 230** — åberopar: BFL
  > - Aldrig medan BFL gäller
- **rad 309** — åberopar: BFL, GDPR, JB, ML
  > 1. **Bryter det mot lag?** (BFL, ML, GDPR, JB 12 kap) — då är svaret enkelt

### `.claude/knowledge/eveno/tidigare-buggar.md`

- **rad 110** — åberopar: BFL
  > ## FIX 3 — Cascade-delete tog ner audit-loggar (BFL-överträdelse)
- **rad 132** — åberopar: BFL
  > // ❌ Fel — bryter mot BFL
- **rad 149** — åberopar: GDPR
  > - Användardata: `Cascade` är OK om GDPR-rättigheten "right to erasure" kräver det
- **rad 261** — åberopar: BFL
  > **Severity (vid upptäckt):** CRITICAL (felaktig bokföring → BFL-överträdelse)
- **rad 277** — åberopar: Räntelagen
  > 1. **FIFO-ordning:** äldsta förfallna faktura matchas först (rättssäker per Räntelagen och praxis)

### `.claude/knowledge/standarder/bas-kontoplan.md`

- **rad 1** — åberopar: BAS — belopp/frist: 2024
  > # BAS-kontoplan 2024 — fastighetsfokus
- **rad 3** — åberopar: BAS
  > > Källa: BAS-kontogruppen (BAS Intressenter AB), bas.se
- **rad 6** — åberopar: BAS
  > BAS är de facto-standard för svensk redovisning, accepterad av Skatteverket, Bolagsverket och alla större revisionsbyråer. Eveno ska aldrig avvika från BAS utan tydlig motivering — det skapar onödig friktion för revisorer och redovisningskonsulter.
- **rad 10** — åberopar: BAS
  > BAS-kontoplanen är hierarkisk med 4 siffror per konto. Första siffran avgör klass:
- **rad 139** — åberopar: ML — belopp/frist: 25%, 2611, 3913
  > - **Lokalhyra med frivillig skattskyldighet** (ML 9 kap) → 25% moms. 3913 (netto) + 2611 (moms).
- **rad 311** — åberopar: 1981:1057, Inkassoförordningen — belopp/frist: 1057, 1981, 2013, 50 kr
  > Inkassoförordningen (1981:1057) är UPPHÄVD sedan 2013-03-16 och angav 50 kr.)
- **rad 378** — åberopar: BAS
  > ## BAS-pricniper Eveno måste följa
- **rad 380** — åberopar: BAS — belopp/frist: 2024
  > 1. **Endast godkända konton:** använd BAS 2024-konton, inte fantasi-konton
- **rad 388** — åberopar: BAS
  > ## När man får avvika från BAS
- **rad 390** — åberopar: BAS, K2
  > - **K2-företag** (mindre AB) kan ha förenklade kontoplaner — fungerar med BAS som superset
- **rad 391** — åberopar: BAS, K3
  > - **K3-företag** kan ha mer detaljerade kontoplaner men ska kunna mappas till BAS
- **rad 396** — åberopar: BAS
  > - BAS Intressenter AB — bas.se
- **rad 397** — åberopar: BFN
  > - BFN R 4 (Räkenskapsslutskurs)
- **rad 398** — åberopar: BFN
  > - BFN R 8 (Värdering av kundfordringar)
- **rad 399** — åberopar: BFN, K2
  > - BFN K2 (Årsredovisning i mindre företag)
- **rad 400** — åberopar: BFN, K3
  > - BFN K3 (Årsredovisning och koncernredovisning)

### `.claude/knowledge/standarder/owasp-top10.md`

- **rad 656** — åberopar: GDPR
  > - **HIGH** — PII i loggar (GDPR-överträdelse)
- **rad 727** — åberopar: GDPR
  > För vår kodbas är **A01 (Broken Access Control)** den absolut viktigaste — vi är multi-tenant, vi har haft incidenter (FIX 1, FIX 2), och konsekvensen av en läcka är direkt ekonomisk skada + GDPR-bot.

### `apps/api/src/ai/ai-assistant.service.ts`

- **rad 74** — åberopar: Jordabalken
  > HYRESLAGEN (12 kap. Jordabalken):
- **rad 108** — åberopar: BAS
  > BAS-KONTOPLAN FÖR FASTIGHETER:
- **rad 229** — åberopar: BAS — belopp/frist: 4010
  > - Underhållskostnader bokförs på BAS-konto 4010
- **rad 273** — åberopar: BAS
  > - get_account_balance vid frågor om saldon på enskilda BAS-konton
- **rad 287** — åberopar: BAS — belopp/frist: 2026
  > VIKTIGT: All bokföring följer BAS-2026 kontoplanen. Alla momsberäkningar
- **rad 288** — åberopar: Mervärdesskattelag
  > följer svensk Mervärdesskattelag. Bostäder är alltid momsfria.
- **rad 290** — åberopar: BAS
  > VANLIGA BAS-KONTON FÖR FASTIGHETSFÖRVALTNING:
- **rad 311** — åberopar: BAS — belopp/frist: 3593
  > konfiguration). Avgiften bokförs på BAS 3593 och läggs på fakturan som ny rad.

### `apps/api/src/ai/tenant-ai.service.ts`

- **rad 142** — åberopar: GDPR
  > // försvaret). GDPR (Art. 5.1c dataminimering): logga ALDRIG råinnehållet —

### `docs/legal/44-digital-delgivning-beslutsunderlag.md`

- **rad 16**
  > **Den enskilt viktigaste juridiska frågan:** om 63 § är en _formföreskrift_ (kräver just rek-brev) eller en _bevisrättslig presumtion_ (då kan stark faktisk bevisning som BankID-kvittens bära bevisbördan). Detta måste en mänsklig hyresjurist bekräfta innan ett papperslöst alternativ byggs.
- **rad 24**
  > > "Ett meddelande som avses i [...] 54 § eller 54 a § ska anses lämnat när det har avsänts i ett rekommenderat brev till mottagarens vanliga adress."
- **rad 28**
  > **Konsekvens vid 54 a §:** kan bevisbördan inte bäras inträder aldrig den passiva acceptansen ("tystnadens bindande verkan", 54 a § 3 st) — hyran anses inte avtalad på det nya beloppet.
- **rad 34** — åberopar: 2010:1932 — belopp/frist: 1932, 2010
  > ### 1.1 Delgivningslagen (2010:1932) — **SÄKER**
- **rad 43** — belopp/frist: 2026
  > - **Emot:** 63 § anger specifikt "rekommenderat brev"; ingen känd hyresnämnds-/hovrättspraxis (per 2026-05-31) likställer Kivra-leverans med rek.
- **rad 51**
  > - **Emot:** om 63 §:s "rek-brev" tolkas som **formföreskrift** räcker inte bevisning om mottagning via annat medium.
- **rad 56**
  > Digitalt med spårbarhet/kvittens; mottagaren måste aktivt hämta. Oklart om det utgör "rekommenderat brev" i 63 §:s mening. **Ingen verifierad praxis.** Om det registreras som rek hos Postnord och ger avsändningskvittens i samma system som fysiskt rek finns goda argument för presumtion — men osäkert.
- **rad 60** — åberopar: 2016:561 — belopp/frist: 2016
  > eIDAS art. 44 ger en QERDS-leverans **"rättsverkan av ett rekommenderat postbrev"** där nationell rätt kräver rek (genomfört via eIDAS-kompletteringslagen 2016:561). Verifierar avsändar- och mottagaridentitet + bevis om sändning/mottagande med tidsstämplar.
- **rad 75**
  > - **Eveno bygger:** PDF-generering (alla 54 a § 2 st-uppgifter) + integration mot brevtjänst-API; logga avsändningskvittens; sätt `NOTICE_SENT` med avsändningsdatum.
- **rad 87** — åberopar: 2016:561 — belopp/frist: 2016
  > - **Kvarvarande risk:** Måttlig — gott lagstöd (art. 44 + 2016:561) men ingen svensk hyresrättslig praxis.
- **rad 104** — belopp/frist: 80 kr
  > | **1** | A — Brevtjänst-API (fysiskt rek) | Hög (63 § explicit) | Hel | ~40–80 kr |
- **rad 108**
  > **Rekommendation:** **Alternativ C** ger bäst balans mellan produktambition (digitalt primärt) och juridisk säkerhet — _men kräver_ mänsklig bekräftelse att BankID-kvittens kan bära bevisbördan under 63 §. **Alternativ A** är enklast och juridiskt otvetydigt och ändå helt automatiserat. **Alternativ B** är inte motiverat i dagsläget (kostnad + omognad).
- **rad 118**
  > 1. **E-post ensamt** uppfyller inte 63 §-presumtionen; bevisbördan är hyresvärdens. Nuläget är juridiskt otillräckligt.
- **rad 119** — åberopar: 2010:1932 — belopp/frist: 1932, 2010
  > 2. **Delgivningslagen (2010:1932)** gäller inte privata hyresvärd–hyresgäst-relationer.
- **rad 120**
  > 3. **54 a § 3 st:** utan presumtion/bevisad mottagning inträder aldrig avtalet om ny hyra.
- **rad 121**
  > 4. **54 a § 2 st** innehållskrav (höjning i kr, total hyra, dag för ny hyra, sista invändningsdag, hyresvärdens adress, hänvisning till hyresnämnden, vad hyresgästen ska göra) gäller **oavsett leveranskanal**.
- **rad 125**
  > 5. **Är 63 § formföreskrift eller bevispresumtion?** (Avgör om BankID-kvittens kan ersätta rek.) Agenten lutar mot bevispresumtion — _tolkning, ej klarlagd praxis._
- **rad 126**
  > 6. **Postnord Digitalt rek** som "rek-brev" i 63 §:s mening — ingen känd praxis.
- **rad 127**
  > 7. **QERDS (eIDAS art. 44)** mot 63 § i hyresrätt — lagstöd finns, praxis saknas.
- **rad 129** — belopp/frist: 2023, 2026
  > 9. **Nyare praxis 2023–2026** om digital delgivning av 54 a §-meddelanden — kan ej verifieras i realtid av agenten.
- **rad 133**
  > 1. Är 63 § formföreskrift eller bevisrättslig presumtion? Kan BankID-kvittens i portal ersätta presumtionen?
- **rad 134** — belopp/frist: 2026
  > 2. Godtas Postnords Digitalt rek som "rekommenderat brev" i 63 §:s mening idag (2026)?
- **rad 135**
  > 3. Finns etablerad praxis om QERDS (eIDAS art. 44) mot 63 § i hyresrättslig kontext?

### `docs/legal/45-imd-forbrukningsdebitering-momsfragor.md`

- **rad 17** — åberopar: BFL — belopp/frist: 7 år
  > från fakturadatum, mätunderlag arkiveras 7 år (BFL), bokslutspost upplupen

### `docs/legal/46-inkasso-hyra-pamminnelse.md`

- **rad 27** — åberopar: 1975:635 — belopp/frist: 1975
  > `ReferenceInterestRate` — **aldrig hårdkodad**. Lagstöd: räntelagen (1975:635)
- **rad 28**
  > 6 § och 9 §.
- **rad 32** — åberopar: 1999:1078, BFL — belopp/frist: 1078, 1999, 7 år
  > (BFL 1999:1078 — räkenskapsinformation, 7 år).
- **rad 47** — åberopar: ML
  > (ML 9 kap) är däremot momspliktig: utgående moms har redovisats på avin. När en

### `docs/legal/privacy-policy.md`

- **rad 10** — åberopar: GDPR
  > i EU:s dataskyddsförordning (GDPR), kompletterande svensk
- **rad 97** — åberopar: GDPR
  > | **Tillhandahålla Tjänsten** | Skapa och underhålla ditt konto, autentisera dig, lagra och visa din data | Fullgörande av avtal (art. 6.1.b GDPR) |
- **rad 129** — åberopar: GDPR
  > uppfyller artikel 28 GDPR.
- **rad 187** — åberopar: GDPR
  > ## 7. Dina rättigheter enligt GDPR
- **rad 189** — åberopar: GDPR
  > Du har följande rättigheter enligt artikel 15–22 GDPR. Vi besvarar
- **rad 252** — åberopar: GDPR
  > artikel 32 GDPR och NIS2:
- **rad 282** — åberopar: GDPR
  > Om du anser att vi behandlar dina personuppgifter i strid med GDPR har du
- **rad 315** — åberopar: GDPR
  > artikel 37 GDPR, men vår dataskyddsfunktion nås på dataskydd@eveno.se.

### `docs/legal/terms-of-service.md`

- **rad 61** — åberopar: BAS
  > - Bokföring enligt BAS-kontoplanen med journalposter och bankavstämning
- **rad 112** — åberopar: GDPR
  > - underrätta Kunden om personuppgiftsincidenter inom 72 timmar enligt GDPR
- **rad 134** — belopp/frist: 8 procentenhet
  > referensräntan + 8 procentenheter enligt 6 § räntelagen.
- **rad 137** — belopp/frist: 180 kr, 60 kr
  > påminnelseavgift om 60 kr och inkassokostnad om 180 kr enligt 4 § lagen
- **rad 138** — åberopar: 1981:739 — belopp/frist: 1981
  > (1981:739) om ersättning för inkassokostnader.
- **rad 198** — åberopar: 1999:1078 — belopp/frist: 1078, 1999
  > som måste behållas enligt bokföringslagen (1999:1078) eller annan
- **rad 238** — åberopar: GDPR
  > artikel 32 GDPR: kryptering, åtkomstkontroll, loggning, regelbundna

## Hög C

### `.claude/agents/ai-architect.md`

- **rad 3** — _C4 kontoplan-rad_ — belopp/frist: 2024, 2026
  > description: Senior AI Research Engineer (Anthropic) specialiserad på LLM-applikationer i produktion — prompt engineering, tool use, RAG, agentic patterns, prompt caching, kostnads-/latensoptimering och prompt-injection-säkerhet. Granskar och designar Evenos AI-features (AI-chatbot, PDF-bankavstämning, morgonrapporter, månads-PDF, AI-tools) mot state-of-the-art (2024–2026). Anropa vid varje ändrin
- **rad 12** — _C3 procentsats_ — belopp/frist: 80 %
  > Du är **inte** en AI-hype-evangelist som klistrar en LLM på varje problem. Du är en pragmatiker som vet att **den bästa AI-koden ofta är ingen AI alls** — en regex, en SQL-query eller en deterministisk funktion slår en språkmodell på pris, latens och tillförlitlighet i 80 % av fallen. Din ledstjärna: \_AI ska användas där osäkerhet, naturligt språk eller ostrukturerad data gör deterministisk kod op
- **rad 56** — _C3 procentsats_ — belopp/frist: 2024, 49 %
  > 3. **RAG** — embeddings (Voyage rekommenderas av Anthropic, OpenAI, Cohere), hybrid search (semantic + BM25/keyword), chunking-strategier, re-ranking, **Contextual Retrieval** (Anthropic 2024 — prepend chunk-kontext före embedding, sänker retrieval-fel ~35–49 %), knowledge-graph-integration.
- **rad 60** — _C3 procentsats_ — belopp/frist: 2024, 2026, 50 %
  > 7. **Cutting edge (2024–2026)** — prompt caching, extended thinking, tool-result-caching, computer use, multimodalt (vision/audio), long context (200K+), Contextual Retrieval, Constitutional AI v2, Message Batches API (50 % rabatt på icke-realtid).
- **rad 112** — _C3 procentsats_ — belopp/frist: 40 %
  > - **Fil/rad**, **Problem**, **Fix (kod)**, **Mätbar effekt** (t.ex. "−40 % input-tokens via prompt caching → ~X SEK/mån")
- **rad 144** — _C4 kontoplan-rad_ — belopp/frist: 2024, 2026
  > - **Alltid** citera senaste research/tekniker (2024–2026) när relevant — prompt caching, Contextual Retrieval, Batch API, structured output.
- **rad 180** — _C3 procentsats_ — belopp/frist: 50 %
  > # Batch-kandidater (icke-realtid → Message Batches API, 50 % rabatt)

### `.claude/agents/bokforings-expert.md`

- **rad 52** — _C3 procentsats_ — belopp/frist: 25%
  > - Är det momspliktigt? Bostad (undantaget) eller lokal med frivillig skattskyldighet (25% moms)?
- **rad 76** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > - 1510 Kundfordringar (debet vid fakturering)
- **rad 77** — _C4 kontoplan-rad_ — belopp/frist: 3911
  > - 3911 Hyresintäkter, bostäder (kredit vid fakturering — undantagen moms)
- **rad 78** — _C4 kontoplan-rad_ — belopp/frist: 3913
  > - 3913 Hyresintäkter, lokaler (kredit vid fakturering — om momspliktigt)
- **rad 79** — _C3 procentsats_ — belopp/frist: 25%, 2611
  > - 2611 Utgående moms 25% (kredit vid momspliktig hyra)
- **rad 80** — _C4 kontoplan-rad_ — belopp/frist: 1930
  > - 1930 Företagskonto/checkkonto (debet vid mottagen betalning)
- **rad 81** — _C4 kontoplan-rad_ — belopp/frist: 8313
  > - 8313 Räntor från kunder (kredit vid dröjsmålsränta)
- **rad 85** — _C4 kontoplan-rad_ — belopp/frist: 2611, 3911
  > - Bostadshyra → ingen utgående moms. Kontering: 3911 enbart (ingen 2611).
- **rad 86** — _C4 kontoplan-rad_ — belopp/frist: 2611, 3913
  > - Kommersiell lokal **utan** frivillig skattskyldighet → ingen moms. Kontering: 3913, ingen 2611.
- **rad 87** — _C3 procentsats_ — belopp/frist: 25%, 2611, 3913
  > - Kommersiell lokal **med** frivillig skattskyldighet → 25% moms. Kontering: 3913 (netto) + 2611 (moms).
- **rad 94** — _C4 kontoplan-rad_ — belopp/frist: 2972
  > - Vid årsbokslut: 2972 Förskott från kunder ska visa förskottsfakturerad hyra för kommande period.
- **rad 95** — _C4 kontoplan-rad_ — belopp/frist: 1620
  > - Ej fakturerad upparbetad intäkt → 1620 Upparbetad men ej fakturerad intäkt.
- **rad 99** — _C2 frist/tidsgräns_ — belopp/frist: 7 år
  > - Räkenskapsinformation: 7 år efter utgången av räkenskapsåret den avser.
- **rad 106** — _C3 procentsats_ — belopp/frist: 8 procentenhet
  > - Dröjsmålsränta = referensränta + 8 procentenheter, från förfallodag.
- **rad 191** — _C4 kontoplan-rad_ — belopp/frist: 3911
  > Debet 3911 Hyresintäkter bostäder 10 000
- **rad 192** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > Kredit 1510 Kundfordringar -10 000 ← debet/kredit-felaktigt!
- **rad 195** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > Debet 1510 Kundfordringar 10 000
- **rad 196** — _C4 kontoplan-rad_ — belopp/frist: 3911
  > Kredit 3911 Hyresintäkter bostäder 10 000
- **rad 211** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > { accountNumber: '1510', debit: invoice.totalAmount, credit: 0 },
- **rad 212** — _C4 kontoplan-rad_ — belopp/frist: 3911
  > { accountNumber: '3911', debit: 0, credit: invoice.totalAmount },
- **rad 251** — _C4 kontoplan-rad_ — belopp/frist: 2026, 8601
  > - **Aldrig** skriver datum som "5/29/2026". Svenska standarder: `2026-05-29` (ISO 8601) eller `2026-05-29` i kod, `29 maj 2026` i UI.
- **rad 252** — _C4 kontoplan-rad_ — belopp/frist: 3911
  > - **Aldrig** översätter konto-namn till engelska. Konto 3911 heter "Hyresintäkter, bostäder" — punkt slut.
- **rad 281** — _C3 procentsats_ — belopp/frist: 25%
  > grep -rEn "0\.25|0,25|25%" apps/api/src/accounting apps/api/src/invoices

### `.claude/agents/hyresjurist.md`

- **rad 98** — _C2 frist/tidsgräns_ — belopp/frist: 3 månader
  > - Tillsvidareavtal: 3 månader
- **rad 104** — _C2 frist/tidsgräns_ — belopp/frist: 9 månader
  > - Tillsvidareavtal: 9 månader

### `.claude/agents/security-auditor.md`

- **rad 20** — _C2 frist/tidsgräns_ — belopp/frist: 30 dagar
  > - **Auth:** JWT (15 min) + refresh token (UUID, 30 dagar, roterad). bcryptjs 12 rounds. `JwtAuthGuard` global, `@Public()` för undantag, `@Roles()` för RBAC. Rollhierarki: OWNER > ADMIN > MANAGER > ACCOUNTANT > VIEWER.
- **rad 30** — _C5 säkerhetsklassning_ — belopp/frist: 2021
  > 1. `/workspaces/eken/.claude/knowledge/standarder/owasp-top10.md` — OWASP Top 10 2021 (alla 10 kategorier)
- **rad 175** — _C5 säkerhetsklassning_ — belopp/frist: 2021
  > **OWASP:** A01:2021 – Broken Access Control

### `.claude/knowledge/eveno/arkitektur.md`

- **rad 3** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > > Senast uppdaterad: 2026-05-29
- **rad 13** — _C4 kontoplan-rad_ — belopp/frist: 3000
  > │ ├── api/ # NestJS 10 + Fastify (port 3000)
- **rad 14** — _C4 kontoplan-rad_ — belopp/frist: 5173
  > │ ├── web/ # React 18 + Vite + TanStack Router (port 5173)
- **rad 52** — _C4 kontoplan-rad_ — belopp/frist: 3000
  > - **Swagger** på `http://localhost:3000/api/docs` i dev
- **rad 178** — _C4 kontoplan-rad_ — belopp/frist: 3000
  > - `baseURL: '/api/v1'` (Vite-proxy rewrite till `:3000/v1`)
- **rad 302** — _C2 frist/tidsgräns_ — belopp/frist: 30 dagar
  > - JWT 15 min + refresh 30 dagar (UUID, roteras)

### `.claude/knowledge/eveno/design-decisions.md`

- **rad 3** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > > Senast uppdaterad: 2026-05-29
- **rad 220** — _C4 kontoplan-rad_ — belopp/frist: 2025
  > - Förenklar reasoning om finansiell data — "vad var saldot 2025-12-31?" går att svara exakt
- **rad 259** — _C2 frist/tidsgräns_ — belopp/frist: 30 dagar
  > - Refresh-token: UUID (inte JWT), 30 dagar, lagrad i DB, **roteras vid varje refresh**

### `.claude/knowledge/eveno/tidigare-buggar.md`

- **rad 3** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > > Senast uppdaterad: 2026-08-01
- **rad 14** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **När:** Tidig 2026 (innan branch protection skärptes)
- **rad 51** — _C4 kontoplan-rad_ — belopp/frist: 2025, 2026
  > **När:** Vinter 2025/2026
- **rad 112** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **När:** Tidig 2026
- **rad 165** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **När:** maj 2026
- **rad 210** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **När:** maj 2026
- **rad 260** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **När:** maj 2026
- **rad 303** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **När:** maj 2026
- **rad 346** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **När:** juli 2026
- **rad 354** — _C4 kontoplan-rad_ — belopp/frist: 1510, 1930
  > bokförd (1930 D/1510 K), men `applyMatchToInvoice` rörde aldrig `Deposit`-raden. Depositionen stod
- **rad 395** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **När:** 2026-07 till 2026-08

### `.claude/knowledge/standarder/bas-kontoplan.md`

- **rad 14** — _C4 kontoplan-rad_ — belopp/frist: 1119, 1510, 1930
  > | 1xxx | **Tillgångar** (anläggnings + omsättning) | 1119, 1510, 1930 |
- **rad 15** — _C4 kontoplan-rad_ — belopp/frist: 2010, 2440, 2611
  > | 2xxx | **Eget kapital och skulder** | 2010, 2440, 2611 |
- **rad 16** — _C4 kontoplan-rad_ — belopp/frist: 3911, 3913, 3920
  > | 3xxx | **Rörelsens intäkter** | 3911, 3913, 3920 |
- **rad 17** — _C4 kontoplan-rad_ — belopp/frist: 4010
  > | 4xxx | **Material och varor** | 4010 (sällsynt här) |
- **rad 18** — _C4 kontoplan-rad_ — belopp/frist: 5010, 5070, 5170
  > | 5-6xxx | **Övriga externa rörelsekostnader** | 5010, 5070, 5170 |
- **rad 19** — _C4 kontoplan-rad_ — belopp/frist: 7010, 7510, 7610
  > | 7xxx | **Personalkostnader** | 7010, 7510, 7610 |
- **rad 20** — _C4 kontoplan-rad_ — belopp/frist: 8113, 8313, 8410
  > | 8xxx | **Finansiella och andra intäkter/kostnader** | 8113, 8313, 8410 |
- **rad 24** — _C4 kontoplan-rad_ — belopp/frist: 1110, 1119
  > ### 1110-1119 — Byggnader
- **rad 28** — _C4 kontoplan-rad_ — belopp/frist: 1110
  > | 1110 | Byggnader | Anskaffningsvärde fastighetens byggnad |
- **rad 29** — _C4 kontoplan-rad_ — belopp/frist: 1111
  > | 1111 | Byggnader på egen mark | Som ovan, separat när det är relevant |
- **rad 30** — _C4 kontoplan-rad_ — belopp/frist: 1112
  > | 1112 | Byggnader på annans mark | Tomträtt, etc. |
- **rad 31** — _C4 kontoplan-rad_ — belopp/frist: 1110, 1119
  > | 1119 | Ack. avskrivningar på byggnader | Motsvarar 1110 — visar nedskrivning |
- **rad 33** — _C4 kontoplan-rad_ — belopp/frist: 1110, 1111, 1930, 2350
  > **Eveno:** vid förvärv av fastighet → debet 1110/1111, kredit 1930 (bankkonto) eller 2350 (lån)
- **rad 35** — _C4 kontoplan-rad_ — belopp/frist: 1130, 1139
  > ### 1130-1139 — Mark
- **rad 39** — _C4 kontoplan-rad_ — belopp/frist: 1130
  > | 1130 | Mark | Marken som byggnaden står på |
- **rad 40** — _C4 kontoplan-rad_ — belopp/frist: 1131
  > | 1131 | Mark, tomter | Obebyggd tomtmark |
- **rad 44** — _C4 kontoplan-rad_ — belopp/frist: 1140, 1149
  > ### 1140-1149 — Tomträtt och liknande
- **rad 46** — _C4 kontoplan-rad_ — belopp/frist: 1150, 1159
  > ### 1150-1159 — Markanläggningar
- **rad 50** — _C4 kontoplan-rad_ — belopp/frist: 1180, 1189
  > ### 1180-1189 — Pågående ny-/till-/ombyggnad
- **rad 54** — _C4 kontoplan-rad_ — belopp/frist: 1200, 1299
  > ### 1200-1299 — Maskiner och inventarier
- **rad 58** — _C4 kontoplan-rad_ — belopp/frist: 1220
  > | 1220 | Inventarier och verktyg | Möbler, datorer, verktyg |
- **rad 59** — _C4 kontoplan-rad_ — belopp/frist: 1229
  > | 1229 | Ack. avskrivningar inventarier | |
- **rad 61** — _C4 kontoplan-rad_ — belopp/frist: 1500, 1599
  > ### 1500-1599 — Kundfordringar
- **rad 65** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > | **1510** | **Kundfordringar** | **Huvudkonto för utestående hyresfakturor** |
- **rad 66** — _C4 kontoplan-rad_ — belopp/frist: 1511
  > | 1511 | Kundfordringar (gemensamt med utländska) | Sällsynt för bostadshyra |
- **rad 67** — _C4 kontoplan-rad_ — belopp/frist: 1515
  > | 1515 | Osäkra kundfordringar | Vid förfallna obetalda fakturor överförd hit |
- **rad 68** — _C4 kontoplan-rad_ — belopp/frist: 1518
  > | 1518 | Ej reskontraförda kundfordringar | Bokföringsmässiga periodiseringar |
- **rad 69** — _C4 kontoplan-rad_ — belopp/frist: 1519
  > | 1519 | Värdereglering kundfordringar | Nedskrivning av osäkra fordringar |
- **rad 73** — _C4 kontoplan-rad_ — belopp/frist: 1510, 2611, 3911, 3913
  > 1. Hyresfaktura skapas → debet 1510, kredit 3911/3913 (+ 2611 om moms)
- **rad 74** — _C4 kontoplan-rad_ — belopp/frist: 1510, 1930
  > 2. Betalning kommer → debet 1930, kredit 1510
- **rad 75** — _C2 frist/tidsgräns_ — belopp/frist: 1510, 1515, 90 dagar
  > 3. Förfallodatum + 90 dagar utan betalning → omföring debet 1515, kredit 1510 (osäker fordran)
- **rad 76** — _C4 kontoplan-rad_ — belopp/frist: 1515, 6352
  > 4. Konstaterad förlust → debet 6352 (kundförluster), kredit 1515
- **rad 78** — _C4 kontoplan-rad_ — belopp/frist: 1700, 1799
  > ### 1700-1799 — Förutbetalda kostnader och upplupna intäkter
- **rad 82** — _C4 kontoplan-rad_ — belopp/frist: 1730
  > | 1730 | Förutbetalda försäkringspremier | T.ex. fastighetsförsäkring betald i förskott |
- **rad 83** — _C4 kontoplan-rad_ — belopp/frist: 1740
  > | 1740 | Förutbetalda räntekostnader | |
- **rad 84** — _C4 kontoplan-rad_ — belopp/frist: 1790
  > | 1790 | Övriga förutbetalda kostnader och upplupna intäkter | T.ex. upparbetad men ej fakturerad hyra (sällsynt — hyror är oftast förskott) |
- **rad 86** — _C4 kontoplan-rad_ — belopp/frist: 1900, 1999
  > ### 1900-1999 — Likvida medel
- **rad 90** — _C4 kontoplan-rad_ — belopp/frist: 1910
  > | 1910 | Kassa | Fysisk kassa (sällan idag) |
- **rad 91** — _C4 kontoplan-rad_ — belopp/frist: 1930
  > | **1930** | **Företagskonto/checkkonto** | **Huvudkonto för svenska företagskontot** |
- **rad 92** — _C4 kontoplan-rad_ — belopp/frist: 1931, 1939
  > | 1931-1939 | Bank-/postgiro | Specifika konton (t.ex. 1931 separat plusgiro) |
- **rad 93** — _C4 kontoplan-rad_ — belopp/frist: 1940, 1949
  > | 1940-1949 | Övriga bankkonton | Specialkonton, depositum-konto |
- **rad 94** — _C4 kontoplan-rad_ — belopp/frist: 1950
  > | 1950 | Bankcertifikat | |
- **rad 96** — _C4 kontoplan-rad_ — belopp/frist: 1510, 1930
  > **Eveno:** alla inkommande hyresbetalningar debet 1930 (eller specifikt bank-konto), kredit 1510
- **rad 100** — _C4 kontoplan-rad_ — belopp/frist: 2010, 2099
  > ### 2010-2099 — Eget kapital
- **rad 104** — _C4 kontoplan-rad_ — belopp/frist: 2010
  > | 2010 | Eget kapital | Enskild firma |
- **rad 105** — _C4 kontoplan-rad_ — belopp/frist: 2080
  > | 2080 | Aktiekapital | Aktiebolag |
- **rad 106** — _C4 kontoplan-rad_ — belopp/frist: 2086
  > | 2086 | Reservfond | |
- **rad 107** — _C4 kontoplan-rad_ — belopp/frist: 2091
  > | 2091 | Balanserad vinst eller förlust | |
- **rad 108** — _C4 kontoplan-rad_ — belopp/frist: 2099
  > | 2099 | Årets resultat | |
- **rad 110** — _C4 kontoplan-rad_ — belopp/frist: 2300, 2399
  > ### 2300-2399 — Lån och kontokrediter
- **rad 114** — _C4 kontoplan-rad_ — belopp/frist: 2350
  > | 2350 | Andra långfristiga skulder till kreditinstitut | Fastighetslån (vanligast) |
- **rad 115** — _C4 kontoplan-rad_ — belopp/frist: 2390
  > | 2390 | Övriga långfristiga skulder | |
- **rad 117** — _C4 kontoplan-rad_ — belopp/frist: 2400, 2499
  > ### 2400-2499 — Kortfristiga skulder
- **rad 121** — _C4 kontoplan-rad_ — belopp/frist: 2440
  > | 2440 | Leverantörsskulder | Obetalda leverantörsfakturor (renovation, städ, el) |
- **rad 123** — _C4 kontoplan-rad_ — belopp/frist: 2600, 2699
  > ### 2600-2699 — Moms och särskilda skatter
- **rad 127** — _C3 procentsats_ — belopp/frist: 25%, 2611
  > | **2611** | **Utgående moms 25%** | **Lokalhyra med frivillig skattskyldighet** |
- **rad 128** — _C4 kontoplan-rad_ — belopp/frist: 12%, 2612
  > | 2612 | Utgående moms 12% | Sällsynt för fastighet |
- **rad 129** — _C4 kontoplan-rad_ — belopp/frist: 2613, 6%
  > | 2613 | Utgående moms 6% | Sällsynt för fastighet |
- **rad 130** — _C4 kontoplan-rad_ — belopp/frist: 25%, 2614
  > | 2614 | Utg. moms omvänd skattskyldighet 25% | Vid byggtjänster (omvänd byggmoms) |
- **rad 131** — _C3 procentsats_ — belopp/frist: 25%, 2641
  > | **2641** | **Debiterad ingående moms 25%** | **Avdragsgill ingående moms på leverantörsfakturor** |
- **rad 132** — _C4 kontoplan-rad_ — belopp/frist: 2645
  > | 2645 | Beräknad ingående moms på unionsförvärv | EU-inköp |
- **rad 133** — _C4 kontoplan-rad_ — belopp/frist: 2650
  > | 2650 | Redovisningskonto för moms | Avstämningskonto vid momsdeklaration |
- **rad 138** — _C4 kontoplan-rad_ — belopp/frist: 2611, 3913
  > - **Lokalhyra utan frivillig skattskyldighet** → ingen moms. Endast 3913, ingen 2611.
- **rad 141** — _C4 kontoplan-rad_ — belopp/frist: 2700, 2799
  > ### 2700-2799 — Personalrelaterade skulder (lön, sociala avgifter)
- **rad 143** — _C4 kontoplan-rad_ — belopp/frist: 2800, 2899
  > ### 2800-2899 — Övriga kortfristiga skulder
- **rad 147** — _C4 kontoplan-rad_ — belopp/frist: 2820
  > | 2820 | Kortfristiga skulder till anställda | |
- **rad 148** — _C4 kontoplan-rad_ — belopp/frist: 2890
  > | 2890 | Övriga kortfristiga skulder | |
- **rad 150** — _C4 kontoplan-rad_ — belopp/frist: 2900, 2999
  > ### 2900-2999 — Upplupna kostnader och förutbetalda intäkter
- **rad 154** — _C4 kontoplan-rad_ — belopp/frist: 2960
  > | 2960 | Upplupna räntekostnader | |
- **rad 155** — _C4 kontoplan-rad_ — belopp/frist: 2970
  > | 2970 | Förutbetalda intäkter | Allmänt |
- **rad 156** — _C4 kontoplan-rad_ — belopp/frist: 2972
  > | **2972** | **Förutbetalda hyresintäkter** | **Hyror fakturerade i förskott för kommande period** |
- **rad 157** — _C4 kontoplan-rad_ — belopp/frist: 2990
  > | 2990 | Övriga upplupna kostnader | |
- **rad 162** — _C4 kontoplan-rad_ — belopp/frist: 2972, 3911
  > debet 3911 (minska intäkten), kredit 2972 (skuld till hyresgästen i form av förskott)
- **rad 164** — _C4 kontoplan-rad_ — belopp/frist: 2972, 3911
  > debet 2972, kredit 3911 (vänd tillbaka, intäkten hör nu till perioden)
- **rad 168** — _C4 kontoplan-rad_ — belopp/frist: 3900, 3999
  > ### 3900-3999 — Övriga rörelseintäkter (fastighet)
- **rad 172** — _C4 kontoplan-rad_ — belopp/frist: 3911
  > | **3911** | **Hyresintäkter, bostäder** | **Bostadshyror — undantagna moms** |
- **rad 173** — _C4 kontoplan-rad_ — belopp/frist: 3912
  > | **3912** | **Hyresintäkter, parkeringsplatser** | **Carport, garage (oftast undantagna, ibland momspliktiga)** |
- **rad 174** — _C4 kontoplan-rad_ — belopp/frist: 3913
  > | **3913** | **Hyresintäkter, lokaler** | **Kommersiella lokaler — moms vid frivillig skattskyldighet** |
- **rad 175** — _C4 kontoplan-rad_ — belopp/frist: 3914
  > | 3914 | Hyresintäkter, övriga | T.ex. förråd, vindar |
- **rad 176** — _C4 kontoplan-rad_ — belopp/frist: 3915
  > | 3915 | Garagehyra | |
- **rad 177** — _C4 kontoplan-rad_ — belopp/frist: 3916
  > | 3916 | Hyresgästavtal (extraordinära avtal) | |
- **rad 178** — _C4 kontoplan-rad_ — belopp/frist: 2972, 3917
  > | 3917 | Förskott från kunder | Sällsynt — använd 2972 istället |
- **rad 179** — _C4 kontoplan-rad_ — belopp/frist: 3918
  > | 3918 | Lägenhetsöverlåtelseavgifter (BRF) | För bostadsrättsföreningar |
- **rad 180** — _C4 kontoplan-rad_ — belopp/frist: 3920
  > | 3920 | Hyresgästers el-/värmeersättning | Vidaredebitering av el och värme |
- **rad 181** — _C4 kontoplan-rad_ — belopp/frist: 3921
  > | 3921 | Hyresintäkter, p-platser, momspliktiga | Separat när moms tillämpas |
- **rad 182** — _C4 kontoplan-rad_ — belopp/frist: 3960
  > | 3960 | Värme- och kylakostnader, vidaredebitering | Specifik för individuell debitering |
- **rad 183** — _C4 kontoplan-rad_ — belopp/frist: 3970
  > | 3970 | Vatten- och avloppsavgifter, vidaredebitering | |
- **rad 184** — _C4 kontoplan-rad_ — belopp/frist: 3990
  > | 3990 | Övriga rörelseintäkter | |
- **rad 188** — _C1 belopp i kronor_ — belopp/frist: 10 000 kr
  > Bostadshyra 10 000 kr (ingen moms):
- **rad 191** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > Debet 1510 Kundfordringar 10 000
- **rad 192** — _C4 kontoplan-rad_ — belopp/frist: 3911
  > Kredit 3911 Hyresintäkter, bostäder 10 000
- **rad 195** — _C1 belopp i kronor_ — belopp/frist: 25 000 kr, 25%
  > Lokalhyra 25 000 kr + 25% moms (frivillig skattskyldighet):
- **rad 198** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > Debet 1510 Kundfordringar 31 250
- **rad 199** — _C4 kontoplan-rad_ — belopp/frist: 3913
  > Kredit 3913 Hyresintäkter, lokaler 25 000
- **rad 200** — _C3 procentsats_ — belopp/frist: 25%, 2611
  > Kredit 2611 Utgående moms 25% 6 250
- **rad 206** — _C4 kontoplan-rad_ — belopp/frist: 1930
  > Debet 1930 Företagskonto 10 000
- **rad 207** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > Kredit 1510 Kundfordringar 10 000
- **rad 214** — _C4 kontoplan-rad_ — belopp/frist: 5010
  > | 5010 | Lokalhyra | Egna förhyrda lokaler (Eveno-kontoret, ej hyresfastigheten) |
- **rad 215** — _C4 kontoplan-rad_ — belopp/frist: 5020
  > | 5020 | El för belysning | Allmänna utrymmen |
- **rad 216** — _C4 kontoplan-rad_ — belopp/frist: 5040
  > | 5040 | Vatten och avlopp | Fastighetens egen kostnad |
- **rad 217** — _C4 kontoplan-rad_ — belopp/frist: 5050
  > | 5050 | Värme | |
- **rad 218** — _C4 kontoplan-rad_ — belopp/frist: 5060
  > | 5060 | Renhållning | |
- **rad 219** — _C4 kontoplan-rad_ — belopp/frist: 5070
  > | 5070 | Reparation och underhåll av lokaler | **Stor post för fastighetsförvaltning** |
- **rad 220** — _C4 kontoplan-rad_ — belopp/frist: 5090
  > | 5090 | Övriga fastighetskostnader | |
- **rad 221** — _C4 kontoplan-rad_ — belopp/frist: 5170
  > | 5170 | Reparation och underhåll, byggnader | |
- **rad 222** — _C4 kontoplan-rad_ — belopp/frist: 5190
  > | 5190 | Andra fastighetsspecifika kostnader | |
- **rad 223** — _C4 kontoplan-rad_ — belopp/frist: 6071
  > | 6071 | Representation, ej avdragsgill | |
- **rad 224** — _C4 kontoplan-rad_ — belopp/frist: 6110
  > | 6110 | Kontorsmateriel | |
- **rad 225** — _C4 kontoplan-rad_ — belopp/frist: 6212
  > | 6212 | Telekommunikation | |
- **rad 226** — _C4 kontoplan-rad_ — belopp/frist: 6310
  > | 6310 | Företagsförsäkringar | **Fastighetsförsäkring → här** |
- **rad 227** — _C4 kontoplan-rad_ — belopp/frist: 6352
  > | 6352 | Konstaterade förluster på kundfordringar | Definitiva förluster (efter inkasso) |
- **rad 228** — _C4 kontoplan-rad_ — belopp/frist: 6420
  > | 6420 | Ersättningar till revisor | |
- **rad 229** — _C4 kontoplan-rad_ — belopp/frist: 6530
  > | 6530 | Redovisningstjänster | Externa redovisningskonsulter |
- **rad 230** — _C4 kontoplan-rad_ — belopp/frist: 6570
  > | 6570 | Bankkostnader | |
- **rad 236** — _C4 kontoplan-rad_ — belopp/frist: 7010
  > | 7010 | Löner till kollektivanställda | |
- **rad 237** — _C4 kontoplan-rad_ — belopp/frist: 7210
  > | 7210 | Löner till tjänstemän | Förvaltningspersonal |
- **rad 238** — _C4 kontoplan-rad_ — belopp/frist: 7510
  > | 7510 | Lagstadgade sociala avgifter | Arbetsgivaravgifter |
- **rad 239** — _C4 kontoplan-rad_ — belopp/frist: 7610
  > | 7610 | Utbildning | |
- **rad 243** — _C4 kontoplan-rad_ — belopp/frist: 8000, 8199
  > ### 8000-8199 — Finansiella intäkter
- **rad 247** — _C4 kontoplan-rad_ — belopp/frist: 8113
  > | 8113 | Ränteintäkter från bank | |
- **rad 248** — _C4 kontoplan-rad_ — belopp/frist: 8131
  > | 8131 | Ränteintäkter från kunder | **Dröjsmålsränta debiterad hyresgäst** |
- **rad 249** — _C4 kontoplan-rad_ — belopp/frist: 8170
  > | 8170 | Diskonteringskostnader | |
- **rad 251** — _C4 kontoplan-rad_ — belopp/frist: 8300, 8499
  > ### 8300-8499 — Räntekostnader
- **rad 255** — _C4 kontoplan-rad_ — belopp/frist: 8313
  > | 8313 | Räntor från kunder | Vanlig benämning för intäktsräntor |
- **rad 256** — _C4 kontoplan-rad_ — belopp/frist: 8410
  > | 8410 | Räntekostnader för lån | **Fastighetslånets ränta** |
- **rad 257** — _C4 kontoplan-rad_ — belopp/frist: 8420
  > | 8420 | Räntekostnader för korta lån | |
- **rad 258** — _C4 kontoplan-rad_ — belopp/frist: 8440
  > | 8440 | Räntekostnader till anställda | |
- **rad 260** — _C4 kontoplan-rad_ — belopp/frist: 8800, 8899
  > ### 8800-8899 — Bokslutsdispositioner
- **rad 262** — _C4 kontoplan-rad_ — belopp/frist: 8900, 8999
  > ### 8900-8999 — Skatter på årets resultat
- **rad 266** — _C4 kontoplan-rad_ — belopp/frist: 8910
  > | 8910 | Skatt på årets resultat | |
- **rad 273** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > Debet 1510 Kundfordringar (Anna Andersson) 8 500
- **rad 274** — _C4 kontoplan-rad_ — belopp/frist: 3911
  > Kredit 3911 Hyresintäkter, bostäder 8 500
- **rad 276** — _C4 kontoplan-rad_ — belopp/frist: 1204, 2026
  > Verifikation: Hyresfaktura #2026-0142, månadshyra juni 2026, lgh 1204
- **rad 282** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > Debet 1510 Kundfordringar (AB Acme) 31 250
- **rad 283** — _C4 kontoplan-rad_ — belopp/frist: 3913
  > Kredit 3913 Hyresintäkter, lokaler 25 000
- **rad 284** — _C3 procentsats_ — belopp/frist: 25%, 2611
  > Kredit 2611 Utgående moms 25% 6 250
- **rad 290** — _C4 kontoplan-rad_ — belopp/frist: 1930
  > Debet 1930 Företagskonto 8 500
- **rad 291** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > Kredit 1510 Kundfordringar (Anna Andersson) 8 500
- **rad 296** — _C1 belopp i kronor_ — belopp/frist: 2026, 33 kr, 5%, 8 500 kr, 8%
  > Hyra 8 500 kr förfallen 2026-05-31, betald 2026-06-30. Referensränta 4,5% (exempel). Ränta = 8 500 × (4,5% + 8%) / 365 × 30 = 87,33 kr.
- **rad 299** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > Debet 1510 Kundfordringar (Anna Andersson) 87,33
- **rad 300** — _C4 kontoplan-rad_ — belopp/frist: 8131
  > Kredit 8131 Ränteintäkter från kunder 87,33
- **rad 306** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > Debet 1510 Kundfordringar (Anna Andersson) 60,00
- **rad 307** — _C4 kontoplan-rad_ — belopp/frist: 3999
  > Kredit 3999 Övriga rörelseintäkter 60,00
- **rad 316** — _C4 kontoplan-rad_ — belopp/frist: 6352
  > Debet 6352 Konstaterade förluster på kundfordringar 8 500
- **rad 317** — _C4 kontoplan-rad_ — belopp/frist: 1515
  > Kredit 1515 Osäkra kundfordringar 8 500
- **rad 322** — _C1 belopp i kronor_ — belopp/frist: 25%, 6 250 kr
  > Städfaktura 5 000 + 25% moms = 6 250 kr:
- **rad 325** — _C4 kontoplan-rad_ — belopp/frist: 5070
  > Debet 5070 Reparation och underhåll av lokaler 5 000
- **rad 326** — _C3 procentsats_ — belopp/frist: 25%, 2641
  > Debet 2641 Debiterad ingående moms 25% 1 250
- **rad 327** — _C4 kontoplan-rad_ — belopp/frist: 2440
  > Kredit 2440 Leverantörsskulder 6 250
- **rad 333** — _C4 kontoplan-rad_ — belopp/frist: 2440
  > Debet 2440 Leverantörsskulder 6 250
- **rad 334** — _C4 kontoplan-rad_ — belopp/frist: 1930
  > Kredit 1930 Företagskonto 6 250
- **rad 339** — _C1 belopp i kronor_ — belopp/frist: 2026, 2027, 3 000 kr
  > Q1 2027 fakturerad i december 2026 (3 000 kr):
- **rad 342** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > Vid bokslut 31 dec 2026:
- **rad 343** — _C4 kontoplan-rad_ — belopp/frist: 3911
  > Debet 3911 Hyresintäkter, bostäder 3 000
- **rad 344** — _C4 kontoplan-rad_ — belopp/frist: 2972
  > Kredit 2972 Förutbetalda hyresintäkter 3 000
- **rad 346** — _C4 kontoplan-rad_ — belopp/frist: 2027
  > 1 januari 2027 (omvänd):
- **rad 347** — _C4 kontoplan-rad_ — belopp/frist: 2972
  > Debet 2972 Förutbetalda hyresintäkter 3 000
- **rad 348** — _C4 kontoplan-rad_ — belopp/frist: 3911
  > Kredit 3911 Hyresintäkter, bostäder 3 000
- **rad 354** — _C4 kontoplan-rad_ — belopp/frist: 1940
  > Debet 1940 Övriga bankkonton (depositionskonto) 25 500
- **rad 355** — _C4 kontoplan-rad_ — belopp/frist: 2820
  > Kredit 2820 Kortfristiga skulder (deposition) 25 500
- **rad 363** — _C4 kontoplan-rad_ — belopp/frist: 2820
  > Debet 2820 Kortfristiga skulder (deposition) 25 500
- **rad 364** — _C4 kontoplan-rad_ — belopp/frist: 1940
  > Kredit 1940 Övriga bankkonton (depositionskonto) 25 500
- **rad 367** — _C1 belopp i kronor_ — belopp/frist: 5 000 kr
  > ### 12. Återbetalning deposition med avdrag för städ (5 000 kr)
- **rad 370** — _C4 kontoplan-rad_ — belopp/frist: 2820
  > Debet 2820 Kortfristiga skulder (deposition) 25 500
- **rad 371** — _C4 kontoplan-rad_ — belopp/frist: 1940
  > Kredit 1940 Övriga bankkonton 20 500
- **rad 372** — _C4 kontoplan-rad_ — belopp/frist: 3999
  > Kredit 3999 Övriga rörelseintäkter (städkostnad) 4 000
- **rad 373** — _C3 procentsats_ — belopp/frist: 25%, 2611
  > Kredit 2611 Utgående moms 25% (städkostnad) 1 000
- **rad 382** — _C4 kontoplan-rad_ — belopp/frist: 1204, 2026
  > 3. **Tydlig verifikationstext:** "Hyresfaktura #2026-0142, lgh 1204, juni 2026" — inte bara "fakturering"
- **rad 386** — _C2 frist/tidsgräns_ — belopp/frist: 10 år, 2%, 20%, 50 år
  > 7. **Avskrivningar:** byggnader 50 år (2%), inventarier 5-10 år (10-20%)

### `.claude/knowledge/standarder/owasp-top10.md`

- **rad 1** — _C5 säkerhetsklassning_ — belopp/frist: 2021
  > # OWASP Top 10 (2021) — full reference
- **rad 19** — _C5 säkerhetsklassning_ — belopp/frist: 2021
  > ## A01:2021 — Broken Access Control
- **rad 21** — _C3 procentsats_ — belopp/frist: 94%
  > **Andel apps med fynd:** 94%
- **rad 95** — _C5 säkerhetsklassning_ — belopp/frist: 2021
  > ## A02:2021 — Cryptographic Failures
- **rad 97** — _C3 procentsats_ — belopp/frist: 77%
  > **Andel apps med fynd:** 77%
- **rad 170** — _C5 säkerhetsklassning_ — belopp/frist: 2021
  > ## A03:2021 — Injection
- **rad 172** — _C3 procentsats_ — belopp/frist: 94%
  > **Andel apps med fynd:** 94%
- **rad 248** — _C5 säkerhetsklassning_ — belopp/frist: 2021
  > ## A04:2021 — Insecure Design
- **rad 254** — _C5 säkerhetsklassning_ — belopp/frist: 2021
  > **Ny kategori i 2021.** Skiljer sig från andra OWASP-kategorier genom att fokusera på **designflaws** snarare än implementation-flaws. Du kan inte fixa en osäker design med säker kod — designen måste ändras.
- **rad 306** — _C5 säkerhetsklassning_ — belopp/frist: 2021
  > ## A05:2021 — Security Misconfiguration
- **rad 308** — _C3 procentsats_ — belopp/frist: 90%
  > **Andel apps med fynd:** 90%
- **rad 379** — _C5 säkerhetsklassning_ — belopp/frist: 2021
  > ## A06:2021 — Vulnerable and Outdated Components
- **rad 381** — _C3 procentsats_ — belopp/frist: 89%
  > **Andel apps med fynd:** 89%
- **rad 382** — _C5 säkerhetsklassning_ — belopp/frist: 1104
  > **CWE-koppling:** CWE-1104
- **rad 399** — _C2 frist/tidsgräns_ — belopp/frist: 2 år
  > - Användning av paket vars sista release är > 2 år gammal
- **rad 436** — _C5 säkerhetsklassning_ — belopp/frist: 2021
  > ## A07:2021 — Identification and Authentication Failures
- **rad 526** — _C5 säkerhetsklassning_ — belopp/frist: 2021
  > ## A08:2021 — Software and Data Integrity Failures
- **rad 528** — _C4 kontoplan-rad_ — belopp/frist: 2021
  > **Ny kategori i 2021.**
- **rad 599** — _C5 säkerhetsklassning_ — belopp/frist: 2021
  > ## A09:2021 — Security Logging and Monitoring Failures
- **rad 651** — _C2 frist/tidsgräns_ — belopp/frist: 90 dagar
  > 6. Logs retained för minst 90 dagar (compliance)
- **rad 661** — _C4 kontoplan-rad_ — belopp/frist: 2021
  > ## A10:2021 — Server-Side Request Forgery (SSRF)
- **rad 663** — _C4 kontoplan-rad_ — belopp/frist: 2021
  > **Ny kategori i 2021.**

### `apps/api/src/ai/ai-assistant.service.ts`

- **rad 50** — _C4 kontoplan-rad_ — belopp/frist: 2048, 4096
  > // 2048, Opus 5 behöver 4096 för att inte lägga hela budgeten på thinking och
- **rad 76** — _C2 frist/tidsgräns_ — belopp/frist: 3 månader, 9 månader
  > - Uppsägningstid bostäder: 3 månader från hyresgäst, 3-9 månader från hyresvärd
- **rad 77** — _C2 frist/tidsgräns_ — belopp/frist: 9 månader
  > - Uppsägningstid lokaler: vanligen 9 månader om inget annat avtalats
- **rad 109** — _C4 kontoplan-rad_ — belopp/frist: 1110
  > - 1110 Byggnader och markanläggningar
- **rad 110** — _C4 kontoplan-rad_ — belopp/frist: 1119
  > - 1119 Ackumulerade avskrivningar byggnader
- **rad 111** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > - 1510 Kundfordringar (utestående hyror)
- **rad 112** — _C4 kontoplan-rad_ — belopp/frist: 1920
  > - 1920 Plusgiro/bankgiro
- **rad 113** — _C4 kontoplan-rad_ — belopp/frist: 2440
  > - 2440 Leverantörsskulder
- **rad 114** — _C3 procentsats_ — belopp/frist: 25%, 2611
  > - 2611 Utgående moms 25% (lokaler)
- **rad 115** — _C3 procentsats_ — belopp/frist: 12%, 2621
  > - 2621 Utgående moms 12%
- **rad 116** — _C3 procentsats_ — belopp/frist: 2631, 6%
  > - 2631 Utgående moms 6%
- **rad 117** — _C4 kontoplan-rad_ — belopp/frist: 3911
  > - 3911 Hyresintäkter, bostäder (momsfria)
- **rad 118** — _C4 kontoplan-rad_ — belopp/frist: 3912
  > - 3912 Hyresintäkter, parkeringsplatser
- **rad 119** — _C4 kontoplan-rad_ — belopp/frist: 3913
  > - 3913 Hyresintäkter, lokaler (momspliktiga vid frivillig skattskyldighet)
- **rad 120** — _C4 kontoplan-rad_ — belopp/frist: 3914
  > - 3914 Hyresintäkter, övriga (förråd m.m.)
- **rad 121** — _C4 kontoplan-rad_ — belopp/frist: 2890
  > - 2890 Mottagna depositioner (skuld till hyresgäst)
- **rad 122** — _C4 kontoplan-rad_ — belopp/frist: 4010
  > - 4010 Reparation och underhåll
- **rad 123** — _C4 kontoplan-rad_ — belopp/frist: 5010
  > - 5010 Fastighetsskötsel
- **rad 124** — _C4 kontoplan-rad_ — belopp/frist: 6212
  > - 6212 Fastighetsskatt
- **rad 127** — _C3 procentsats_ — belopp/frist: 0%
  > - Bostäder: MOMSFRIA (0%)
- **rad 128** — _C3 procentsats_ — belopp/frist: 25%
  > - Lokaler: kan vara momspliktiga (25%) om uthyraren är frivilligt skattskyldig
- **rad 131** — _C3 procentsats_ — belopp/frist: 25%
  > - Nackdel: hyresgästen betalar 25% mer i hyra
- **rad 138** — _C3 procentsats_ — belopp/frist: 5%
  > - Byggnader: 2-5% per år beroende på typ
- **rad 140** — _C3 procentsats_ — belopp/frist: 30%
  > - Inventarier: 20-30% per år
- **rad 152** — _C2 frist/tidsgräns_ — belopp/frist: 40 år
  > - Periodiskt underhåll: tak, fasad, fönster (20-40 år)
- **rad 153** — _C1 belopp i kronor_ — belopp/frist: 400 kr
  > - Rekommenderat underhållskapital: 200-400 kr/m²/år
- **rad 193** — _C1 belopp i kronor_ — belopp/frist: 8 500 kr
  > - Visa belopp: 8 500 kr (svenska format)
- **rad 245** — _C2 frist/tidsgräns_ — belopp/frist: 10 år
  > - Underhållsplan är långsiktig planering av större åtgärder (5–10 år framåt)
- **rad 246** — _C2 frist/tidsgräns_ — belopp/frist: 20 år, 25 år, 30 år
  > - Typiska intervall: tak 20–30 år, fasad 15–20 år, fönster 20–25 år, VVS 15–20 år
- **rad 247** — _C1 belopp i kronor_ — belopp/frist: 400 kr
  > - Rekommenderat underhållskapital: 200–400 kr/m²/år
- **rad 248** — _C2 frist/tidsgräns_ — belopp/frist: 5 år
  > - Planera minst 5 år framåt för god ekonomisk planering och korrekt fondering
- **rad 291** — _C4 kontoplan-rad_ — belopp/frist: 1510
  > - 1510 Kundfordringar
- **rad 292** — _C4 kontoplan-rad_ — belopp/frist: 1930
  > - 1930 Företagskonto / Bank
- **rad 293** — _C3 procentsats_ — belopp/frist: 25%, 2611
  > - 2611 Utgående moms 25%
- **rad 294** — _C3 procentsats_ — belopp/frist: 12%, 2621
  > - 2621 Utgående moms 12%
- **rad 295** — _C3 procentsats_ — belopp/frist: 2631, 6%
  > - 2631 Utgående moms 6%
- **rad 296** — _C4 kontoplan-rad_ — belopp/frist: 2641
  > - 2641 Ingående moms
- **rad 297** — _C4 kontoplan-rad_ — belopp/frist: 3911
  > - 3911 Hyresintäkter, bostäder (momsfri)
- **rad 298** — _C4 kontoplan-rad_ — belopp/frist: 3912
  > - 3912 Hyresintäkter, parkeringsplatser
- **rad 299** — _C4 kontoplan-rad_ — belopp/frist: 3913
  > - 3913 Hyresintäkter, lokaler (momspliktiga vid frivillig skattskyldighet)
- **rad 300** — _C4 kontoplan-rad_ — belopp/frist: 3914
  > - 3914 Hyresintäkter, övriga (förråd m.m.)
- **rad 301** — _C4 kontoplan-rad_ — belopp/frist: 3593
  > - 3593 Påminnelseavgifter (intäkt vid formell påminnelse)
- **rad 302** — _C4 kontoplan-rad_ — belopp/frist: 5070
  > - 5070 Reparation och underhåll
- **rad 303** — _C4 kontoplan-rad_ — belopp/frist: 5080
  > - 5080 Försäkring fastighet
- **rad 304** — _C4 kontoplan-rad_ — belopp/frist: 6212
  > - 6212 Fastighetsskatt
- **rad 305** — _C4 kontoplan-rad_ — belopp/frist: 8410
  > - 8410 Räntekostnader
- **rad 372** — _C1 belopp i kronor_ — belopp/frist: 500 000 kr
  > - Belopp > 500 000 kr (ovanligt högt)
- **rad 373** — _C3 procentsats_ — belopp/frist: 0%, 12%, 25%, 6%
  > - Momssatser utöver 0%, 6%, 12%, 25%
- **rad 375** — _C1 belopp i kronor_ — belopp/frist: 200 000 kr
  > - Hyror > 200 000 kr/mån
- **rad 412** — _C1 belopp i kronor_ — belopp/frist: 0 kr
  > "Deposition? (standard: 0 kr)"
- **rad 455** — _C4 kontoplan-rad_ — belopp/frist: 1000
  > export const PENDING*ACTION_TTL_MS = 5 * 60 \_ 1000
- **rad 482** — _C1 belopp i kronor_ — belopp/frist: 50 000 kr
  > // Large single invoice (>50 000 kr)
- **rad 490** — _C1 belopp i kronor_ — belopp/frist: 100 000 kr
  > // Stora manuella verifikat (> 100 000 kr)
- **rad 501** — _C1 belopp i kronor_ — belopp/frist: 100 000 kr
  > // Stora utgiftsbokningar (> 100 000 kr)
- **rad 524** — _C4 kontoplan-rad_ — belopp/frist: 1000
  > const days = (Date.now() - matched.getTime()) / (24 _ 60 _ 60 \* 1000)
- **rad 1148** — _C3 procentsats_ — belopp/frist: 10 %
  > // frågor med samma hämtade paragrafer — cachad läsning kostar ~10 %
- **rad 1671** — _C4 kontoplan-rad_ — belopp/frist: 1024
  > ? (Buffer.byteLength(fileContent, 'utf8') / 1024).toFixed(1)
- **rad 1718** — _C1 belopp i kronor_ — belopp/frist: 0 kr
  > input.vatAmount !== undefined ? `${safeAmountStr(input.vatAmount)} kr` : '0 kr',
- **rad 1825** — _C1 belopp i kronor_ — belopp/frist: 08 kr
  > - ORG. En fan-out över N tomma orgar lägger bara ~0,08 kr på var och en, så
- **rad 1864** — _C4 kontoplan-rad_ — belopp/frist: 1024
  > max_tokens: 1024,
- **rad 1877** — _C2 frist/tidsgräns_ — belopp/frist: 14 dagar
  > 'felanmälningar, kontrakt som går ut inom 14 dagar.',
- **rad 1940** — _C4 kontoplan-rad_ — belopp/frist: 1280
  > max_tokens: 1280,
- **rad 2018** — _C4 kontoplan-rad_ — belopp/frist: 2048
  > max_tokens: 2048,

### `apps/api/src/ai/tenant-ai.service.ts`

- **rad 19** — _C4 kontoplan-rad_ — belopp/frist: 1024
  > // hyresgästernas assistent — och TENANT_MAX_TOKENS 1024 räcker inte till ett
- **rad 20** — _C4 kontoplan-rad_ — belopp/frist: 2048
  > // Opus 5-resonemang (uppmätt: vid 2048 blev svaret tomt).
- **rad 22** — _C4 kontoplan-rad_ — belopp/frist: 1024
  > const TENANT_MAX_TOKENS = 1024

### `docs/legal/44-digital-delgivning-beslutsunderlag.md`

- **rad 4** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > > **Upprättat av:** hyresjurist-agent (Eveno) · **Datum:** 2026-05-31
- **rad 77** — _C1 belopp i kronor_ — belopp/frist: 3 dagar, 80 kr
  > - **Kostnad/komplexitet:** Medelhög integration; ~40–80 kr/brev; ledtid 1–3 dagar fysisk leverans.
- **rad 86** — _C1 belopp i kronor_ — belopp/frist: 200 kr
  > - **Kostnad/komplexitet:** Hög; ~80–200 kr/leverans; ev. opt-in-problem (mottagaren måste ta emot).
- **rad 95** — _C1 belopp i kronor_ — belopp/frist: 0 kr
  > - **Kostnad/komplexitet:** Medelhög; primärväg 0 kr/utskick; fallback som Alt. A.
- **rad 105** — _C1 belopp i kronor_ — belopp/frist: 0 kr, 80 kr
  > | **2** | C — Portal+BankID m. rek-fallback | Hög/Medelhög | Hel (hybrid) | 0 kr (portal) / 40–80 kr (fallback) |
- **rad 106** — _C1 belopp i kronor_ — belopp/frist: 200 kr
  > | **3** | B — QERDS | Potentiellt hög, oprövad | Hel | Hög, 80–200 kr |

### `docs/legal/45-imd-forbrukningsdebitering-momsfragor.md`

- **rad 15** — _C4 kontoplan-rad_ — belopp/frist: 3920
  > Bokföringsbedömningen har fastslagit: intäkt bruttoredovisad (3920 el/värme,
- **rad 16** — _C4 kontoplan-rad_ — belopp/frist: 3911, 3970, 5020, 5040
  > 3970 vatten, skilt från hyresintäkt 3911), kostnad 5020/5040, mätperiod skild
- **rad 18** — _C4 kontoplan-rad_ — belopp/frist: 1790
  > intäkt (1790).
- **rad 30** — _C3 procentsats_ — belopp/frist: 25 %
  > blir ett självständigt, **momspliktigt** tillhandahållande (25 %)?
- **rad 40** — _C4 kontoplan-rad_ — belopp/frist: 3970
  > bokföras på samma intäktskonto (3970), eller ska varmvatten följa
- **rad 41** — _C4 kontoplan-rad_ — belopp/frist: 3920
  > värmeersättning (3920)?
- **rad 47** — _C4 kontoplan-rad_ — belopp/frist: 1790, 3920, 3970
  > (1790 D / 3920|3970 K per 31/12, återförs 1/1): ska accrualen estimeras på

### `docs/legal/46-inkasso-hyra-pamminnelse.md`

- **rad 21** — _C1 belopp i kronor_ — belopp/frist: 60 kr
  > - **Påminnelse:** dag 7 efter förfallodag. Påminnelseavgift 60 kr, **momsfri**,
- **rad 24** — _C2 frist/tidsgräns_ — belopp/frist: 14 dagar
  > - **Inkasso-ready:** 14 dagar efter påminnelsen (`rentInkassoDaysAfterReminder`).
- **rad 25** — _C3 procentsats_ — belopp/frist: 8 procentenhet
  > - **Dröjsmålsränta:** referensränta + 8 procentenheter, från dagen efter
- **rad 36** — _C4 kontoplan-rad_ — belopp/frist: 1510, 3593
  > - **Påminnelseavgift:** 1510 D / 3593 K (momsfri rörelseintäkt).
- **rad 37** — _C4 kontoplan-rad_ — belopp/frist: 3593, 8131, 8313
  > - **Dröjsmålsränta:** 8131 (finansiell intäkt) — **INTE** 3593. (8313 seedad
- **rad 39** — _C4 kontoplan-rad_ — belopp/frist: 1515, 6352
  > - **Kundförlust:** 1515 (befarad) → 6352 (konstaterad).
- **rad 52** — _C4 kontoplan-rad_ — belopp/frist: 2611
  > lokalhyra — ska nedskrivningen bokföras så att utgående moms (2611) reduceras,
- **rad 55** — _C4 kontoplan-rad_ — belopp/frist: 1515, 6352
  > mot 1515 → 6352; lokalhyrans momsdel hålls öppen och spikas inte i kod.
- **rad 57** — _C4 kontoplan-rad_ — belopp/frist: 8131, 8313
  > ### Fråga 2 — 8131 (primärt) för dröjsmålsränta, 8313 seedat som reserv
- **rad 59** — _C4 kontoplan-rad_ — belopp/frist: 8131
  > **8131 är det tekniskt starkare valet** och fastställd regel: kontogrupp
- **rad 60** — _C4 kontoplan-rad_ — belopp/frist: 8100, 8199
  > 8100–8199 (Ränteintäkter och utdelning) är rätt hemvist för en finansiell
- **rad 61** — _C4 kontoplan-rad_ — belopp/frist: 8313
  > intäkt som dröjsmålsränta på kundfordringar. 8313 ligger i kontogruppen
- **rad 62** — _C4 kontoplan-rad_ — belopp/frist: 8300
  > 8300-serien (räntekostnader och liknande finansiella poster) och är ett svagare,
- **rad 66** — _C4 kontoplan-rad_ — belopp/frist: 8131
  > dröjsmålsräntan mot **8131** (inte att fritt välja mellan kontona). Påverkar

### `docs/legal/cookie-policy.md`

- **rad 4** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **Senast uppdaterad:** 2026-05-12
- **rad 5** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **Ikraftträdande:** 2026-05-12
- **rad 41** — _C2 frist/tidsgräns_ — belopp/frist: 30 dagar
  > | `eken-auth` | Sparar din JWT-access-token och refresh-token så att du förblir inloggad mellan sidvisningar | Session / 30 dagar | localStorage |
- **rad 43** — _C2 frist/tidsgräns_ — belopp/frist: 7 dagar
  > | `tenant-session` | Hyresgästportalens token för att hålla hyresgästen inloggad | 7 dagar | localStorage |
- **rad 44** — _C2 frist/tidsgräns_ — belopp/frist: 12 månader
  > | `cookie-consent` | Sparar ditt val i cookie-bannern | 12 månader | localStorage |
- **rad 52** — _C2 frist/tidsgräns_ — belopp/frist: 12 månader
  > | `eveno-theme` | Sparar ditt val av tema (ljust/mörkt — kommande funktion) | 12 månader | localStorage |
- **rad 53** — _C2 frist/tidsgräns_ — belopp/frist: 12 månader
  > | `eveno-sidebar-collapsed` | Sparar om sidomenyn ska vara minimerad | 12 månader | localStorage |
- **rad 54** — _C2 frist/tidsgräns_ — belopp/frist: 12 månader
  > | `eveno-table-prefs-*` | Sparar dina kolumninställningar och filter i tabeller | 12 månader | localStorage |

### `docs/legal/privacy-policy.md`

- **rad 4** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **Senast uppdaterad:** 2026-05-12
- **rad 5** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **Ikraftträdande:** 2026-05-12
- **rad 173** — _C2 frist/tidsgräns_ — belopp/frist: 90 dagar
  > | Avslutade konton (data hålls "hos cold storage") | 90 dagar efter uppsägning för återställning, sedan radering | Berättigat intresse |
- **rad 175** — _C2 frist/tidsgräns_ — belopp/frist: 90 dagar
  > | Inloggningsloggar | 90 dagar | Berättigat intresse (säkerhet) |
- **rad 176** — _C2 frist/tidsgräns_ — belopp/frist: 12 månader
  > | Säkerhetsincidenter | 12 månader | Berättigat intresse |
- **rad 177** — _C2 frist/tidsgräns_ — belopp/frist: 24 månader
  > | AI-konversationer | 24 månader, sedan automatisk radering | Berättigat intresse |
- **rad 178** — _C2 frist/tidsgräns_ — belopp/frist: 36 månader
  > | Supportärenden | 36 månader efter senaste kontakt | Berättigat intresse |
- **rad 179** — _C2 frist/tidsgräns_ — belopp/frist: 24 månader
  > | Marknadsföringskontakter (prospekt) | Tills samtycket återkallas eller 24 månader passiv | Samtycke |
- **rad 180** — _C2 frist/tidsgräns_ — belopp/frist: 30 dagar
  > | IP-adresser i vanliga åtkomstloggar | 30 dagar | Berättigat intresse |
- **rad 286** — _C4 kontoplan-rad_ — belopp/frist: 8114
  > Box 8114, 104 20 Stockholm
- **rad 299** — _C2 frist/tidsgräns_ — belopp/frist: 30 dagar
  > ändringar meddelas via e-post och en notis i Tjänsten minst 30 dagar

### `docs/legal/terms-of-service.md`

- **rad 4** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **Senast uppdaterad:** 2026-05-12
- **rad 5** — _C4 kontoplan-rad_ — belopp/frist: 2026
  > **Ikraftträdande:** 2026-05-12
- **rad 109** — _C3 procentsats_ — belopp/frist: 5%
  > - leverera en upptid på minst 99,5% per kalendermånad, exklusive
- **rad 130** — _C2 frist/tidsgräns_ — belopp/frist: 30 dagar
  > 6.2 **Betalningsvillkor.** 30 dagar netto från fakturadatum. Betalning
- **rad 148** — _C2 frist/tidsgräns_ — belopp/frist: 90 dagar
  > överlämnas till inkasso. Kunddata behålls i ytterligare 90 dagar för
- **rad 156** — _C3 procentsats_ — belopp/frist: 25%
  > 6.7 **Moms.** Samtliga priser anges exklusive moms. Svensk moms (25%)
- **rad 163** — _C2 frist/tidsgräns_ — belopp/frist: 30 dagar
  > 7.1 Nya konton får en kostnadsfri provperiod på 30 dagar från
- **rad 186** — _C2 frist/tidsgräns_ — belopp/frist: 14 dagar
  > - väsentligt bryter mot Villkoren och inte rättar bristen inom 14 dagar
- **rad 195** — _C2 frist/tidsgräns_ — belopp/frist: 30 dagar
  > format (CSV, PDF, SIE4) inom 30 dagar
- **rad 196** — _C2 frist/tidsgräns_ — belopp/frist: 90 dagar
  > - Kunddata lagras i 90 dagar efter uppsägning för återställning
- **rad 197** — _C2 frist/tidsgräns_ — belopp/frist: 90 dagar
  > - Efter 90 dagar raderas all Kunddata permanent, med undantag för data
- **rad 199** — _C2 frist/tidsgräns_ — belopp/frist: 7 år
  > tvingande lagstiftning (typiskt 7 år för fakturor och journalposter)
