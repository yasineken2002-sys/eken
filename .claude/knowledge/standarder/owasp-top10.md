# OWASP Top 10 (2021) — full reference

> Källa: https://owasp.org/Top10/
> Anpassad för Eveno (NestJS + Fastify + Prisma + React multi-tenant SaaS)

OWASP Top 10 är **inte** en uttömmande säkerhetschecklist. Det är de tio mest kritiska kategorierna av webbsäkerhetsrisker, sammanställda från ~500 000 ansökningsdataset. Eveno-koden ska granskas mot varje kategori vid varje signifikant PR, särskilt PRs som rör auth, RBAC, multi-tenant queries, filuppladdningar, eller PII-hantering.

Varje kategori nedan har:

- **Beskrivning** — vad kategorin omfattar
- **Vanliga manifestationer** — konkreta sårbarheter
- **Eveno-relevans** — var detta typiskt dyker upp i vår kodbas
- **Detection** — hur man hittar problemet (grep-mönster, frågor)
- **Prevention** — hur man undviker problemet
- **Severity-mappning** — när detta blir CRITICAL vs HIGH vs MEDIUM

---

## A01:2021 — Broken Access Control

**Andel apps med fynd:** 94%
**CWE-koppling:** CWE-200, CWE-201, CWE-352, CWE-441

### Beskrivning

Auktoriseringskontrollen som ska säkerställa att en användare bara kommer åt det hen får komma åt är trasig eller saknas. Detta inkluderar:

- Insecure Direct Object References (IDOR) — användare kan komma åt resurser via direkt manipulation av identifierare
- Saknad eller felaktig roll-kontroll
- Saknade ägarskapskontroller (multi-tenant-läckage)
- Privilege escalation (horisontellt eller vertikalt)
- CORS-konfiguration som tillåter otillåtna origins
- Force browsing till autentiserade sidor som unauthenticated user

### Vanliga manifestationer

```typescript
// IDOR — användare A kan läsa användare B:s faktura
@Get(':id')
async getInvoice(@Param('id') id: string) {
  return this.prisma.invoice.findUnique({ where: { id } })  // ❌ ingen tenant-check
}

// Saknad rollkontroll på destruktiv endpoint
@Delete(':id')
async deleteOrganization(@Param('id') id: string) {  // ❌ vem som helst kan radera
  return this.prisma.organization.delete({ where: { id } })
}

// Stol orgId från body istället för JWT
@Post()
async create(@Body() dto: CreatePropertyDto) {
  return this.prisma.property.create({
    data: { ...dto, organizationId: dto.organizationId }  // ❌ angripare kan välja org
  })
}
```

### Eveno-relevans

**Detta är vår #1 risk.** Eveno är multi-tenant — varje endpoint måste scopas till `organizationId` från JWT (`@OrgId()`), och destruktiva endpoints måste skyddas med `@Roles()`. Se `tidigare-buggar.md` FIX 1 och FIX 2 — vi har haft båda dessa.

### Detection

```bash
# IDOR — findUnique utan organizationId
grep -rn "findUnique({ *where: *{ *id" apps/api/src

# Queries utan organizationId
grep -rEn "(findMany|findFirst|update|delete|count)" apps/api/src | grep -v organizationId

# Destruktiva endpoints utan @Roles
grep -rB3 "@Delete\|@Put\|@Patch" apps/api/src | grep -v "@Roles"

# organizationId från body istället för JWT
grep -rn "dto\.organizationId\|body\.organizationId" apps/api/src
```

### Prevention

1. **Default-deny:** Global `JwtAuthGuard`, opt-out med `@Public()` enbart där medvetet
2. **Multi-tenant scoping:** varje Prisma-query inkluderar `organizationId` från `@OrgId()`-dekorator
3. **RBAC på alla state-changing endpoints:** `@Roles(OWNER, ADMIN)` etc.
4. **Aldrig stol identifierare från body/query/path för auktorisering** — bara från verifierad JWT-payload
5. **Integration-tester:** explicit testfall där "user A försöker komma åt user B:s data → 403/404"

### Severity

- **CRITICAL** — IDOR där angripare kan läsa eller modifiera tenant-data
- **HIGH** — saknad `@Roles()` där intra-org elevation är möjlig
- **MEDIUM** — saknad ownership-check på underordnade resurser (t.ex. unit som inte tillhör property som tillhör orgId)

