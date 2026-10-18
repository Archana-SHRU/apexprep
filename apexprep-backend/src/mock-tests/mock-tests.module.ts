import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MockTestSweep } from './mock-test-sweep.service';
import { MockTestsController } from './mock-tests.controller';
import { MockTestsRepository } from './mock-tests.repository';
import { MockTestsService } from './mock-tests.service';

@Module({
  imports: [DatabaseModule],
  controllers: [MockTestsController],
  providers: [MockTestsRepository, MockTestsService, MockTestSweep],
  exports: [MockTestsService, MockTestSweep],
})
export class MockTestsModule {}
