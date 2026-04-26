import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common'
import { ApiTags, ApiOperation } from '@nestjs/swagger'
import { UsersService } from './users.service'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { InviteUserDto } from './dto/invite-user.dto'
import { UpdateUserRoleDto } from './dto/update-user-role.dto'
import type { JwtPayload } from '@eken/shared'

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Lista alla användare i organisationen' })
  findAll(@OrgId() organizationId: string) {
    return this.users.findAll(organizationId)
  }

  @Post('invite')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Bjud in en ny användare till organisationen' })
  invite(
    @Body() dto: InviteUserDto,
    @OrgId() organizationId: string,
    @CurrentUser() current: JwtPayload,
  ) {
    return this.users.invite(dto, organizationId, current.sub)
  }

  @Patch(':id/role')
  @Roles('OWNER')
  @ApiOperation({ summary: 'Ändra roll för en användare (endast OWNER)' })
  updateRole(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateUserRoleDto,
    @OrgId() organizationId: string,
    @CurrentUser() current: JwtPayload,
  ) {
    return this.users.updateRole(id, dto.role, organizationId, current.sub)
  }

  @Delete(':id')
  @Roles('OWNER')
  @ApiOperation({ summary: 'Inaktivera en användare (endast OWNER, ej självet)' })
  deactivate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @OrgId() organizationId: string,
    @CurrentUser() current: JwtPayload,
  ) {
    return this.users.deactivate(id, organizationId, current.sub)
  }

  @Post(':id/reactivate')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Återaktivera en tidigare inaktiverad användare' })
  reactivate(@Param('id', new ParseUUIDPipe()) id: string, @OrgId() organizationId: string) {
    return this.users.reactivate(id, organizationId)
  }
}
