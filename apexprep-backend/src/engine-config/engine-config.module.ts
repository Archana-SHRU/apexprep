import { Module } from '@nestjs/common';
import { EngineConfigAdminController, EngineConfigController } from './engine-config.controller';
import { EngineConfigService } from './engine-config.service';

/** Versioned engine parameters: read by the question bank and the adaptive engine, managed by platform admins. */
@Module({
  controllers: [EngineConfigController, EngineConfigAdminController],
  providers: [EngineConfigService],
  exports: [EngineConfigService],
})
export class EngineConfigModule {}
