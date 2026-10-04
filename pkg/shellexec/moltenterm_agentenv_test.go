// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package shellexec

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentparts"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

func TestLocalShellBaseEnvDropsAgentSessionMarkers(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("CLAUDE_CODE_CHILD_SESSION", "1")
	t.Setenv("CLAUDE_CODE_ENTRYPOINT", "cli")
	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "1")
	t.Setenv("MOLTEN_TEST_KEEP", "kept")
	env := localShellBaseEnv()
	for _, kv := range env {
		switch kv {
		case "CLAUDECODE=1", "CLAUDE_CODE_CHILD_SESSION=1", "CLAUDE_CODE_ENTRYPOINT=cli":
			t.Fatalf("local shell env still holds %q", kv)
		}
	}
	for _, kv := range []string{"CLAUDE_CODE_USE_BEDROCK=1", "MOLTEN_TEST_KEEP=kept"} {
		if !slices.Contains(env, kv) {
			t.Fatalf("local shell env lost %q", kv)
		}
	}
}

func pluginDirsEntries(env []string) []string {
	var found []string
	for _, kv := range env {
		if strings.HasPrefix(kv, agentparts.PluginDirsVarName+"=") {
			found = append(found, kv)
		}
	}
	return found
}

// FR-MORPH-010: a local shell gets the Claude Code slots after the user's own plugin folders, none in safe mode, and
// never the slots of a MoltenTerm that started this one.
func TestLocalShellBaseEnvCarriesTheSlots(t *testing.T) {
	dataDir := t.TempDir()
	savedDataDir := wavebase.DataHome_VarCache
	wavebase.DataHome_VarCache = dataDir
	defer func() { wavebase.DataHome_VarCache = savedDataDir }()
	slot := agentparts.SlotPath(dataDir, "band")
	if err := os.MkdirAll(filepath.Dir(slot), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), slot); err != nil {
		t.Fatal(err)
	}
	sep := string(os.PathListSeparator)
	inheritedSlot := "/gold/molten/agent-parts/claude-code/old"
	t.Setenv(agentparts.SafeModeVarName, "")
	t.Setenv(agentparts.PluginDirsVarName, "/mine"+sep+inheritedSlot)
	want := agentparts.PluginDirsVarName + "=/mine" + sep + slot
	if runtime.GOOS == "windows" {
		want = agentparts.PluginDirsVarName + "=/mine"
	}
	if got := pluginDirsEntries(localShellBaseEnv()); len(got) != 1 || got[0] != want {
		t.Fatalf("env %v, want %s", got, want)
	}

	t.Setenv(agentparts.SafeModeVarName, "1")
	t.Setenv(agentparts.PluginDirsVarName, inheritedSlot)
	if got := pluginDirsEntries(localShellBaseEnv()); len(got) != 0 {
		t.Fatalf("safe mode with only inherited slots must unset the variable: %v", got)
	}
	value, set := moltenAgentPartsEnv()
	if !set || value != "" {
		t.Fatalf("the job env must override the inherited slots with an empty value: %q %v", value, set)
	}

	t.Setenv(agentparts.PluginDirsVarName, "/mine")
	if value, set := moltenAgentPartsEnv(); set || value != "/mine" {
		t.Fatalf("an unchanged value needs no override: %q %v", value, set)
	}
}
