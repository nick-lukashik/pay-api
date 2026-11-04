import 'reflect-metadata'
import type { ConfigType } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module.js'
import { configureApp } from './app.setup.js'
import { appConfig } from './config/config.js'

/**
 * Hard stop: Kubernetes kills the pod 30 s after SIGTERM, so the graceful path
 * (delay, consumer drain, pg-boss stop, pools) must finish within 25 s.
 * If something hangs, exit with an error instead of being killed silently.
 */
const SHUTDOWN_DEADLINE_MS = 25_000
for (const signal of [
    'SIGTERM',
    'SIGINT',
] as const) {
    process.once(signal, () => {
        setTimeout(() => {
            process.stderr.write(
                `${JSON.stringify({
                    level: 'fatal',
                    msg: `Shutdown exceeded ${SHUTDOWN_DEADLINE_MS} ms, exiting`,
                })}\n`,
            )
            process.exit(1)
        }, SHUTDOWN_DEADLINE_MS).unref()
    })
}

// Environment comes from the process (Kubernetes) or `node --env-file-if-exists=.env`.
const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Close idle keep-alive sockets on shutdown instead of waiting for them.
    forceCloseConnections: true,
})
app.useLogger(app.get(Logger))
configureApp(app)
const { port } = app.get<ConfigType<typeof appConfig>>(appConfig.KEY)
await app.listen(port, '0.0.0.0')
