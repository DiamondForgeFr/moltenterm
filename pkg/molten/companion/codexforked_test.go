// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// #1967: the rollout of a Codex sub-agent, in the shape codex-cli 0.166 writes it for a gpt-6 sub-agent forked from its
// session. It starts with a copy of the parent's history (the parent's header, a compacted record, its turns' contexts
// and events: the parent's model), then the sub-agent's own settings and turn, whose turn_context is written once, when
// the turn starts. Its commands run in code mode: no function_call carries a workdir, each command ends as an
// item_completed CommandExecution whose cwd is a file:// URL. The sub-agent works a long while in one turn, so what
// names its model and folder lies far from the end of the file.

const (
	forkedSubId = "01a1ae11-2761-7da1-aff1-69d48d942acb"
	// More than any tail the readers used to take (64 KB for Integration's listing, 512 KB for the companion's).
	forkedOutputBytes   = 40 * 1024
	forkedOutputRecords = 24
)

func fileURL(path string) string {
	return (&url.URL{Scheme: "file", Path: path}).String()
}

func codexCommandExecution(at time.Time, id string, cwd string, output string) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":"item_completed","thread_id":%q,"turn_id":"t","item":{"type":"CommandExecution","id":%q,"process_id":"4242","command":["/bin/zsh","-lc","go test ./pkg/..."],"cwd":%q,"parsed_cmd":[],"source":"unified_exec_startup","status":"completed","exit_code":0,"aggregated_output":%q,"duration":{"secs":0,"nanos":8125}}}}`,
		codexStamp(at), forkedSubId, id, cwd, output)
}

// The code-mode call that ran the command: its folder is inside the script, which nothing reads.
func codexCodeModeCall(at time.Time, callId string, workdir string) string {
	script := fmt.Sprintf(`text(await tools.exec_command({cmd:"go test ./pkg/...","workdir":%q}));`, workdir)
	return fmt.Sprintf(`{"timestamp":%q,"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":%q,"call_id":%q}}`,
		codexStamp(at), script, callId)
}

