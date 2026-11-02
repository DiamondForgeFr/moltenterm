// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Every agent of the catalog has a dated, sourced sign-in and a plans page that is never a download page (#1723).
func TestEveryAgentSignIn(t *testing.T) {
	kinds := map[string]bool{SignInKindCommand: true, SignInKindSlash: true, SignInKindFirstRun: true}
	for _, profile := range molten.AgentProfiles {
		if profile.Id == molten.GenericAgentId {
			continue
		}
		entry := signInEntry(profile)
		if entry == nil {
			t.Errorf("%s: no sign-in", profile.Id)
			continue
		}
		if !kinds[entry.Kind] || entry.CheckedOn == "" || len(entry.Sources) == 0 || entry.Opens == "" {
			t.Errorf("%s: incomplete sign-in %+v", profile.Id, entry)
		}
		if (entry.Kind == SignInKindSlash) != (entry.Slash != "") {
			t.Errorf("%s: a slash sign-in names its command, the others none: %+v", profile.Id, entry)
		}
		if !strings.HasPrefix(entry.Command, profile.Executable) {
			t.Errorf("%s: the sign-in does not start %s: %q", profile.Id, profile.Executable, entry.Command)
		}
		page := agentInstallCatalog[profile.Id].PlansPage
		if !strings.HasPrefix(page, "https://") || strings.Contains(page, "download") || strings.Contains(page, "install") {
			t.Errorf("%s: plans page %q", profile.Id, page)
		}
	}
	if got := signInEntry(mustAgent(t, "codex")).Command; got != "codex login" {
		t.Errorf("codex sign-in %q", got)
	}
	if got := signInEntry(mustAgent(t, "claude-code")).Command; got != "claude auth login" {
		t.Errorf("claude sign-in %q", got)
	}
	if k := signInEntry(mustAgent(t, "kimi")); k.Command != "kimi" || k.Slash != "/login" {
		t.Errorf("kimi sign-in %+v", k)
	}
}

func mustAgent(t *testing.T, id string) molten.AgentProfile {
	t.Helper()
	p, err := molten.FindAgent(id)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// The terminal runs the catalog's command in the login PATH, with the window's line printed, quoted, above it.
func TestSignInBlockMeta(t *testing.T) {
	t.Setenv(TestSignInDirEnv, "")
	meta, err := SignInBlockMeta("codex", "Codex opens your browser'; rm -rf ~ #\n", "/opt/bin:/usr/bin")
	if err != nil {
		t.Fatal(err)
	}
	if meta.GetString(waveobj.MetaKey_Controller, "") != "cmd" || meta.GetString(waveobj.MetaKey_View, "") != "term" {
		t.Errorf("meta %+v", meta)
	}
	if meta.GetBool(waveobj.MetaKey_CmdCloseOnExit, true) || !meta.GetBool(waveobj.MetaKey_CmdRunOnce, false) ||
		meta.GetString(SignInBlockMetaKey, "") != "codex" {
		t.Errorf("meta %+v", meta)
	}
	want := `printf '%s\n\n' 'Codex opens your browser'\''; rm -rf ~ #'; codex login`
	if got := meta.GetString(waveobj.MetaKey_Cmd, ""); got != want {
		t.Errorf("cmd %q, want %q", got, want)
	}
	if env := meta.GetStringMap(waveobj.MetaKey_CmdEnv, false); env["PATH"] != "/opt/bin:/usr/bin" {
		t.Errorf("env %+v", env)
	}
	if _, err := SignInBlockMeta("generic", "", ""); err == nil {
		t.Error("the generic agent has no sign-in")
	}
	if _, err := SignInBlockMeta("nope", "", ""); err == nil {
		t.Error("an unknown id is refused")
	}
}

// With TestSignInDirEnv the fake runs, never the agent; an agent without a fake is refused.
func TestSignInFake(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "kimi.sh"), []byte("echo fake\n"), 0644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(TestSignInDirEnv, dir)
	meta, err := SignInBlockMeta("kimi", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if got := meta.GetString(waveobj.MetaKey_Cmd, ""); got != "sh "+shellQuote(filepath.Join(dir, "kimi.sh")) {
		t.Errorf("cmd %q", got)
	}
	if _, err := SignInBlockMeta("codex", "", ""); err == nil {
		t.Error("no fake for codex: refused")
	}
}
