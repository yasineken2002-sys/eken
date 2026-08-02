/**
 * Contracts-controllerns rollgrindar.
 *
 * `GET /contracts/download/:leaseId` låg ogrindad mellan två grindade metoder
 * i samma controller (`POST generate/:leaseId` och `PATCH
 * :leaseId/appendices/:documentId`, båda MANAGER/ADMIN/OWNER). Följden var att
 * varje autentiserad roll — inklusive VIEWER, som per UI-text är en
 * "visa-användare som inte kan göra ändringar" — kunde:
 *
 *   1. hämta hyresavtalet som PDF, med hyresgästens personnummer inbakat, och
 *   2. UTLÖSA genereringen av det, eftersom metoden bygger kontraktet när det
 *      saknas — alltså nå den skrivning `generate` grindar.
 *
 * Tillsammans med den ogrindade `GET /leases` fanns en komplett kedja: lista
 * alla leaseId, ladda ner varje avtal.
 *
 * Ingenting här är attrapp. `Reflector` är NestJS egen, metadatan läses från de
 * riktiga metoderna, och subjektet är den riktiga `RolesGuard`. Ett test som
 * matade in en handskriven lista hade bevisat att testfilen är konsekvent med
 * sig själv — inte att endpointen är grindad.
 *
 * ── `status` (2026-08-02) ────────────────────────────────────────────────────
 *
 * Samma fil, samma klass av fynd. `GET status/:leaseId` returnerar
 * `signedFromIp`, `signedUserAgent`, `signatureName` och den signerande
 * hyresgästens namn — exakt de fält som MEDVETET ströks ur hyresgästportalen i
 * PR 5a, med motiveringen att de är "data OM hyresgästen". Systemet hade alltså
 * redan bedömt dem som känsliga, medan operatörssidan delade ut dem till varje
 * autentiserad roll. Inte en glömska: en inkonsekvens mellan två delar som
 * bedömt samma data olika.
 *
 * `appendices` förblir ogrindad med flit — den filtrerar bort CONTRACT och
 * returnerar bara bilagornas metadata, vilket är R1:s medvetna policy (läsning
 * av besiktningsunderlag är förvaltning). Testet låser att den POLICYN inte
 * regredierar när grannarna stramas åt.
 */