func codexCompacted(at time.Time, size int) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"compacted","payload":{"message":%q}}`, codexStamp(at), strings.Repeat("h", size))
}

type forkedFixture struct {
	root   string
	repo   string
	tree   string
	parent string
	sub    string
	start  time.Time
	lines  []string
}

// The sub-agent's rollout up to its first command: the parent's copied history, then its own settings and turn.
func forkedHead(f forkedFixture, withOwnTurnContext bool) []string {
	at := f.start.Add(time.Minute)
	lines := []string{
		codexSubMeta(forkedSubId, codexSubParent, 1, "/root/fix_1964_vars", "Meitner", "sf-fix", f.repo, at),
		codexMeta(codexSubParent, f.repo, f.start, ""),
		codexCompacted(at, 150*1024),
		codexSubTurnContext(f.repo, "gpt-6-astra", "high"),
		codexTurnEvent(at, "task_complete"),
		codexTurnEvent(at, "task_started"),
		codexSubTurnContext(f.repo, "gpt-6-astra", "high"),
		codexTurnEvent(at, "turn_aborted"),
		codexThreadSettingsLine(forkedSubId, "gpt-6.1-sol", "medium"),
		codexTurnEvent(at, "task_started"),
	}
	if withOwnTurnContext {
		lines = append(lines, codexSubTurnContext(f.repo, "gpt-6.1-sol", "medium"))
	}
	return lines
}

func forkedOutput(f forkedFixture, from int) []string {
	var lines []string
	at := f.start.Add(2 * time.Minute)
	for i := from; i < from+forkedOutputRecords; i++ {
		lines = append(lines,
			codexCodeModeCall(at, fmt.Sprintf("call-%d", i), f.tree),
			codexCommandExecution(at, fmt.Sprintf("exec-%d", i), fileURL(f.tree), strings.Repeat("o", forkedOutputBytes)))
	}
	return lines
}

// makeForkedFixture: a session on develop in repo, and its sub-agent working in tree, a worktree on fix/1964-… whose
// path holds a space, with the settings and the commands far apart.
func makeForkedFixture(t *testing.T) forkedFixture {
	t.Helper()
	f := forkedFixture{root: t.TempDir(), repo: t.TempDir(), start: time.Now().Add(-10 * time.Minute)}
	makeRepo(t, f.repo, "develop")
	f.tree = filepath.Join(t.TempDir(), "my trees", "mt-1964")
	makeWorktree(t, f.repo, f.tree, "fix/1964-variable-rpc-boundaries")
	f.parent = codexRolloutPath(f.root, f.start, codexSubParent)
	writeCodexLines(t, f.parent, codexMeta(codexSubParent, f.repo, f.start, ""), codexTurnEvent(f.start, "task_started"))
	f.sub = codexRolloutPath(f.root, f.start.Add(time.Minute), forkedSubId)
	f.lines = append(forkedHead(f, true), forkedOutput(f, 0)...)
	writeCodexLines(t, f.sub, f.lines...)
	return f
}

func appendCodexLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.WriteString(strings.Join(lines, "\n") + "\n"); err != nil {
		t.Fatal(err)
	}
}

func onlySubagent(t *testing.T, a *CodexAdapter, parent string) SubagentIdentity {
	t.Helper()
	ids := ApplyHookSubagents(a.ListSubagents(parent), nil, time.Now())
	if len(ids) != 1 {
		t.Fatalf("one sub-agent listed: %+v", ids)
	}
	return ids[0]
}

func checkForkedSubagent(t *testing.T, what string, got SubagentIdentity, f forkedFixture, model string, effort string) {
	t.Helper()
	if got.Description != "fix 1964 vars" || got.Kind != "sf-fix" || got.AgentId != forkedSubId {
		t.Errorf("%s: its task and kind: %+v", what, got)
	}
	if got.Model != model || got.Effort != effort {
		t.Errorf("%s: its own model and effort, never its parent's gpt-6-astra: %q %q, want %q %q", what, got.Model, got.Effort, model, effort)
	}
	if got.Worktree != f.tree {
		t.Errorf("%s: it works in the worktree its commands ran in: %q, want %q", what, got.Worktree, f.tree)
	}
}

func TestCodexForkedSubagentKeepsItsOwnSettingsAndFolder(t *testing.T) {
	f := makeForkedFixture(t)
	a := MakeCodexAdapter([]string{f.root})
	got := onlySubagent(t, a, f.parent)
	checkForkedSubagent(t, "Integration's listing", got, f, "gpt-6.1-sol", "medium")
	if got.Finished || got.State != SubagentRunning {
		t.Errorf("a sub-agent in the middle of its turn runs: %+v", got)
	}

	facts, ok := a.ReadSubagent(f.parent, forkedSubId)
	if !ok || facts.Model != "gpt-6.1-sol" || facts.Effort != "medium" || facts.Worktree != f.tree || facts.Branch != "fix/1964-variable-rpc-boundaries" || facts.Ended {
		t.Errorf("the companion's read of it: %+v %v", facts, ok)
	}

	// A refresh and a reconnect read the same: the same adapter again, a new one after a restart.
	checkForkedSubagent(t, "a second read", onlySubagent(t, a, f.parent), f, "gpt-6.1-sol", "medium")
	checkForkedSubagent(t, "a new adapter", onlySubagent(t, MakeCodexAdapter([]string{f.root}), f.parent), f, "gpt-6.1-sol", "medium")
}

func TestCodexForkedSubagentFollowsItsRolloutAsItGrows(t *testing.T) {
	f := makeForkedFixture(t)
	a := MakeCodexAdapter([]string{f.root})
	checkForkedSubagent(t, "first read", onlySubagent(t, a, f.parent), f, "gpt-6.1-sol", "medium")

	// More output, no new settings: nothing changes, however far the settings are now.
	appendCodexLines(t, f.sub, forkedOutput(f, forkedOutputRecords)...)
	checkForkedSubagent(t, "after more output", onlySubagent(t, a, f.parent), f, "gpt-6.1-sol", "medium")

	// A record still being written is read once it is complete.
	file, err := os.OpenFile(f.sub, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	done := codexTurnEvent(time.Now(), "task_complete")
	if _, err := file.WriteString(done[:len(done)/2]); err != nil {
		t.Fatal(err)
	}
	if got := onlySubagent(t, a, f.parent); got.Finished {
		t.Errorf("half a record ends nothing: %+v", got)
	}
	if _, err := file.WriteString(done[len(done)/2:] + "\n"); err != nil {
		t.Fatal(err)
	}
	if got := onlySubagent(t, a, f.parent); !got.Finished || got.State != SubagentDone {
		t.Errorf("its turn ended: %+v", got)
	}

	// Its parent sends it back to work, with another effort, in another worktree.
	other := filepath.Join(t.TempDir(), "mt-1965")
	makeWorktree(t, f.repo, other, "fix/1965-route-unannounce-ownership")
	at := time.Now()
	appendCodexLines(t, f.sub,
		codexTurnEvent(at, "task_started"),
		codexSubTurnContext(f.repo, "gpt-6.1-sol", "high"),
		codexCommandExecution(at, "exec-resumed", other, "ok"),
	)
	got := onlySubagent(t, a, f.parent)
	if got.Finished || got.Effort != "high" || got.Worktree != other || got.Model != "gpt-6.1-sol" {
		t.Errorf("resumed: %+v", got)
	}
}

// The first moments of a sub-agent: its rollout is the parent's history and its own settings, before its first turn
// writes a context. Its model is its own, never the copied parent's.
func TestCodexForkedSubagentJustStartedHasItsOwnModel(t *testing.T) {
	f := makeForkedFixture(t)
	writeCodexLines(t, f.sub, forkedHead(f, false)...)
	got := onlySubagent(t, MakeCodexAdapter([]string{f.root}), f.parent)
	if got.Model != "gpt-6.1-sol" || got.Effort != "medium" || got.Finished {
		t.Errorf("just started: %+v", got)
	}
	if got.Worktree != f.repo {
		t.Errorf("no command yet: the folder of its turn: %q", got.Worktree)
	}
}

func TestCodexCommandFolderOfCommandExecution(t *testing.T) {
	at := time.Now()
	for _, c := range []struct {
		name string
		cwd  string
		want string
	}{
		{"a file URL", "file:///private/tmp/mt1964", "/private/tmp/mt1964"},
		{"a file URL, percent-encoded", "file:///Users/me/My%20Trees/mt-1964", "/Users/me/My Trees/mt-1964"},
		{"a file URL of this computer", "file://localhost/private/tmp/mt1964", "/private/tmp/mt1964"},
		{"a file URL of another computer", "file://build-box/srv/mt1964", ""},
		{"a plain folder", "/private/tmp/mt1964", "/private/tmp/mt1964"},
		{"no folder", "", ""},
	} {
		if got := codexCommandFolder([]byte(codexCommandExecution(at, "e", c.cwd, "ok"))); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
	other := `{"timestamp":"2026-11-06T00:00:00Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","cwd":"file:///private/tmp/mt1964"}}}`
	if got := codexCommandFolder([]byte(other)); got != "" {
		t.Errorf("only a command names the folder it ran in: %q", got)
	}
}

// A session that started more sub-agents than the listing holds keeps the newest, the ones that may still be working,
// as Claude Code's listing does (most recently written first).
func TestCodexListSubagentsKeepsTheNewest(t *testing.T) {
	root, repo := t.TempDir(), t.TempDir()
	makeRepo(t, repo, "develop")
	start := time.Now().Add(-2 * time.Hour)
	parent := codexRolloutPath(root, start, codexSubParent)
	writeCodexLines(t, parent, codexMeta(codexSubParent, repo, start, ""))
	total := MaxSubagents + 3
	for i := 1; i <= total; i++ {
		at := start.Add(time.Duration(i) * time.Minute)
		id := fmt.Sprintf("01a1ae11-0000-7000-8000-%012d", i)
		writeCodexLines(t, codexRolloutPath(root, at, id),
			codexSubMeta(id, codexSubParent, 1, fmt.Sprintf("/root/task_%02d", i), "Nash", "worker", repo, at),
			codexTurnEvent(at, "task_started"),
		)
	}
	a := MakeCodexAdapter([]string{root})
	found := a.FindSubagents(parent, []string{codexSubParent}, start.UnixMilli())
	if len(found) != MaxSubagents || found[len(found)-1].Name != fmt.Sprintf("task %02d", total) {
		t.Errorf("the newest %d are found, the last is the newest: %d %+v", MaxSubagents, len(found), found[len(found)-1:])
	}
	ids := a.ListSubagents(parent)
	if len(ids) != maxIdentitySubagents {
		t.Fatalf("the listing holds %d, not %d", len(ids), maxIdentitySubagents)
	}
	names := map[string]bool{}
	for _, id := range ids {
		names[id.Description] = true
	}
	if !names[fmt.Sprintf("task %02d", total)] || names["task 01"] {
		t.Errorf("the newest sub-agent is listed, the oldest is not: %v", names)
	}
}
