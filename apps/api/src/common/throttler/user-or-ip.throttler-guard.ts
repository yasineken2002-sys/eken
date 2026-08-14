import { Injectable, Logger } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'
import { authThrottleRelaxed, E2E_AUTH_THROTTLE_FLAG } from './auth-throttle-mode'

/**
 * Custom Throttler-tracker som använder JWT-användarens id om requesten är
 * autentiserad, annars klient-IP. Default-trackern bygger bara på IP — det
 * räcker inte i miljöer där flera användare delar utgångs-IP (kontor, NAT)
 * och vill kunna hamra på dyra endpoints (t.ex. PDF-generering) utan att
 * blockera varandra.
 *
 * För publika endpoints (login, glömt lösenord) använder vi fortfarande IP
 * eftersom där finns ingen användarkontext att rate-limita på.
 */
@Injectable()
export class UserOrIpThrottlerGuard extends ThrottlerGuard {
  /**
   * Löses EN gång, vid konstruktion — inte per request.
   *
   * Två skäl. Dels är läget statiskt: det kan inte ändras utan omstart. Dels
   * fail-fastar `authThrottleRelaxed` om uppmjukningen begärs i produktion, och
   * ett kast i konstruktorn dödar boot (rätt) medan ett kast per request hade
   * gett 500 på varje anrop av en app som redan startat (fel). Speglar
   * `validateEnv`, som gör samma kontroll ännu tidigare — bältet och hängslena
   * är avsiktliga: guarden ska inte kunna instansieras i ett läge validateEnv
   * släppt igenom av misstag.
   */
  private readonly relaxed = ((): boolean => {
    const relaxed = authThrottleRelaxed()
    if (relaxed) {
      // Syns i CI-loggen. En uppmjukad strypning ska aldrig vara tyst — den som
      // läser en grön E2E-körning ska se att skyddet var avstängt under den.
      new Logger(UserOrIpThrottlerGuard.name).warn(
        `${E2E_AUTH_THROTTLE_FLAG}=true — auth-strypningen är UPPMJUKAD. ` +
          'Endast för E2E; omöjlig i produktion (fail-fast vid boot).',
      )
    }
    return relaxed
  })()

  /**
   * Hoppar över strypningen helt när E2E-läget är på. Att sänka i stället för
   * att hoppa över hade gett ett tak som fortfarande kan slås i av en längre
   * svit — alltså samma flakighet, bara senare. Risken är avgränsad av att läget
   * inte går att sätta i produktion, inte av att taket är högt.
   */
  protected override shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (this.relaxed) return Promise.resolve(true)
    return super.shouldSkip(context)
  }

  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const user = (req as { user?: { sub?: string } }).user
    if (user?.sub) return Promise.resolve(`user:${user.sub}`)
    const ip = (req as { ip?: string }).ip ?? 'unknown'
    return Promise.resolve(`ip:${ip}`)
  }
}
