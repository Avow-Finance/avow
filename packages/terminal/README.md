# @avow-finance/terminal

How Avow's command-line tools draw in a terminal. `create-avow-agent` and the SDK's `avow-sandbox` both use it, so one setup reads as one flow across the two commands.

> **Status:** pre-release and testnet only. It has no dependencies, and it travels inside the starter's tarballs.

| Part | What it does |
| --- | --- |
| `banner` | Avow's mark and wordmark in block characters, traced from the logo so its squares land on whole cells, with the testnet line under it. A terminal too narrow for it gets the word alone |
| `Rail` | Steps drawn down one line at the left. It opens on a title, each stage starts on it, what's done is ticked, a question waits on it, and it closes on the outcome. A spinner turns beside a step that takes time. A rail another process opened carries on without opening again |
| `setApart` | Lines behind a bar in the brand's violet, the first in bold, for the one moment a run is about |
| `lookOf` | What a stream can show. `NO_COLOR` turns colour off, `FORCE_COLOR` turns it on at a level, and otherwise a terminal gets colour and a pipe or a file gets plain text |
