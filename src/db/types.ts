import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { TxOf } from '../common/database/database.js'
import type * as schema from './schema.js'

/** This service's Drizzle handle: `@Inject(DB) db: Db`. */
export type Db = NodePgDatabase<typeof schema>
export type Tx = TxOf<Db>

export type PaymentRow = typeof schema.payments.$inferSelect
export type WebhookEventRow = typeof schema.webhookEvents.$inferSelect
