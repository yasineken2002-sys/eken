import { ForbiddenException } from '@nestjs/common'
import { ACTION_TOOLS } from './ai-tools.definition'
import { TENANT_ACTION_TOOLS } from './tenant-ai-tools.definition'

/**
 * BINDANDE VERKTYG FÅR INTE UTFÖRAS UTAN BEVIS PÅ EN KONSUMERAD BEKRÄFTELSE.
 *
 * ── VAD MÄTNINGEN VISADE ─────────────────────────────────────────────────────
 *
 * Utgångspunkten var att "inget hindrar att samma verktygsanrop utförs två
 * gånger". För LÄSVERKTYG stämmer det, och det är ofarligt. För de verktyg som
 * rör pengar stämmer det INTE:
 *
 *   `create_invoice`, `create_journal_entry` och `mark_invoice_paid` är alla
 *   ACTION_TOOLS. Ett ACTION_TOOL utförs ALDRIG i verktygsloopen — loopen ser
 *   `actionBlock` och returnerar en pending action i stället. Det utförs bara
 *   via `confirmAction`, och där ligger redan `consumePendingAction`: en ATOMÄR
 *   engångsanspråk (`updateMany` på `consumedAt: null`, `count === 1`) med
 *   utgångsspärr, som körs FÖRE `executeTool` och kastar när anspråket faller.
 *
 * En uppspelad bekräftelse utför alltså redan i dag ingenting. Hyresgäst-AI:n
 * har samma konstruktion mot `AiTenantConversation.pendingActionHash`.
 *
 * ── VAD SOM DÄREMOT SAKNADES ─────────────────────────────────────────────────
 *
 * Att ett ACTION_TOOL inte kan nå `executeTool` utan att ha passerat anspråket
 * vilar på att TRE loopar var för sig kommer ihåg att kolla `actionBlock`:
 *
 *   ai-assistant.service.ts:748    ai-assistant.controller.ts:412
 *   tenant-ai.service.ts:193
 *
 * Tre kopior av samma kontroll är en VANA, inte en invariant. En fjärde
 * anropsväg — och det agentiska bygget är precis en sådan — når `executeTool`
 * direkt, och då står ingenting mellan modellen och en verifikationspost.
 *
 * Invarianten flyttas därför hit och prövas i `executeTool`, dit ALLA vägar
 * måste. Loopar­nas `actionBlock`-kontroller blir djupförsvar i stället för det
 * enda som håller. Samma konstruktion som utfallskopplingen (#562) och
 * `createReversalEntry` (#538): regeln bor på ETT ställe, och en ny väg ärver
 * den utan att någon tänker på det.
 *
 * ── VARFÖR INTE NYCKLA PÅ tool_use-id ────────────────────────────────────────
 *
 * Det vore rätt nyckel om bindande verktyg utfördes i loopen. Mätningen säger
 * att de inte gör det: `confirmAction` anropas från `POST /ai/confirm` med
 * `toolName` + `toolInput` från klienten, och det tool_use-block modellen en
 * gång skrev tillhör en TIDIGARE tur. Det finns inget tool_use-id att nyckla på
 * i den enda väg som utför åtgärden. (I loopen, där id:t finns, körs bara
 * läsverktyg — och att köra om en läsning är ofarligt.)
 *
 * Id:t överlever inte heller en återanslutning: SSE-strömmen är en GET, och en
 * ny anslutning ger en ny modelltur med nya tool_use-id:n.
 *
 * Beviset är i stället den KONSUMERADE raden. Den är atomiskt anspråkad, den
 * finns i databasen, och den går att verifiera i efterhand — till skillnad från
 * ett id som bara passerade genom minnet.
 */

/** Är verktyget bindande — alltså sådant som kräver bekräftelse? */
export function isActionTool(toolName: string): boolean {
  return ACTION_TOOLS.has(toolName) || TENANT_ACTION_TOOLS.has(toolName)
}

/**
 * Beviset som `confirmAction`-vägarna lämnar in.
 *
 * `pendingActionId` finns bara på ägarvägen, där bekräftelsen är en EGEN rad
 * (`AiPendingAction`). Hyresgästvägen bär sitt anspråk som en hash-kolumn på
 * konversationen som nollas vid anspråket — det finns ingen rad att peka på, och
 * att införa en bara för symmetrins skull hade varit att bygga om en fungerande
 * mekanism för att den ser annorlunda ut.
 *
 * Båda vägarna måste däremot ha GJORT sitt anspråk innan de anropar, och det är
 * vad `claimed` intygar. Fältet sätts EXKLUSIVT av de två anspråksfunktionerna.
 */
export interface ActionProof {
  /** Sant endast efter ett lyckat, atomärt engångsanspråk. */
  claimed: true
  /** `AiPendingAction.id` när bekräftelsen bars av en egen rad (ägarvägen). */
  pendingActionId?: string
}

/**
 * Grinden. Kastar om ett bindande verktyg saknar bevis.
 *
 * `ForbiddenException` och inte `BadRequest`: det är inte anropet som är
 * felformat, det är behörigheten som saknas. En AI som når hit utan bevis har
 * kringgått människans bekräftelse, och det är samma klass av fel som ett
 * saknat rollkrav.
 */
export function assertActionToolAuthorized(toolName: string, proof: ActionProof | undefined): void {
  if (!isActionTool(toolName)) return
  if (proof?.claimed === true) return
  throw new ForbiddenException(
    `Den bindande åtgärden "${toolName}" kan inte utföras utan en bekräftelse som ` +
      'konsumerats. Åtgärden måste föreslås av assistenten och bekräftas av en människa.',
  )
}
