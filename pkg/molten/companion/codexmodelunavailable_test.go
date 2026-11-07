// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"fmt"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2076: the turn end codex-cli 0.166.0 writes when the account cannot use the session's model.
func codexModelRefused(model string) string {
	return fmt.Sprintf(`{"timestamp":"2026-11-07T16:54:47.689Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t2","last_agent_message":null,"error":{"message":"The '%s' model is not supported when using Codex with a ChatGPT account.","codex_error_info":"model_not_found"}}}`, model)
}

func codexOtherRefusal() string {
	return `{"timestamp":"2026-11-07T16:54:47.689Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t2","error":{"message":"Selected model is at capacity. Please try a different model.","codex_error_info":"server_overloaded"}}}`
}

func TestCodexModelUnavailableSettings(t *testing.T) {
	root := t.TempDir()
	path := codexRolloutPath(root, time.Now(), codexLinkThread)
	a := MakeCodexAdapter([]string{root})
	astra := molten.AgentSettings{Model: "gpt-6-astra", Effort: "high"}
	refused := molten.AgentSettings{Model: "gpt-6-astra", Effort: "high", ModelUnavailable: true}
	for _, tc := range []struct {
		what  string
		lines []string
		want  molten.AgentSettings
	}{
		{"refused for its model", []string{codexTurnContext("gpt-6-astra", "high"), codexUserMessage(time.Now(), "Go on"), codexModelRefused("gpt-6-astra")}, refused},
		{"another refusal says nothing of the model", []string{codexTurnContext("gpt-6-astra", "high"), codexOtherRefusal()}, astra},
		{"a new turn tries again", []string{codexTurnContext("gpt-6-astra", "high"), codexModelRefused("gpt-6-astra"), codexTurnContext("gpt-6-astra", "high")}, astra},
		{"a /model change is the way out", []string{codexTurnContext("gpt-6-astra", "high"), codexModelRefused("gpt-6-astra"), codexThreadSettingsLine(codexLinkThread, "gpt-6-luna", "medium")}, molten.AgentSettings{Model: "gpt-6-luna", Effort: "medium"}},
		{"a sub-agent's change is not the session's", []string{codexTurnContext("gpt-6-astra", "high"), codexModelRefused("gpt-6-astra"), codexThreadSettingsLine(codexLinkOther, "gpt-6-luna", "medium")}, refused},
	} {
		writeCodexLines(t, path, append([]string{codexMeta(codexLinkThread, "/tmp", time.Now(), "")}, tc.lines...)...)
		if got, ok := a.ReadSettings(path); !ok || got != tc.want {
			t.Errorf("%s: %+v %v, want %+v", tc.what, got, ok, tc.want)
		}
	}
}

// A follower that reads only the appended refusal keeps the model it knew, and the next turn clears the mark.
func TestCodexModelUnavailableFollowed(t *testing.T) {
	root := t.TempDir()
	path := codexRolloutPath(root, time.Now(), codexLinkThread)
	writeCodexLines(t, path, codexMeta(codexLinkThread, "/tmp", time.Now(), ""), codexTurnContext("gpt-6-astra", "high"))
	a := MakeCodexAdapter([]string{root})
	known, ok, next := a.ReadSettingsFrom(path, 0)
	if !ok || known != (molten.AgentSettings{Model: "gpt-6-astra", Effort: "high"}) {
		t.Fatalf("first read: %+v %v", known, ok)
	}
	appendFile(t, path, codexModelRefused("gpt-6-astra")+"\n")
	read, ok, next := a.ReadSettingsFrom(path, next)
	if !ok || read != (molten.AgentSettings{ModelUnavailable: true}) {
		t.Fatalf("the refusal alone: %+v %v", read, ok)
	}
	known = mergeFollowedSettings(known, read)
	if known != (molten.AgentSettings{Model: "gpt-6-astra", Effort: "high", ModelUnavailable: true}) {
		t.Fatalf("merged: %+v", known)
	}
	appendFile(t, path, codexTurnContext("gpt-6-luna", "medium")+"\n")
	read, ok, _ = a.ReadSettingsFrom(path, next)
	if known = mergeFollowedSettings(known, read); !ok || known != (molten.AgentSettings{Model: "gpt-6-luna", Effort: "medium"}) {
		t.Fatalf("next turn: %+v %v", known, ok)
	}
}

// The pane's agent state gets the mark through the process link, as Léa's did not (#2076).
func TestCodexModelUnavailableReachesThePane(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	now := time.Now()
	mine := codexRolloutPath(root, now, codexLinkThread)
	writeCodexLines(t, mine, codexMeta(codexLinkThread, cwd, now, ""), codexTurnContext("gpt-6-astra", "high"), codexUserMessage(now, "Audit"))
	m, env := makeCodexLinkManager(t, root)
	defer m.Close("a", "v")
	env.lock.Lock()
	env.runs["a"] = molten.AgentRunInfo{BlockId: "a", Agent: molten.AgentIdCodex, Started: now.Add(-time.Minute).UnixMilli(), Running: true, Pid: 101}
	env.cwds["a"] = cwd
	env.files[101] = []string{mine}
	env.lock.Unlock()
	m.Open("a", "v")
	waitSettings(t, m, env.sink, "a:codex", molten.AgentSettings{Model: "gpt-6-astra", Effort: "high"})
	appendFile(t, mine, codexModelRefused("gpt-6-astra")+"\n")
	waitSettings(t, m, env.sink, "a:codex", molten.AgentSettings{Model: "gpt-6-astra", Effort: "high", ModelUnavailable: true})
	appendFile(t, mine, codexThreadSettingsLine(codexLinkThread, "gpt-6-luna", "medium")+"\n")
	waitSettings(t, m, env.sink, "a:codex", molten.AgentSettings{Model: "gpt-6-luna", Effort: "medium"})
}
