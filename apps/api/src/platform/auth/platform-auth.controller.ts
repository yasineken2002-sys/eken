import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { Public } from '../../common/decorators/public.decorator'
import { PlatformAuthService } from './platform-auth.service'
import { PlatformGuard } from './platform.guard'
import { CurrentPlatformUser } from './current-platform-user.decorator'
import {
  PlatformChangePasswordDto,
  PlatformLoginDto,
  PlatformRefreshDto,
  PlatformTotpVerifyDto,
} from './dto/platform-login.dto'
import type { PlatformJwtPayload } from '../platform-token.types'

@ApiTags('Platform / Auth')
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Post('login')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Super-admin inloggning' })
  login(@Body() dto: PlatformLoginDto) {
    return this.auth.login(dto.email, dto.password, dto.totpCode)
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Förnya platform access-token' })
  refresh(@Body() dto: PlatformRefreshDto) {
    return this.auth.refresh(dto.refreshToken)
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logga ut (revoke refresh-token)' })
  async logout(@Body() dto: PlatformRefreshDto) {
    await this.auth.logout(dto.refreshToken)
    return null
  }

  @Get('me')
  @UseGuards(PlatformGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Hämta inloggad platform-user' })
  me(@CurrentPlatformUser() user: PlatformJwtPayload) {
    return this.auth.getProfile(user.sub)
  }

  @Post('change-password')
  @UseGuards(PlatformGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Byt lösenord' })
  async changePassword(
    @CurrentPlatformUser() user: PlatformJwtPayload,
    @Body() dto: PlatformChangePasswordDto,
  ) {
    await this.auth.changePassword(user.sub, dto.currentPassword, dto.newPassword)
    return null
  }

  @Post('2fa/setup')
  @UseGuards(PlatformGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Starta 2FA-setup (returnerar QR-kod)' })
  setup2fa(@CurrentPlatformUser() user: PlatformJwtPayload) {
    return this.auth.generateTotpSetup(user.sub)
  }

  @Post('2fa/enable')
  @UseGuards(PlatformGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aktivera 2FA genom att verifiera kod' })
  async enable2fa(
    @CurrentPlatformUser() user: PlatformJwtPayload,
    @Body() dto: PlatformTotpVerifyDto,
  ) {
    await this.auth.enableTotp(user.sub, dto.code)
    return null
  }

  @Post('2fa/disable')
  @UseGuards(PlatformGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Avaktivera 2FA genom att verifiera kod' })
  async disable2fa(
    @CurrentPlatformUser() user: PlatformJwtPayload,
    @Body() dto: PlatformTotpVerifyDto,
  ) {
    await this.auth.disableTotp(user.sub, dto.code)
    return null
  }
}
