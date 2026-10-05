# API-Go: Requirements Review Checklist

Review the feature.md for Go API and real-time feature considerations.

## WebSocket Requirements (CRITICAL)

- [ ] Real-time requirements clearly specified
- [ ] Connection lifecycle documented (connect, disconnect, reconnect)
- [ ] Message types and formats defined
- [ ] Concurrent connection estimates provided

**Flag as CRITICAL if:**
- Real-time features lack WebSocket specifications
- No connection scaling requirements for high-load features

## Concurrency & Performance (CRITICAL)

- [ ] Goroutine usage patterns considered
- [ ] Connection pool requirements specified
- [ ] Performance targets defined (latency, throughput)

**Flag as CRITICAL if:**
- High-concurrency features lack performance requirements
- No throughput targets for batch operations

## Channel/Room Architecture (IMPORTANT)

- [ ] Room/channel structure defined for collaborative features
- [ ] Broadcast vs unicast requirements clear
- [ ] User presence requirements documented

**Flag as IMPORTANT if:**
- Multi-user features lack room architecture
- Presence requirements not specified

## MQTT Integration (IMPORTANT)

- [ ] Topic hierarchy defined for pub/sub features
- [ ] QoS level requirements specified
- [ ] Last Will Testament needs documented

**Flag as IMPORTANT if:**
- Real-time updates lack topic design
- QoS not specified for reliable delivery needs

## Memory Management (IMPORTANT)

- [ ] Buffer size requirements considered
- [ ] Connection cleanup requirements documented
- [ ] Memory limits for high-volume features

**Flag as IMPORTANT if:**
- Long-running connections lack cleanup requirements
- Large payload features lack memory considerations

## Error Recovery (NICE-TO-HAVE)

- [ ] Reconnection strategies documented
- [ ] Graceful degradation considered
- [ ] Circuit breaker patterns identified

**Flag as NICE-TO-HAVE if:**
- Resilience patterns could be better specified

