# Contributing

Thanks for improving pi-token-speed-status!

## Development

```bash
npm install
npm test            # vitest
npm run typecheck   # tsc --noEmit
pi -e .             # try the extension live against this checkout
```

## Guidelines

- Keep the extension a single file (`token-speed.ts`); pi loads it directly
- Pure logic (windows, formatting, palettes) stays exported and covered by tests in `test/`
- Event handlers may use the SDK's exported event types; streaming delta blocks are not in the SDK's Content union and are typed locally as `StreamBlock`
- The footer must never go blank — any new state transition must end in a `setStatus` with values or the placeholder
- Behavior changes require tests

## Releasing

Maintainers publish from the repo root: `npm publish` (account with publish rights + 2FA), then tag `v<version>`.

## License

By contributing you agree your contributions are licensed under [MIT](LICENSE).
