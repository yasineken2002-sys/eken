# Installerbar hyresgästportal och offentlig offline-sida

Portalen kan erbjudas som en installerbar webbapp där webbläsaren stöder det.
Installationshjälpen finns på login och under inställningar. Webbläsarens erbjudande
och användarens klick krävs för den inbyggda dialogen. Ett accepterat erbjudande
räknas inte som slutförd installation; `appinstalled` eller faktiskt fristående
visningsläge ger bekräftelse. Menyhjälp finns när ingen dialog erbjuds.

## Offlinegräns

Installationen gör inte privata funktioner tillgängliga offline. Avier, dokument,
ärenden och andra personuppgifter behöver fortfarande nät och en giltig session.
Service workern lagrar endast `/offline-v1.html` i `eveno-portal-offline-v1`.
Sidan är offentlig, självständig och innehåller inga personuppgifter, script eller
externa resurser. Dess hela SHA-256, HTTP-status, innehållstyp och URL verifieras
innan den skrivs till CacheStorage. Hämtningen saknar credentials och tillåter
inte omdirigeringar. Cachens svar får en separat uppsättning säkra headers.

Bara uttryckligen uppräknade GET-navigationer utan query kan få denna sida när
nätanropet misslyckas. Fallbacken svarar 503; verkliga HTTP-fel lämnas oförändrade.
API-anrop, POST, dokument, bilder, okända sökvägar, externa origins och URL:er med
parametrar får ingen fallback. Aktivering och lösenordsåterställning med token
är undantagna även om deras sida annars skulle finnas i portalens router.
Inga runtime-svar, privata API-svar eller React Query-data läggs i workerns cache.
Ingen offlinekö, Background Sync eller automatisk omsändning införs.

CacheStorage är separat från webbläsarens vanliga HTTP-cache och portalens
befintliga sessionslagring. Detta paket är inget påstående om att all lokal
lagring i hela produkten är avskaffad. Sessionsisolering och återkallelse hanteras
av de tidigare portaländringarna.

## Registrering och uppdatering

Workern registreras endast i produktionsbygge och säker kontext. Misslyckad
registrering får inte stoppa portalens vanliga start. Ingen `skipWaiting`,
`clients.claim` eller automatisk omladdning tar över ett öppet formulär.
En ny worker väntar på sin normala livscykel; första besöket behöver en efterföljande
navigation för att kontrolleras av workern. Äldre cacheversioner med exakt appens
eget prefix rensas vid aktivering, andra cacheområden lämnas kvar.

Vid förändring av offline-sidan: versionera filnamn och cache, uppdatera HTML-digest,
workerreferens och hostingregel tillsammans. Kontrollera alltid byggd fil, inte bara
källtext. En felaktig digest stoppar installationen i stället för att spara ett
okänt dokument. Ikonernas färger kommer från `packages/ui/src/tokens.ts` och
E-motivet från portalens befintliga varumärke.

## Verifiering före publicering

Kör `pnpm --filter @eken/portal build` och `pnpm --filter @eken/portal test:pwa`.
Installera först matchande testmotorer med `pnpm --filter @eken/portal exec
playwright install --no-shell chromium webkit`. På Linux krävs även den installerade
Playwright-versionens WebKit-systemberoenden.

Proven använder byggd dist, riktig loopback-HTTP-server och nya profiler i både
Chromium och WebKit, med service workers tillåtna. Tio fall per motor körs med en
worker, utan omförsök eller undantagna fall. API-svaren är syntetiska. Ett separat
TCP-avbrott stänger serversvaret och jämför klient med och utan worker; detta
ersätter inte klientens offlineprov. Båda måste klara sina egna krav.

Web och portal använder samma låsta Playwright-version och bundlad full Chromium
med `channel: 'chromium'` (nytt headless-läge), inte en godtycklig systembrowser.
Playwright 1.64.1 innehåller WebKit-rättningen för offlinenavigation med service
worker. Versionsbytet får aldrig ersätta kraven på faktisk 503 från workern och
utebliven fallback för API/PDF/token/externt origin. Portalens vanliga Vitest-svit
och befintliga E2E körs också. CI kör båda motorerna i befintligt E2E-jobb efter
den ordinarie sviten och kräver exakt 20 godkända PWA-prov utan fel, flaky eller
skip. Browsercachen binds till installerad version, OS-version och arkitektur;
WebKits OS-bibliotek installeras med separat timeout även vid cacheträff.

Kontrollera i publicerad testmiljö att manifest, worker, offlinefil och ikoner
har rätt innehåll/MIME och inte ersätts av SPA-rewrite. Vercelkonfigurationens
smala headers är en avsikt, inte bevis för en faktisk driftsatt server. Workern
och manifestet ska revalideras. Första installation, naturlig uppdatering och
kallstart ska provas där. Publicering ingår inte i den lokala verifieringen.

Chromium-/WebKitprov och mobil viewport bevisar inte en lyckad installation på en fysisk
iPhone. Gör separat Safari-/iPhone-kontroll av hemskärmsval, start, utloggning och
nätavbrott. Lova inte App Store-distribution eller generell privat offlineåtkomst.

## Tekniska källor

- [MDN: fetch-event och nät/fallback](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/fetch_event)
- [Playwright: service workers och begränsningar](https://playwright.dev/docs/service-workers)
- [Vite: publika byggresurser](https://vite.dev/guide/assets.html)

- [Playwright: bundlade motorer och nytt headless-läge](https://playwright.dev/docs/browsers)
- [Playwright: WebKit-rättning av offline/fetch-event](https://github.com/microsoft/playwright/pull/42894)
