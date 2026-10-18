import { Body, Controller, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { AuthContext } from '../common/auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { UpdateProfileDto } from './dto/users.dto';
import { UserDto } from './user.dto';
import { UsersService } from './users.service';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Patch('profile')
  @RequirePermissions('self:profile')
  @ApiOperation({ summary: 'Update your student profile / complete onboarding' })
  @ApiOkResponse({ type: UserDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'Not a student account' })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto, description: 'REFERENCE_NOT_FOUND (unknown track)' })
  updateProfile(@CurrentAuth() auth: AuthContext, @Body() dto: UpdateProfileDto): Promise<UserDto> {
    return this.users.updateOwnProfile(auth, dto);
  }
}
