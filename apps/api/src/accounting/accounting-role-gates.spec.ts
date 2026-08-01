/**
 * R2 steg 3 — MANAGER nekas av GRINDEN, inte först av tjänsten.
 *
 * ── Vad som ändrades, och varför det inte är kosmetik ─────────────────────────
 *
 * Att stänga en bokföringsperiod och att rätta ett verifikat är bindande
 * redovisningshandlingar. Avsikten har hela tiden varit att utesluta MANAGER —
 * en förvaltare får se bokföringen men inte agera i den.
 *
 * Fram till R2 steg 2 kunde `@Roles` inte uttrycka det. Guarden var hierarkisk:
 * `@Roles('ACCOUNTANT','ADMIN','OWNER')` betydde "ACCOUNTANT och uppåt", och
 * MANAGER låg över ACCOUNTANT. Listan sa en sak och gjorde en annan. Spärren
 * bars därför ensam av `CLOSE_ROLES`/`REVERSAL_ROLES` i tjänstelagret, och
 * dekoratorn fick i steg 1 skriva ut MANAGER för att inte ljuga om nuläget.
 *
 * Steg 2 gjorde matchningen exakt. Steg 3 tar bort MANAGER ur de två listorna:
 * en förvaltare stoppas nu i grinden i stället för ett lager senare.
 *
 * ── Varför testet ser ut som det gör ─────────────────────────────────────────
 *
 * Ingenting här är attrapp. `Reflector` är NestJS egen, metadatan läses från de
 * riktiga metoderna på `AccountingController`, och subjektet är den riktiga
 * `RolesGuard`. Ett test som matade in en handskriven lista hade bevisat att
 * testfilen är konsekvent med sig själv — inte att endpointen är grindad.
 *
 * ── Det andra lagret står kvar ───────────────────────────────────────────────
 *
 * Tjänstegrinden togs INTE bort när dekoratorn blev ärlig. AI-vägen och
 * framtida interna anropare når tjänsten utan att passera någon dekorator, och
 * chokepunkten är den enda plats varje anropare måste förbi (#194-mönstret).
 *
 * Två lager skyddar dock bara så länge de är ÖVERENS. Glider listorna isär —
 * någon vidgar dekoratorn men inte tjänsten — ser det fortfarande ut som två
 * skydd medan det inre blivit det enda verksamma, och det yttre ljuger igen.
 * Därför kräver testet identiska mängder, inte bara att båda nekar MANAGER.
 */

