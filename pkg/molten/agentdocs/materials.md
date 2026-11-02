# Materials: what you produce for the developer, kept per project

MoltenTerm keeps, on this computer and per project, the documents an agent produces for the developer outside the
repository and shows them: a published page, a report, a capture, a recording, a link. The developer finds them months
later in the library's Materials section, after the temporary folder they lived in was emptied. Nothing is sent
anywhere and nothing is written in the repository.

## Declare what you produce

When you make something for the developer outside the repository, declare it:

```sh
molten material add /tmp/audit/report.html --title "UI audit"
molten material add https://claude.ai/artifact/AbCd123 --title "Theme proposal"
```

- A file is copied when you declare it (a page with the files it references: images, styles, fonts), up to 25 MB.
- An address is kept as a link; its sensitive parameters (token, signature, key) are dropped.
- Declare the finished document, not every draft: what you name is what the developer will find.
- Never declared or copied: code and files tracked by git, `.env*`, json, yaml, toml, archives, keys and credentials
  (`~/.ssh`, `~/.aws`, `*.pem`, `*.key`...), the agents' own configuration. A text that holds a secret is not copied.

Some agents are read without declaring: MoltenTerm sees Claude Code's publications, and the addresses and file paths
Claude Code and Codex name in their answers. Declaring is always safe: a material declared twice is kept once.

## List them

```sh
molten material list          # one per line: id, title, kind, form, size, origin, date
molten material list --json   # the same, as JSON
```

The list is the materials of the project of the terminal you run in (a worktree belongs to its main repository).
Renaming, pinning and deleting are the developer's, in the library.
