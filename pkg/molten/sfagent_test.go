// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

func readSfCatalogFixture(t *testing.T) []SfAgentProfile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "sf-agents-catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	profiles, err := ParseSfCatalog(data)
	if err != nil {
		t.Fatal(err)
	}
	return profiles
}

// #2514: SaaSFoundryAI refuses every name but its registered ids; Kimi Code is kimi, never kimi-code.
func TestSfAgentIdOfEachAgent(t *testing.T) {
	t.Parallel()
	want := map[string]string{
		AgentIdClaude: "claude-code",
		AgentIdCodex:  "codex",
		AgentIdKimi:   "kimi",
		AgentIdGemini: "gemini-cli",
		AgentIdQwen:   "qwen-code",
	}
	catalog := readSfCatalogFixture(t)
	for agent, id := range want {
		if got := SfAgentIdIn(agent, nil); got != id {
			t.Errorf("built-in identity of %s = %q, want %q", agent, got, id)
		}
		if got := SfAgentIdIn(agent, catalog); got != id {
			t.Errorf("catalog identity of %s = %q, want %q", agent, got, id)
		}
	}
	for _, agent := range []string{AgentIdOpenCode, AgentIdCursor, AgentIdVibe, "", "unknown"} {
		if got := SfAgentIdIn(agent, catalog); got != "" {
			t.Errorf("%q has no SaaSFoundryAI profile, got %q", agent, got)
		}
		if got := SfAgentIdIn(agent, nil); got != "" {
			t.Errorf("%q has no built-in identity, got %q", agent, got)
		}
	}
}

func TestSfAgentIdFollowsTheCatalog(t *testing.T) {
	t.Parallel()
	renamed := []SfAgentProfile{{Id: "kimi-cli", DisplayName: "Kimi Code"}, {Id: "codex", DisplayName: "OpenAI Codex"}}
	if got := SfAgentIdIn(AgentIdKimi, renamed); got != "kimi-cli" {
		t.Errorf("a catalog that names Kimi Code otherwise wins, got %q", got)
	}
	if got := SfAgentIdIn(AgentIdCodex, renamed); got != "codex" {
		t.Errorf("the built-in id the catalog lists is kept when the names differ, got %q", got)
	}
	if got := SfAgentIdIn(AgentIdClaude, renamed); got != "" {
		t.Errorf("an agent the catalog does not list has no identity, got %q", got)
	}
}

func TestParseSfCatalog(t *testing.T) {
	t.Parallel()
	profiles := readSfCatalogFixture(t)
	var ids []string
	for _, p := range profiles {
		ids = append(ids, p.Id)
	}
	if !slices.Equal(ids, []string{"claude-code", "codex", "kimi", "gemini-cli", "qwen-code", "generic"}) {
		t.Fatalf("ids = %v", ids)
	}
	if _, err := ParseSfCatalog([]byte(`{"profiles":[{"id":"Bad Id"}]}`)); err == nil {
		t.Errorf("a catalog without a valid id must fail")
	}
	if _, err := ParseSfCatalog([]byte(`not json`)); err == nil {
		t.Errorf("a broken catalog must fail")
	}
}

func TestWithSfAgentEnv(t *testing.T) {
	t.Parallel()
	inherited := []string{"HOME=/h", SfAgentEnvVar + "=claude-code", "PATH=/bin"}
	got := WithSfAgentEnv(inherited, AgentIdKimi, nil)
	if !slices.Equal(got, []string{"HOME=/h", "PATH=/bin", SfAgentEnvVar + "=kimi"}) {
		t.Errorf("Kimi Code started from Claude Code's shell: %v", got)
	}
	got = WithSfAgentEnv(inherited, AgentIdOpenCode, nil)
	if !slices.Equal(got, []string{"HOME=/h", "PATH=/bin"}) {
		t.Errorf("an agent without an identity must not keep another one's: %v", got)
	}
	if inherited[1] != SfAgentEnvVar+"=claude-code" {
		t.Errorf("the input changed: %v", inherited)
	}
}

func TestSfCatalogCache(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	if _, err := ReadSfCatalogCache(dir); err == nil {
		t.Fatalf("no cache yet must fail")
	}
	profiles := readSfCatalogFixture(t)
	if err := WriteSfCatalogCache(dir, profiles); err != nil {
		t.Fatal(err)
	}
	got, err := ReadSfCatalogCache(dir)
	if err != nil || !slices.Equal(got, profiles) {
		t.Fatalf("ReadSfCatalogCache() = %v, %v", got, err)
	}
}

