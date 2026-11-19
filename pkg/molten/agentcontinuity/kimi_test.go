// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentcontinuity

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestKimiModels(t *testing.T) {
	home := t.TempDir()
	kimiHome := filepath.Join(home, "custom-kimi")
	if err := os.MkdirAll(kimiHome, 0700); err != nil {
		t.Fatal(err)
	}
	env := ModelEnv{Home: home, Getenv: func(name string) string {
		if name == "KIMI_CODE_HOME" {
			return kimiHome
		}
		return ""
	}}
	a := Find(molten.AgentIdKimi)
	defaultOnly := []ModelChoice{{Id: "", Label: "Your default model"}}
	if got := a.Models(env); !reflect.DeepEqual(got, defaultOnly) {
		t.Fatalf("missing config: %+v", got)
	}
	config := `default_model = "kimi-code/k3"
[models."kimi-code/k3"]
display_name = "K3"
max_context_size = 1048576
[models."z-last"]
model = "underlying-name"
max_context_size = 262144
[models."-bad"]
display_name = "not an option"
[models."a-first"]
display_name = "First\u0001"
max_context_size = -1
`
	if err := os.WriteFile(filepath.Join(kimiHome, kimiConfigFile), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	want := []ModelChoice{
		{Id: "", Label: "Your default model"},
		{Id: "kimi-code/k3", Label: "K3", ContextWindow: 1048576, Configured: true},
		{Id: "a-first", Label: "First"},
		{Id: "z-last", Label: "underlying-name", ContextWindow: 262144},
	}
	if got := a.Models(env); !reflect.DeepEqual(got, want) {
		t.Errorf("models %+v, want %+v", got, want)
	}
	if err := os.WriteFile(filepath.Join(kimiHome, kimiConfigFile), []byte("not = [valid"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := a.Models(env); !reflect.DeepEqual(got, defaultOnly) {
		t.Errorf("invalid config: %+v", got)
	}
}

func TestKimiDeclaredLimits(t *testing.T) {
	a := Find(molten.AgentIdKimi)
	caps := a.Capabilities()
	if !strings.Contains(caps[CapInitialPrompt].Note, "stream-json") || !strings.Contains(caps[CapInitialPrompt].Note, "may write") {
		t.Errorf("headless limitation: %q", caps[CapInitialPrompt].Note)
	}
	if a.Launch() != nil || a.Usage() != nil || a.Toolkit(ModelEnv{}, "").Supported {
		t.Error("Kimi has no launcher, usage adapter or toolkit reader in this integration")
	}
	if got := a.ResumesSession([]string{"--", "--continue"}); got {
		t.Error("a prompt after -- is not a resume option")
	}
}
