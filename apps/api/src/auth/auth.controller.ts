import { Controller, Post, Get, Body, HttpCode, HttpStatus } from '@nestjs/common'
import { ApiTags, ApiOperation } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { AuthService } from './auth.service'
import { Public } from '../common/decorators/public.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { LoginDto } from './dto/login.dto'
import { RegisterDto } from './dto/register.dto'
import { RefreshDto } from './dto/refresh.dto'
import { ChangePasswordDto } from './dto/change-password.dto'
import { ForgotPasswordDto } from './dto/forgot-password.dto'
import { ResetPasswordDto } from './dto/reset-password.dto'
import { AcceptInviteDto } from './dto/accept-invite.dto'

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('register')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Registrera ny organisation och ägare' })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto)
  }

  @Post('login')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logga in' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto)
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Förnya access token' })
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken)
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logga ut' })
  async logout(@CurrentUser() user: JwtPayload) {
    await this.auth.logout(user.sub)
    return null
  }

  @Get('me')
  @ApiOperation({
    summary:
      'Hämta inloggad user + organization. Returnerar impersonation-info om token är impersonerad.',
  })
  async me(
    @CurrentUser() payload: JwtPayload & { impersonatedBy?: string; impersonationLogId?: string },
  ) {
    const base = await this.auth.me(payload.sub, payload.organizationId)
    return {
      ...base,
      impersonation: payload.impersonatedBy
        ? {
            active: true,
            platformUserId: payload.impersonatedBy,
            logId: payload.impersonationLogId ?? null,
          }
        : null,
    }
  }

  // ── Lösenordshantering ───────────────────────────────────────────────────────

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Byt lösenord (kräver inloggning)' })
  async changePassword(@CurrentUser() user: JwtPayload, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(user.sub, dto.currentPassword, dto.newPassword)
  }

  @Post('forgot-password')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 3, ttl: 600_000 } }) // 3 / 10 min per IP
  @ApiOperation({
    summary: 'Begär lösenordsåterställning. Svarar alltid 204 (skydd mot enumeration)',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.forgotPassword(dto.email)
  }

  @Post('reset-password')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: 600_000 } }) // 5 / 10 min per IP
  @ApiOperation({ summary: 'Återställ lösenord med engångstoken' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.newPassword)
  }

  @Post('accept-invite')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @ApiOperation({ summary: 'Acceptera inbjudan och sätt första lösenord — loggar in användaren' })
  acceptInvite(@Body() dto: AcceptInviteDto) {
    return this.auth.acceptInvite(dto.token, dto.newPassword)
  }
}
