import { Module } from '@nestjs/common';
import { PasswordService } from '../auth/password.service';
import { UsersModule } from '../users/users.module';
import { TenantsController } from './tenants.controller';
import { TenantsRepository } from './tenants.repository';
import { TenantsService } from './tenants.service';

@Module({
  imports: [UsersModule],
  controllers: [TenantsController],
  providers: [TenantsRepository, TenantsService, PasswordService],
  exports: [TenantsRepository],
})
export class TenantsModule {}
