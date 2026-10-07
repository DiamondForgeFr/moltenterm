// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
)

func writeFakeAgent(t *testing.T, dir string, name string, script string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script+"\n"), 0755); err != nil {
		t.Fatal(err)
	}
	return path
}

func skipOnWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake agents are shell scripts")
	}
}

func TestBuiltinRegistry(t *testing.T) {
	r := Default()
	if got := r.Ids(); !reflect.DeepEqual(got, []string{molten.AgentIdClaude, molten.AgentIdCodex}) {
		t.Fatalf("ids %v", got)
	}
	for _, a := range r.Adapters() {
		if err := checkAdapter(a); err != nil {
			t.Error(err)
		}
		if kind := molten.FindAgentKind(a.Id()); kind == nil || kind.Name != a.Name() || !slices.Contains(kind.Commands, a.Executable()) {
			t.Errorf("%s does not match molten.AgentKinds", a.Id())
		}
	}
	if _, err := r.Lookup("aider"); err == nil || !strings.Contains(err.Error(), "supported: claude, codex") {
		t.Errorf("unknown id: %v", err)
	}
	if _, err := r.Lookup(molten.AgentIdGemini); err == nil || !strings.Contains(err.Error(), "#333") {
		t.Errorf("planned id: %v", err)
	}
	if a, err := r.Lookup("codex"); err != nil || a.Id() != "codex" {
		t.Errorf("codex lookup: %v", err)
	}
	if Find("nope") != nil {
		t.Error("Find of an unknown id")
	}
}

// FR-CONT-006 AC3, DS-CONT-007: each adapter's briefing channel and capability matrix.
func TestCapabilityMatrix(t *testing.T) {
	want := map[string]map[string]string{
		molten.AgentIdClaude: {CapBriefing: SupportDocumented, CapInitialPrompt: SupportDocumented, CapModels: SupportDocumented, CapResume: SupportDocumented,
			CapTranscript: SupportDocumented, CapQuota: SupportDocumented, CapMcp: SupportDocumented, CapHooks: SupportDocumented},
		molten.AgentIdCodex: {CapBriefing: SupportDocumented, CapInitialPrompt: SupportDocumented, CapModels: SupportDocumented, CapResume: SupportDocumented,
			CapTranscript: SupportUndocumented, CapQuota: SupportUndocumented, CapMcp: SupportDocumented, CapHooks: SupportDocumented},
	}
	inUse := map[string][]string{
		molten.AgentIdClaude: {CapHooks, CapQuota, CapTranscript},
		molten.AgentIdCodex:  {CapHooks, CapQuota, CapTranscript},
	}
	for id, caps := range want {
		a := Find(id)
		got := a.Capabilities()
		var used []string
		for name, support := range caps {
			if got[name].Support != support {
				t.Errorf("%s %s: %q, want %q", id, name, got[name].Support, support)
			}
			if got[name].InUse {
				used = append(used, name)
			}
		}
		sort.Strings(used)
		if !reflect.DeepEqual(used, inUse[id]) {
			t.Errorf("%s in use: %v, want %v", id, used, inUse[id])
		}
		got[CapBriefing] = Capability{}
		if a.Capabilities()[CapBriefing].Support == "" {
			t.Errorf("%s: Capabilities returns its own map", id)
		}
	}
	if b := Find("claude").Briefing(); b.Channel != ChannelSystemAppend || b.Flag != "--append-system-prompt-file" || b.Support != SupportDocumented {
		t.Errorf("claude briefing %+v", b)
	}
	if b := Find("codex").Briefing(); b.Channel != ChannelDeveloper || b.Flag != "-c" || b.Key != "developer_instructions" || b.Support != SupportDocumented {
		t.Errorf("codex briefing %+v", b)
	}
	if e := Find("claude").Exit(); e.Command != "/exit" {
		t.Errorf("claude exit %+v", e)
	}
	if e := Find("codex").Exit(); e.Command != "/exit" {
		t.Errorf("codex exit %+v", e)
	}
}

type badAdapter struct {
	claudeAdapter
	id      string
	channel string
	caps    map[string]Capability
}

