import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { AuthContext } from '../common/auth/auth-context';
import { CurrentAuth, RequirePermissions, TenantScoped } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { CreateEngineConfigDto, EngineConfigDto, EngineConfigListDto } from './dto/engine-config.dto';
import { EngineConfigService } from './engine-config.service';

const uuid = new ParseUUIDPipe();

/**
 * Reading your own organisation's engine parameters (`engine_config:read`, tenant admins).
 */
@ApiTags('admin: engine configuration')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@Controller('admin/engine-config')
@RequirePermissions('engine_config:read')
export class EngineConfigController {
  constructor(private readonly configs: EngineConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'The active engine configuration of your organisation',
    description: '`paramsValid` reports whether the stored parameters satisfy the engine schema; `paramsIssues` names any missing key.',
  })
  @ApiOkResponse({ type: EngineConfigDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'ENGINE_CONFIG_MISSING' })
  getActive(@CurrentAuth() auth: AuthContext): Promise<EngineConfigDto> {
    return this.configs.getActive(auth.tenantId);
  }

  @Get('versions')
  @ApiOperation({ summary: 'Configuration versions of your organisation, newest first' })
  @ApiOkResponse({ type: EngineConfigListDto })
  listVersions(@CurrentAuth() auth: AuthContext): Promise<EngineConfigListDto> {
    return this.configs.listVersions(auth.tenantId);
  }

  @Get('versions/:id')
  @ApiOperation({ summary: 'One configuration version' })
  @ApiOkResponse({ type: EngineConfigDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  getVersion(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<EngineConfigDto> {
    return this.configs.getVersion(auth.tenantId, id);
  }
}

/**
 * Changing engine parameters is a platform power (`engine_config:manage`, SUPER_ADMIN —
 * DECISIONS.md §B15), so these routes name the organisation explicitly. Versions are
 * immutable: a change is a new version, and activation is audited by the database itself.
 */
@ApiTags('admin: engine configuration (super admin)')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('admin/tenants/:tenantId/engine-config')
@RequirePermissions('engine_config:manage')
@TenantScoped()
export class EngineConfigAdminController {
  constructor(private readonly configs: EngineConfigService) {}

  @Get()
  @ApiOperation({ summary: "An organisation's active configuration" })
  @ApiOkResponse({ type: EngineConfigDto })
  getActive(@Param('tenantId', uuid) tenantId: string): Promise<EngineConfigDto> {
    return this.configs.getActive(tenantId);
  }

  @Get('versions')
  @ApiOperation({ summary: "An organisation's configuration versions, newest first" })
  @ApiOkResponse({ type: EngineConfigListDto })
  listVersions(@Param('tenantId', uuid) tenantId: string): Promise<EngineConfigListDto> {
    return this.configs.listVersions(tenantId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create the next configuration version',
    description:
      'Every parameter is required: a version missing a key is rejected with that key named, so the engine never runs on an invented value. Pass `activate: true` to switch to it at once.',
  })
  @ApiCreatedResponse({ type: EngineConfigDto })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto, description: 'ENGINE_CONFIG_INVALID' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Param('tenantId', uuid) tenantId: string,
    @Body() dto: CreateEngineConfigDto,
  ): Promise<EngineConfigDto> {
    return this.configs.createVersion(auth, tenantId, dto);
  }

  @Post('versions/:id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate a stored version (the current one is deactivated in the same transaction)' })
  @ApiOkResponse({ type: EngineConfigDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'INVALID_STATE' })
  activate(
    @CurrentAuth() auth: AuthContext,
    @Param('tenantId', uuid) tenantId: string,
    @Param('id', uuid) id: string,
  ): Promise<EngineConfigDto> {
    return this.configs.activateVersion(auth, tenantId, id);
  }
}
