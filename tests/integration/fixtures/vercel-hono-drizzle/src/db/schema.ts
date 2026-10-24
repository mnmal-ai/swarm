// Drizzle schema using pg-core pgTable so schema-file-based Drizzle detection
// matches in addition to the drizzle-orm dependency signal.
import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const restaurants = pgTable('restaurants', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