func (b badAdapter) Id() string {
	if b.id != "" {
		return b.id
	}
	return b.claudeAdapter.Id()
}

func (b badAdapter) Briefing() BriefingChannel {
	rtn := b.claudeAdapter.Briefing()
	if b.channel != "" {
		rtn.Channel = b.channel
	}
	return rtn
}

func (b badAdapter) Capabilities() map[string]Capability {
	if b.caps != nil {
		return b.caps
	}
	return b.claudeAdapter.Capabilities()
}

func TestMakeRegistryRefusesBadAdapters(t *testing.T) {
	missing := claudeAdapter{}.Capabilities()
	delete(missing, CapMcp)
	badSupport := claudeAdapter{}.Capabilities()
	badSupport[CapResume] = Capability{Support: "maybe"}
	extra := claudeAdapter{}.Capabilities()
	extra["teleport"] = Capability{Support: SupportDocumented}
	unavailableInUse := claudeAdapter{}.Capabilities()
	unavailableInUse[CapMcp] = Capability{Support: SupportUnavailable, InUse: true}
	for name, set := range map[string][]AgentAdapter{
		"nil":                {nil},
		"duplicate":          {claudeAdapter{}, claudeAdapter{}},
		"unknown id":         {badAdapter{id: "aider"}},
		"bad channel":        {badAdapter{channel: "telepathy"}},
		"missing capability": {badAdapter{caps: missing}},
		"bad support":        {badAdapter{caps: badSupport}},
		"extra capability":   {badAdapter{caps: extra}},
		"unavailable in use": {badAdapter{caps: unavailableInUse}},
	} {
		if _, err := MakeRegistry(set...); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := MakeRegistry(badAdapter{id: molten.AgentIdKimi}); err != nil {
		t.Errorf("kimi is a known id: %v", err)
	}
}

// FR-CONT-006 AC4: fresh and resume argv, a model and a session id each one argument.
func TestFreshAndResumeArgs(t *testing.T) {
	claude, codex := Find("claude"), Find("codex")
	for _, tc := range []struct {
		a      AgentAdapter
		model  string
		prompt string
		want   []string
	}{
		{claude, "", "", nil},
		{claude, "opus", "", []string{"--model", "opus"}},
		{claude, "opus[1m]", "Continue the task", []string{"--model", "opus[1m]", "--", "Continue the task"}},
		{claude, "", "-p everything", []string{"--", "-p everything"}},
		{claude, "claude-opus-5-5", "fix it; echo $(id)", []string{"--model", "claude-opus-5-5", "--", "fix it; echo $(id)"}},
		{claude, "", "update the parser", []string{"--", "update the parser"}},
		{codex, "", "", nil},
		{codex, "gpt-6.1-sol", "", []string{"-m", "gpt-6.1-sol"}},
		{codex, "gpt-6.1-sol", "Continue the task", []string{"-m", "gpt-6.1-sol", "--", "Continue the task"}},
		{codex, "", "--help", []string{"--", "--help"}},
		{codex, "", "logout", []string{"--", "logout"}},
		{codex, "", "exec", []string{"--", "exec"}},
	} {
		got, err := tc.a.FreshArgs(tc.model, tc.prompt)
		if err != nil || !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s FreshArgs(%q, %q) = %q, %v; want %q", tc.a.Id(), tc.model, tc.prompt, got, err, tc.want)
		}
	}
	// Claude Code's parser runs a subcommand named by a one-word prompt even after "--".
	for _, prompt := range []string{"update", " doctor ", "continue", "--version"} {
		if got, err := claude.FreshArgs("", prompt); err == nil {
			t.Errorf("claude accepted the one-word prompt %q: %q", prompt, got)
		}
	}
	for _, a := range []AgentAdapter{claude, codex} {
		for _, model := range []string{"-p", "--dangerously-skip-permissions", "opus sonnet", "op\nus", "a;b", "$(x)", strings.Repeat("m", 200)} {
			if _, err := a.FreshArgs(model, ""); err == nil {
				t.Errorf("%s accepted model %q", a.Id(), model)
			}
		}
		if _, err := a.FreshArgs("", "a\x00b"); err == nil {
			t.Errorf("%s accepted a NUL in the prompt", a.Id())
		}
		if _, err := a.FreshArgs("", strings.Repeat("x", maxInitialPromptBytes+1)); err == nil {
			t.Errorf("%s accepted a huge prompt", a.Id())
		}
		for _, id := range []string{"", "-c", "--last", "a b", "x/../y", "id\n"} {
			if _, err := a.ResumeArgs(id); err == nil {
				t.Errorf("%s accepted session id %q", a.Id(), id)
			}
		}
	}
	const id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	if got, err := claude.ResumeArgs(id); err != nil || !reflect.DeepEqual(got, []string{"--resume", id}) {
		t.Errorf("claude resume %q %v", got, err)
	}
	if got, err := codex.ResumeArgs(id); err != nil || !reflect.DeepEqual(got, []string{"resume", id}) {
		t.Errorf("codex resume %q %v", got, err)
	}
}