import { Reflector } from '@nestjs/core'
import { ForbiddenException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { UserRole } from '@prisma/client'
import { RolesGuard, ROLES_KEY } from '../common/guards/roles.guard'
import { AccountingController } from './accounting.controller'
import { CLOSE_ROLES } from './accounting-period.service'
import { REVERSAL_ROLES } from './accounting.service'

const ALL_ROLES = [
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.ACCOUNTANT,
  UserRole.VIEWER,
] as const

type Handler = (...args: never[]) => unknown

/** Kör den riktiga guarden mot den riktiga metodens metadata. */
function guardAllows(handler: Handler, role: UserRole | undefined): boolean {
  const guard = new RolesGuard(new Reflector())
  const context = {
    getHandler: () => handler,
    getClass: () => AccountingController,
    switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
  } as unknown as ExecutionContext
  try {
    return guard.canActivate(context) === true
  } catch (err) {
    if (err instanceof ForbiddenException) return false
    throw err
  }
}

/** Listan som FAKTISKT sitter på metoden, via NestJS egen metadata-läsning. */
function declaredRoles(handler: Handler): string[] {
  return (
    new Reflector().getAllAndOverride<string[]>(ROLES_KEY, [handler, AccountingController]) ?? []
  )
}

const proto = AccountingController.prototype
const CLOSE = proto.closePeriod as unknown as Handler
const REVERSE = proto.reverseJournalEntry as unknown as Handler
const READ_JOURNAL = proto.getJournal as unknown as Handler

describe('R2 steg 3 · bindande bokföringshandlingar grindas av RolesGuard', () => {
  it('riggen läser faktisk metadata (annars bevisar testet ingenting)', () => {
    // Ett stavfel i metodnamnet, en flyttad dekorator eller en Reflector som
    // inte hittar metadatan skulle annars ge "inga roller" → guarden
    // kortsluter till true → allt nedan passerar av fel anledning.
    expect(declaredRoles(CLOSE).length).toBeGreaterThan(0)
    expect(declaredRoles(REVERSE).length).toBeGreaterThan(0)
  })

  describe.each([
    ['POST /accounting/periods/:year/:month/close', CLOSE, CLOSE_ROLES],
    ['POST /accounting/journal/:id/reverse', REVERSE, REVERSAL_ROLES],
  ])('%s', (_endpoint, handler, serviceGate) => {
    it('MANAGER nekas — av grinden, inte först av tjänsten', () => {
      expect(guardAllows(handler, UserRole.MANAGER)).toBe(false)
    })

    it('VIEWER nekas (oförändrat, klassgrinden stängde redan ute den)', () => {
      expect(guardAllows(handler, UserRole.VIEWER)).toBe(false)
    })

    it('ACCOUNTANT, ADMIN och OWNER släpps in — ingen regression', () => {
      expect(guardAllows(handler, UserRole.ACCOUNTANT)).toBe(true)
      expect(guardAllows(handler, UserRole.ADMIN)).toBe(true)
      expect(guardAllows(handler, UserRole.OWNER)).toBe(true)
    })

    it('okänd eller saknad roll nekas (fail-closed)', () => {
      expect(guardAllows(handler, undefined)).toBe(false)
      expect(guardAllows(handler, 'REVISOR_SOM_INTE_FINNS' as UserRole)).toBe(false)
    })

    it('dekoratorn och tjänstegrinden listar EXAKT samma roller', () => {
      // Inte "båda nekar MANAGER" — identiska mängder. Vidgar någon det ena
      // lagret utan det andra ser det fortfarande ut som två skydd, medan det
      // yttre tyst slutat betyda något. Det är den drift R2 finns till att
      // stänga, och den är osynlig i en diff som bara rör en fil.
      expect([...declaredRoles(handler)].sort()).toEqual([...serviceGate].sort())
    })
  })

  it('MANAGER får fortfarande LÄSA bokföringen (klassgrinden är orörd)', () => {
    // Gränsen som drogs är agera/läsa, inte roll/domän. En förvaltare som inte
    // längre såg verifikationsjournalen vore en regression, inte en åtstramning.
    expect(guardAllows(READ_JOURNAL, UserRole.MANAGER)).toBe(true)
    expect(guardAllows(READ_JOURNAL, UserRole.VIEWER)).toBe(false)
  })

  it('tjänstegrindarna finns kvar och utesluter MANAGER', () => {
    // Att dekoratorn blivit ärlig är inget skäl att ta bort chokepunkten:
    // AI-vägen och interna anropare passerar aldrig en dekorator.
    for (const gate of [CLOSE_ROLES, REVERSAL_ROLES]) {
      expect(gate).not.toContain(UserRole.MANAGER)
      expect(gate).not.toContain(UserRole.VIEWER)
      expect(gate).toEqual(
        expect.arrayContaining([UserRole.ACCOUNTANT, UserRole.ADMIN, UserRole.OWNER]),
      )
    }
  })

  it('ingen annan roll än de fyra kända finns i mängderna', () => {
    // Fångar en framtida roll (t.ex. REVISOR) som läggs till i en lista men
    // glöms i den andra — då failar likhetstestet ovan, och det här säger
    // varför.
    for (const gate of [CLOSE_ROLES, REVERSAL_ROLES]) {
      for (const role of gate) expect(ALL_ROLES).toContain(role)
    }
  })
})
