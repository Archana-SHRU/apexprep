import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EngineConfigModule } from '../engine-config/engine-config.module';
import { QuestionsModule } from '../questions/questions.module';
import { SyllabusModule } from '../syllabus/syllabus.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { AbilityRebuildService } from './ability-rebuild.service';
import { AttemptsService } from './attempts.service';
import { PracticeController } from './practice.controller';
import { PracticeRepository } from './practice.repository';
import { PracticeService } from './practice.service';

/**
 * Wires the pure adaptive engine (`src/adaptive/`) to the student request path. It owns no
 * adaptive rules of its own: selection, grading weights, the ladder and decay all come from
 * the engine, parameterised by the active engine configuration.
 */
@Module({
  imports: [SyllabusModule, QuestionsModule, EngineConfigModule, UsersModule, TenantsModule, AuditModule],
  controllers: [PracticeController],
  providers: [PracticeRepository, PracticeService, AttemptsService, AbilityRebuildService],
  exports: [PracticeRepository, PracticeService, AbilityRebuildService],
})
export class PracticeModule {}