// RefreshSfCatalog runs SaaSFoundryAI's own command, never a bare sf. It sets the process-wide catalog: serial.
func TestRefreshSfCatalog(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake saasfoundryai is a shell script")
	}
	t.Cleanup(func() { SetSfCatalog(nil) })
	bin := t.TempDir()
	data := t.TempDir()
	fixture, err := filepath.Abs(filepath.Join("testdata", "sf-agents-catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	bare := filepath.Join(bin, "sf")
	if err := os.WriteFile(bare, []byte("#!/bin/sh\nexit 3\n"), 0755); err != nil {
		t.Fatal(err)
	}
	pathList := bin + string(os.PathListSeparator) + "/bin" + string(os.PathListSeparator) + "/usr/bin"
	if err := RefreshSfCatalog(context.Background(), data, pathList); err == nil {
		t.Fatalf("without saasfoundryai the refresh must fail")
	}
	if got := SfAgentId(AgentIdKimi); got != "kimi" {
		t.Fatalf("without a catalog the built-in identity applies, got %q", got)
	}
	script := "#!/bin/sh\n[ \"$1 $2 $3\" = \"agents catalog --json\" ] || exit 2\ncat '" + fixture + "'\n"
	if err := os.WriteFile(filepath.Join(bin, SfProgramName), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	if err := RefreshSfCatalog(context.Background(), data, pathList); err != nil {
		t.Fatal(err)
	}
	if got := SfAgentId(AgentIdKimi); got != "kimi" {
		t.Errorf("SfAgentId(kimi) = %q", got)
	}
	if cached, err := ReadSfCatalogCache(data); err != nil || len(cached) != 6 {
		t.Errorf("the catalog was not saved for the launcher: %v, %v", cached, err)
	}
	if env := SfAgentEnv(AgentIdClaude); !slices.Equal(env, []string{SfAgentEnvVar + "=claude-code"}) {
		t.Errorf("SfAgentEnv(claude) = %v", env)
	}
}

// The molten-pipeline guide each agent reads names its own identity for `agents route --provider`.
func TestPipelineGuideNamesTheSfIdentity(t *testing.T) {
	t.Parallel()
	guide, err := FindGuide(PipelineGuideName)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"claude-code": "claude-code", "codex": "codex", "kimi": "kimi", "gemini-cli": "gemini-cli", "qwen-code": "qwen-code"}
	for _, profile := range AgentProfiles {
		text, err := profile.RenderGuide(guide, "1.0.0")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(text, "{{SF_") {
			t.Errorf("%s: a placeholder is left", profile.Id)
		}
		id, ok := want[profile.Id]
		sentence := "--provider <id>`, `sf agents enable <id>`), it is `" + id + "`."
		if !ok {
			sentence = "it is the id `molten agent identity` prints."
		}
		if !strings.Contains(strings.Join(strings.Fields(text), " "), sentence) {
			t.Errorf("%s's guide does not say %q", profile.Id, sentence)
		}
	}
	dir := t.TempDir()
	if err := WriteDocs(dir); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "molten-pipeline.md"))
	if err != nil || !strings.Contains(string(data), "the id `molten agent identity` prints") || strings.Contains(string(data), "{{SF_") {
		t.Errorf("molten docs' pipeline guide: %v", err)
	}
}

func TestFindCallingAgent(t *testing.T) {
	t.Parallel()
	// wavesrv 10 > zsh 20 > kimi 30 > zsh 40 > molten 50; and a codex 60 started by kimi's shell, whose shell 70 runs 80.
	table := proctree.MakeTable([]proctree.Proc{
		{Pid: 10, Ppid: 1, Name: "wavesrv"},
		{Pid: 20, Ppid: 10, Name: "zsh"},
		{Pid: 30, Ppid: 20, Name: "kimi", StartMs: 1},
		{Pid: 40, Ppid: 30, Name: "zsh"},
		{Pid: 50, Ppid: 40, Name: "wsh"},
		{Pid: 60, Ppid: 40, Name: "node", StartMs: 2},
		{Pid: 70, Ppid: 60, Name: "bash"},
		{Pid: 80, Ppid: 70, Name: "wsh"},
	})
	read := func(pid int32) (string, []string) {
		if pid == 60 {
			return "/usr/local/bin/node", []string{"node", "/usr/local/lib/node_modules/@openai/codex/bin/codex.js"}
		}
		return "", nil
	}
	if found, ok := FindCallingAgent(table, 50, read); !ok || found.Agent != AgentIdKimi || found.Pid != 30 {
		t.Errorf("a command in Kimi Code's shell: %+v, %v", found, ok)
	}
	if found, ok := FindCallingAgent(table, 80, read); !ok || found.Agent != AgentIdCodex || found.Pid != 60 {
		t.Errorf("the nearest agent answers: %+v, %v", found, ok)
	}
	if _, ok := FindCallingAgent(table, 20, read); ok {
		t.Errorf("a shell no agent runs has no calling agent")
	}
	// A test instance started from Claude Code's shell: claude 2 > zsh 3 > wavesrv 4 > zsh 5 > molten 6, and the same
	// shell under a durable terminal's job manager: wavesrv 4 > wsh 7 > zsh 8 > molten 9.
	above := proctree.MakeTable([]proctree.Proc{
		{Pid: 2, Ppid: 1, Name: "claude"},
		{Pid: 3, Ppid: 2, Name: "zsh"},
		{Pid: 4, Ppid: 3, Name: "wavesrv.arm64"},
		{Pid: 5, Ppid: 4, Name: "zsh"},
		{Pid: 6, Ppid: 5, Name: "molten"},
		{Pid: 7, Ppid: 4, Name: "wsh-1.0.0-12-da"},
		{Pid: 8, Ppid: 7, Name: "zsh"},
		{Pid: 9, Ppid: 8, Name: "molten"},
	})
	for _, pid := range []int32{6, 9} {
		if found, ok := FindCallingAgent(above, pid, read); ok {
			t.Errorf("an agent above MoltenTerm is not the terminal's: %+v", found)
		}
	}
	if _, ok := FindCallingAgent(nil, 50, read); ok {
		t.Errorf("no process table, no agent")
	}
	loop := proctree.MakeTable([]proctree.Proc{{Pid: 5, Ppid: 6, Name: "a"}, {Pid: 6, Ppid: 5, Name: "b"}})
	if _, ok := FindCallingAgent(loop, 5, read); ok {
		t.Errorf("a parent loop ends the walk")
	}
}
