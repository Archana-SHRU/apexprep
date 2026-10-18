import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { passwordPolicyViolation, PasswordService } from '../auth/password.service';
import { AppException } from '../common/errors/app-exception';
import { decodeCursor, toPage, type CursorQueryDto, type Page } from '../common/pagination/cursor';
import { DRIZZLE, type Database } from '../database/database.module';
import { isUniqueViolation } from '../database/pg-error';
import { toUserDto, type UserDto } from '../users/user.dto';
import { UsersRepository } from '../users/users.repository';
import { toTenantDto, type CreateStaffDto, type CreateTenantDto, type TenantDto, type UpdateTenantDto } from './dto/tenants.dto';
import { TenantsRepository, type TenantPatch } from './tenants.repository';

/** Platform administration (SUPER_ADMIN). Every mutation is audited against the target tenant. */
@Injectable()
export class TenantsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tenants: TenantsRepository,
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  async list(q: CursorQueryDto): Promise<Page<TenantDto>> {
    const limit = q.limit ?? 20;
    const rows = await this.tenants.list(limit, q.cursor ? decodeCursor(q.cursor) : undefined);
    return toPage(rows, limit, toTenantDto);
  }

  async create(dto: CreateTenantDto): Promise<TenantDto> {
    try {
      const tenant = await this.db.transaction(async (tx) => {
        const row = await this.tenants.insert(
          { slug: dto.slug, name: dto.name, selfRegistrationEnabled: dto.selfRegistrationEnabled ?? false },
          tx,
        );
        await this.audit.record(
          { tenantId: row.id, action: 'tenant.created', entityType: 'tenant', entityId: row.id, after: toTenantDto(row) as unknown as Record<string, unknown> },
          tx,
        );
        return row;
      });
      return toTenantDto(tenant);
    } catch (err) {
      if (isUniqueViolation(err, 'tenants_slug_uq')) throw AppException.conflict('This slug is already in use', 'SLUG_TAKEN');
      throw err;
    }
  }

  async update(tenantId: string, dto: UpdateTenantDto): Promise<TenantDto> {
    const current = await this.tenants.findById(tenantId);
    if (!current) throw AppException.notFound('Organisation not found', 'TENANT_NOT_FOUND');
    const patch: TenantPatch = { ...dto };
    if (Object.keys(patch).length === 0) return toTenantDto(current);
    const updated = await this.db.transaction(async (tx) => {
      const row = await this.tenants.update(tenantId, patch, tx);
      await this.audit.record(
        {
          tenantId,
          action: 'tenant.updated',
          entityType: 'tenant',
          entityId: tenantId,
          before: Object.fromEntries(Object.keys(patch).map((k) => [k, current[k as keyof TenantPatch]])),
          after: patch,
        },
        tx,
      );
      return row;
    });
    if (!updated) throw AppException.notFound('Organisation not found', 'TENANT_NOT_FOUND');
    return toTenantDto(updated);
  }

  async createAdmin(tenantId: string, dto: CreateStaffDto): Promise<UserDto> {
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant) throw AppException.notFound('Organisation not found', 'TENANT_NOT_FOUND');
    const violation = passwordPolicyViolation(dto.password, dto.email);
    if (violation) throw AppException.validation([{ field: 'password', message: violation }]);
    const passwordHash = await this.passwords.hash(dto.password);
    try {
      const user = await this.db.transaction(async (tx) => {
        const row = await this.users.insert(
          { tenantId, email: dto.email, passwordHash, role: 'ADMIN', displayName: dto.displayName },
          tx,
        );
        await this.audit.record(
          { tenantId, action: 'user.created', entityType: 'user', entityId: row.id, after: { role: 'ADMIN', email: row.email } },
          tx,
        );
        return row;
      });
      return toUserDto(user);
    } catch (err) {
      if (isUniqueViolation(err, 'users_tenant_email_uq')) {
        throw AppException.conflict('An account with this email already exists', 'EMAIL_TAKEN');
      }
      throw err;
    }
  }
}
