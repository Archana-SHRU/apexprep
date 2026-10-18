import { Module } from '@nestjs/common';
import { SyllabusAdminController } from './syllabus-admin.controller';
import { SyllabusAdminService } from './syllabus-admin.service';
import { SyllabusController } from './syllabus.controller';
import { SyllabusRepository } from './syllabus.repository';
import { SyllabusService } from './syllabus.service';
import { TheoryAdminService } from './theory-admin.service';

@Module({
  controllers: [SyllabusController, SyllabusAdminController],
  providers: [SyllabusRepository, SyllabusService, SyllabusAdminService, TheoryAdminService],
  exports: [SyllabusRepository, SyllabusService],
})
export class SyllabusModule {}
