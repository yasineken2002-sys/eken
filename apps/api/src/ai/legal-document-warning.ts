/**
 * Varnings-mekanism för send_document_to_tenant.
 *
 * Filosofi (Eveno): INFORMERA och VARNA — blockera aldrig hårt kundens egna
 * informerade val. När ett dokument som levereras till en hyresgästs portal
 * kan uppfattas som en rättsligt verkande handling (uppsägning, hyreshöjning,
 * rättelseanmaning, förverkande) ska bekräftelserutan tydligt upplysa
 * hyresvärden om att portalleverans INTE ger rättslig verkan — men om hen ändå
 * bekräftar levereras dokumentet som ett informellt brev.
 *
 * PROJEKTREGEL: ingen kod här citerar SFS-nummer eller paragrafer som fakta.
 * Varningen hålls i klartext ("hyreslagens formkrav"); den juridiska
 * exaktheten verifieras av människa/jurist.
 */

export interface LegalDocumentWarning {
  /** Klartext-etikett för den misstänkta handlingstypen, t.ex. "uppsägning". */
  label: string
  /** Färdig varningstext att visa i bekräftelserutan. */
  warning: string
}

interface Pattern {
  label: string
  /** Klartextnamn för "en formell X" i varningstexten. */
  formalName: string
  keywords: RegExp
}

// Ordningen avgör vilken etikett som vinner vid flera träffar (mest ingripande
// först). Nyckelorden är medvetet breda — vi hellre varnar en gång för mycket
// än missar en rättsverkande handling. En falsk varning blockerar inget.
const PATTERNS: Pattern[] = [
  {
    label: 'uppsägning',
    formalName: 'uppsägning',
    keywords: /\b(uppsäg\w*|säger upp|säga upp|sägs upp|avflyttning krävs)\b/i,
  },
  {
    label: 'förverkande/avhysning',
    formalName: 'förverkande eller avhysning',
    keywords: /\b(förverk\w*|avhys\w*|vräkn\w*|vräka)\b/i,
  },
  {
    label: 'rättelseanmaning',
    formalName: 'rättelseanmaning eller tillsägelse',
    keywords: /\b(rättelse\w*|anmaning\w*|tillsägelse\w*|åtgärda omedelbart)\b/i,
  },
  {
    label: 'hyreshöjning',
    formalName: 'hyreshöjning',
    keywords: /(hyreshöjn\w*|höjd hyra|höja hyran|höjning av hyran|ny hyra från)/i,
  },
]

/**
 * Klassificerar titel + innehåll och returnerar en varning om dokumentet kan
 * vara av rättsligt verkande karaktär — annars null. Ren funktion (inga
 * sidoeffekter) så den är enkel att enhetstesta.
 */
export function detectLegalDocumentWarning(
  title: string | undefined,
  content: string | undefined,
): LegalDocumentWarning | null {
  const haystack = `${title ?? ''}\n${content ?? ''}`
  const match = PATTERNS.find((p) => p.keywords.test(haystack))
  if (!match) return null

  return {
    label: match.label,
    warning:
      `⚠️ Detta dokument kan uppfattas som en ${match.label}, men levereras bara till ` +
      `hyresgästens portal. Det utgör INTE en juridiskt giltig ${match.formalName} — en ` +
      `formell ${match.formalName} kräver delgivning enligt hyreslagens formkrav, och ` +
      `portalleverans räcker inte för rättslig verkan. Vill du ändå skicka det som ett ` +
      `informellt brev kan du bekräfta nedan.`,
  }
}