func TestResumesSession(t *testing.T) {
	claude, codex := Find("claude"), Find("codex")
	for _, tc := range []struct {
		a    AgentAdapter
		args []string
		want bool
	}{
		{claude, nil, false},
		{claude, []string{"fix the bug"}, false},
		{claude, []string{"--model", "opus", "--resume", "abc"}, true},
		{claude, []string{"-r"}, true},
		{claude, []string{"--resume=abc"}, true},
		{claude, []string{"-c"}, true},
		{claude, []string{"--continue", "--fork-session"}, true},
		{claude, []string{"--from-pr", "12"}, true},
		{claude, []string{"--", "--resume"}, false},
		{claude, []string{"--session-id", "abc"}, false},
		{claude, []string{"attach", "build-bot"}, true},
		{claude, []string{"--model", "attach"}, false},
		{claude, []string{"--add-dir", "a", "b", "attach"}, false},
		{claude, []string{"--teleport"}, true},
		{claude, []string{"--cloud=0199"}, true},
		{claude, []string{"mcp", "list"}, false},
		{codex, nil, false},
		{codex, []string{"resume", "abc"}, true},
		{codex, []string{"resume", "--last"}, true},
		{codex, []string{"-m", "resume", "hello"}, false},
		{codex, []string{"-c", "model=\"x\"", "fork", "abc"}, true},
		{codex, []string{"-c", "resume"}, false},
		{codex, []string{"resume the work on the parser"}, false},
		{codex, []string{"--", "resume"}, false},
		{codex, []string{"exec", "resume", "--last"}, true},
		{codex, []string{"e", "-m", "x", "resume", "abc"}, true},
		{codex, []string{"exec", "fix the parser"}, false},
		{codex, []string{"-i", "a.png", "b.png", "resume"}, false},
		{codex, []string{"-i", "a.png", "-m", "x", "resume"}, true},
		{codex, []string{"exec"}, false},
	} {
		if got := tc.a.ResumesSession(tc.args); got != tc.want {
			t.Errorf("%s ResumesSession(%q) = %v", tc.a.Id(), tc.args, got)
		}
	}
}

