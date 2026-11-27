# Publishing your plan: the companion shows the steps of your work

The agent companion next to your terminal shows what you are doing as "Plan of <first name>", under you and your
sub-agents: how many steps are done, the step you are on and the steps to come. Some agents keep a native task list
that the companion reads. Others do not, so the developer sees nothing of your plan. When you keep no task list of
your own, publish your plan with the command below. It works the same for every agent CLI.

## The command

```sh
molten agent plan set "<step>" "<step>" ...    # replace the plan, all steps to do
molten agent plan start <n>                    # step n (1 is the first) is the current one
molten agent plan done <n>                     # step n is done
molten agent plan add "<step>"                 # append a step to do
molten agent plan clear                        # empty the plan
molten agent plan show [--json]                # print the plan
```

- Steps are short: one line each, a few words the developer reads at a glance, in the language of the project.
- Keep one step current. `start` makes a step the current one and sets the previous current step back to do.
- Update the plan as you go: `done` when a step is finished, `start` on the next one, `add` when the work grows.
- `show --json` prints the plan as JSON: `steps` (each with `text`, `status` as `pending`, `in_progress` or `completed`,
  and the unix milliseconds of `startedat` and `doneat`) and `updatedat`.
- Output is English; the command prints what it changed, so you can check it.

## Where the plan lives

The plan belongs to the agent session of the terminal you run the command in. It shows in that terminal's companion.
A new session (after `/clear`, or another run of the agent) starts with an empty plan. Run the command from your own
terminal: outside a MoltenTerm terminal it fails. It sends nothing over the network and never changes your files.

## When the agent keeps its own task list

Claude Code (`TodoWrite`, or `TaskCreate` / `TaskUpdate`), Codex (`update_plan`) and Kimi Code (`TodoList`) keep a
task list the companion reads. When both a native list and a published plan exist, the companion shows the one updated
last. You may still publish a plan with this command; keep it in step with your native list if you use both.

Check that you really have a task tool before you count on it. Recent Claude Code versions give the task tools only to
some models, and a sub-agent may run without them: when none is in your tool list, publish your plan with this command.
After a context compaction or summary, set your list again at once (re-load your task tool first if it is deferred).
