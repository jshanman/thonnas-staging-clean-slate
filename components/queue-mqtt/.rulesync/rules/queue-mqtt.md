---
root: false
targets: ["*"]
globs:
  - "components/queue-mqtt/**"
---

# queue-mqtt

MQTT message broker for real-time pub/sub messaging. Lightweight communication for live updates, presence, and IoT. Supports QoS 0/1/2.

**Root:** `components/queue-mqtt`

**Strategies:**
- [`comms.queue.pub-sub.mqtt`](../../docs/rules/strategies/queue-mqtt--comms.queue.pub-sub.mqtt.md) - MQTT pub/sub
- [`comms.events.pub-sub`](../../docs/rules/strategies/queue-mqtt--comms.events.pub-sub.md) - Event messaging
- [`comms.duplex.bidirectional`](../../docs/rules/strategies/queue-mqtt--comms.duplex.bidirectional.md) - Bidirectional comms

## Lifecycle Context
- **Requirements:** [review](../../docs/thonnas-prompts/planning.requirements.review.md)

