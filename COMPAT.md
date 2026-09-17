# Compatibility

Overlay releases are named for **this repo**, but they are **tested against a Codex Desktop version**. Use the GitHub release whose title matches `ChatGPT.app` → `CFBundleShortVersionString`.

| Overlay | Desktop | Desktop build | cursor-api-proxy | Notes |
| --- | --- | --- | --- | --- |
| 26.908.70816-3 | 26.908.70816 | 9275 | 1.4.0 | Do not compact-replay a previous assistant essay when the user says дальше |

Check locally:

```bash
node scripts/desktop-version.mjs
plutil -extract CFBundleShortVersionString raw -- /Applications/ChatGPT.app/Contents/Info.plist
```

If Desktop is newer than the table, do not assume the SSE contract still maps to Thought / Read / Ran.
