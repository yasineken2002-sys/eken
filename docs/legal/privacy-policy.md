# Integritetspolicy för Eveno

**Version:** 1.0
**Senast uppdaterad:** 2026-05-12
**Ikraftträdande:** 2026-05-12

Denna integritetspolicy beskriver hur Eveno AB ("**vi**", "**oss**",
"**Eveno**") behandlar personuppgifter när du använder vår
fastighetsförvaltningstjänst. Policyn är utformad för att uppfylla kraven
i EU:s dataskyddsförordning (GDPR), kompletterande svensk
dataskyddslagstiftning och Integritetsskyddsmyndighetens (IMY) vägledningar.

---

## 1. Personuppgiftsansvarig

**Eveno AB**, org.nr 559999-9999, är personuppgiftsansvarig för:

- Personuppgifter om dig som registrerar dig som Användare i Tjänsten
- Personuppgifter om dig som besöker eveno.se eller kontaktar vår support
- Loggdata, säkerhetsloggar och fakturaunderlag som genereras vid din
  användning av Tjänsten

**Postadress:** Sveavägen 1, 111 57 Stockholm
**E-post:** dataskydd@eveno.se

För personuppgifter om Hyresgäster och övriga som Kunden lägger in i
Tjänsten är **Kunden** (typiskt en fastighetsägare eller
förvaltningsbolag) personuppgiftsansvarig och Eveno endast
personuppgiftsbiträde. Behandlingen i denna roll regleras i
Personuppgiftsbiträdesavtalet (DPA) som ingår som en del av
användarvillkoren.

---

## 2. Vilka personuppgifter behandlar vi?

### 2.1 Kontaktuppgifter

- För- och efternamn
- E-postadress
- Telefonnummer (frivilligt)
- Roll i organisationen (OWNER, ADMIN, MANAGER, ACCOUNTANT, VIEWER)

### 2.2 Företagsuppgifter

- Organisationsnamn
- Organisationsnummer
- Företagsform (AB, enskild firma m.fl.)
- Adressuppgifter
- F-skatte- och momsregistreringsstatus
- Bankgiro

### 2.3 Inloggnings- och säkerhetsdata

- Krypterat lösenord (bcrypt med 12 salt rounds — vi har aldrig åtkomst
  till klartextlösenord)
- Tidpunkt för senaste inloggning
- IP-adress vid inloggning och vid säkerhetshändelser
- Webbläsare och operativsystem (User-Agent)
- Antal misslyckade inloggningsförsök och eventuell konto-låsning
- Refresh-tokens (UUID, knutna till aktiv session)

### 2.4 Innehåll som du skapar i Tjänsten

- Fastighets-, lägenhets- och hyresgäst-data du lägger in
- Hyresavtal, fakturor, journalposter och bankavstämningar
- Dokument du laddar upp (PDF, bilder)
- Meddelanden och kommentarer
- Bilder och filer för felanmälningar och inspektioner

### 2.5 AI-konversationer

- Promptar och svar i AI-assistenten
- Verktygsanrop som AI:n utför å dina vägnar (skapa fakturor, söka data
  m.m.)
- Tokenförbrukning per organisation och användare

### 2.6 Användnings- och loggdata

- Klick, sidvisningar och funktionsanvändning (för produktförbättring)
- Felmeddelanden och stack-traces (via Sentry — anonymiserade där möjligt)
- Tidsstämplar för säkerhetshändelser
- Faktureringsunderlag (vald plan, AI-anrop, antal aktiva objekt)

### 2.7 Supportkommunikation

- E-postkonversationer med support@eveno.se
- Skärmbilder du frivilligt skickar in

---

## 3. Hur använder vi uppgifterna?

| Ändamål                       | Beskrivning                                                               | Rättslig grund                         |
| ----------------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| **Tillhandahålla Tjänsten**   | Skapa och underhålla ditt konto, autentisera dig, lagra och visa din data | Fullgörande av avtal (art. 6.1.b GDPR) |
| **Fakturering**               | Räkna AI-anrop, skapa månadsfakturor, kreditkontroll                      | Fullgörande av avtal (art. 6.1.b)      |
| **Bokföring**                 | Spara fakturaunderlag enligt bokföringslagen                              | Rättslig förpliktelse (art. 6.1.c)     |
| **Support**                   | Besvara frågor, felsöka, utbilda                                          | Berättigat intresse (art. 6.1.f)       |
| **Säkerhet**                  | Förhindra brute-force, upptäcka intrång, logga säkerhetshändelser         | Berättigat intresse (art. 6.1.f)       |
| **Produktförbättring**        | Anonymiserad användningsstatistik, A/B-tester                             | Berättigat intresse (art. 6.1.f)       |
| **Marknadsföring**            | Nyhetsbrev till befintliga kunder                                         | Berättigat intresse, opt-out i fotnot  |
| **Marknadsföring (prospekt)** | Riktad marknadsföring till nya prospekt                                   | Samtycke (art. 6.1.a)                  |

