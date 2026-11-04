Source: official docs (summarized): https://www.rabbitmq.com/docs/quorum-queues (4.4, "Dead Lettering", "Poison Message Handling"), https://www.rabbitmq.com/docs/confirms ("Publisher Confirms", "When Will Published Messages Be Confirmed by the Broker?"), https://www.rabbitmq.com/docs/publishers ("Unroutable Message Handling"), https://www.rabbitmq.com/docs/dlx, https://www.rabbitmq.com/docs/ttl, https://amqp-node.github.io/amqplib/channel_api.html, README amqplib 2.2.0 ("Opt-in recovery", https://github.com/amqp-node/amqplib). There are no official agent rules or llms.txt for RabbitMQ and amqplib. The API was checked against the installed amqplib 2.2.0 (index.d.ts, lib/recovery.js) and the behavior against a `rabbitmq:4.4.0-alpine` broker (return before confirm, `PRECONDITION_FAILED` on changed arguments, at-least-once dead-lettering to a missing queue).

# RabbitMQ 4.4 + amqplib 2.x

## Connection

- One connection per process: `connect(url, { recovery: { setup, waitForConnect: false, maxRetries: Infinity } })`, the result is a `RecoveringChannelModel`. RabbitMQ is degradable (service contract): startup waits a bounded time (`waitForConnect()` raced with a timer) and then goes on without the broker; recovery reconnects forever.
- `setup(model)` runs after every (re)connection: declare exchanges and open the publisher channel there. Channels created outside `setup` don't survive a reconnect, so references are refreshed in `setup`. Don't let a consumer that cannot start fail `setup`: that would fail the whole connection (and publishing). Start consumers from `setup` without awaiting them.
- On the connection, listen for `disconnect`, `connect-failed`, `reconnect-failed`, `error`, `blocked`/`unblocked`; on every channel, listen for `error`, `close` and `handler-error`. Without `handler-error`, an exception in our handler can silently close the channel.
- Use a separate `createConfirmChannel()` for publishing and one channel per consumer.

## Publishing

- Each producer service has its own topic exchange: `<service>.events`, `durable: true`. The routing key is `<entity>.<event>.v<N>`.
- Publish on a confirm channel with `mandatory: true` and `persistent: true`, `messageId`, `contentType: 'application/json'`, `timestamp`, `type`, `correlationId` (`confirmedPublisher` in `src/common/messaging/confirm.ts`). The broker confirms an unroutable message too (the exchange exists, no queue is bound); with `mandatory` it sends `basic.return` before that `basic.ack` (confirms docs). So a confirm alone does not mean "stored": a returned message is a delivery failure. Match the return to its publish by a per-publish header (`x-publish-id`), not by `messageId`, which repeats on republish and replay.
- Mark the outbox row as sent only after an ack without a return. On a return, a nack, no confirm in time (a blocked connection never confirms) or a closed channel, the row stays pending and the relay retries with backoff. Count failures by reason (`outbox_publish_failures_total{reason}`).
- A publish to a missing exchange closes the channel (404): open a new publisher channel on the next publish and declare the exchanges again.
- Put the outbox record id (uuidv7) in `messageId`: consumers deduplicate by it.
- Confirms may arrive out of order (confirms docs): resolve each publish from its own callback, never by counting acks.

## Queues

- The consumer owns the queue. The name is `<consumer-service>.<purpose>`, the type `x-queue-type: quorum`. The type is set only at declaration and can't be changed later. Classic mirrored queues were removed in 4.x; a quorum queue can't be exclusive or non-durable.
- Queue arguments are part of the identity: redeclaring with different `x-arguments` (also `x-dead-letter-strategy`) gives `PRECONDITION_FAILED` and closes the channel. Changing them means a new queue or a delete first (a topology migration). The official recommendation is to set DLX, TTL and limits with policies; when they are set in code (`queueDeclarations()` in `topology.ts`), change them deliberately.
- Dead-lettering of quorum queues is at-most-once by default: a message whose target is missing or does not confirm is dropped. Every queue that dead-letters (the main queue for the delivery limit, each retry queue for its TTL) needs `x-dead-letter-strategy: at-least-once`, `x-overflow: reject-publish` (with the default `drop-head` RabbitMQ silently falls back to at-most-once) and an `x-dead-letter-exchange` (`''`, the default exchange, works). The `stream_queue` feature flag is required; it is always on in 4.x. Then the message stays in the source queue until the target confirmed it; the broker retries periodically (`dead_letter_worker_publisher_confirm_timeout`), so duplicates are possible (quorum-queues docs, "At-least-once dead-lettering").
- At-least-once dead-lettering keeps unconfirmed messages in memory and counts them toward length limits: set `max-length` by policy if a target can be missing for long. Target queues must be durable and messages persistent.
- Retry: one queue per delay level, with a fixed `x-message-ttl` and the DLX back to the main queue. Messages expire at the head of the queue, so different per-message TTLs in one queue block the tail. After the attempt limit, the message goes to `<queue>.dlq`.
- A quorum queue has a `delivery-limit` of 20 by default (`-1` disables it, not recommended). Messages over the limit are dead-lettered (to the DLQ, at least once) or dropped if no DLX is configured.

## Consuming

- `consume(queue, handler, { noAck: false })` with an explicit `prefetch(n)`. Don't set unlimited (0); a quorum queue caps prefetch at 2000 anyway.
- `ack` only after the handler succeeds and the transaction (inbox + business changes) commits, and on the same channel the message was received on. A double ack or an unknown delivery tag closes the channel. `ack` on a closed channel throws: catch it, the broker redelivers.
- Don't `nack(msg, false, true)` on a processing error: it is a hot loop. A transient error → retry queue. An invalid message (Zod `safeParse`) or exhausted attempts → DLQ. Count attempts by the `x-death` header (`count`) or by your own header.
- Moving to a retry queue or the DLQ is a publish too: `mandatory` + confirm, then ack the original. If the move fails (a missing queue is a return), don't ack: close the consumer's channel (the message returns to its queue) and re-subscribe, which declares the retry queues and the DLQ again.
- Delivery is at-least-once: duplicates and `redelivered` are normal. Idempotency comes from the inbox by `messageId`.
- If the callback received `msg === null`, the broker cancelled the consumer (e.g. the queue was deleted). A closed channel (any channel error) also stops it. Both happen without a connection loss, so `setup` won't run: re-subscribe that consumer on its own with backoff (declaring its queues again), track its state, and report it in readiness and as `messaging_consumer_up{queue}`.
- Shutdown: `cancel(consumerTag)` → wait for handlers that are still running → `close()` the connection.

## DLQ replay

- `<queue>.dlq` → `<queue>` with `get` + `mandatory` publish + confirm, then ack the DLQ copy; on any failure nack it back (`requeue: true`) and stop. Check that both queues exist first. Take at most the messages present at the start, so a message that fails again is not replayed twice in one run. Reset the attempt header. `src/common/messaging/replay.ts`, CLI `node dist/messaging/replay-dlq.js <queue> [--limit N]`.
