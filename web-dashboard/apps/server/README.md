# @openludus/dashboard-server

Zero-dependency Node.js HTTP + SSE server.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Serves `public/index.html` + static assets |
| `POST` | `/api/events` | Ingest a hook event. Returns `{eventId}`. |
| `GET` | `/api/events` | Returns all stored events (max 1000). |
| `GET` | `/api/events/stream` | SSE stream of new events. |
| `GET` | `/api/decisions/:eventId` | Poll for a decision (used by `hook.sh`). |
| `POST` | `/api/decisions/:eventId` | Submit a decision from the UI. |

## State

- **In-memory only**. Last 1000 events in a circular buffer. `pendingDecisions` map holds unresolved blocking events.
- No database. Intended for single-user / single-machine deployments.
- Reboots lose history.

## Run

```bash
npm start
# or: PORT=4000 npm start
```

Default port: `3456`.
