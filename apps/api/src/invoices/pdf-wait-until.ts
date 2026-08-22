import type { PuppeteerLifeCycleEvent } from 'puppeteer'

/**
 * Hur länge Puppeteer väntar innan sidan anses färdig och PDF:en skrivs.
 *
 * ── VARFÖR DET INTE ÄR `networkidle0` LÄNGRE ────────────────────────────────
 *
 * `networkidle0` väntar på att nätverket ska vara tyst i 500 ms. Alla PDF-mallar
 * bygger ett komplett HTML-dokument i Node och skickar det till `setContent` —
 * sidan hämtar ingenting utifrån. Väntan var alltså en väntan på ingenting, och
 * det syns på att den var OBEROENDE AV INNEHÅLLET:
 *
 *     med logotyp        1944 ms      tom sida          1974 ms
 *     utan logotyp       1949 ms      1,5 kB … 16 kB    1940–1984 ms
 *
 * Verkligt arbete i samma render är ~170 ms (`page.pdf` ≈ 64 ms). Uppmätt över
 * samtliga tolv mallproducenter: NOLL nätverksanrop, och en fast väntan på
 * ~1970 ms oavsett dokumentets storlek. För 4 500 avier är det ~60 min mot
 * uppskattat ~5 min.
 *
 * ── VARFÖR `load` OCH INTE `domcontentloaded` ───────────────────────────────
 *
 * `load` väntar in bilder som ingår i laddningen. `domcontentloaded` gör det
 * inte. Skillnaden är ~7 ms mot ~8 ms — att köpa den svagare garantin för en
 * millisekund är inte värt något, och `load` är rätt sida av gränsen den dagen
 * någon lägger in en bild som inte redan är en `data:`-URL.
 *
 * ── VAD SOM HÅLLER DET SANT ─────────────────────────────────────────────────
 *
 * Antagandet är att ingen mall hämtar något utifrån. Det är inte en vana utan
 * en grind: `scripts/check-pdf-templates-selfcontained.mjs` härleder samtliga
 * mallproducenter UR KODEN och fäller CI på `http(s)://`, protokollrelativt
 * `//`, `@import`, `url(`, `<link`, `<script`, `@font-face` — och på en
 * `src=`/`href=` som inte är en `data:`-URL.
 *
 * Ser du en PDF som saknar sin logotyp: höj INTE tillbaka den här konstanten.
 * Väntan mättes till att vänta på ingenting, och en logotyp som saknas kommer
 * från `getLogoDataUrl` (som returnerar null när R2-hämtningen misslyckas),
 * inte från att sidan inte hann ladda.
 */
export const PDF_WAIT_UNTIL: PuppeteerLifeCycleEvent = 'load'
