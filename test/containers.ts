import { createServer } from 'node:net'
import { RabbitMQContainer } from '@testcontainers/rabbitmq'
import { RedisContainer } from '@testcontainers/redis'
import { getContainerRuntimeClient, type StartedTestContainer } from 'testcontainers'

/** Same majors as compose.yaml and production. */
export const IMAGES = {
    postgres: 'postgres:18.6-alpine',
    redis: 'redis:8.10.3-alpine',
    rabbitmq: 'rabbitmq:4.4.0-alpine',
}

/**
 * A free host port, so a stopped and started container keeps its address.
 * Taken below the ephemeral range (49152+), from which Docker and the OS hand
 * out random ports: while our container is stopped nobody else gets it.
 */
async function freePort(): Promise<number> {
    for (let attempt = 0; attempt < 50; attempt++) {
        const port = 20_000 + Math.floor(Math.random() * 12_000)
        const server = createServer()
        const free = await new Promise<boolean>(resolve => {
            server.once('error', () => resolve(false))
            server.listen(port, '0.0.0.0', () => resolve(true))
        })
        if (free) {
            await new Promise<void>(resolve => server.close(() => resolve()))
            return port
        }
    }
    throw new Error('no free port')
}

/** Runs `check`; on failure adds the container's last log lines to the error (broker did not come back?). */
export async function withLogs<T>(container: StartedTestContainer, check: () => Promise<T>): Promise<T> {
    try {
        return await check()
    } catch (error) {
        const lines: string[] = []
        const stream = await container.logs({
            tail: 40,
        })
        await new Promise<void>(resolve => {
            stream.on('data', (line: Buffer | string) => lines.push(String(line).trim()))
            stream.on('end', () => resolve())
            setTimeout(resolve, 1_000).unref()
        })
        throw new Error(`${(error as Error).message}\n--- container log ---\n${lines.join('\n')}`, {
            cause: error,
        })
    }
}

/**
 * Failure tests stop and start a dependency, so they get their own container
 * instead of the shared ones (also in CI, where the shared ones are service
 * containers). The host port is fixed: Docker keeps it across stop and start.
 */
export async function startOwnRabbitMq(environment: Record<string, string> = {}) {
    const port = await freePort()
    const container = await new RabbitMQContainer(IMAGES.rabbitmq)
        .withExposedPorts({
            container: 5672,
            host: port,
        })
        .withEnvironment(environment)
        .start()
    return {
        container,
        url: container.getAmqpUrl(),
    }
}

export async function startOwnRedis() {
    const port = await freePort()
    const container = await new RedisContainer(IMAGES.redis)
        .withExposedPorts({
            container: 6379,
            host: port,
        })
        .start()
    return {
        container,
        url: container.getConnectionUrl(),
    }
}

/** Stops the container without removing it (the dependency is down). */
export async function stopContainer(container: StartedTestContainer) {
    const client = await getContainerRuntimeClient()
    await client.container.stop(client.container.getById(container.getId()), {
        timeout: 10,
    })
}

/** Starts a stopped container again on the same host port. */
export async function startContainer(container: StartedTestContainer) {
    const client = await getContainerRuntimeClient()
    await client.container.start(client.container.getById(container.getId()))
}