---

## A02:2021 — Cryptographic Failures

**Andel apps med fynd:** 77%
**CWE-koppling:** CWE-259, CWE-327, CWE-331

### Beskrivning

Tidigare hette denna kategori "Sensitive Data Exposure". Fokus är på misslyckanden i kryptering som leder till exponering av känslig data:

- Klartext-lagring av lösenord, tokens, PII
- Användning av svaga eller deprekerade algoritmer (MD5, SHA1, DES, RC4)
- Egen kryptografi ("rolling your own crypto")
- Saknad TLS eller felaktigt konfigurerad TLS
- Hårdkodade nycklar eller secrets i kod
- Otillräcklig entropi i tokens/IDs

### Vanliga manifestationer

```typescript
// Klartext-lösenord
await this.prisma.user.create({ data: { email, password } }) // ❌

// Svag hash
const hash = crypto.createHash('md5').update(password).digest('hex') // ❌

// Hårdkodad secret
const JWT_SECRET = 'super-secret-key' // ❌

// Förutsägbar ID
const orderId = Date.now().toString() // ❌ — enumerable

// HTTP istället för HTTPS i prod
app.listen(80) // ❌
```

### Eveno-relevans

- **Lösenord:** vi använder bcryptjs 12 rounds — bra. Verifiera att INGEN ny kod någonsin lagrar klartext.
- **JWT-secret:** ska komma från `process.env.JWT_SECRET`, aldrig hårdkodad
- **PII i DB:** personnummer, bankkontonummer — överväg om de ska krypteras at-rest (vi gör det inte idag, men det är en HIGH-fråga vi bör adressera)
- **TLS:** Railway terminerar automatiskt
- **OCR-nummer:** har checksumma; UUID:s är säkra (v4)

### Detection

```bash
# Hårdkodade secrets
grep -rEn '(secret|password|api[_-]?key|token|jwt[_-]?secret)\s*[:=]\s*["'\''][^"'\''$]{8,}' apps/api/src

# Svaga hash-algoritmer
grep -rn "md5\|sha1\|DES\|RC4" apps/api/src apps/web/src

# Klartext-lösenord i DB-kod
grep -rn "password" apps/api/src/auth | grep -v "hash\|bcrypt\|compare"

# Saknad bcrypt
grep -rn "password" apps/api/src/auth
```

### Prevention

1. bcryptjs 12+ rounds för lösenord (vi gör detta)
2. Secrets via `process.env`, validerade vid uppstart med Zod
3. TLS överallt (Railway gör detta automatiskt — kontrollera prod-domän)
4. UUID v4 för identifierare (Prisma `@default(uuid())`)
5. Vid PII-kryptering at-rest: använd pgcrypto eller app-layer envelope encryption med KMS

### Severity

- **CRITICAL** — klartext-lösenord, hårdkodad nyckel i diff, MD5 för lösenord
- **HIGH** — JWT-secret med låg entropi, PII utan kryptering där det är reglerat (sjukvård/finans)
- **MEDIUM** — användning av deprekerad cipher i sekundär funktion

---

## A03:2021 — Injection

**Andel apps med fynd:** 94%
**CWE-koppling:** CWE-79 (XSS), CWE-89 (SQL injection), CWE-73, CWE-94

### Beskrivning

Tidigare två separata kategorier (Injection + XSS) som slogs ihop. Omfattar:

- SQL injection
- NoSQL injection (MongoDB, etc.)
- Command injection (shell exec med user input)
- LDAP injection
- XPath injection
- ORM injection (Prisma raw queries med interpolation)
- Cross-Site Scripting (reflected, stored, DOM-based)
- Template injection (Pug, Handlebars med user input)
- Email header injection

### Vanliga manifestationer

