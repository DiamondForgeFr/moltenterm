# Privacy

MoltenTerm sends no usage data and has no account. It connects to the network only for what you ask: links you open,
GitHub for a project you link to Mission Control, the release feed, and, only if you turn it on, Anthropic's usage
endpoint (see "Optional: Claude Code plan usage" below).

MoltenTerm ships no AI and does not read your agents' credentials, apart from that one optional reading. The coding
agents you run in it (Claude Code, Codex, Gemini CLI or any other) connect to their own services under their own terms,
exactly as in any other terminal.

## Optional: Claude Code plan usage

This is off by default. When you turn on "Claude Code limits (experimental)" (the plan usage section of the companion
asks you to confirm, and says where the token is read from; the same switch is in Settings › Advanced), MoltenTerm
reads the sign-in token that Claude Code already keeps on this computer, in the system keychain or in the
`.credentials.json` file of Claude Code's configuration folder. It uses it for one thing: asking Anthropic's usage
endpoint (`https://api.anthropic.com/api/oauth/usage`) for the limits of your subscription, so the companion can show
them.

- The token goes to that address only, over HTTPS, in the request itself. MoltenTerm sends nothing else about you.
- It keeps the token in memory for the length of one request. It never writes, refreshes or copies it, and never logs,
  displays or sends it anywhere else.
- It reads the token again for each request: at most every 5 minutes, or once a minute when you press Refresh.
- Turning the switch off stops the readings at once.
- The endpoint is not documented by Anthropic, so it may change or stop working.

The other plan usage readings use no credential of yours: Claude Code's status line data, handed over by Claude Code
itself, and Codex's own session files and `codex` program, which uses its own sign-in.

The browser panel is Chromium. It loads the pages you or your agents open, and those sites see what they would see in
any browser. It does not block ads or trackers yet: that is planned
([#426](https://github.com/DiamondForgeFr/moltenterm/issues/426)) and not part of 1.0.0.
