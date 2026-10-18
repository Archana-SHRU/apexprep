import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../common/auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { ChangeUserStatusDto, ListUsersQueryDto } from './dto/users.dto';
import { UserDto, UserPageDto } from './user.dto';
import { UsersService } from './users.service';

@ApiTags('admin: students')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@Controller('admin/students')
@RequirePermissions('students:read')
export class AdminStudentsController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List students in your organisation (cursor-paginated, newest first)' })
  @ApiOkResponse({ type: UserPageDto })
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListUsersQueryDto): Promise<UserPageDto> {
    return this.users.listStudents(auth, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One student in your organisation' })
  @ApiOkResponse({ type: UserDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string): Promise<UserDto> {
    return this.users.getStudent(auth, id);
  }
}

@ApiTags('admin: users')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@Controller('admin/users')
@RequirePermissions('students:manage')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Enable or disable an account in your organisation',
    description: 'Disabling ends all of the user\'s sessions immediately. Staff accounts require staff:manage.',
  })
  @ApiOkResponse({ type: UserDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  changeStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ChangeUserStatusDto,
  ): Promise<UserDto> {
    return this.users.changeStatus(auth, id, dto);
  }
}