func TestCodexModels(t *testing.T) {
	home := t.TempDir()
	codexHome := filepath.Join(home, ".codex")
	os.MkdirAll(codexHome, 0700)
	env := ModelEnv{Home: home, Getenv: func(string) string { return "" }}
	codex := Find("codex")
	if got := codex.Models(env); len(got) != 1 || got[0].Id != "" {
		t.Fatalf("no cache: %+v", got)
	}
	os.WriteFile(filepath.Join(codexHome, "models_cache.json"), []byte(`{"identity":"not read","models":[
		{"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","visibility":"list","context_window":800000},
		{"slug":"gpt-reserve","display_name":"GPT-Reserve","visibility":"hide","context_window":272000},
		{"slug":"-bad","display_name":"Bad","visibility":"list"},
		{"slug":"gpt-6-luna","display_name":"","visibility":"list","context_window":272000}]}`), 0600)
	os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("# mine\nmodel = \"gpt-6-luna\" # pinned\n[profiles.x]\nmodel = \"other\"\n"), 0600)
	got := codex.Models(env)
	want := []ModelChoice{
		{Id: "", Label: "Your default model"},
		{Id: "gpt-6.1-sol", Label: "GPT-6.1-Sol", ContextWindow: 800000},
		{Id: "gpt-6-luna", Label: "gpt-6-luna", ContextWindow: 272000, Configured: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("models %+v", got)
	}
	os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("[profiles.x]\nmodel = \"gpt-6-sol\"\n"), 0600)
	if got := codex.Models(env); len(got) != 3 || got[2].Configured {
		t.Errorf("a profile's model is not the user's: %+v", got)
	}
	os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("model = \"my-own\"\n"), 0600)
	if got := codex.Models(env); got[len(got)-1] != (ModelChoice{Id: "my-own", Label: "my-own", Configured: true}) {
		t.Errorf("configured model not listed: %+v", got)
	}
	other := t.TempDir()
	envHome := ModelEnv{Home: home, Getenv: func(name string) string {
		if name == "CODEX_HOME" {
			return other
		}
		return ""
	}}
	if got := codex.Models(envHome); len(got) != 1 {
		t.Errorf("CODEX_HOME is not read: %+v", got)
	}
	if got := Find("claude").Models(env); len(got) < 2 || got[0].Id != "" || got[1].ContextWindow == 0 {
		t.Errorf("claude models %+v", got)
	}
}

func TestParseVersion(t *testing.T) {
	for out, want := range map[string]string{
		"2.1.292 (Claude Code)\n":     "2.1.292",
		"codex-cli 0.160.1\n":         "0.160.1",
		"\x1b[1mcodex-cli\x1b[0m 1.2": "1.2",
		"v0.63.0-nightly.3":           "0.63.0-nightly.3",
		"no version here":             "",
	} {
		if got := ParseVersion(out); got != want {
			t.Errorf("ParseVersion(%q) = %q, want %q", out, got, want)
		}
	}
}

// FR-CONT-006 AC2, AC6, TC-CONT-006: detection with fake binaries.
func TestDetect(t *testing.T) {
	skipOnWindows(t)
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	counter := filepath.Join(dir, "count")
	writeFakeAgent(t, bin, "claude", `echo x >> "`+counter+`"; echo "2.1.292 (Claude Code)"`)
	writeFakeAgent(t, bin, "codex", `sleep 30`)
	writeFakeAgent(t, bin, "gemini", `echo boom >&2; exit 3`)
	writeFakeAgent(t, bin, "opencode", `echo "no digits"`)
	d := MakeDetector(RunVersionProbe, 2*time.Second)
	env := DetectEnv{PathList: "relative:" + bin}
	start := time.Now()
	got := d.DetectAll(context.Background(), []string{"claude", "codex", "gemini", "opencode", "kimi"}, env)
	if elapsed := time.Since(start); elapsed > 4*time.Second {
		t.Errorf("detection took %s", elapsed)
	}
	if c := got["claude"]; !c.Installed || c.Version != "2.1.292" || c.Path != filepath.Join(bin, "claude") || c.Reason != "" {
		t.Errorf("claude %+v", c)
	}
	if c := got["codex"]; c.Installed || c.Path == "" || !strings.Contains(c.Reason, "did not answer within 2s") {
		t.Errorf("hanging codex %+v", c)
	}
	if c := got["gemini"]; c.Installed || !strings.Contains(c.Reason, "failed") {
		t.Errorf("failing gemini %+v", c)
	}
	if c := got["opencode"]; c.Installed || c.Reason != ReasonNoVersion {
		t.Errorf("opencode %+v", c)
	}
	if c := got["kimi"]; c.Installed || c.Path != "" || c.Reason != ReasonNotFound {
		t.Errorf("missing kimi %+v", c)
	}
	d.Detect(context.Background(), "claude", env)
	if data, _ := os.ReadFile(counter); strings.Count(string(data), "x") != 1 {
		t.Errorf("the cached result was not reused: %q", data)
	}
	later := time.Now().Add(time.Hour)
	os.Chtimes(filepath.Join(bin, "claude"), later, later)
	d.Detect(context.Background(), "claude", env)
	if data, _ := os.ReadFile(counter); strings.Count(string(data), "x") != 2 {
		t.Errorf("a changed binary was not probed again: %q", data)
	}
}

