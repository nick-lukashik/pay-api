import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    // SWC emits decorator metadata (Nest DI); Vite's own transform does not.
    plugins: [
        swc.vite({
            module: {
                type: 'es6',
            },
        }),
    ],
    test: {
        restoreMocks: true,
        projects: [
            {
                test: {
                    name: 'unit',
                    include: [
                        'src/**/*.test.ts',
                    ],
                },
            },
            {
                test: {
                    name: 'integration',
                    include: [
                        'test/**/*.test.ts',
                    ],
                    // Real Postgres, Redis and RabbitMQ: started once, shared by every file.
                    globalSetup: [
                        'test/global-setup.ts',
                    ],
                    fileParallelism: false,
                    testTimeout: 30_000,
                    hookTimeout: 180_000,
                },
            },
        ],
    },
})