```typescript
// SQL injection via Prisma raw
const users = await this.prisma.$queryRaw`SELECT * FROM "User" WHERE email = ${email}`  // ❌ template literal interpolation utan parametrisering
// Korrekt: använd Prisma.sql eller parametriserade $queryRaw
const users = await this.prisma.$queryRaw`SELECT * FROM "User" WHERE email = ${Prisma.sql`${email}`}`

// Command injection
exec(`pdftk ${userFilename} output combined.pdf`)  // ❌ användarens filnamn kommer in oescaped

// XSS via dangerouslySetInnerHTML
<div dangerouslySetInnerHTML={{ __html: userInput }} />  // ❌

// Email-header injection
const subject = `Reply to ${userEmail}`  // ❌ kan innehålla \r\nBcc: angripare@evil.com
```

### Eveno-relevans

- **Prisma:** vi använder parametriserade queries by default, vilket skyddar mot SQL injection. **`$queryRawUnsafe` är förbjudet** utan explicit motivering.
- **XSS:** React eskapar by default. Risk uppstår om vi använder `dangerouslySetInnerHTML` (sökbart) eller om vi serverar HTML från API:t.
- **Command injection:** Puppeteer kör i sin egen sandbox; vi exec:ar inte shell-kommandon med user input.
- **Email:** Nodemailer eskapar headers, men templates som tar user input behöver kontrolleras (Mustache/Handlebars eskapar text by default men inte `{{{raw}}}`).
- **PDF-templates:** vi använder React-baserad rendering — skyddat. Men om templates får user input direkt i strukturen → kontrollera.

### Detection

```bash
# Raw SQL
grep -rn '\$queryRaw\|\$executeRaw' apps/api/src

# Unsafe React rendering
grep -rn "dangerouslySetInnerHTML" apps/web/src apps/portal/src

# Shell exec
grep -rn "exec\|spawn" apps/api/src | grep -v "test\|spec"

# Email-template render med user input
grep -rn "compileTemplate\|renderTemplate\|handlebars\|mustache" apps/api/src
```

### Prevention

1. Använd Prisma:s parametrisering (default). Undvik `$queryRawUnsafe`.
2. Använd `Prisma.sql` template tag för parametriserade raw queries
3. `class-validator` på alla DTOs (validera format, längd, typ)
4. React:s default eskaping — undvik `dangerouslySetInnerHTML` (om nödvändigt, sanitize med DOMPurify)
5. CSP-headers för defense-in-depth mot XSS
6. Aldrig konkatenera user input i shell-kommandon — använd `spawn` med array-args

### Severity

- **CRITICAL** — SQL injection, RCE via command injection
- **HIGH** — XSS i autentiserat område där PII kan stjälas
- **MEDIUM** — reflected XSS utan persistens, template injection i låg-priv context

---

## A04:2021 — Insecure Design

**CWE-koppling:** CWE-209, CWE-256, CWE-501

### Beskrivning

**Ny kategori i 2021.** Skiljer sig från andra OWASP-kategorier genom att fokusera på **designflaws** snarare än implementation-flaws. Du kan inte fixa en osäker design med säker kod — designen måste ändras.

Exempel:

- Saknad threat-modell vid feature-design
- Otillräcklig segregering av användare-roller
- Brist på rate-limiting i designen
- Förlitande på "security through obscurity"
- Affärslogik som tillåter exploitation (race conditions, missade auktoriseringssteg)
- Saknat audit-trail för känsliga operationer

### Vanliga manifestationer

- Lösenordsåterställning som mailar lösenordet i klartext
- API som låter användare ändra `userId` i request → ändra annans data
- Pris-fält i request body istället för att läsas från DB (tampering)
- Filuppladdning utan storleksgräns (DoS)
- Bank-import som inte är idempotent (dubbla transaktioner vid retry)

### Eveno-relevans

- **Affärslogik:** statusmaskinen för Invoice (`INVOICE_TRANSITIONS`) hindrar fel övergångar — bra design
- **Audit-trail:** `InvoiceEvent` append-only — bra design
- **OCR + bank-import:** FIX 6 var en designfix (FIFO + låsning) — visar hur viktigt detta är
- **AI-användning:** confidence-score, human-in-the-loop, cost-tracking (FIX 7) — designval för att förhindra missbruk

### Detection

Detection är manuell — granska designval, threat-modell vid feature-start. Frågor att ställa:

- Vilka roller kan göra vad med denna feature?
- Vad händer vid concurrent execution? Race condition?
- Vad händer vid retry/replay? Idempotent?
- Vad händer vid massmissbruk? Rate-limited?
- Vilka invarianter får aldrig brytas? Hur skyddas de?