// Controllern drar in StorageService (S3) transitivt. Attrapperna gäller inte
// grinden — de gör bara filen laddbar. Samma mönster som authz-surface.spec.ts.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { Reflector } from '@nestjs/core'
import { ForbiddenException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { UserRole } from '@prisma/client'
import { RolesGuard, ROLES_KEY } from '../common/guards/roles.guard'
import { ContractsController } from './contracts.controller'

const ALL_ROLES = [
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.ACCOUNTANT,
  UserRole.VIEWER,
] as const

type Handler = (...args: never[]) => unknown

function guardAllows(handler: Handler, role: UserRole | undefined): boolean {
  const guard = new RolesGuard(new Reflector())
  const context = {
    getHandler: () => handler,
    getClass: () => ContractsController,
    switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
  } as unknown as ExecutionContext
  try {
    return guard.canActivate(context) === true
  } catch (err) {
    if (err instanceof ForbiddenException) return false
    throw err
  }
}

function declaredRoles(handler: Handler): string[] {
  return (
    new Reflector().getAllAndOverride<string[]>(ROLES_KEY, [handler, ContractsController]) ?? []
  )
}

const proto = ContractsController.prototype
const DOWNLOAD = proto.download as unknown as Handler
const GENERATE = proto.generate as unknown as Handler
const UPDATE_APPENDIX = proto.updateAppendix as unknown as Handler
const STATUS = proto.status as unknown as Handler
const APPENDICES = proto.listAppendices as unknown as Handler

describe('kontraktsnedladdning · rollgrind', () => {
  it('riggen läser faktisk metadata (annars bevisar testet ingenting)', () => {
    // Ett stavfel i metodnamnet eller en Reflector som inte hittar metadatan
    // ger "inga roller" → guarden kortsluter till true → allt nedan passerar
    // av fel anledning.
    expect(declaredRoles(DOWNLOAD).length).toBeGreaterThan(0)
  })

  it('VIEWER nekas nedladdning', () => {
    // Kärnan. Före den här ändringen returnerade guarden true, eftersom ingen
    // @Roles-metadata fanns och RolesGuard då släpper igenom (roles.guard.ts).
    expect(guardAllows(DOWNLOAD, UserRole.VIEWER)).toBe(false)
  })

  it('ACCOUNTANT nekas också — listan är förvaltning, inte ekonomi', () => {
    expect(guardAllows(DOWNLOAD, UserRole.ACCOUNTANT)).toBe(false)
  })

  it('MANAGER, ADMIN och OWNER kan fortfarande ladda ner', () => {
    const nekade = [UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER].filter(
      (r) => !guardAllows(DOWNLOAD, r),
    )
    expect(nekade).toEqual([])
  })

  it('utan autentiserad användare nekas anropet', () => {
    expect(guardAllows(DOWNLOAD, undefined)).toBe(false)
  })

  it('download har SAMMA rollmängd som generate och updateAppendix', () => {
    // Metoden kan utlösa `generateLeaseContract` när kontraktet saknas. Vore
    // dess lista bredare än `generate`:s hade den grinden gått att kringgå via
    // en nedladdning — därför krävs identiska mängder, inte bara att båda
    // nekar VIEWER.
    const sortera = (r: string[]) => [...r].sort()
    expect(sortera(declaredRoles(DOWNLOAD))).toEqual(sortera(declaredRoles(GENERATE)))
    expect(sortera(declaredRoles(DOWNLOAD))).toEqual(sortera(declaredRoles(UPDATE_APPENDIX)))
  })

  it('grannmetoderna är orörda', () => {
    // Fixen ska bara ha lagt till en grind, inte ändrat de befintliga.
    for (const handler of [GENERATE, UPDATE_APPENDIX]) {
      expect(guardAllows(handler, UserRole.VIEWER)).toBe(false)
      expect(guardAllows(handler, UserRole.ACCOUNTANT)).toBe(false)
      for (const r of [UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER]) {
        expect(guardAllows(handler, r)).toBe(true)
      }
    }
  })

  it('varje roll får samma svar från grinden på download som på generate', () => {
    // Uttömmande över alla fem roller — fångar en framtida ändring som vidgar
    // den ena men inte den andra.
    const utfall = ALL_ROLES.map((r) => ({
      role: r,
      download: guardAllows(DOWNLOAD, r),
      generate: guardAllows(GENERATE, r),
    }))
    expect(utfall.filter((u) => u.download !== u.generate)).toEqual([])
  })

  describe('signeringsstatus', () => {
    it('riggen läser faktisk metadata för status', () => {
      expect(declaredRoles(STATUS).length).toBeGreaterThan(0)
    })

    it('VIEWER och ACCOUNTANT nekas signeringsspåret', () => {
      // signedFromIp, signedUserAgent, signatureName + hyresgästens namn.
      expect(guardAllows(STATUS, UserRole.VIEWER)).toBe(false)
      expect(guardAllows(STATUS, UserRole.ACCOUNTANT)).toBe(false)
    })

    it('MANAGER, ADMIN och OWNER läser status som förut', () => {
      const nekade = [UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER].filter(
        (r) => !guardAllows(STATUS, r),
      )
      expect(nekade).toEqual([])
    })

    it('status har samma rollmängd som resten av kontraktsytan', () => {
      const sortera = (r: string[]) => [...r].sort()
      expect(sortera(declaredRoles(STATUS))).toEqual(sortera(declaredRoles(DOWNLOAD)))
      expect(sortera(declaredRoles(STATUS))).toEqual(sortera(declaredRoles(GENERATE)))
    })
  })

  describe('appendices förblir öppen — R1:s policy', () => {
    it('varje roll passerar grinden', () => {
      // Ingen regression: bilagor är besiktningsunderlag och liknande, inte
      // kontraktet självt. Metoden filtrerar bort CONTRACT i sin egen query.
      const nekade = ALL_ROLES.filter((r) => !guardAllows(APPENDICES, r))
      expect(nekade).toEqual([])
    })

    it('och är alltså medvetet OGRINDAD, inte glömd', () => {
      expect(declaredRoles(APPENDICES)).toEqual([])
    })
  })
})
