import { Injectable } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

@Injectable()
export class PlatformGuard extends AuthGuard('platform-jwt') {}
