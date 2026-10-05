---
alwaysApply: true
description: 
---

# Component: Queue - MQTT

## Summary

MQTT message broker for real-time pub/sub messaging, enabling lightweight communication and live updates in distributed systems.

## When to Use

Use for real-time notifications, user presence tracking, live updates, and lightweight pub/sub messaging.

**Specific Use Cases**:
- Real-time user presence and status updates
- Live notification broadcasting
- IoT device communication
- Chat and messaging applications
- Real-time dashboards and analytics
- Event-driven architecture
- Lightweight pub/sub patterns
- Mobile app push notifications
- Distributed system coordination
- Real-time data synchronization

## When NOT to Use

Avoid for guaranteed message delivery, complex routing, or when durable queues are required.

**Anti-patterns**:
- Guaranteed message persistence (use RabbitMQ/Kafka)
- Complex message routing logic
- Long-term message storage
- Ordered message delivery requirements
- High-throughput transactional workflows

## Technology Stack

- **Broker**: Eclipse Mosquitto (or EMQX, HiveMQ)
- **Protocol**: MQTT 3.1.1 / 5.0
- **Transport**: TCP, WebSocket
- **QoS Levels**: 0 (at most once), 1 (at least once), 2 (exactly once)

## Integration Points

- **Web Clients**: WebSocket MQTT for browser connections
- **Mobile Apps**: Native MQTT clients for real-time updates
- **APIs**: Publish events from backend services
- **Workers**: Subscribe to topics for event processing

## Configuration

MQTT broker configuration includes:
- Port settings (TCP 1883, WebSocket 9001)
- Authentication and ACLs
- Topic permissions
- Message retention policies
- Connection limits and throttling

