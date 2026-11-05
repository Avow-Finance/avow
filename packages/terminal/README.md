# @avow-finance/terminal

How Avow's command-line tools draw in a terminal. `create-avow-agent` and the SDK's `avow-sandbox` both use it, so one setup reads as one flow across the two commands.

> **Status:** pre-release and testnet only. It has no dependencies, and it travels inside the starter's tarballs.

| Part | What it does |
| --- | --- |
| `banner` | Avow's mark and wordmark in block characters, traced from the logo so its squares land on whole cells, with the testnet line under it. A terminal too narrow for it gets the word alone |
| `Rail` | Steps drawn down one line at the left. It opens on a title, each stage starts on it, what's done is ticked, a question waits on it, and it closes on the outcome. A spinner turns beside a step that takes time. A rail another process opened carries on without opening again |
| Agent lines | A job run's three kinds of line, kept apart. `said` and `speak` draw a model's or an agent's own words in its name, `speak` as they stream in. `call` and `returned` draw a tool call and what it gave back. `fact` draws what code outside the model verified, with who verified it (your service.ts, Avow's API, or the customer's own statement), the block it was read at and the chain reference, and refuses evidence that lacks any of them. `receipt` draws a commitment with the states it has reached, where they were read and where to check it, `table` draws recorded results, such as the offers a model compared, with the chosen row marked and the limits under it, and `you` and `quiet` draw the developer's line and quieter notes |
| `setApart` | Lines behind a bar in the brand's violet, the first in bold, for the one moment a run is about |
| `lookOf` | What a stream can show. `NO_COLOR` turns colour off, `FORCE_COLOR` turns it on at a level, and otherwise a terminal gets colour and a pipe or a file gets plain text |
