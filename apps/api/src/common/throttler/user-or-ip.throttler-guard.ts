import { Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

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
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const user = (req as { user?: { sub?: string } }).user
    if (user?.sub) return Promise.resolve(`user:${user.sub}`)
    const ip = (req as { ip?: string }).ip ?? 'unknown'
    return Promise.resolve(`ip:${ip}`)
  }
}
