The `molten` command talks to MoltenTerm through a local socket (`wave.sock`), which your sandbox may refuse: the
command then fails with `operation not permitted` (or `permission denied`) on `wave.sock`. MoltenTerm does not open
that socket to your sandbox, since every sandboxed command would then reach MoltenTerm. Run that same `molten`
command again with your sandbox's escalation, which asks the user: in Codex, request escalated permissions for the
command with a one-line justification and suggest a `prefix_rule` naming only that `molten` subcommand (for example
`["molten", "agent", "send"]`), which the user may keep; in Claude Code, run it outside the sandbox. Escalate only
`molten` commands this way, never turn the sandbox off for the session, and never open the network for it.
