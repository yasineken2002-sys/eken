import type Anthropic from '@anthropic-ai/sdk'

/**
 * PAR-INVARIANTEN: varje `tool_use` MÅSTE följas av ett `tool_result` i nästa
 * meddelande, annars avvisar Anthropic hela requesten med 400:
 *
 *   messages.6: `tool_use` ids were found without `tool_result` blocks
 *   immediately after: toolu_… Each `tool_use` block must have a corresponding
 *   `tool_result` block in the next message.
 *
 * Modulen finns för att invarianten hölls på TVÅ ställen med två olika
 * implementationer — SSE-vägen mappade ALLA tool_use till resultat,
 * icke-strömmande vägen bara den FÖRSTA (`.find()`). Divergensen var buggen.
 * Nu finns regeln på ett ställe och båda vägarna kallar samma kod.
 */

type Block = { type?: string; [key: string]: unknown }

function blocksOf(message: Anthropic.MessageParam): Block[] | null {
  return Array.isArray(message.content) ? (message.content as unknown as Block[]) : null
}

/**
 * Blocktyper som ALDRIG persisteras i en assistent-rads `blocks`.
 *
 * `tool_use` — tool_result-blocken persisteras aldrig; de lever bara i minnet
 * under tool-loopen. Ett sparat `tool_use` är därför ett halvt par per
 * definition, och när konversationen läses in igen 400:ar VARJE följande
 * meddelande. Konversationen blir permanent förgiftad. Det inträffade när
 * tool-loopen tog slut på iterationer med `stop_reason` fortfarande `tool_use`.
 *
 * `thinking` / `redacted_thinking` — resonemangsblock. De persisterades förr,
 * vilket var ofarligt så länge HELA chatten körde en enda modell. Sedan
 * modellvalet blev per meddelande (Sonnet för text, Opus 5 för bilagor) kan en
 * och samma konversation innehålla turer från olika modeller, och då blir ett
 * sparat thinking-block en koppling mellan historiken och den modell som råkade
 * skriva den. Två skäl att strippa dem:
 *
 *  1. De bär ingen information. Opus 5 returnerar aldrig sin råa tankekedja —
 *     med default-`display` är `thinking`-fältet tomt. Vi sparar alltså ett
 *     block utan innehåll och skickar tillbaka det i varje efterföljande tur.
 *  2. De är modellbundna. Att spela upp ett resonemangsblock för en ANNAN modell
 *     än den som skapade det är i bästa fall en no-op och i värsta fall ett
 *     avvisat anrop. Utan blocken är historiken modelloberoende av konstruktion
 *     i stället för att förlita sig på att API:t är förlåtande.
 *
 * Textblocken — det användaren faktiskt läste — är opåverkade.
 */
const NON_PERSISTED_BLOCK_TYPES = new Set(['tool_use', 'thinking', 'redacted_thinking'])

/**
 * Vad som får PERSISTERAS som en assistent-rads `blocks`.
 *
 * Returnerar `null` när ingenting meningsfullt återstår — anroparen sparar då
 * ingen `blocks`-kolumn och rehydreringen faller tillbaka på `content`
 * (den extraherade texten), vilket är exakt vad äldre rader redan gör.
 */
export function sanitizeBlocksForPersistence(
  content: Anthropic.ContentBlock[],
): Anthropic.ContentBlock[] | null {
  const kept = content.filter((b) => !NON_PERSISTED_BLOCK_TYPES.has(b.type))
  // Utan ett textblock finns inget att återge — bara resonemang eller tomhet.
  if (!kept.some((b) => b.type === 'text')) return null
  return kept
}

/**
 * Rensar resonemangsblock ur en historik som redan ligger i databasen.
 *
 * Backstop för rader skrivna FÖRE stripningen ovan: de kan bära thinking-block
 * från en Opus-tur, och nästa meddelande i samma konversation kan gå till
 * Sonnet. Körs på väg IN till modellen, precis som par-invarianten.
 */
export function stripThinkingBlocks(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((message) => {
    const blocks = blocksOf(message)
    if (!blocks) return message
    const kept = blocks.filter((b) => b['type'] !== 'thinking' && b['type'] !== 'redacted_thinking')
    if (kept.length === blocks.length) return message
    return { ...message, content: kept as unknown as Anthropic.ContentBlockParam[] }
  })
}

/** tool_use_id:n som besvaras av ett meddelande (tomt om det inte är svar). */
function answeredIds(message: Anthropic.MessageParam | undefined): Set<string> {
  const ids = new Set<string>()
  if (!message || message.role !== 'user') return ids
  for (const block of blocksOf(message) ?? []) {
    if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
      ids.add(block['tool_use_id'])
    }
  }
  return ids
}

