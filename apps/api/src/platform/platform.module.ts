import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { PropertiesModule } from '../properties/properties.module'
import { PlatformAuthService } from './auth/platform-auth.service'
import { PlatformAuthController } from './auth/platform-auth.controller'
import { PlatformJwtStrategy } from './auth/platform-jwt.strategy'
import { PlatformGuard } from './auth/platform.guard'
import { PlatformOrganizationsService } from './organizations/platform-organizations.service'
import { PlatformOrganizationsController } from './organizations/platform-organizations.controller'
import { ImpersonationService } from './impersonation/impersonation.service'
import { ImpersonationController } from './impersonation/impersonation.controller'
import { PlatformPropertiesService } from './properties/platform-properties.service'
import { PlatformPropertiesController } from './properties/platform-properties.controller'
import { PlatformInvoicesService } from './invoices/platform-invoices.service'
import { PlatformInvoicesController } from './invoices/platform-invoices.controller'
import { PlatformErrorsService } from './errors/platform-errors.service'
import { PlatformErrorsController } from './errors/platform-errors.controller'
import { PlatformStatsService } from './stats/platform-stats.service'
import { PlatformStatsController } from './stats/platform-stats.controller'

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('PLATFORM_JWT_SECRET'),
        signOptions: { expiresIn: config.get('PLATFORM_JWT_ACCESS_EXPIRES_IN', '1h') },
      }),
    }),
    PropertiesModule,
  ],
  controllers: [
    PlatformAuthController,
    PlatformOrganizationsController,
    ImpersonationController,
    PlatformPropertiesController,
    PlatformInvoicesController,
    PlatformErrorsController,
    PlatformStatsController,
  ],
  providers: [
    PlatformJwtStrategy,
    PlatformGuard,
    PlatformAuthService,
    PlatformOrganizationsService,
    ImpersonationService,
    PlatformPropertiesService,
    PlatformInvoicesService,
    PlatformErrorsService,
    PlatformStatsService,
  ],
  exports: [PlatformErrorsService],
})
export class PlatformModule {}
