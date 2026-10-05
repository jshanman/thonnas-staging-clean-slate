# Queue-MQTT: Requirements Review Checklist

Review the feature.md for MQTT messaging considerations.

## Topic Design (CRITICAL)

- [ ] Topic hierarchy documented ({domain}/{entity}/{action})
- [ ] Topic naming conventions followed
- [ ] Wildcard subscription needs identified
- [ ] Topic access control requirements

**Flag as CRITICAL if:**
- Pub/sub features lack topic design
- Topic hierarchy not defined

## QoS Requirements (CRITICAL)

- [ ] QoS level specified for each message type
- [ ] At-most-once (0) vs at-least-once (1) vs exactly-once (2) justified
- [ ] Message persistence requirements documented
- [ ] Delivery guarantees clearly stated

**Flag as CRITICAL if:**
- Reliable delivery needs lack QoS specification
- No delivery guarantee defined

## Connection Management (IMPORTANT)

- [ ] Reconnection strategy documented
- [ ] Last Will Testament requirements specified
- [ ] Keep-alive interval requirements
- [ ] Clean session vs persistent session decision

**Flag as IMPORTANT if:**
- Real-time features lack reconnection strategy
- No LWT for presence tracking

## Message Format (IMPORTANT)

- [ ] Message payload format specified (JSON, binary, etc.)
- [ ] Message size limits considered
- [ ] Schema versioning strategy documented
- [ ] Compression requirements

**Flag as IMPORTANT if:**
- Messages lack format specification
- Large messages not addressed

## Scalability (IMPORTANT)

- [ ] Expected message volume documented
- [ ] Subscriber scaling strategy
- [ ] Broker clustering requirements
- [ ] Rate limiting needs

**Flag as IMPORTANT if:**
- High-volume features lack scaling plan
- No rate limiting consideration

## Monitoring (NICE-TO-HAVE)

- [ ] Message throughput metrics
- [ ] Connection monitoring requirements
- [ ] Dead letter handling

**Flag as NICE-TO-HAVE if:**
- Monitoring could be specified

