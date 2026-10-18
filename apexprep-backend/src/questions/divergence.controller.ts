import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../common/auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { DivergenceService } from './divergence.service';
import { CheckDivergenceDto, DivergenceCheckResultDto } from './dto/divergence.dto';

@ApiTags('questions')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@Controller('admin/questions')
export class DivergenceController {
  constructor(private readonly divergence: DivergenceService) {}

  @Post('check-divergence')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('questions:manage')
  @ApiOperation({
    summary: 'Check question difficulty divergence against assigned L-labels (FR-6.6 / E3)',
    description:
      'Evaluates calibrated questions (calibration_n >= 30) for divergence between observed empirical difficulty and the assigned L-label. ' +
      'Opens review tasks for teacher revision rather than silently overwriting pedagogical judgement.',
  })
  @ApiOkResponse({ type: DivergenceCheckResultDto })
  async checkDivergence(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: CheckDivergenceDto,
  ): Promise<DivergenceCheckResultDto> {
    return this.divergence.checkDivergence(auth, dto);
  }
}
