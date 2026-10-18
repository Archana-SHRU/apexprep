import { customType, timestamp } from 'drizzle-orm/pg-core';

/** bytea <-> Buffer (node-postgres returns Buffer for bytea). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** timestamptz as a JS Date. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const timestamps = {
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
};
