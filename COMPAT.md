# Compatibility

Overlay releases are named for **this repo**, but they are **tested against a Codex Desktop version**. Use the GitHub release whose title matches `ChatGPT.app` → `CFBundleShortVersionString`.

| Overlay | Desktop | Desktop build | cursor-api-proxy | Notes |
| --- | --- | --- | --- | --- |
| 0.1.0 | 26.908.70816 | 9275 | 1.4.0 | Thought (`reasoning`); Read/Ran via `exec_command`; Mixin `*-cursor` catalog |

Check locally:

```bash
node scripts/desktop-version.mjs
plutil -extract CFBundleShortVersionString raw -- /Applications/ChatGPT.app/Contents/Info.plist
```

If Desktop is newer than the table, do not assume the SSE contract still maps to Thought / Read / Ran.
