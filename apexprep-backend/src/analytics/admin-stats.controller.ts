import { Controller, Get } from '@nestjs/common';
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
import { AnalyticsService } from './analytics.service';
import { AdminStatsDto } from './dto/admin-stats.dto';

@ApiTags('admin: analytics')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@Controller('admin/stats')
@RequirePermissions('reports:tenant')
export class AdminStatsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  @ApiOperation({
    summary: 'Platform-wide administrative statistics',
    description:
      'Aggregates total enrolled learners, published questions by subject, daily practice volume, and content ingestion success rate. Scoped strictly to the caller organisation.',
  })
  @ApiOkResponse({ type: AdminStatsDto })
  stats(@CurrentAuth() auth: AuthContext): Promise<AdminStatsDto> {
    return this.analytics.adminStats(auth);
  }
}
