import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { MaintenanceController } from './maintenance.controller';
import { RetentionService } from './retention.service';

@Module({
  imports: [AuditModule],
  controllers: [MaintenanceController],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class MaintenanceModule {}
