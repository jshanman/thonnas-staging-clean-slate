# Strategy Implementation: comms.duplex.websocket

**Component/Module:** api-go  
**Strategy:** `comms.duplex.websocket`  
**Category:** comms.duplex  
**Purpose:** Bidirectional WebSocket

---

## Implementation Approach

### Overview

api-go supports full-duplex WebSocket communication through installable packages. The standalone component shell does not ship an inline websocket module; installers provide connection pools, read/write pumps, heartbeat monitoring, and graceful cleanup.

### Technology Stack

- **WebSocket:** `github.com/gorilla/websocket` - Gorilla WebSocket with permessage-deflate compression
- **Concurrency:** Go goroutines for read/write pumps (one pair per connection)
- **Heartbeat:** Ping/pong every 30s with 10s timeout for dead connection detection
- **Broadcast:** Pub/sub transport for cross-instance message distribution

### Key Components

- **Connection pool** - Thread-safe map tracking active connections
- **Read pump** - Goroutine reading messages from client, handles pong responses
- **Write pump** - Goroutine writing messages to client, handles ping/timeouts
- **Device tracking** - Per-user device map enabling multi-device connection management

---

## Code Patterns

### Basic Usage

```go
go func() {
    defer conn.Close()
    for {
        messageType, message, err := conn.ReadMessage()
        if err != nil {
            break
        }
        handleMessage(userID, messageType, message)
    }
}()
```

---

## Configuration

### Required Settings

- `WS_PING_INTERVAL` - Heartbeat ping interval (default: 30s)
- `WS_PONG_TIMEOUT` - Pong response timeout (default: 10s)
- `WS_MAX_MESSAGE_SIZE` - Maximum message size (default: 8192 bytes)
- `WS_WRITE_DEADLINE` - Write operation timeout (default: 10s)

---

## Best Practices

- Separate read/write goroutines to avoid deadlocks.
- Use heartbeat monitoring to detect dead connections.
- Use non-blocking writes so slow clients do not block broadcasts.
- Enforce message size limits to prevent memory exhaustion.

---

## Related Strategies

- [`auth.jwt`](api-go--auth.jwt.md) - WebSocket authentication
- Pub/sub transport strategies - Cross-instance message distribution

