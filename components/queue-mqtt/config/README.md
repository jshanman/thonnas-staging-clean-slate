# Mosquitto configuration

Broker config for the `queue-mqtt` component (Eclipse Mosquitto 2).

## Files

| File | Purpose |
|------|---------|
| `mosquitto.conf` | **Default dev** — anonymous MQTT (1883) and WebSocket (9001). Used by `docker-compose.yml`. |
| `mosquitto.prod.conf` | **Production template** — TLS, auth, stricter logging. Not mounted by default. |
| `acl.example` | ACL template — copy to `acl` and customize. |
| `passwd.example` | Instructions for generating `passwd` with `mosquitto_passwd`. |

## Development (default)

`docker-compose.yml` mounts this directory and Mosquitto loads `mosquitto.conf`:

- `allow_anonymous true` — no `passwd` or `acl` required
- Listeners: **1883** (MQTT), **9001** (WebSocket)

Application modules (e.g. `tm-mqtt`) define topic names in their own config; the broker does not ship app-specific ACL rules.

## Production setup

1. Copy the production config over the active config (or mount it as `mosquitto.conf`):

   ```bash
   cp config/mosquitto.prod.conf config/mosquitto.conf
   ```

2. Add TLS certificates to `config/`: `ca.crt`, `server.crt`, `server.key`.

3. Create credentials (do **not** commit generated files):

   ```bash
   cp config/acl.example config/acl
   # edit config/acl for your users and topics

   mosquitto_passwd -c config/passwd publisher
   mosquitto_passwd -b config/passwd subscriber your-secret
   ```

4. Ensure `mosquitto.prod.conf` (or your active conf) sets:

   ```conf
   allow_anonymous false
   password_file /mosquitto/config/passwd
   acl_file /mosquitto/config/acl
   ```

5. Mount `passwd` and `acl` in compose alongside certs (see example in this doc’s history or your infra layer).

## Gitignored secrets

The following are listed in `.gitignore` and must be created per environment:

- `config/passwd`
- `config/acl`
- `config/*.crt`, `config/*.key`

## Testing

```bash
# Dev (anonymous)
mosquitto_pub -h localhost -p 1883 -t myapp/test -m "hello"

# Prod (TLS + auth) — after setup
mosquitto_pub -h mqtt.example.com -p 8883 --cafile config/ca.crt \
  -u publisher -P your-secret -t myapp/test -m "hello"
```

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Connection refused | Container running, ports 1883/9001 published |
| Auth failed | `passwd` hashes generated with `mosquitto_passwd`, username in `acl` |
| TLS errors | Cert paths, permissions (`chmod 600` on `server.key`) |
| Topic denied | `acl` allows user + topic pattern |

