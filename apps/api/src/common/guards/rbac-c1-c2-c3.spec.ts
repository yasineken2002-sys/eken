/**
 * RBAC-regressionstest för säkerhetsfixarna C1, C2, C3.
 *
 * Verifierar mot de RIKTIGA controllernas @Roles-metadata via den RIKTIGA
 * RolesGuard (hierarkisk) att:
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

  it('lämnar GET current öppet för VIEWER (lässtatistik)', () => {
    expect(allows(proto.current as () => unknown, AiUsageController, 'VIEWER')).toBe(true)
  })
})

describe('RBAC C3 — AI-assistenten kräver minst ACCOUNTANT', () => {
  const proto = AiAssistantController.prototype

  it.each(['chat', 'streamChat', 'getAnalysis', 'getConversations'] as const)(
    'nekar VIEWER på %s (403)',
    (method) => {
      expect(allows(proto[method] as () => unknown, AiAssistantController, 'VIEWER')).toBe(false)
    },
  )

  it.each(['ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER'] as const)(
    'släpper in %s på AI-chat (200)',
    (role) => {
      expect(allows(proto.chat as () => unknown, AiAssistantController, role)).toBe(true)
    },
  )
})