### Prevention

1. Threat-modell vid varje större feature (STRIDE-analys)
2. Definiera security-requirements explicit, inte underförstått
3. Säker default-konfiguration (rate-limits, max-payload-sizes)
4. Använd statusmaskiner och invarianter för affärslogik (vi gör detta)
5. Audit-trail för känsliga operationer (vi gör detta för fakturor)

### Severity

- **CRITICAL** — designval som möjliggör mass-databreach eller ekonomisk skada
- **HIGH** — saknad rate-limiting på sensitive endpoint
- **MEDIUM** — saknad audit-trail på medel-sensitive operation

---

## A05:2021 — Security Misconfiguration

**Andel apps med fynd:** 90%
**CWE-koppling:** CWE-16, CWE-611

### Beskrivning

Felkonfigurerad applikation, ramverk, server, eller plattform. Inkluderar:

- Default-credentials (admin/admin)
- Aktiverade men oanvända features (PUT/DELETE när bara GET behövs)
- Verbose error messages i produktion (stack traces, SQL-fel)
- Saknade säkerhetsheaders (CSP, HSTS, X-Frame-Options)
- Dåligt konfigurerad CORS
- Out-of-date eller osäkra defaults i frameworks
- XML External Entity (XXE) attacks via bad XML parsing config

### Vanliga manifestationer

```typescript
// Verbose error i prod
app.useGlobalFilters(new ExceptionFilter({ exposeStack: true })) // ❌ läcker stack traces

// CORS allow-all
app.enableCors({ origin: '*', credentials: true }) // ❌ — credentials med wildcard är farligt

// Saknad helmet
// (ingen `app.register(helmet)` → saknade säkerhetsheaders)
```

### Eveno-relevans

- **HttpExceptionFilter:** måste stripa stack traces i prod — kontrollera
- **CORS:** bör vara restriktiv per Vercel-domain, inte wildcard
- **Helmet (eller Fastify-equivalent):** lägger till CSP, HSTS, X-Frame-Options, etc.
- **Swagger:** finns på `/api/docs` i dev — får INTE vara aktiverat i prod
- **Default-credentials:** vi har inga "admin/admin" — bra
- **Trust proxy:** Fastify måste konfigureras med `trustProxy: true` för korrekt IP-detection bakom Railway/Vercel

### Detection

```bash
# Wildcard CORS
grep -rn "origin: *['\"]*\*['\"]*" apps/api/src

# Swagger i prod
grep -rn "SwaggerModule\|setupSwagger" apps/api/src

# Stack trace i errors
grep -rn "stack\|trace" apps/api/src/common

# Saknade säkerhetsheaders
grep -rn "helmet\|@fastify/helmet" apps/api/src
```

### Prevention

1. `@fastify/helmet` registrerat med säker default-config
2. CORS restriktiv: explicita origins per env (prod-domän + Vercel preview-domäner)
3. `HttpExceptionFilter` strippar internals i prod (`NODE_ENV === 'production'`)
4. Swagger bara i dev (`if (process.env.NODE_ENV !== 'production')`)
5. Säkerhetsheaders verifierade i CI med `npm audit` + manuell `curl -I`
6. Konfiguration via Zod-schema som validerar vid uppstart

### Severity

- **HIGH** — verbose errors i prod som läcker internals
- **HIGH** — CORS wildcard med credentials
- **MEDIUM** — saknade security headers (defense-in-depth)
- **LOW** — Swagger aktiverat utan auth (men endast metadata exponerat)

---

## A06:2021 — Vulnerable and Outdated Components

**Andel apps med fynd:** 89%
**CWE-koppling:** CWE-1104

### Beskrivning

Användning av komponenter (npm-paket, runtimes, OS-deps) med kända sårbarheter eller utan support. Inkluderar:

- Out-of-date dependencies
- Out-of-date Node.js runtime
- Transitiva deps med CVEs
- Paket som inte längre underhålls
- Supply-chain attacks (postinstall-scripts, typo-squatting)

### Vanliga manifestationer

- `package.json` har deps med kända CVEs
- `pnpm-lock.yaml` inte uppdaterad → installerar gamla transitive deps
- Node 16 (EOL) i Dockerfile
- Användning av paket vars sista release är > 2 år gammal