func TestDetectRetriesFailedProbe(t *testing.T) {
	skipOnWindows(t)
	bin := filepath.Join(t.TempDir(), "bin")
	writeFakeAgent(t, bin, "codex", `exit 1`)
	calls := 0
	probe := func(ctx context.Context, path string, env []string) (string, error) {
		calls++
		if calls == 1 {
			return "", context.Canceled
		}
		return "codex-cli 0.160.1", nil
	}
	d := MakeDetector(probe, time.Second)
	now := time.Now()
	d.now = func() time.Time { return now }
	env := DetectEnv{PathList: bin}
	if c := d.Detect(context.Background(), "codex", env); c.Installed {
		t.Fatalf("first probe %+v", c)
	}
	if c := d.Detect(context.Background(), "codex", env); c.Installed || calls != 1 {
		t.Fatalf("a failure is kept for a minute: %+v, %d calls", c, calls)
	}
	now = now.Add(failedProbeCacheTTL)
	if c := d.Detect(context.Background(), "codex", env); !c.Installed || calls != 2 {
		t.Fatalf("failure retried: %+v, %d calls", c, calls)
	}
}

func TestDetectSkipsLaunchers(t *testing.T) {
	skipOnWindows(t)
	dir := t.TempDir()
	launchers := filepath.Join(dir, "data", "bin", "agents")
	os.MkdirAll(launchers, 0755)
	wsh := writeFakeAgent(t, filepath.Join(dir, "data", "bin"), "wsh", `echo "9.9.9"`)
	os.Symlink(wsh, filepath.Join(launchers, "claude"))
	other := filepath.Join(dir, "other")
	os.MkdirAll(other, 0755)
	os.Symlink(wsh, filepath.Join(other, "claude"))
	real := writeFakeAgent(t, filepath.Join(dir, "real"), "claude", `echo "2.1.292 (Claude Code)"`)
	d := MakeDetector(RunVersionProbe, time.Second)
	got := d.Detect(context.Background(), "claude", DetectEnv{PathList: launchers + ":" + other + ":" + filepath.Dir(real), LauncherDir: launchers})
	if got.Path != real || got.Version != "2.1.292" {
		t.Errorf("launcher not skipped: %+v", got)
	}
}

func TestDetectCanceledIsNotCached(t *testing.T) {
	skipOnWindows(t)
	bin := filepath.Join(t.TempDir(), "bin")
	writeFakeAgent(t, bin, "claude", `sleep 30`)
	d := MakeDetector(RunVersionProbe, 3*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	got := d.Detect(ctx, "claude", DetectEnv{PathList: bin})
	if got.Installed || time.Since(start) > 2*time.Second {
		t.Errorf("canceled detection %+v after %s", got, time.Since(start))
	}
	if len(d.cache) != 0 {
		t.Error("a canceled probe was cached")
	}
}

func hashTree(t *testing.T, root string) map[string]string {
	t.Helper()
	rtn := map[string]string{}
	filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		info, _ := entry.Info()
		key := strings.TrimPrefix(path, root)
		if entry.IsDir() {
			rtn[key] = "dir " + info.ModTime().String()
			return nil
		}
		data, _ := os.ReadFile(path)
		sum := sha256.Sum256(data)
		rtn[key] = hex.EncodeToString(sum[:]) + " " + info.Mode().String() + " " + info.ModTime().String()
		return nil
	})
	return rtn
}

