import sanitizeHtml from 'sanitize-html'

/**
 * SANERING AV MÄNNISKO- OCH MODELLFÖRFATTAD BRÖDTEXT I MEJL — ETT STÄLLE.
 *
 * ── VARFÖR DEN LIGGER HÄR OCH INTE I VARJE ANROPARE ─────────────────────────
 *
 * `base/Custom.tsx` renderar sin `bodyHtml` med `dangerouslySetInnerHTML`, och
 * säger det rakt ut i sin egen docblock: *"Måste redan vara säker —
 * sanitiseras inte."* Ansvaret ligger alltså per konstruktion hos anroparen.
 *
 * Två anropare bygger den HTML:en i dag: `MessagesService` (operatörens
 * fritext) och AI-verktyget `compose_and_send_email` (modellens fritext). Innan
 * den här filen fanns sanerade den FÖRSTA och den andra inte alls.
 *
 * Rättningen får inte vara en andra sanerare. Två allowlists mot samma mall är
 * hur den ena tyst blir svagare än den andra: någon lägger till en tagg där den
 * behövs, den andra listan följer inte med, och ingen kontroll blir röd. Därför
 * EN allowlist och EN renderare, som båda vägarna använder.
 *
 * ── VAD DEN HÄR FILEN INTE GÖR ──────────────────────────────────────────────
 *
 * Den sanerar BRÖDTEXT. Skalärer som vävs in runt brödtexten — mottagarens
 * namn i hälsningen, organisationsnamnet, ämnesraden — är inte HTML och ska
 * `escapeHtml`:as av anroparen, inte skickas hit. Och den säger ingenting om
 * mallens eget omslag: att `MessagesService` matar in ett HELT HTML-dokument
 * hit i stället för ett fragment är ett eget ärende (#629).
 */

/**
 * Tillåtna taggar i användar-/modellförfattad brödtext.
 *
 * Flyttad hit ur `messages.service.ts` UTAN ändring — samma taggar, samma
 * attribut, samma scheman, samma `disallowedTagsMode`. Att listan flyttade sig
 * får inte samtidigt betyda att den ändrade sig.
 */
export const USER_HTML_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'strong',
    'em',
    'a',
    'br',
    'ul',
    'ol',
    'li',
  ],
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  disallowedTagsMode: 'discard',
}

/**
 * Gör brödtext till sanerade `<p>`-stycken. Tomma rader faller bort.
 *
 * `disallowedTagsMode: 'discard'` behåller TEXTEN i en otillåten tagg men
 * kastar taggen — utom för sanitize-htmls `nonTextTags` (`script`, `style`,
 * `textarea`, `option`), där både tagg och innehåll försvinner. Det är den
 * skillnad som gör `<b>hej</b>` till `hej` medan `<script>…</script>` blir
 * ingenting alls.
 */
export function renderUserParagraphs(text: string): string {
  return text
    .split('\n')
    .filter((rad) => rad.trim())
    .map((rad) => `<p>${sanitizeHtml(rad, USER_HTML_OPTS)}</p>`)
    .join('\n')
}
