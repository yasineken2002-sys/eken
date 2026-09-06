import { ForbiddenException } from '@nestjs/common'
import { prövaDuglighet } from '../assignments/assignment-eligibility'
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
/**
 * BEVISET FÖR EN DELEGERAD KÖRNING — ett EGET bevis, aldrig ett `ActionProof`.
 *
 * ── VARFÖR INTE ÅTERANVÄNDA ActionProof ────────────────────────────────────
 *
 * Det hade varit en rad kod, och det är precis felet. `ActionProof.claimed`
 * betyder *"en människa bekräftade den här enskilda handlingen, och anspråket
 * är konsumerat"*. En delegation betyder *"en människa gav i förväg rätten att
 * göra sådant här utan att bekräfta varje gång"*. De två är olika påståenden,
 * och en delad typ hade gjort dem oskiljbara i varje fråga som ställs efteråt —
 * inklusive den fråga hela spärren finns för: *utfördes det här utan att någon
 * sa ja?*
 *
 * Planens Del 6 säger samma sak åt andra hållet: delegationen ska inte producera
 * `ActionProof` utan vara en separat `assertDelegated`. Två producenter av samma
 * bevis är hur en spärr blir otydlig.
 *
 * `delegationId` är obligatoriskt. Ett bevis utan pekare tillbaka till rätten
 * hade varit ett påstående utan grund — och det är just grunden spåret ska bära.
 */
export interface DelegationProof {
  /** Sant endast efter ett `assertDelegated` som svarade ja. */
  delegated: true
  /** `AiDelegation.id` — rätten körningen åberopar. */
  delegationId: string
}

/**
 * ── VARFÖR MÄNGDEN ÄR FEM OCH INTE ÅTTA, OCH VAD SOM LYFTER DEN ────────────
 *
 * `delegerbaraVerktyg()` ger ÅTTA: verktyg hyresvärden får ge bort rätten till.
 * Den frågan handlar om BEFOGENHET.
 *
 * Att köra något OBEVAKAT är en annan fråga: kan en andraeffekt uppstå om
 * körningen görs om? Tre av de åtta är `DEDUPLICERBAR` — `create_inspection`,
 * `create_invoice`, `create_maintenance_ticket` — och för dem betyder en
 * omkörning en ANDRA rad. `prövaDuglighet` kräver `IDEMPOTENT` plus ett bärande
 * spår, och släpper därför fram fem av de åtta.
 *
 * SKILLNADEN ÄR AVSIKTLIG. Delegationen är giltig för alla åtta; det är
 * UTFÖRANDET utan människa som de tre inte tål. Att låta dem passera hade gjort
 * en obevakad loop till en obegränsad mängd rader — samma risk som
 * frekvensvillkoret finns för, fast utan tak.
 *
 * VAD SOM LYFTER GRÄNSEN: att verktyget får en bärande idempotensnyckel och
 * omklassificeras till `IDEMPOTENT` i `EFFECT_DECLARATIONS`. Då släpper
 * `prövaDuglighet` fram det av sig självt, och den här filen behöver inte röras
 * — mängden är HÄRLEDD, inte skriven. Ett frekvensvillkor räcker INTE: det
 * begränsar hur många dubbletter som kan uppstå, det utesluter dem inte.
 */
export function assertActionToolAuthorized(
  toolName: string,
  proof: ActionProof | DelegationProof | undefined,
): void {
  if (!isActionTool(toolName)) return

  // MÄNNISKANS BEKRÄFTELSE, som förut.
  if (proof && 'claimed' in proof && proof.claimed === true) return

  // DELEGATIONEN. Anroparen har redan fått ja av `assertDelegated` — den här
  // grinden prövar inte rätten på nytt, den prövar att verktyget alls FÅR köras
  // obevakat. De två frågorna ställs på två ställen med flit: den ena är
  // organisationens beslut, den andra en egenskap hos verktyget.
  if (proof && 'delegated' in proof && proof.delegated === true) {
    const d = prövaDuglighet(toolName)
    if (d.duglig) return
    throw new ForbiddenException(
      `Den bindande åtgärden "${toolName}" kan inte utföras på en delegation: ${d.text} ` +
        'En delegation ger rätten, men ett verktyg vars omkörning kan ge en andra effekt ' +
        'får inte köras utan att en människa ser varje gång.',
    )
  }

  throw new ForbiddenException(
    `Den bindande åtgärden "${toolName}" kan inte utföras utan en bekräftelse som ` +
      'konsumerats. Åtgärden måste föreslås av assistenten och bekräftas av en människa.',
  )
}
