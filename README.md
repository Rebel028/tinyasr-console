# tinyasr-console
<img width="1669" height="1003" alt="image" src="https://github.com/user-attachments/assets/57cf4cb9-77e4-4e8c-8261-f5284dee9eb5" />

A browser console for [tinyasr-server](https://github.com/Rebel028/tinyasr-server). It streams microphone or file audio to `/v2/listen` and shows the turns along with the raw event log of the websocket.

```bash
cp .env.example .env            # optional, see below
docker compose pull             # get the current server image for the tag
docker compose up -d --build
# UI:     http://localhost:8080
# server: ws://localhost:8000/v2/listen (the UI's default URL)
```

## Server image

`.env` (or the shell environment) picks the server image and options:

| Variable | Default | Meaning |
|---|---|---|
| `TINYASR_TAG` | `latest` | `latest`: every model is inside the image (about 300 MB) and no network is needed at start. `slim`: a small image that fetches the models it needs at start. |
| `TINYASR_MODEL` | `/models/en-ru-uk.tzf` | The model file. The others are `ar`, `en-es-it-pt`, `en-fa`, `en-km`, `fr-de`, `id-ms` and `uz` (`/models/<name>.tzf`). Set `TINYASR_LANGS` to match. |
| `TINYASR_LANGS` | `en,ru,uk` | Languages the server uses when the UI sends no `language_hint`, which is the UI's default. The default lists every language of the default model. The server has no "all" value, so list the languages again when you change `TINYASR_MODEL`. Each language adds a decode pass, so fewer languages are faster. |
| `TINYASR_LID` | empty | `/models/tinylid.bin` makes the server label each `EndOfTurn` with the language tinylid hears. The label shows in the turn row. This adds about 90 ms to each end of turn. |

The server image is pulled, not built. Run `docker compose pull` to pick up a new release under the same tag.

With `slim`, the models are fetched into the container and survive restarts. A recreated container fetches them again, for example after `pull` or after a change in `.env`. Compose waits up to 10 minutes for the server to turn healthy before it starts the UI.

The UI has buttons for the hints `ru`, `en` and `uk`, plus a field for other codes, comma separated (`fr, de`). By default no hint is selected, and the server uses `TINYASR_LANGS`. A hint the model does not have gets a 400, which the UI reports as a refused upgrade.

## Notes

- The browser connects to the server directly, so the server runs without `TINYASR_TOKEN`. A browser websocket cannot send an `Authorization` header.
- The mic works only in a secure context (`localhost` or HTTPS). From another machine over plain HTTP, use File mode.
- A file is decoded and resampled to 16 kHz in the browser. It streams at 1x, 2x or max pace, followed by 2 s of silence and a `CloseStream`.
- The log folds heartbeat `Update`s and outgoing audio frames into counted rows. Switch on "heartbeats" to see each `Update`. Download JSONL exports every event.
