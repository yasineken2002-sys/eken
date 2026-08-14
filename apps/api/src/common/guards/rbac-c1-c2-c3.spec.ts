/**
 * RBAC-regressionstest för säkerhetsfixarna C1, C2, C3.
 *
 * Verifierar mot de RIKTIGA controllernas @Roles-metadata via den RIKTIGA
 * RolesGuard (exakt mängdmatchning sedan R2 steg 2) att:
 *   • VIEWER nekas (ForbiddenException → 403) på de tre tidigare öppna ytorna,
 *   • behörig roll släpps igenom (canActivate=true → 200),
 *   • öppna läs-endpoints (ai-usage GET) förblir öppna.
 *
 * Importen av AI-controllern drar in tunga leaf-tjänster (Anthropic-SDK, tool-
 * executor → storage/pdf). Vi mockar dem så att metadata-läsningen blir lätt —
 * dekoratorerna (klass-/metod-metadata) appliceras ändå vid klassdefinition.
 */
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))

import { ForbiddenException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { RolesGuard } from './roles.guard'
import { AccountingController } from '../../accounting/accounting.controller'
import { AiUsageController } from '../../ai-usage/ai-usage.controller'
import { AiAssistantController } from '../../ai/ai-assistant.controller'

type Role = 'OWNER' | 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'VIEWER'

const guard = new RolesGuard(new Reflector())

// Bygger en ExecutionContext som pekar på en EKTA handler + controller-klass,
// precis som Nest gör i runtime — så guarden läser samma metadata som i drift.
function contextFor(handler: () => unknown, cls: object, role: Role): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext
}

function allows(handler: () => unknown, cls: object, role: Role): boolean {
  try {
    return guard.canActivate(contextFor(handler, cls, role)) === true
  } catch (err) {
    if (err instanceof ForbiddenException) return false
    throw err
  }
}

describe('RBAC C1 — bokföring kräver minst ACCOUNTANT', () => {
  const proto = AccountingController.prototype

  it.each(['getAccounts', 'getJournal', 'getJournalEntry'] as const)(
    'nekar VIEWER på %s (403)',
    (method) => {
      expect(allows(proto[method] as () => unknown, AccountingController, 'VIEWER')).toBe(false)
    },
  )

  it.each(['ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER'] as const)(
    'släpper in %s på journalläsning (200)',
    (role) => {
      expect(allows(proto.getJournal as () => unknown, AccountingController, role)).toBe(true)
    },
  )
})

describe('RBAC C2 — köp av AI-credits kräver minst ADMIN', () => {
  const proto = AiUsageController.prototype

  it.each(['VIEWER', 'ACCOUNTANT', 'MANAGER'] as const)('nekar %s på buy-credits (403)', (role) => {
    expect(allows(proto.buyCredits as () => unknown, AiUsageController, role)).toBe(false)
  })

  it.each(['ADMIN', 'OWNER'] as const)('släpper in %s på buy-credits (200)', (role) => {
    expect(allows(proto.buyCredits as () => unknown, AiUsageController, role)).toBe(true)
  })

  // ── C2:S LÄSBESLUT ÄR UPPHÄVT (#441, 2026-08-14) ──────────────────────────
  //
  // Här stod tidigare "lämnar GET current/history öppet för VIEWER
  // (lässtatistik)". Premissen var fel: svaret är inte statistik utan
  // organisationens PRENUMERATIONSFÖRHÅLLANDE — subscriptionPlan,
  // planMonthlyFee, aiCreditsBalance, trialEndsAt, status — och `history` bär
  // dessutom faktisk kostnad (costUsd) per dag.
  //
  // Att det inte upptäcktes vid C2 har en mekanisk förklaring värd att minnas:
  // fyra endpoints bar samma fältblock och INGEN av dem ägde det. Var och en såg
  // rimlig i sin egen kontext. Se noten i ai-usage.controller.ts.
  //
  // Ett test som fastnaglar ett upphävt beslut är farligare än inget test — det
  // gör återställningen till en röd svit och ser ut som en regression. Därför
  // ersätts påståendet i stället för att tas bort.
  it.each(['current', 'history'] as const)('nekar VIEWER på GET %s (403)', (method) => {
    expect(allows(proto[method] as () => unknown, AiUsageController, 'VIEWER')).toBe(false)
  })

  it.each(['current', 'history'] as const)('nekar MANAGER på GET %s (403)', (method) => {
    // MANAGER är utestängd med avsikt och är den enda rollen som FÖRLORAR åtkomst
    // i #441: prenumerationskostnaden är ett kommersiellt förhållande som
    // bokföraren har yrkesmässig del i (den ska konteras), förvaltaren inte.
    expect(allows(proto[method] as () => unknown, AiUsageController, 'MANAGER')).toBe(false)
  })

  it.each(['ACCOUNTANT', 'ADMIN', 'OWNER'] as const)(
    'släpper in %s på GET current (200)',
    (role) => {
      expect(allows(proto.current as () => unknown, AiUsageController, role)).toBe(true)
    },
  )
})

describe('RBAC C3 — AI-assistenten kräver minst ACCOUNTANT', () => {
  const proto = AiAssistantController.prototype

  // Täcker SAMTLIGA endpoints i controllern (inte ett urval) så att en framtida
  // handler-nivå-@Roles som av misstag öppnar en metod för VIEWER fångas — särskilt
  // confirmAction, som faktiskt exekverar AI-åtgärder (bokföring/avtalsändringar).
  it.each([
    'streamChat',
    'chat',
    'confirmAction',
    'getConversations',
    'getConversation',
    'deleteConversation',
    'clearMemory',
    'getAnalysis',
    'getUsage',
    'getUsageBreakdown',
  ] as const)('nekar VIEWER på %s (403)', (method) => {
    expect(allows(proto[method] as () => unknown, AiAssistantController, 'VIEWER')).toBe(false)
  })

  it.each(['ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER'] as const)(
    'släpper in %s på AI-chat (200)',
    (role) => {
      expect(allows(proto.chat as () => unknown, AiAssistantController, role)).toBe(true)
    },
  )

  // De två usage-endpointsen är SNÄVARE än klasslistan sedan #441 — MANAGER tas
  // bort. De ärvde klassens lista av bekvämlighet, inte av ett beslut om datat:
  // svaret är prenumerationsförhållandet, inte assistentfunktionalitet.
  // `getUsageBreakdown` bär dessutom kostnad PER userId, alltså en
  // aktivitetsprofil över namngivna kollegor.
  it.each(['getUsage', 'getUsageBreakdown'] as const)('nekar MANAGER på %s (403)', (method) => {
    expect(allows(proto[method] as () => unknown, AiAssistantController, 'MANAGER')).toBe(false)
  })

  it.each(['getUsage', 'getUsageBreakdown'] as const)(
    'släpper in ACCOUNTANT på %s (200)',
    (method) => {
      expect(allows(proto[method] as () => unknown, AiAssistantController, 'ACCOUNTANT')).toBe(true)
    },
  )
})