### Eveno-relevans

- Vi har Renovate eller Dependabot? Om inte → setup
- `pnpm audit` ska köras i CI
- Snyk eller socket.dev för SBOM och supply-chain
- Node-version i Dockerfile ska vara aktuell LTS (20+ enligt `engines` i package.json)

### Detection

```bash
pnpm audit                       # CVEs i deps
pnpm outdated                    # Out-of-date paket
node --version                   # Säkerställ ≥ 20 LTS

# Nyligen tillkomna deps utan etablerad historia
git log --all --diff-filter=A -- '**/package.json' | head -50
```

### Prevention

1. Renovate/Dependabot för automatiska dep-updates
2. `pnpm audit --audit-level=moderate` blockerar PR i CI
3. Verifiera nya deps innan add: maintainers, senaste release, antal downloads, GitHub-aktivitet
4. Pinna deps explicit (inte `^` på säkerhetskritiska)
5. SBOM-generering (`@cyclonedx/cyclonedx-npm`) för audit
6. Frys minor versions för kritiska paket (Prisma, NestJS)

### Severity

- **CRITICAL** — känd RCE i deps i prod
- **HIGH** — kända CVEs med exploit-PoC
- **MEDIUM** — out-of-date major version utan kända CVEs (men risk)

---

## A07:2021 — Identification and Authentication Failures

**CWE-koppling:** CWE-297, CWE-287, CWE-384

### Beskrivning

Tidigare "Broken Authentication". Misslyckanden i att verifiera användarens identitet:

- Saknad MFA
- Tillåten credential stuffing (ingen rate-limit)
- Tillåtna svaga lösenord
- Användande av default/svaga/välkända lösenord
- Otillräcklig password recovery
- Plain-text/escapade/svagt hashade lösenord
- Sessions som inte invalideras vid logout
- Token utan rotation
- Förutsägbara session-IDs

### Vanliga manifestationer

```typescript
// Bruteforce möjligt
@Post('login')
async login(@Body() dto: LoginDto) {  // ❌ ingen rate-limit
  ...
}

// Tillåter "password"
@MinLength(4)  // ❌ för låg minimum
password: string

// Refresh-token utan rotation
async refresh(token: string) {
  const valid = await this.verifyRefresh(token)
  return this.generateAccessToken(...)  // ❌ samma refresh-token funkar igen
}

// Session inte invalideras
async logout(token: string) {
  return { success: true }  // ❌ token förblir giltig
}
```

### Eveno-relevans

- bcryptjs 12 rounds — bra
- JWT 15min + refresh 30d, **roteras** — bra
- Logout invaliderar refresh-token i DB — kontrollera
- Rate-limit på `/auth/login`, `/auth/register`, `/auth/forgot-password` — **kontrollera, riskområde**
- MFA finns inte (idag) — bör vara på roadmap för admin-roller
- Password policy: minst 8 tecken, mixed case, siffra, special — kontrollera schema
- Inga "secret questions" — bra
- Password reset via signed token, korttidsgiltighet — kontrollera

### Detection

```bash
# Rate-limit på auth-endpoints
grep -rn "@Throttle\|throttler\|rate.\?limit" apps/api/src/auth

# Lösenordsregler
grep -rn "password" packages/shared/src/schemas | grep -iE "(min|max|regex)"

# MFA
grep -rn "totp\|mfa\|two.\?factor" apps/api/src

# Session-invalidation
grep -rn "logout\|signout" apps/api/src
```

### Prevention

1. Rate-limit auth-endpoints (5 req/min/IP eller liknande)
2. Stark password-policy: 8+ tecken, mixed case, siffra (eller passphrases ≥ 12)
3. bcryptjs 12+ rounds (vi gör)
4. Refresh-token rotation (vi gör)
5. Logout invaliderar refresh-token i DB
6. Account-lockout efter N failed attempts
7. MFA för admin-roller (OWNER, ADMIN)
8. Password reset via signed JWT med 15min TTL, single-use

### Severity

- **CRITICAL** — bruteforce möjligt på login utan rate-limit
- **HIGH** — refresh-token utan rotation
- **HIGH** — logout invaliderar inte refresh-token
- **MEDIUM** — för svag password-policy

---