Vi gör en intresseavvägning för all behandling som baseras på berättigat
intresse. Kontakta dataskydd@eveno.se om du vill ta del av
intresseavvägningen för en viss behandling.

---

## 4. Mottagare av personuppgifter

Vi delar personuppgifter med följande kategorier av mottagare:

### 4.1 Underleverantörer (personuppgiftsbiträden)

| Leverantör                      | Tjänst                                                 | Land                                    | Typ av data                           |
| ------------------------------- | ------------------------------------------------------ | --------------------------------------- | ------------------------------------- |
| **Vercel Inc.**                 | Hosting av webb-frontend, edge-funktioner              | EU/USA (Frankfurt-region för EU-trafik) | All data som passerar frontend        |
| **Railway / Render**            | Hosting av API och databas                             | EU (Amsterdam-region)                   | All Kunddata                          |
| **Anthropic, PBC**              | AI-modeller (Claude) för AI-assistenten                | USA                                     | Promptar och svar i AI-konversationer |
| **Resend, Inc.**                | Transaktionella mejl (välkomst, fakturor, påminnelser) | USA / EU                                | E-postadress, namn, mejl-innehåll     |
| **Stripe Payments Europe Ltd.** | Kortbetalning av abonnemang (om aktiverat)             | Irland                                  | Betalningsuppgifter                   |
| **Sentry, Inc.**                | Felspårning och prestandaövervakning                   | EU (Frankfurt-region)                   | Stack-traces, anonymiserade events    |
| **Google Cloud Storage**        | Säkerhetskopiering av databas och uppladdade dokument  | EU                                      | All Kunddata, krypterad               |

Samtliga underleverantörer är bundna av personuppgiftsbiträdesavtal som
uppfyller artikel 28 GDPR.

### 4.2 Myndigheter

Vi lämnar ut personuppgifter till myndigheter (Skatteverket, Polisen,
Kronofogden m.fl.) endast när vi är skyldiga enligt lag eller efter
rättsligt bindande beslut.

### 4.3 Andra Användare i samma organisation

Inom Kundens organisation kan andra Användare se uppgifter om dig (t.ex.
namn, e-post, roll) i syfte att samarbeta i Tjänsten.

### 4.4 Vid bolagsöverlåtelse

Vid en eventuell försäljning eller fusion av Eveno kan personuppgifter
överföras till förvärvaren, som då blir bunden av denna policy fram tills
en ny policy antas.

---

## 5. Internationell överföring

Vissa underleverantörer är etablerade i USA. Överföringar till tredjeland
sker med någon av följande skyddsåtgärder:

- **EU-Kommissionens standardklausuler (SCC)** — för leverantörer utan
  giltigt adekvansbeslut
- **EU-US Data Privacy Framework (DPF)** — för certifierade amerikanska
  leverantörer (bland annat Anthropic, Resend och Stripe)
- **Tekniska tilläggsåtgärder** — TLS-kryptering i transit och AES-256
  i vila

Vid AI-anrop till Anthropic skickas endast den prompt som är nödvändig
för att besvara frågan — vi delar aldrig hela databasen. Anthropic är
avtalsmässigt förbjudet att använda data för modellträning.

---

## 6. Lagringstid

| Datatyp                                          | Lagringstid                                                 | Lagstöd                        |
| ------------------------------------------------ | ----------------------------------------------------------- | ------------------------------ |
| Aktiva kontouppgifter                            | Under avtalstiden                                           | Avtal                          |
| Avslutade konton (data hålls "hos cold storage") | 90 dagar efter uppsägning för återställning, sedan radering | Berättigat intresse            |
| Fakturaunderlag och bokföring                    | 7 år från räkenskapsårets utgång                            | Bokföringslagen 7 kap. 2 §     |
| Inloggningsloggar                                | 90 dagar                                                    | Berättigat intresse (säkerhet) |
| Säkerhetsincidenter                              | 12 månader                                                  | Berättigat intresse            |
| AI-konversationer                                | 24 månader, sedan automatisk radering                       | Berättigat intresse            |
| Supportärenden                                   | 36 månader efter senaste kontakt                            | Berättigat intresse            |
| Marknadsföringskontakter (prospekt)              | Tills samtycket återkallas eller 24 månader passiv          | Samtycke                       |
| IP-adresser i vanliga åtkomstloggar              | 30 dagar                                                    | Berättigat intresse            |

Efter lagringstidens utgång raderas eller anonymiseras uppgifterna
permanent. Anonymiserade uppgifter får behållas för aggregerad statistik.

---

## 7. Dina rättigheter enligt GDPR

Du har följande rättigheter enligt artikel 15–22 GDPR. Vi besvarar
samtliga förfrågningar inom en månad utan kostnad.

### 7.1 Rätt till information (art. 13–14)

Den information du läser i denna policy är ett uttryck för rätten till
information.

### 7.2 Rätt till tillgång (art. 15)

