import { defineEnv, postgresEnvSchema } from '../common/config/define-env.js'
import { migrateDatabase, migrationsFolder } from './migrations.js'

// Kubernetes: a Job (Argo CD Sync hook, wave 0) runs `node dist/db/migrate.js` before
// the new Deployment rolls out. Of the app's config it reads only DATABASE_URL.
const env = defineEnv(
    postgresEnvSchema.pick({
        DATABASE_URL: true,
    }),
)

const log = (level: 'info' | 'warn', msg: string, fields: Record<string, unknown>) =>
    console.log(
        JSON.stringify({
            level,
            time: new Date().toISOString(),
            msg,
            ...fields,
        }),
    )

await migrateDatabase(env().DATABASE_URL, {
    onRetry: (attempt, delayMs) =>
        log('warn', 'migration gave up on a lock, retrying', {
            attempt,
            delayMs,
        }),
})
log('info', 'migrations applied', {
    folder: migrationsFolder,
})