## A08:2021 — Software and Data Integrity Failures

**Ny kategori i 2021.**
**CWE-koppling:** CWE-829, CWE-494, CWE-502

### Beskrivning

Antaganden om integritet utan verifiering. Inkluderar:

- Användning av komponenter från opålitliga källor
- Insecure CI/CD pipelines som tillåter unauthorized code
- Auto-update utan integritetsverifiering
- Deserialization av untrusted data
- JSON Web Tokens med svag signaturverifiering
- Webhooks utan signaturverifiering

### Vanliga manifestationer

```typescript
// JWT med "none" algoritm tillåtet
verify(token, secret)  // ❌ — kontrollera algoritm explicit

// Deserialization av user-data
JSON.parse(userInput)  // ✅ för plain JSON men inte arbiträra typer
eval(userCode)  // ❌ NEVER

// Webhook utan signatur
@Post('webhook/stripe')
async webhook(@Body() body: any) {  // ❌ ingen signaturverifiering
  ...
}

// npm install från godtyckliga URL
"foo": "git+https://random-host.com/foo.git"  // ❌
```

### Eveno-relevans

- **JWT:** vi använder HS256 explicit — verifiera att verify-anropet bara accepterar HS256
- **Webhooks:** om vi tar emot Klarna/Stripe/PSD2 webhooks → måste signaturverifiera. Sök efter `/webhook`-routes
- **CI/CD:** GitHub Actions deployar till Railway/Vercel — secrets skyddade?
- **Deserialization:** vi gör inte `eval` eller arbiträr JSON-deserialization. Bra.
- **Supply chain:** se A06 — `pnpm audit`, Renovate

### Detection

```bash
# JWT-verify utan algoritm-restriction
grep -rn "jwt.verify\|jwtService.verify" apps/api/src

# Webhook-routes
grep -rn "webhook" apps/api/src

# eval
grep -rn "eval\|new Function" apps/api/src apps/web/src
```

### Prevention

1. JWT-verify med explicit algoritm: `verify(token, secret, { algorithms: ['HS256'] })`
2. Webhook-signaturer verifieras med HMAC, timing-safe comparison
3. NPM-deps från registry, inte direkt git-URLs
4. CI/CD med signed commits eller protected branches
5. Aldrig `eval` eller dynamic code execution

### Severity

- **CRITICAL** — JWT none-algoritm möjlig, webhook utan signatur
- **HIGH** — npm-paket från opålitlig källa
- **MEDIUM** — auto-update utan checksum

---

## A09:2021 — Security Logging and Monitoring Failures

**CWE-koppling:** CWE-117, CWE-223, CWE-532

### Beskrivning

Otillräcklig loggning och övervakning som hindrar incident-detektion och incident-respons. Inkluderar:

- Auditable events (login, failed login, high-value transactions) loggas inte
- Loggar saknar tillräcklig detalj
- Loggar lagras lokalt (försvinner vid container-restart)
- Loggar inte övervakade (ingen alerting)
- Loggar innehåller känslig data (lösenord, tokens, PII)
- Saknad incident-response-plan

### Vanliga manifestationer

- `console.log` istället för strukturerad logging
- Lösenord loggas i request-body
- Inga login-failure-logs (kan inte detektera bruteforce)
- Inga audit-logs för känsliga operationer
- Sentry skickar oscrubbed PII

### Eveno-relevans

- **Pino** för strukturerad logging i NestJS
- **Sentry** för error tracking
- **InvoiceEvent** för audit-trail av fakturahändelser
- CLAUDE.md: inga `console.log` (bara `console.warn`/`error`) — bra
- Pii-scrubbing i Sentry: **verifiera config**
- Login-failures loggas? **kontrollera**

### Detection

```bash
# console.log (förbjudet enligt CLAUDE.md)
grep -rn "console\.log" apps/api/src apps/web/src

# Loggning av lösenord/tokens
grep -rn "logger" apps/api/src/auth

# Sentry PII-scrubbing
grep -rn "beforeSend\|sendDefaultPii" apps/api/src apps/web/src
```

### Prevention

