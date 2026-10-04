# Worktrees: tell MoltenTerm which worktree a terminal works in

When several tasks run in parallel in one workspace, an agent may give its task a git worktree so the tasks do not
collide. MoltenTerm shows, in the header of every terminal, the tree its folder is in:

- **main tree**: the repository's own checkout (no worktree);
- **the worktree's name and branch**, with a colour of its own: two terminals in the same worktree show the same
  marker;
- **missing worktree**: the terminal was linked to a worktree that was removed outside MoltenTerm.

The status bar shows the same for the focused pane, and the tab's tooltip lists the trees of its terminals.

Worktrees stay optional. MoltenTerm never creates one, never asks for one, and a terminal that stays in the main tree
gets no offer.

## Linking a worktree to its terminal

A terminal **linked** to a worktree owns it: when the terminal closes, MoltenTerm offers to remove the worktree.
When a terminal's folder enters a worktree it is not linked to, its header offers the link (Link / Not now). An agent
that created the worktree for its task links it itself, without a prompt:

```
git worktree add ../myproject-feature-42 -b feature/42-thing
cd ../myproject-feature-42
molten worktree link
```

```
molten worktree link [folder]   # the worktree holding the folder (default: the terminal's folder)
molten worktree show            # the terminal's link and the tree of its folder
molten worktree unlink          # forget the link; the worktree is not touched
```

- The command links the terminal it runs in. Run it from the agent's own terminal (agents run their tools there).
- `link` accepts only a linked worktree: the main checkout, a submodule or a folder outside git are refused.
- `--json` prints the result as JSON.
- Outside MoltenTerm `molten` is not there: test `WAVETERM_BLOCKID` first
  (`[ -n "$WAVETERM_BLOCKID" ] && molten worktree link`).
- The link survives `cd`: the terminal still owns its worktree when the agent goes back to the main tree.

## Closing the terminal

Closing a terminal linked to a worktree shows the plan first: the path, the branch, the uncommitted changes, the
commits no remote has, whether the branch is merged into the trunk, the ignored files that would go with it, and the
other open terminals using the worktree. Then: **Remove**, **Keep** or **Cancel**.

- Keep is the default when another terminal uses the worktree.
- Uncommitted changes or unpushed commits need a second, explicit confirmation; only then is git forced.
- The branch is kept unless the user asks to delete it, and it is deleted only when its content is on the trunk.
- Nothing of this can be triggered from a terminal: only the user, in a MoltenTerm window, removes a worktree. An
  agent that wants its worktree gone removes it with git itself.

A worktree removed outside MoltenTerm (`git worktree remove`, the folder deleted) shows as **missing worktree** in the
header; closing the terminal then asks nothing.
