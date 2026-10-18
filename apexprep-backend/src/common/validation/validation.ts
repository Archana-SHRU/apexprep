import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { AppException, type ErrorDetail } from '../errors/app-exception';

function flatten(errors: ValidationError[], parent = ''): ErrorDetail[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = Object.values(e.constraints ?? {}).map((message) => ({ field, message }));
    return [...own, ...flatten(e.children ?? [], field)];
  });
}

/**
 * Global request validation: unknown properties are rejected (so a client cannot slip
 * `role`, `tenantId` or similar into a payload), and failures produce
 * { code: VALIDATION_FAILED, details: [{ field, message }] }.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    stopAtFirstError: false,
    exceptionFactory: (errors) => AppException.validation(flatten(errors)),
  });
}
