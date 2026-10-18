import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../auth/decorators';
import { ErrorResponseDto } from '../errors/error-response.dto';
import { PurgeEventsDto, PurgeEventsResultDto } from './dto/maintenance.dto';
import { RetentionService } from './retention.service';

@ApiTags('maintenance')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@Controller('admin/maintenance')
export class MaintenanceController {
  constructor(private readonly retention: RetentionService) {}

  @Post('purge-events')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:manage')
  @ApiOperation({
    summary: 'Purge old raw session events (12-month event retention enforcement)',
    description:
      'Removes raw session and focus-tracking events older than the specified duration (default 365 days) ' +
      'per statutory data minimization requirements. Aggregate learning analytics and student attempts remain preserved.',
  })
  @ApiOkResponse({ type: PurgeEventsResultDto })
  async purgeOldEvents(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: PurgeEventsDto,
  ): Promise<PurgeEventsResultDto> {
    return this.retention.purgeOldSessionEvents(auth, dto.olderThanDays);
  }
}
