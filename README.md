# pi-token-speed-status

A pi footer status extension showing token throughput:

```
⚡ TPS 24.3 tok/s 18.2 tok/s (10s)
```

- **first value** — tokens in the last ~2s (true real-time throughput)
- **(10s)** — tokens generated in the last 10s (stable average)
- color-coded with the pi-token-speed palette (red <15, orange <30, green <45, cyan ≥45 tok/s)
- turn total when a turn ends: `⚡ TPS ✓ 4321 tok / 38.2s = 113.1 tok/s (turn)`
- context compaction: `⚡ compacting…` while it runs, then `⚡ compact ✓ 1234 tok / 25.3s = 48.8 tok/s`
- the footer is never blanked — the last known values stay visible across tool pauses and session rebinds

## Install

```bash
pi install git:github.com/pjq/pi-token-speed-status
```

## Develop

```bash
pi -e ./path/to/this/repo   # run against a local checkout
```
