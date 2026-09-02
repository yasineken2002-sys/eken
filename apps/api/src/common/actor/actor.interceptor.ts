/**
 * MÄNNISKOGRÄNSEN — en autentiserad request är en människas handling.
 *
 * ── VARFÖR EN INTERCEPTOR OCH INTE EN GUARD ─────────────────────────────────
 *
 * En guard returnerar en boolean och OMSLUTER ingenting; den kan inte öppna en
 * AsyncLocalStorage som lever under hanteraren. En interceptor kan, eftersom
 * den får `next.handle()`.
 *
 * ── OCH VARFÖR `new Observable`, INTE `runWithActor(kind, () => next.handle())` ─
 *
 * `next.handle()` returnerar en LAT Observable: hanteraren körs först när Nest
 * PRENUMERERAR, vilket sker efter att interceptorn returnerat. Den enkla
 * formen hade alltså stängt kontexten innan hanteraren ens startade — den
 * klassiska ALS-fällan med lata promises, och den hade sett ut att fungera i
 * varje synkron enhetsprov.
 *
 * Formen nedan flyttar in SUBSKRIPTIONEN i kontexten, och det är subskriptionen
 * som kör hanteraren. Asynkrona fortsättningar ärver därifrån.
 *
 * ── DEN PÅSTÅR INGENTING OM EN OAUTENTISERAD REQUEST ────────────────────────
 *
 * Utan `request.user` sätts INGEN kontext, och skrivningen får NULL = okänt.
 * Ett `HUMAN` som default hade varit exakt det obelagda påstående hela G1
 * finns för att ta bort. Publika vägar som ändå skriver — webhooks — sätter
 * `SYSTEM` själva, vid sin egen gräns.
 *
 * AI-vägen ligger INNANFÖR den här: `runAsAi` öppnar `AGENT` inuti requestens
 * `HUMAN`, och den innersta kontexten vinner. En AI-skriven rad bär därför
 * AGENT även när requesten kom från en inloggad människa — vilket är hela
 * poängen.
 */
import { Injectable } from '@nestjs/common'
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import { Observable } from 'rxjs'

import { runWithActor } from './actor.context'

@Injectable()
export class ActorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ user?: unknown; tenant?: unknown }>()
    const inloggad = Boolean(request?.user) || Boolean(request?.tenant)
    if (!inloggad) return next.handle()

    return new Observable((subscriber) =>
      runWithActor('HUMAN', () => next.handle().subscribe(subscriber)),
    )
  }
}