1. Strukturerad logging (Pino i NestJS, Sentry i web)
2. Audit-log för: login, failed login, password reset, role change, deletion of major entities
3. PII-scrubbing i Sentry (`beforeSend` hook)
4. Centraliserad logging (Better Stack, Datadog, etc.)
5. Alerts på anomali-patterns (50+ failed logins från samma IP)
6. Logs retained för minst 90 dagar (compliance)

### Severity

- **HIGH** — saknad audit-log för känsliga operationer (kan inte forensikera incident)
- **HIGH** — PII i loggar (GDPR-överträdelse)
- **MEDIUM** — saknad rate-anomali-alerting

---

## A10:2021 — Server-Side Request Forgery (SSRF)

**Ny kategori i 2021.**
**CWE-koppling:** CWE-918

### Beskrivning

Applikationen hämtar fjärrresurser utan att validera URL:en, vilket låter angripare manipulera requesten:

- Internt nätverksrekognoscering (skanna internt nätverk)
- Åtkomst till cloud metadata (AWS 169.254.169.254 → credentials)
- Bypass av brandvägg/access-kontroll
- DoS genom att tvinga applikationen göra många requests

### Vanliga manifestationer

```typescript
// Användarens URL hämtas oescaped
@Post('proxy')
async fetchUrl(@Body() { url }: { url: string }) {
  return await fetch(url)  // ❌ angripare kan ange 169.254.169.254 eller internal-svc.local
}

// Webhook-test som följer redirects till intern URL
const result = await axios.get(userWebhookUrl, { maxRedirects: 5 })  // ❌
```

### Eveno-relevans

- **AI-anrop:** vi anropar OpenAI/Anthropic — säkert (känd URL)
- **Filuppladdning från URL:** om någon endpoint hämtar fil från user-angiven URL → risk. Kontrollera.
- **Webhook-tester:** om vi har "test webhook"-funktionalitet → risk
- **PDF-generering:** Puppeteer renderar HTML från template — om template tar user-URLs som bildsource → SSRF möjligt
- **Cloud metadata:** Railway eller Vercel kör i kontrolledad miljö — men 169.254.169.254 ska blockeras ändå

### Detection

```bash
# Endpoints som tar URL från användaren
grep -rn "url.*string\|@Body.*url" apps/api/src

# Direkta fetch/axios med user input
grep -rn "fetch(\|axios" apps/api/src | grep -v "test\|spec"

# Puppeteer med user-angiven URL
grep -rn "page.goto\|page.setContent" apps/api/src
```

### Prevention

1. Allowlist för outbound URLs (känd OpenAI, Anthropic, Stripe, etc.)
2. Block private/internal IP-ranges: 10.x, 172.16.x, 192.168.x, 127.x, 169.254.x
3. DNS-resolution sker i app-koden, IP-validering före request
4. `maxRedirects: 0` på user-initiated requests, eller validera redirect-target
5. Nätverkssegmentering — backend-app saknar tillgång till metadata-endpoints

### Severity

- **CRITICAL** — SSRF som ger access till cloud credentials
- **HIGH** — SSRF som låter intern reconnaissance
- **MEDIUM** — SSRF som möjliggör DoS

---

## Sammanfattning — Eveno-prioritering

För vår kodbas är **A01 (Broken Access Control)** den absolut viktigaste — vi är multi-tenant, vi har haft incidenter (FIX 1, FIX 2), och konsekvensen av en läcka är direkt ekonomisk skada + GDPR-bot.

Granskningsprioritet (top-down):

1. **A01 — Broken Access Control** — multi-tenant + RBAC. Granska varje endpoint.
2. **A07 — Auth Failures** — rate-limit, MFA, refresh-rotation, password policy.
3. **A03 — Injection** — Prisma raw queries, dangerouslySetInnerHTML, email templates.
4. **A09 — Logging Failures** — audit-trail, PII-scrubbing i loggar.
5. **A02 — Cryptographic Failures** — secrets, password hashing, PII at-rest.
6. **A04 — Insecure Design** — threat-modell vid feature-design.
7. **A05 — Misconfiguration** — Helmet, CORS, Swagger-disabled-in-prod.
8. **A06 — Vulnerable Components** — Renovate, pnpm audit i CI.
9. **A08 — Integrity Failures** — JWT algoritm explicit, webhook-signaturer.
10. **A10 — SSRF** — kontrollera AI/webhook/file-upload-flöden.