// FR-CONT-006 AC1, AC5, TC-CONT-007: the listing of every known agent, written from nothing of the agents'.
func TestListWritesNothing(t *testing.T) {
	skipOnWindows(t)
	home := t.TempDir()
	bin := filepath.Join(home, "bin")
	writeFakeAgent(t, bin, "claude", `echo "2.1.292 (Claude Code)"`)
	writeFakeAgent(t, bin, "codex", `echo "codex-cli 0.160.1"`)
	for _, dir := range []string{".claude/projects", ".codex/sessions", ".gemini", ".kimi-code", ".config/opencode"} {
		os.MkdirAll(filepath.Join(home, dir), 0700)
	}
	os.WriteFile(filepath.Join(home, ".codex", "config.toml"), []byte("model = \"gpt-6-sol\"\n"), 0600)
	os.WriteFile(filepath.Join(home, ".codex", "models_cache.json"), []byte(`{"models":[{"slug":"gpt-6-sol","display_name":"GPT-6-Sol","visibility":"list","context_window":272000}]}`), 0600)
	os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{}`), 0600)
	before := hashTree(t, home)
	listings := Default().List(context.Background(), MakeDetector(RunVersionProbe, time.Second), DetectEnv{PathList: bin},
		ModelEnv{Home: home, Getenv: func(string) string { return "" }})
	if after := hashTree(t, home); !reflect.DeepEqual(before, after) {
		t.Errorf("the listing changed the agents' files")
	}
	var ids []string
	for _, l := range listings {
		ids = append(ids, l.Id)
	}
	if !reflect.DeepEqual(ids, []string{"claude", "codex", "gemini", "kimi", "opencode"}) {
		t.Fatalf("ids %v", ids)
	}
	claude, codex, gemini := listings[0], listings[1], listings[2]
	if !claude.Offered() || claude.Version != "2.1.292" || claude.Briefing.Channel != ChannelSystemAppend || !claude.Launcher ||
		claude.GuideProfile != "claude-code" || claude.Quota == nil || len(claude.Quota.Sources) != 2 || len(claude.TranscriptRoots) == 0 ||
		len(claude.Capabilities) != len(AllCapabilities) || claude.Exit == nil {
		t.Errorf("claude listing %+v", claude)
	}
	if claude.Quota.Sources[0].Support != SupportDocumented || claude.Quota.Sources[1].Support != SupportUndocumented {
		t.Errorf("claude quota sources %+v", claude.Quota.Sources)
	}
	if !codex.Offered() || codex.Version != "0.160.1" || !codex.Launcher || codex.GuideProfile != "codex" || codex.Quota.PageURL != usage.CodexUsagePageURL ||
		len(codex.Models) != 2 || !codex.Models[1].Configured {
		t.Errorf("codex listing %+v", codex)
	}
	if gemini.Supported || gemini.Offered() || gemini.Installed || gemini.Reason != ReasonNotFound || gemini.Unsupported == "" || gemini.Capabilities != nil {
		t.Errorf("gemini listing %+v", gemini)
	}
}

// Every per-agent part (launcher, transcript reader, usage adapter, guides) belongs to the agent adapter of the same
// id: a new agent cannot be half registered.
func TestPartsBelongToAdapters(t *testing.T) {
	for _, id := range companion.SupportedAgents {
		a := Find(id)
		if a == nil || a.Transcripts() == nil || a.Transcripts().Id() != id {
			t.Errorf("companion reader %s has no agent adapter", id)
		}
	}
	for _, id := range usage.Agents() {
		a := Find(id)
		if a == nil || a.Usage() == nil || a.Usage().Id() != id {
			t.Errorf("usage adapter %s has no agent adapter", id)
		}
	}
	for _, name := range agentlaunch.LauncherNames() {
		launch := agentlaunch.AdapterForProgram(name)
		a := Find(launch.Id())
		if a == nil || a.Launch() == nil || a.Launch().Id() != launch.Id() || a.Executable() != launch.Executable() {
			t.Errorf("launcher %s has no agent adapter", name)
		}
	}
	for _, a := range Default().Adapters() {
		if p := a.GuideProfile(); p != "" {
			if _, err := molten.FindAgent(p); err != nil {
				t.Errorf("%s guide profile: %v", a.Id(), err)
			}
		}
	}
}