Du kan få ett registerutdrag med vilka personuppgifter vi behandlar om
dig, ändamålen, lagringstiden och mottagarna. Skicka en förfrågan till
dataskydd@eveno.se.

### 7.3 Rätt till rättelse (art. 16)

Felaktiga uppgifter rättas på din begäran. De flesta uppgifter kan du
själv ändra under Inställningar → Mitt konto.

### 7.4 Rätt till radering ("rätten att bli glömd", art. 17)

Du kan begära att vi raderar dina personuppgifter. Vi efterkommer
begäran utom när vi är skyldiga att behålla uppgifterna enligt lag
(typiskt bokföringslagen för fakturadata). Användare kan radera sitt
konto under Inställningar → Mitt konto → Radera konto.

### 7.5 Rätt till begränsning (art. 18)

Du kan begära att vi begränsar behandlingen av vissa uppgifter under
tiden vi utreder en invändning eller rättelseanmodan.

### 7.6 Rätt till dataportabilitet (art. 20)

Du kan få ut dina personuppgifter i ett strukturerat, allmänt använt och
maskinläsbart format (JSON eller CSV) eller överföra dem direkt till en
annan personuppgiftsansvarig. Funktionen finns under Inställningar →
Exportera mina data.

### 7.7 Rätt att invända (art. 21)

Du har rätt att invända mot behandling som baseras på berättigat
intresse, inklusive direktmarknadsföring. Vid invändning mot
direktmarknadsföring upphör behandlingen omedelbart.

### 7.8 Rätt att återkalla samtycke

För behandling som baseras på samtycke (t.ex. nyhetsbrev till prospekt)
kan du när som helst återkalla samtycket utan att det påverkar lagligheten
av behandling som skett innan återkallandet.

### 7.9 Rätt att inte vara föremål för automatiserat beslutsfattande

Vi använder inte automatiserat beslutsfattande som har rättsliga
följder eller väsentligt påverkar dig.

För att utöva dina rättigheter, kontakta dataskydd@eveno.se. Vi kan
behöva verifiera din identitet innan vi behandlar förfrågan.

---

## 8. Säkerhetsåtgärder

Eveno tillämpar branschstandard för informationssäkerhet enligt
artikel 32 GDPR och NIS2:

- **Kryptering i transit:** All trafik krypteras med TLS 1.3
- **Kryptering i vila:** Databaser och säkerhetskopior krypteras med AES-256
- **Lösenord:** bcrypt med 12 salt rounds — vi ser aldrig klartextlösenord
- **Brute-force-skydd:** Konton låses i 15 minuter efter 10 misslyckade försök
- **Åtkomstkontroll:** Rollbaserad åtkomst (RBAC) och multi-tenant-isolation
- **Loggning:** Säkerhetshändelser och åtkomst till känsliga data loggas
- **Säkerhetstester:** Penetrationstester genomförs minst årligen
- **Incidenthantering:** Rutin för att rapportera incidenter till IMY inom 72 h
- **Personalutbildning:** Alla med åtkomst till kunddata genomgår årlig
  säkerhetsutbildning
- **Backup:** Daglig säkerhetskopiering med 30 dagars retention och
  geografiskt separerade kopior

---

## 9. Cookies och spårning

Vi använder cookies för att Tjänsten ska fungera (autentisering,
sessionshantering) och för att samla in anonymiserad användningsstatistik
via Sentry. Vi använder **inga** spårningscookies för marknadsföring och
inga tredjepartsskript som delar data med annonsnätverk.

Detaljerad information finns i vår [Cookie-policy](https://eveno.se/legal/cookies).

---

## 10. Klagomål

Om du anser att vi behandlar dina personuppgifter i strid med GDPR har du
rätt att lämna in ett klagomål till tillsynsmyndigheten:

**Integritetsskyddsmyndigheten (IMY)**
Box 8114, 104 20 Stockholm
Telefon: 08-657 61 00
E-post: imy@imy.se
Webb: https://www.imy.se

Vi uppskattar dock om du kontaktar oss först på dataskydd@eveno.se så att
vi får möjlighet att rätta till eventuella brister.

---

## 11. Ändringar av denna policy

Vi kan komma att uppdatera denna policy från tid till annan. Större
ändringar meddelas via e-post och en notis i Tjänsten minst 30 dagar
innan de träder i kraft. Versionsnummer och ikraftträdandedatum framgår
högst upp på sidan.

---

## 12. Kontaktuppgifter

**Personuppgiftsansvarig:** Eveno AB, org.nr 559999-9999
**Postadress:** Sveavägen 1, 111 57 Stockholm

- **Dataskyddsfrågor:** dataskydd@eveno.se
- **Allmänna frågor:** kontakt@eveno.se
- **Support:** support@eveno.se

Eveno har ännu inte krav på formellt utsett dataskyddsombud enligt
artikel 37 GDPR, men vår dataskyddsfunktion nås på dataskydd@eveno.se.
Funktionen leds av vår CTO som ansvarar för efterlevnad av
dataskyddslagstiftningen.