export interface ToolPairRepair {
  /** tool_use som saknade svar och därför togs bort. */
  droppedToolUses: string[]
  /** tool_result som saknade anrop och därför togs bort. */
  droppedToolResults: string[]
  /** Meddelanden som blev tomma och därför föll bort helt. */
  droppedMessages: number
}

/**
 * SISTA GRINDEN före SDK-anropet: gör meddelandelistan parvis konsistent.
 *
 * Backstop, inte primärskydd. Persistensen ska aldrig spara ett halvt par och
 * tool-loopen ska alltid svara på alla anrop — men ett historikobjekt som redan
 * ligger i databasen (skrivet av den gamla koden) får inte kunna fälla en
 * request igen. Den här funktionen släpper ofullständiga par i BÅDA riktningar:
 *
 *  • `tool_use` utan matchande `tool_result` i NÄSTA meddelande → tas bort.
 *  • `tool_result` utan matchande `tool_use` i FÖREGÅENDE meddelande → tas bort
 *    (det spegelvända fallet, som ger samma 400 från andra hållet).
 *
 * Ett par tas alltid bort HELT — aldrig en halva. Blir ett meddelande utan
 * innehåll faller det bort i sin helhet: Anthropic avvisar tomma
 * content-arrayer.
 */
export function enforceToolPairInvariant(messages: Anthropic.MessageParam[]): {
  messages: Anthropic.MessageParam[]
  repair: ToolPairRepair
} {
  const repair: ToolPairRepair = {
    droppedToolUses: [],
    droppedToolResults: [],
    droppedMessages: 0,
  }

  // Steg 1: strippa tool_use som inte besvaras av nästa meddelande.
  const afterToolUse = messages.map((message, index) => {
    const blocks = blocksOf(message)
    if (message.role !== 'assistant' || !blocks) return message

    const toolUseIds = blocks
      .filter((b) => b['type'] === 'tool_use')
      .map((b) => b['id'])
      .filter((id): id is string => typeof id === 'string')
    if (toolUseIds.length === 0) return message

    const answered = answeredIds(messages[index + 1])
    const orphans = toolUseIds.filter((id) => !answered.has(id))
    if (orphans.length === 0) return message

    repair.droppedToolUses.push(...orphans)
    return {
      ...message,
      content: blocks.filter(
        (b) => b['type'] !== 'tool_use' || !orphans.includes(b['id'] as string),
      ) as unknown as Anthropic.ContentBlockParam[],
    }
  })

  // Steg 2: strippa tool_result som inte har ett anrop kvar i föregående
  // meddelande. Måste ske EFTER steg 1 — ett svar kan bli föräldralöst av att
  // dess anrop just togs bort.
  const afterToolResult = afterToolUse.map((message, index) => {
    const blocks = blocksOf(message)
    if (message.role !== 'user' || !blocks) return message

    const previous = afterToolUse[index - 1]
    const previousBlocks = previous?.role === 'assistant' ? blocksOf(previous) : null
    const availableIds = new Set(
      (previousBlocks ?? [])
        .filter((b) => b['type'] === 'tool_use')
        .map((b) => b['id'])
        .filter((id): id is string => typeof id === 'string'),
    )

    const orphans = blocks
      .filter((b) => b['type'] === 'tool_result')
      .map((b) => b['tool_use_id'])
      .filter((id): id is string => typeof id === 'string' && !availableIds.has(id))
    if (orphans.length === 0) return message

    repair.droppedToolResults.push(...orphans)
    return {
      ...message,
      content: blocks.filter(
        (b) => b['type'] !== 'tool_result' || !orphans.includes(b['tool_use_id'] as string),
      ) as unknown as Anthropic.ContentBlockParam[],
    }
  })

  // Steg 3: ta bort meddelanden som blev tomma. En tom content-array avvisas
  // också av API:t, så ett halvt fix hade bytt ett 400 mot ett annat.
  const cleaned = afterToolResult.filter((message) => {
    const blocks = blocksOf(message)
    if (blocks && blocks.length === 0) {
      repair.droppedMessages++
      return false
    }
    if (typeof message.content === 'string' && message.content.length === 0) {
      repair.droppedMessages++
      return false
    }
    return true
  })

  return { messages: cleaned, repair }
}

/** true om saneringen faktiskt behövde ändra något (värt att logga). */
export function wasRepaired(repair: ToolPairRepair): boolean {
  return (
    repair.droppedToolUses.length > 0 ||
    repair.droppedToolResults.length > 0 ||
    repair.droppedMessages > 0
  )
}

/** Kort, loggbar sammanfattning av en reparation. */
export function describeRepair(repair: ToolPairRepair): string {
  return [
    `${repair.droppedToolUses.length} obesvarade tool_use`,
    `${repair.droppedToolResults.length} föräldralösa tool_result`,
    `${repair.droppedMessages} tomma meddelanden`,
  ].join(', ')
}
