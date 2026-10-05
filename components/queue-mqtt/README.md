# queue-mqtt Component

MQTT message broker for Thonnas applications (Eclipse Mosquitto 2). This component provides a Docker Compose managed pub/sub broker with MQTT and WebSocket ports, exported connection settings, and dev-friendly anonymous access.

**Component Key:** queue-mqtt  
**Component Type:** queue  
**Classification:** open-source

## Features

- Eclipse Mosquitto 2 (`eclipse-mosquitto:2`) on the shared `thonnas-network`
- MQTT (`1883`) and WebSocket (`9001`) endpoints
- Dev broker config with optional production TLS/auth templates
- Exported internal and external host/port configuration for consumers
- Health checks for compose orchestration

## Install

Use this component from the workspace root through the Thonnas CLI:

```bash
thonnas component build components/queue-mqtt --yes --ai-provider inline
```

Ensure `@thonnas/infra-docker` is installed so the compose network and shared infrastructure resolve correctly.

## Usage

Start the broker as part of the project compose stack:

```bash
docker compose up queue-mqtt
```

MQTT clients connect on `QUEUE_MQTT_HOST_PORT` when set, defaulting to `1883`. WebSocket clients use `QUEUE_MQTT_WS_HOST_PORT`, defaulting to `9001`.

Downstream components use exported connection settings from `thonnas-config.json`:

- `QUEUE_MQTT_INTERNAL_HOST` / `QUEUE_MQTT_INTERNAL_PORT` — in-cluster MQTT
- `QUEUE_MQTT_EXTERNAL_HOST` / `QUEUE_MQTT_EXTERNAL_PORT` — external native clients
- `QUEUE_MQTT_EXTERNAL_WS_PORT` — browser WebSocket (often behind reverse proxy)

Topic layout and client credentials are owned by consuming apps and modules, not this component.

## Configuration

- `config/mosquitto.conf` — active dev broker config
- `config/mosquitto.prod.conf` — production template
- `thonnas-config.json` / `thonnas-infra.json` — Thonnas wiring and ports

See [config/README.md](config/README.md) for production TLS/auth and `acl.example` / `passwd.example`.

## Implements Strategies

- `comms.queue.pub-sub.mqtt`
- `comms.events.pub-sub`
- `comms.duplex.bidirectional`
- `client-message-push`
- `client-message-two-way`

## Docker Service

Service name: `queue-mqtt`  
Image: `eclipse-mosquitto:2`

| Port | Protocol |
|------|----------|
| `1883` | MQTT |
| `9001` | WebSocket |

## Testing

Build and pack the component from the workspace root:

```bash
thonnas component build components/queue-mqtt --yes --ai-provider inline
thonnas component pack components/queue-mqtt --yes
```

For runtime validation, start the broker and confirm the service is healthy:

```bash
docker compose up queue-mqtt
docker compose ps queue-mqtt
```

MQTT listens on port `1883` and WebSocket on `9001` by default.

