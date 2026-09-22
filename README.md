# pi-token-speed-status

[![CI](https://github.com/pjq/pi-token-speed-status/actions/workflows/CI/badge.svg)](https://github.com/pjq/pi-token-speed-status/actions/workflow/CI)

A [pi](https://pi.dev) footer status extension showing token throughput for any provider — built for local-model users, but useful everywhere.

```
⚡ TPS 24.3 tok/s 18.2 tok/s (10s)
```

## Features

- **Two rates** — first value is tokens in the last ~2s (true real-time); the `(10s)` value is a 10-second average that catches slowdowns a short window smooths over
- **Truecolor, tiered palette** (from pi-token-speed): red `<15` · orange `<30` · green `<45` · cyan `≥45` tok/s
- **Turn summary** — when a turn ends: `⚡ TPS ✓ 4321 tok / 38.2s = 113.1 tok/s (turn)`
- **Compaction visibility** — `⚡ compacting…` while context compaction runs, then `⚡ compact ✓ 1234 tok / 25.3s = 48.8 tok/s`
- **Never blanks** — the footer keeps the last known values across tool pauses, compaction, and session rebinds; before the first stream it shows a dim placeholder
- Counts text, thinking, and **all** tool-call argument generation (bash commands, file writes, …); uses provider-reported usage when available, falls back to chars/4

## Install

```bash
pi install npm:pi-token-speed-status        # or
pi install git:github.com/pjq/pi-token-speed-status
```

Remove with `pi remove npm:pi-token-speed-status`.

## How it works

Each streamed chunk records a token event (provider `usage` diff, or chars/4 estimate, or tool-call arg bytes) into two sliding windows (2s / 10s) with burst-flush correction: if every token arrived in one timestamped burst after a stall, the span is extended back to the previous event so the flush isn't reported as infinitely fast. The footer re-renders on a 100 ms throttle; windows pause while tools execute and reset per request so tool time never drags the average down.

## Developing

```bash
npm install
npm test          # vitest: window math, palette, event flow (mocked pi)
npm run typecheck
pi -e .           # run pi against this checkout
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome — tests are required for behavior changes.

## License

[MIT](LICENSE)
