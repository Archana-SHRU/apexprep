import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailVerificationService } from './email-verification.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordResetService } from './password-reset.service';
import { PasswordService } from './password.service';
import { RefreshTokensService } from './refresh-tokens.service';
import { TokenService } from './token.service';

@Module({
  imports: [UsersModule, TenantsModule],
  controllers: [AuthController],
  providers: [AuthService, TokenService, PasswordService, RefreshTokensService, EmailVerificationService, PasswordResetService, JwtAuthGuard],
  exports: [AuthService, TokenService, PasswordService, RefreshTokensService, JwtAuthGuard],
})
export class AuthModule {}
