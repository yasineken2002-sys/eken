# Cookie-policy för Eveno

**Version:** 1.0
**Senast uppdaterad:** 2026-05-12
**Ikraftträdande:** 2026-05-12

Eveno AB ("**vi**", "**oss**", "**Eveno**") använder cookies och liknande
teknologier på eveno.se, app.eveno.se och portal.eveno.se. Denna
policy förklarar vad cookies är, vilka cookies vi använder och hur du
kan hantera dem. Policyn kompletterar vår [Integritetspolicy](https://eveno.se/legal/integritet).

---

## 1. Vad är en cookie?

En **cookie** är en liten textfil som sparas i din webbläsare när du
besöker en webbplats. Cookien innehåller information som webbplatsen
kan läsa vid senare besök — typiskt för att hålla dig inloggad, komma
ihåg dina inställningar eller mäta hur webbplatsen används.

Vi använder också **localStorage** och **sessionStorage** som tekniskt
sett inte är cookies men fyller samma funktion. I denna policy avses
samtliga sådana lagringstekniker när vi skriver "cookies".

Reglerna om cookies finns i 6 kap. 18 § lag (2003:389) om elektronisk
kommunikation (LEK). Lagen kräver samtycke för cookies som inte är
absolut nödvändiga för att tillhandahålla en tjänst som du uttryckligen
begärt.

---

## 2. Vilka cookies använder vi?

### 2.1 Nödvändiga cookies (inget samtycke krävs)

Dessa cookies är absolut nödvändiga för att Tjänsten ska fungera. Du kan
inte stänga av dem utan att Tjänsten slutar fungera.

| Namn             | Syfte                                                                                        | Lagringstid        | Typ                                        |
| ---------------- | -------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------ |
| `eken-auth`      | Sparar din JWT-access-token och refresh-token så att du förblir inloggad mellan sidvisningar | Session / 30 dagar | localStorage                               |
| `__Host-csrf`    | CSRF-skydd på inloggning och andra känsliga endpoints                                        | Session            | Cookie (HttpOnly, Secure, SameSite=Strict) |
| `tenant-session` | Hyresgästportalens token för att hålla hyresgästen inloggad                                  | 7 dagar            | localStorage                               |
| `cookie-consent` | Sparar ditt val i cookie-bannern                                                             | 12 månader         | localStorage                               |

### 2.2 Funktionella cookies (samtycke krävs men förvalt)

Dessa cookies förbättrar din upplevelse men är inte nödvändiga.

| Namn                      | Syfte                                                     | Lagringstid | Typ          |
| ------------------------- | --------------------------------------------------------- | ----------- | ------------ |
| `eveno-theme`             | Sparar ditt val av tema (ljust/mörkt — kommande funktion) | 12 månader  | localStorage |
| `eveno-sidebar-collapsed` | Sparar om sidomenyn ska vara minimerad                    | 12 månader  | localStorage |
| `eveno-table-prefs-*`     | Sparar dina kolumninställningar och filter i tabeller     | 12 månader  | localStorage |

### 2.3 Analys- och felspårnings-cookies (samtycke krävs)

Vi använder Sentry för att spåra fel och prestandaproblem så att vi kan
rätta buggar. Sentry är konfigurerat för att inte samla in IP-adresser
eller andra direkt identifierande uppgifter — endast anonymiserade
stack-traces och tekniska metadata.

| Namn                | Syfte                                    | Lagringstid | Typ            | Leverantör         |
| ------------------- | ---------------------------------------- | ----------- | -------------- | ------------------ |
| `sentry-trace`      | Spårar request-händelser för felspårning | Per request | Cookie         | Sentry (EU-region) |
| `sentry-session-id` | Anonym sessions-ID för att gruppera fel  | 30 minuter  | sessionStorage | Sentry (EU-region) |

Vi använder **inga** marknadsföringscookies eller tredjeparts-spårning
för annonsering (Google Analytics, Facebook Pixel, LinkedIn Insight m.fl.).

---

## 3. Hur hanterar du cookies?

### 3.1 Via cookie-bannern

Första gången du besöker Tjänsten visas en cookie-banner där du kan välja
mellan:

- **"Acceptera alla"** — godkänner samtliga cookies inklusive analys
- **"Bara nödvändiga"** — endast cookies som krävs för att Tjänsten ska
  fungera
- **"Anpassa"** — välja per kategori

Ditt val sparas i `cookie-consent` och du kan när som helst ändra det
genom att klicka på "Cookie-inställningar" i sidfoten.

### 3.2 Via webbläsaren

Du kan blockera eller radera cookies i webbläsarens inställningar:

- **Chrome:** Inställningar → Sekretess och säkerhet → Cookies
- **Safari:** Inställningar → Sekretess
- **Firefox:** Inställningar → Sekretess och säkerhet
- **Edge:** Inställningar → Cookies och webbplatsbehörigheter

Observera att om du blockerar nödvändiga cookies kommer du inte kunna
logga in eller använda Tjänsten.

### 3.3 Återkalla samtycke

Du kan när som helst återkalla ditt samtycke till analys- och
funktionella cookies utan att det påverkar tidigare behandling. Klicka
på "Cookie-inställningar" i sidfoten på vilken sida som helst.

---

## 4. Tredjepartsmottagare

Vi delar cookie-data med följande tredje parter, samtliga reglerade
genom personuppgiftsbiträdesavtal:

- **Sentry, Inc.** (EU-region, Frankfurt) — felspårning
- **Vercel Inc.** (EU-region, Frankfurt) — hosting och edge-cache

Mer detaljer om dessa leverantörer finns i avsnitt 4 i [Integritetspolicyn](https://eveno.se/legal/integritet).

---

## 5. Ändringar av denna policy

Om vi börjar använda nya cookies eller ändrar syftet med befintliga
cookies uppdaterar vi denna policy och visar en notis i Tjänsten.
Versionsnummer och ikraftträdandedatum framgår överst på sidan.

---

## 6. Kontakt

Vid frågor om vår användning av cookies, kontakta:

**Eveno AB**
Sveavägen 1
111 57 Stockholm
E-post: dataskydd@eveno.se

Du har också rätt att lämna in ett klagomål till
[Integritetsskyddsmyndigheten (IMY)](https://www.imy.se) eller, för
specifika frågor om elektronisk kommunikation, till
[Post- och telestyrelsen (PTS)](https://www.pts.se).
