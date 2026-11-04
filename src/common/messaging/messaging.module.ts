import { type DynamicModule, Global, type InjectionToken, Module } from '@nestjs/common'
import { OUTBOX_RELAY_OPTIONS, OutboxRelay, type OutboxRelayOptions } from './outbox-relay.js'
import { RABBITMQ_OPTIONS, RabbitMq, type RabbitMqOptions } from './rabbitmq.js'

/** RabbitMQ publisher/consumers and the outbox relay. Requires DatabaseModule. */
@Global()
@Module({})
export class MessagingModule {
    static forRootAsync(options: {
        inject?: InjectionToken[]
        useFactory: (...args: never[]) => RabbitMqOptions
        relay?: OutboxRelayOptions
    }): DynamicModule {
        return {
            module: MessagingModule,
            providers: [
                {
                    provide: RABBITMQ_OPTIONS,
                    inject: options.inject ?? [],
                    useFactory: options.useFactory,
                },
                {
                    provide: OUTBOX_RELAY_OPTIONS,
                    useValue: options.relay ?? {},
                },
                RabbitMq,
                OutboxRelay,
            ],
            exports: [
                RabbitMq,
                OutboxRelay,
            ],
        }
    }
}
