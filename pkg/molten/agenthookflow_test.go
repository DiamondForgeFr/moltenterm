// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// useTestHookBackups keeps the backups of a hook mutation in the test's data folder, one file per backup.
func useTestHookBackups(t *testing.T, env AgentEnv) {
	t.Helper()
	old := agentHookBackup
	count := 0
	agentHookBackup = func(path string, data []byte, _ os.FileMode) (string, error) {
		dir := filepath.Join(env.DataDir, "test-backups")
		if err := os.MkdirAll(dir, 0700); err != nil {
			return "", err
		}
		count++
		backup := filepath.Join(dir, fmt.Sprintf("backup-%d-%d", count, len(data)))
		return backup, os.WriteFile(backup, data, 0600)
	}
	t.Cleanup(func() { agentHookBackup = old })
}

// A setting of the developer's own, in each hook file language; a provider in a new language adds its line here.
var foreignHookSettings = map[string]struct{ content, marker string }{
	"json": {`{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"afplay done.wav"}]}]}}` + "\n", "afplay done.wav"},
	"toml": {"model = \"k3\"\n", `model = "k3"`},
}

func flowRequest(agent string, offer AgentHookOffer, action string) AgentHookMutationRequest {
	return AgentHookMutationRequest{BlockId: "block-" + agent, Agent: agent, Action: action, UpdateKey: offer.UpdateKey, ExpectedDigest: offer.ConfigDigest, ConfirmUnqualified: offer.Unqualified}
}

func readHookFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func assertCurrentHooks(t *testing.T, agent string, content string) {
	t.Helper()
	for _, entry := range AgentStateHooks(agent) {
		if !strings.Contains(content, entry.Event) || !strings.Contains(strings.ReplaceAll(content, `\"`, `"`), entry.Command) {
			t.Fatalf("%s %s hook missing from %q", agent, entry.Event, content)
		}
	}
	if strings.Contains(content, "molten agent state") {
		t.Fatalf("an older MoltenTerm hook is left: %q", content)
	}
}

// #2595: every provider of agentHookSetups gets the same flow: apply after a backup, the diff of an older or edited
// set, a refusal once the file changed since the offer, and a removal that keeps the developer's own settings. A
// provider added later without an adapter that does all of it fails here.
func TestEveryHookProviderGetsTheSameFlow(t *testing.T) {
	agents := make([]string, 0, len(agentHookSetups))
	for agent := range agentHookSetups {
		agents = append(agents, agent)
	}
	slices.Sort(agents)
	for _, agent := range agents {
		t.Run(agent, func(t *testing.T) {
			setup := agentHookSetups[agent]
			if setup.adapter == nil || setup.snippet == "" || setup.file == nil || len(AgentStateHooks(agent)) == 0 {
				t.Fatalf("%s has no complete hook setup: %+v", agent, setup)
			}
			foreign, ok := foreignHookSettings[setup.language]
			if !ok {
				t.Fatalf("no fixture for hook files in %q: add one to foreignHookSettings", setup.language)
			}
			env := hookTestEnv(t)
			useTestHookBackups(t, env)
			path := setup.file(env)
			writeTestFile(t, path, foreign.content)

			offer := MakeAgentHookOffer(env, agent, "", false)
			if !offer.Show || !offer.Persistent || !offer.CanApply || offer.Action != HookActionInstall || offer.Status != HookStatusAbsent || offer.File == "" || offer.ConfigDigest == "" || offer.UpdateKey == "" {
				t.Fatalf("setup offer: %+v", offer)
			}
			installed, err := ApplyAgentHookMutation(env, flowRequest(agent, offer, offer.Action), false, AgentHookDetection{})
			if err != nil {
				t.Fatalf("apply: %v", err)
			}
			if installed.BackupPath == "" || readHookFile(t, installed.BackupPath) != foreign.content {
				t.Fatalf("no backup of the file before the change: %+v", installed)
			}
			content := readHookFile(t, path)
			if !strings.Contains(content, foreign.marker) {
				t.Fatalf("the developer's own setting is gone: %q", content)
			}
			assertCurrentHooks(t, agent, content)
			if installed.Offer.CanApply || !installed.Offer.CanRemove || installed.Offer.Status != HookStatusNotReporting {
				t.Fatalf("after apply: %+v", installed.Offer)
			}

			// Refused on a file changed since the offer, whichever way the change goes.
			before := MakeAgentHookOffer(env, agent, "", false)
			writeTestFile(t, path, content+"\n")
			if _, err := RemoveAgentHookMutation(env, flowRequest(agent, before, HookActionRemove), false, AgentHookDetection{}); err == nil {
				t.Fatal("a removal approved on an older file was accepted")
			}
			if readHookFile(t, path) != content+"\n" {
				t.Fatal("a refused removal changed the file")
			}

			// Older MoltenTerm hooks: the diff, then the update replaces them.
			writeTestFile(t, path, strings.ReplaceAll(content, "molten agent hook", "molten agent state done"))
			older := MakeAgentHookOffer(env, agent, "", false)
			if !older.Show || !older.CanApply || len(older.Changes) == 0 || older.UpdateKind == "" {
				t.Fatalf("older hooks offer no diff to apply: %+v", older)
			}
			updated, err := ApplyAgentHookMutation(env, flowRequest(agent, older, older.Action), false, AgentHookDetection{})
			if err != nil {
				t.Fatalf("update: %v", err)
			}
			if updated.BackupPath == "" {
				t.Fatal("the update made no backup")
			}
			content = readHookFile(t, path)
			assertCurrentHooks(t, agent, content)
			if !strings.Contains(content, foreign.marker) {
				t.Fatalf("the update lost the developer's setting: %q", content)
			}

			current := MakeAgentHookOffer(env, agent, "", false)
			removed, err := RemoveAgentHookMutation(env, flowRequest(agent, current, HookActionRemove), false, AgentHookDetection{})
			if err != nil {
				t.Fatalf("remove: %v", err)
			}
			content = readHookFile(t, path)
			if removed.BackupPath == "" || strings.Contains(content, "molten agent") || !strings.Contains(content, foreign.marker) {
				t.Fatalf("removal: backup %q, file %q", removed.BackupPath, content)
			}
			if removed.Offer.Status != HookStatusAbsent || !removed.Offer.CanApply {
				t.Fatalf("after removal: %+v", removed.Offer)
			}
		})
	}
}

// The one a request names is the run's agent; an unknown one has no adapter to write anything.
func TestHookMutationNeedsAKnownAgent(t *testing.T) {
	env := hookTestEnv(t)
	for _, agent := range []string{"", "gemini", "../claude"} {
		if _, err := ApplyAgentHookMutation(env, AgentHookMutationRequest{Agent: agent, Action: HookActionInstall, UpdateKey: "k", ExpectedDigest: "absent"}, false, AgentHookDetection{}); err == nil {
			t.Fatalf("agent %q accepted", agent)
		}
	}
}
