import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class ErrorDetailDto {
  @ApiPropertyOptional({ example: 'email' }) field?: string;
  @ApiProperty({ example: 'email must be a valid email address' }) message!: string;
}

class ErrorBodyDto {
  @ApiProperty({ example: 'VALIDATION_FAILED', description: 'Stable machine-readable code' }) code!: string;
  @ApiProperty({ example: 'Request validation failed' }) message!: string;
  @ApiPropertyOptional({ type: [ErrorDetailDto] }) details?: ErrorDetailDto[];
  @ApiProperty({ example: '7b0c3f7e-5d1a-4e53-9d7e-2f2f7f0c9a11', description: 'Also sent as X-Request-Id' })
  requestId!: string;
}

/** Shape of every error response. */
export class ErrorResponseDto {
  @ApiProperty({ type: ErrorBodyDto }) error!: ErrorBodyDto;
}
