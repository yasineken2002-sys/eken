/**
 * IMPORTSTOPP-009 (FORTNOX-100): rollgrindarna på importstoppens rutter. Den riktiga
 * `RolesGuard` mot metadatan på de riktiga metoderna (samma mönster som
 * accounting-role-gates.spec.ts) — ingen handskriven lista.
 *
 * Läsa (varför kraven pausas): ACCOUNTANT, MANAGER, ADMIN, OWNER — som identitetsgranskningen.
 * Lösa (uttrycklig kundhandling): MANAGER, ADMIN, OWNER — som manuell matchning. VIEWER
 * nekas båda; ACCOUNTANT får se men inte avgöra.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { Reflector } from '@nestjs/core'
import { ForbiddenException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { UserRole } from '@prisma/client'
import { RolesGuard, ROLES_KEY } from '../common/guards/roles.guard'
import { ReconciliationController } from './reconciliation.controller'

type Handler = (...args: never[]) => unknown

function guardAllows(handler: Handler, role: UserRole): boolean {
  const context = {
    getHandler: () => handler,
    getClass: () => ReconciliationController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext
  try {
    return new RolesGuard(new Reflector()).canActivate(context) === true
  } catch (err) {
    if (err instanceof ForbiddenException) return false
    throw err
  }
}

const proto = ReconciliationController.prototype
const LISTA = proto.importStops as unknown as Handler
const LÖS = proto.resolveImportStop as unknown as Handler
const MATCHA = proto.manualMatch as unknown as Handler
const roller = (h: Handler) =>
  new Reflector().getAllAndOverride<string[]>(ROLES_KEY, [h, ReconciliationController]) ?? []

describe('IMPORTSTOPP-009 · rollgrindar', () => {
  it('riggen läser faktisk metadata', () => {
    expect(roller(LISTA).length).toBeGreaterThan(0)
    expect(roller(LÖS).length).toBeGreaterThan(0)
  })

  it('upplösning: samma roller som manuell matchning; VIEWER och ACCOUNTANT nekas', () => {
    expect(new Set(roller(LÖS))).toEqual(new Set(roller(MATCHA)))
    expect(guardAllows(LÖS, UserRole.VIEWER)).toBe(false)
    expect(guardAllows(LÖS, UserRole.ACCOUNTANT)).toBe(false)
    for (const r of [UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER]) {
      expect(guardAllows(LÖS, r)).toBe(true)
    }
  })

  it('läsning: VIEWER nekas, ACCOUNTANT och uppåt släpps in', () => {
    expect(guardAllows(LISTA, UserRole.VIEWER)).toBe(false)
    for (const r of [UserRole.ACCOUNTANT, UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER]) {
      expect(guardAllows(LISTA, r)).toBe(true)
    }
  })
})
