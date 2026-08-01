/**
 * `RolesGuard` — grindens egna beteende.
 *
 * ── Filen hette tidigare roles-guard-equivalence.spec.ts ─────────────────────
 *
 * Den bar då R2 steg 2:s BEVIS: att bytet från hierarkisk till exakt matchning
 * var en no-op. Testet körde varje rollista i kodbasen (159 stycken) × varje
 * roll genom både den gamla hierarkiska implementationen och den nya, och krävde
 * identiskt svar i alla 795 kombinationer. Det passerade, och bytet mergades
 * (#265).
 *
 * ── Varför ekvivalenstestet är BORTTAGET, inte fixat ─────────────────────────
 *
 * Steg 3 tar bort MANAGER ur `close` och `reverse` — det är stegets hela syfte.
 * Ekvivalenstestet failade därför korrekt, och pekade ut exakt de två raderna:
 *
 *   POST /accounting/periods/:year/:month/close  roll=MANAGER  hierarkisk=SLÄPPS IN  exakt=nekas
 *   POST /accounting/journal/:id/reverse         roll=MANAGER  hierarkisk=SLÄPPS IN  exakt=nekas
 *
 * Två av 795 jämförelser, båda avsedda, inga andra. Det var testets sista
 * nyttiga arbete: det bekräftade att steg 3 ändrade precis vad det påstod.
 *
 * Att i stället lägga in de två raderna som tillåtna undantag hade sett
 * försiktigare ut men varit sämre. Oraklet är en rollhierarki vi medvetet har
 * övergett. Att låta den leva vidare som facit tvingar varje framtida endpoint
 * med en snäv lista — `@Roles('ACCOUNTANT')` avviker per definition från
 * "ACCOUNTANT och uppåt" — att motivera sig mot en modell som inte längre finns.
 * Ett test ska mäta mot något vi fortfarande tror på.
 *
 * Beviset går inte förlorat: det ligger i #265:s historik, och steg 3:s egen
 * åtstramning bevakas nu av `accounting/accounting-role-gates.spec.ts`, som
 * dessutom kräver att dekoratorn och tjänstegrinden listar samma roller.
 *
 * VAD SOM SAKNAS: ingen enskild spec bevakar längre alla 159 listorna samlat.
 * Rätt ersättning är en golden-fil över varje endpoints rollbeslut, så att en
 * ändrad lista syns som en diff en granskare måste godkänna — men den är sitt
 * eget arbete, inte en efterhandsflik på steg 3.
 *
 * Kvar nedan är det som alltid handlade om guardens NUVARANDE semantik.
 */

import { ForbiddenException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { RolesGuard } from './roles.guard'

const ALL_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'] as const

/** Den riktiga guarden, med en Reflector-attrapp som matar in listan. */
function runGuard(required: string[], request: unknown): boolean {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector
  const guard = new RolesGuard(reflector)
  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext
  try {
    return guard.canActivate(context) === true
  } catch (err) {
    if (err instanceof ForbiddenException) return false
    throw err
  }
}

function allows(required: string[], role: string): boolean {
  return runGuard(required, { user: { role } })
}

describe('RolesGuard · exakt mängdmatchning', () => {
  it('släpper in exakt de listade rollerna — och ingen annan', () => {
    // Kärnan i R2: listan betyder vad den säger. Under den gamla hierarkin hade
    // MANAGER släppts in här utan att stå med, eftersom den låg över ACCOUNTANT.
    // Det var precis så inkasso-luckan (R1) uppstod.
    const listed = ['ACCOUNTANT', 'ADMIN', 'OWNER']
    for (const role of ALL_ROLES) {
      expect(allows(listed, role)).toBe(listed.includes(role))
    }
  })

  it('lista utan roller släpper igenom alla (kortslutning)', () => {
    // `if (!requiredRoles?.length) return true` — endpoints utan @Roles är
    // autentiserade men inte rollgrindade.
    for (const role of ALL_ROLES) {
      expect(allows([], role)).toBe(true)
    }
  })

  it('okänd, tom eller saknad roll nekas (fail-closed)', () => {
    expect(allows(['VIEWER'], 'REVISOR_SOM_INTE_FINNS')).toBe(false)
    expect(allows(['OWNER', 'ADMIN'], '')).toBe(false)
    // `undefined` är formen man får av en JWT-payload utan `role` — den vägen
    // ska neka, inte krascha. `includes(undefined)` är falskt, inte ett kast.
    expect(allows(['OWNER', 'ADMIN'], undefined as unknown as string)).toBe(false)
    expect(allows([], undefined as unknown as string)).toBe(true) // ingen @Roles → orört
  })

  it('helt saknad användare nekas med 403 — inte TypeError som blir 500', () => {
    // Kräver @Public() + @Roles() på samma route, vilket inte finns i dag. Utan
    // grindens egen kontroll kastar `user.role` TypeError; GlobalExceptionFilter
    // fångar och svarar 500, så ingen åtkomst beviljas — men fail-closed ska vara
    // grindens egenskap, inte en biprodukt av felhanteringen.
    expect(runGuard(['OWNER'], {})).toBe(false)
    expect(runGuard(['OWNER'], { user: undefined })).toBe(false)
  })
})
