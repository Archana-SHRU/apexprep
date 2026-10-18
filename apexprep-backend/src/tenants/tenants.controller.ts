import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions, TenantScoped } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { CursorQueryDto } from '../common/pagination/cursor';
import { ListTenantUsersQueryDto } from '../users/dto/users.dto';
import { UserDto, UserPageDto } from '../users/user.dto';
import { UsersService } from '../users/users.service';
import { CreateStaffDto, CreateTenantDto, TenantDto, TenantPageDto, UpdateTenantDto } from './dto/tenants.dto';
import { TenantsService } from './tenants.service';

/**
 * Platform administration: the only routes that act on a tenant other than the caller's.
 * `tenants:manage` (SUPER_ADMIN) is required for the whole controller; @TenantScoped
 * validates the :tenantId parameter.
 */
@ApiTags('admin: tenants (super admin)')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@Controller('admin/tenants')
@RequirePermissions('tenants:manage')
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List organisations' })
  @ApiOkResponse({ type: TenantPageDto })
  list(@Query() query: CursorQueryDto): Promise<TenantPageDto> {
    return this.tenants.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an organisation (sign-up closed by default)' })
  @ApiCreatedResponse({ type: TenantDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SLUG_TAKEN' })
  create(@Body() dto: CreateTenantDto): Promise<TenantDto> {
    return this.tenants.create(dto);
  }

  @Patch(':tenantId')
  @TenantScoped()
  @ApiOperation({ summary: 'Update an organisation (name, status, sign-up, benchmarking, focus tracking)' })
  @ApiOkResponse({ type: TenantDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(@Param('tenantId') tenantId: string, @Body() dto: UpdateTenantDto): Promise<TenantDto> {
    return this.tenants.update(tenantId, dto);
  }

  @Post(':tenantId/admins')
  @TenantScoped()
  @RequirePermissions('staff:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an ADMIN account in an organisation' })
  @ApiCreatedResponse({ type: UserDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'EMAIL_TAKEN' })
  createAdmin(@Param('tenantId') tenantId: string, @Body() dto: CreateStaffDto): Promise<UserDto> {
    return this.tenants.createAdmin(tenantId, dto);
  }

  @Get(':tenantId/users')
  @TenantScoped()
  @ApiOperation({ summary: 'List users of an organisation' })
  @ApiOkResponse({ type: UserPageDto })
  listUsers(@Param('tenantId') tenantId: string, @Query() query: ListTenantUsersQueryDto): Promise<UserPageDto> {
    return this.users.listTenantUsers(tenantId, query);
  }
}
