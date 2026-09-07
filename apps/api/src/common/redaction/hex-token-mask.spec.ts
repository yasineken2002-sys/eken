/**
 * BÄRARTOKEN I FRITEXT MASKERAS — och maskeringen når Sentrys TAGGAR.
 *
 * ── VAD SOM HÄNDE ───────────────────────────────────────────────────────────
 *
 * Etapp 10:s svarslänk lägger ett 32-bytes token i URL:ens PATH
 * (`/arbetsorder/<64 hex>`), till skillnad från de äldre länkarna som bär det
 * som query-parameter. `GlobalExceptionFilter` sätter `scope.setTag('path',
 * request.url)` vid varje 5xx, och `skrubbaEvent` skrubbade request,
 * breadcrumbs, extra och contexts — men ALDRIG tags.
 *
 * Uppräkningen såg komplett ut: fyra fält, alla hanterade. Den hade bara aldrig
 * prövats mot det femte. En fortfarande giltig bärartoken kunde alltså hamna som
 * en sökbar sträng i Sentrys UI.
 *
 * ── VAD PROVET MÄTER ────────────────────────────────────────────────────────
 *
 * Att mönstret träffar rätt form OCH att det inte träffar för brett. Det andra
 * är inte pedanteri: ett för brett mönster maskerar commit-shas och uuid:n, och
 * gör felmeddelanden obrukbara — vilket i praktiken leder till att någon stänger
 * av maskeringen.
 */
import { maskSensitiveText } from './redact-sensitive'

const TOKEN = 'a'.repeat(64)
const BLANDAT = '9f2a3c4d5e6f7081920a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607'.slice(0, 64)

describe('bärartoken i hex maskeras', () => {
  it('ett 64-teckens hextoken i en sökväg maskeras', () => {
    const ut = maskSensitiveText(`https://app.exempel.se/arbetsorder/${TOKEN}`)
    expect(ut).not.toContain(TOKEN)
    expect(ut).toContain('[token]')
  })

  it('samma token som query-parameter maskeras också', () => {
    const ut = maskSensitiveText(`/reset-password?token=${BLANDAT}`)
    expect(ut).not.toContain(BLANDAT)
  })

  it('versaler och gemener behandlas lika', () => {
    const ut = maskSensitiveText(TOKEN.toUpperCase())
    expect(ut).toBe('[token]')
  })

  /**
   * DEN AVGÖRANDE ÅT ANDRA HÅLLET. Ett för brett mönster gör felmeddelanden
   * obrukbara, och då stängs maskeringen av — vilket är värre än hålet.
   */
  it('MOTPROV: kortare hexsekvenser blir inte [token]', () => {
    // Assertionen är `[token]`, inte oförändrad text, och skillnaden är mätt:
    // ett heltaligt uuid (`11111111-2222-4333-8444-555555555555`) maskeras av
    // det BEFINTLIGA personnummermönstret, inte av det här. Att kräva
    // oförändrad text hade alltså mätt en annan regel än den provet handlar om
    // — och den regeln är avsiktlig, se "ÖVERMASKERING ÄR RÄTT RIKTNING" i
    // redact-sensitive.ts.
    const sha = '7eb9cd8d7d5ff37fa539d34424343db85871c6ae' // 40 — commit-sha
    const uuid = 'a1b2c3d4-e5f6-4789-8abc-def012345678'
    const farg = 'ffffff'
    for (const oror of [sha, uuid, farg]) {
      expect(maskSensitiveText(oror)).not.toContain('[token]')
    }
    // …och commit-shan ska dessutom stå kvar HELT, den bär inget att skydda.
    expect(maskSensitiveText(sha)).toBe(sha)
  })

  it('MOTPROV: 65 hextecken är inte formen och maskeras inte', () => {
    const langre = 'a'.repeat(65)
    expect(maskSensitiveText(langre)).toBe(langre)
  })

  /**
   * KANARIEFÅGEL — mot INSTRUMENTET.
   *
   * Proven ovan är gröna om `maskSensitiveText` returnerar något utan token.
   * De vore också gröna om funktionen råkade returnera tom sträng, eller om
   * indata aldrig innehöll token. Den här kräver att texten RUNT token
   * överlever — alltså att sonden kan skilja "maskerat" från "raderat".
   */
  it('KANARIEFÅGEL: bara token byts ut, resten av texten står kvar', () => {
    const ut = maskSensitiveText(`fel vid POST /work-orders/${TOKEN}/respond (500)`)
    expect(ut).toContain('/work-orders/')
    expect(ut).toContain('/respond (500)')
    expect(ut).not.toContain(TOKEN)
  })
})
