import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
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
import { BenchmarkService } from './benchmark.service';
import { BenchmarkDto, BenchmarkQueryDto, ComputeBenchmarkDto } from './dto/benchmark.dto';

@ApiTags('analytics')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@Controller()
export class BenchmarkController {
  constructor(private readonly benchmarks: BenchmarkService) {}

  @Get('me/benchmark')
  @RequirePermissions('analytics:own')
  @ApiOperation({
    summary: 'Anonymous peer benchmark for a sub-topic',
    description:
      'Returns the top-cohort average accuracy and median pace over a 90-day window. ' +
      'Strictly anonymous. Withheld if fewer than 30 qualifying peers exist per FR-10.2.',
  })
  @ApiOkResponse({ type: BenchmarkDto })
  async getMyBenchmark(
    @CurrentAuth() auth: AuthContext,
    @Query() query: BenchmarkQueryDto,
  ): Promise<BenchmarkDto> {
    return this.benchmarks.getBenchmark(auth, query.subtopicId);
  }

  @Post('admin/benchmarks/compute')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reports:tenant')
  @ApiOperation({
    summary: 'Compute and publish an anonymous benchmark snapshot for a sub-topic',
    description: 'Aggregates recent qualifying student attempts and writes to benchmark_snapshots.',
  })
  @ApiOkResponse({ type: BenchmarkDto })
  async computeBenchmark(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: ComputeBenchmarkDto,
  ): Promise<BenchmarkDto> {
    return this.benchmarks.compute(auth, dto);
  }
}
