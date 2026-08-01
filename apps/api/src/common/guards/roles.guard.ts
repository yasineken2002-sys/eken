import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { Injectable, ForbiddenException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { UserRole } from '@eken/shared'
import type { FastifyRequest } from 'fastify'
import type { JwtPayload } from '@eken/shared'

export const ROLES_KEY = 'roles'

/**
 * Rollgrinden: en `@Roles`-lista släpper in EXAKT de roller den räknar upp.
 *
 * ── Varför inte hierarkiskt (R2) ──────────────────────────────────────────────
 *
 * Guarden var tidigare hierarkisk: varje roll hade en nivå och kontrollen var
 * `requiredRoles.some(r => userLevel >= NIVÅ[r])`. Följden var att bara den
 * LÄGSTA rollen i en lista hade effekt — resten var dekoration.
 * `@Roles('ACCOUNTANT','ADMIN','OWNER')` läste som "dessa tre" men BETYDDE
 * "ACCOUNTANT och uppåt", så MANAGER (som låg över ACCOUNTANT) släpptes in utan
 * att nämnas.
 *
 * Det var inte en läsbarhetsfråga. Nio inkasso-endpoints bar precis den listan,
 * och en förvaltare kunde därför lämna över en hyresgästs skuld till inkasso —
 * en bindande handling mot en enskild person (R1).
 *
 * Hierarkin gjorde också en roll som REVISOR omöjlig att placera: den kräver en
 * total ordning, medan en revisor är en mängd (ser allt, får en specifik sak
 * ägaren inte får, saknar förvaltningsbefogenheter).
 *
 * ── Vad exakt matchning innebär ───────────────────────────────────────────────
 *
 * Listan betyder vad den säger. Vill du att ägaren ska in måste OWNER stå där —
 * även på en endpoint som "egentligen" är för administratörer. Det är avsiktligt
 * dyrare att skriva och omöjligt att missförstå.
 *
 * Felmöjligheten som återstår är att GLÖMMA en roll. Den failar HÖGLJUTT: den
 * glömda rollen får 403 direkt och någon hör av sig. Den gamla felmöjligheten —
 * att tyst släppa in en roll man inte tänkt på — upptäcktes bara om någon råkade
 * granska rätt rad.
 *
 * Bytet var en bevisad no-op: steg 1 gjorde varje lista fullständig först, och
 * ett ekvivalenstest körde samtliga listor × samtliga roller genom både den
 * gamla och den nya implementationen och krävde identiskt svar (795 av 795
 * lika, #265). Testet är sedan steg 3 borttaget — se roles-guard.spec.ts för
 * varför en övergiven modell inte får leva kvar som facit.
 *
 * Steg 3 (#266) drog sedan åt de två accounting-listorna som hierarkin hade
 * hållit vidare öppna än avsett: att stänga en period och att rätta ett
 * verifikat listar inte längre MANAGER.
 *
 * ── Detta är inte hela skyddet ────────────────────────────────────────────────
 *
 * En lista kan numera uttrycka vilken mängd som helst — men den gäller bara den
 * som kommer via HTTP. Där en väg går förbi dekoratorn helt (AI-verktyg som
 * anropar tjänsten direkt, köade jobb, framtida interna anropare) ligger den
 * bärande spärren i tjänstelagret med exakt mängdmatchning: CLOSE_ROLES,
 * REVERSAL_ROLES (accounting) och COLLECTION_ACTION_ROLES (inkasso). Dekoratorn
 * är första lagret, inte enda.
 *
 * De två lagren måste säga SAMMA sak. Glider de isär ser det fortfarande ut som
 * två skydd medan det yttre tyst slutat betyda något — samma sorts tystnad som
 * hierarkin en gång orsakade. accounting-role-gates.spec.ts kräver därför
 * identiska mängder, inte bara att båda nekar rätt roll.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    // Ingen @Roles → autentiserad men inte rollgrindad. Oförändrat.
    if (!requiredRoles?.length) return true

    const request = context.switchToHttp().getRequest<FastifyRequest & { user?: JwtPayload }>()
    const user = request.user

    // Ingen autentiserad användare men ändå ett rollkrav → neka rent.
    //
    // Kombinationen kräver `@Public()` OCH `@Roles()` på samma route, vilket inte
    // finns i kodbasen i dag. Utan raden hade `user.role` kastat TypeError i
    // stället: `GlobalExceptionFilter` fångar det och svarar 500, så ingen
    // åtkomst beviljas — men 500 är fel besked, larmar i onödan, och lutar sig
    // mot ett skyddsnät i stället för att neka på egen hand. Fail-closed ska
    // vara en egenskap hos grinden, inte en biprodukt av felhanteringen.
    if (!user) throw new ForbiddenException('Otillräckliga rättigheter')

    // Fail-closed: en roll som inte står i listan kommer inte in — inklusive en
    // okänd eller saknad roll, som aldrig matchar något.
    const hasRole = requiredRoles.includes(user.role)

    if (!hasRole) throw new ForbiddenException('Otillräckliga rättigheter')
    return true
  }
}
