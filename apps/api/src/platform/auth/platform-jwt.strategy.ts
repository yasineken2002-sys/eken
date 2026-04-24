import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { ConfigService } from '@nestjs/config'
import type { PlatformJwtPayload } from '../platform-token.types'

@Injectable()
export class PlatformJwtStrategy extends PassportStrategy(Strategy, 'platform-jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('PLATFORM_JWT_SECRET'),
    })
  }

  validate(payload: PlatformJwtPayload): PlatformJwtPayload {
    if (!payload.sub || payload.type !== 'platform') {
      throw new UnauthorizedException()
    }
    return payload
  }
}
