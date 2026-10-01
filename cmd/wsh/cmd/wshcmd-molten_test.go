// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

func TestFormatMoltenModListEmpty(t *testing.T) {
	out := formatMoltenModList(&MoltenModList{ModsDir: "/cfg/mods"})
	if out != "no mods in /cfg/mods\n" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestFormatMoltenModListSafeMode(t *testing.T) {
	out := formatMoltenModList(&MoltenModList{ModsDir: "/cfg/mods", SafeMode: true})
	if !strings.HasPrefix(out, "safe mode: no mod is loaded\n") {
		t.Fatalf("safe mode not reported: %q", out)
	}
}

func TestFormatMoltenModListRows(t *testing.T) {
	list := &MoltenModList{
		ModsDir: "/cfg/mods",
		Mods: []MoltenModStatus{
			{Id: "good", Version: "1.0.0", State: "active", Commands: []string{"hello", "bye"}},
			{Id: "broken", Version: "0.1.0", State: "failed", Error: "activate: boom\nsecond line"},
			{Id: "future", State: "refused", Error: "apiVersion 2 is not supported; supported versions: 1"},
		},
	}
	lines := strings.Split(strings.TrimRight(formatMoltenModList(list), "\n"), "\n")
	if len(lines) != 4 {
		t.Fatalf("expected a header and 3 rows, got %d lines: %q", len(lines), lines)
	}
	if !strings.HasPrefix(lines[0], "ID") || !strings.Contains(lines[0], "ERROR") {
		t.Fatalf("unexpected header: %q", lines[0])
	}
	if !strings.Contains(lines[1], "active") || !strings.Contains(lines[1], "hello,bye") {
		t.Fatalf("unexpected active row: %q", lines[1])
	}
	if !strings.Contains(lines[2], "activate: boom second line") {
		t.Fatalf("error must stay on one line: %q", lines[2])
	}
	if !strings.Contains(lines[3], "refused") || !strings.Contains(lines[3], " - ") {
		t.Fatalf("unexpected refused row: %q", lines[3])
	}
}

// The renderer answers with the JSON of MoltenModList in frontend/molten/molten-host.ts; the field names must match.
func TestMoltenModListDecodesRendererAnswer(t *testing.T) {
	var answer any
	err := json.Unmarshal([]byte(`{"apiversions":[1],"safemode":false,"modsdir":"/cfg/mods",
		"mods":[{"id":"good","name":"Good","version":"1.0.0","path":"/cfg/mods/good","state":"active","commands":["hello"]}]}`), &answer)
	if err != nil {
		t.Fatal(err)
	}
	var list MoltenModList
	if err := utilfn.ReUnmarshal(&list, answer); err != nil {
		t.Fatal(err)
	}
	if len(list.ApiVersions) != 1 || list.ApiVersions[0] != 1 || list.ModsDir != "/cfg/mods" {
		t.Fatalf("unexpected list: %+v", list)
	}
	if len(list.Mods) != 1 || list.Mods[0].Name != "Good" || list.Mods[0].Commands[0] != "hello" {
		t.Fatalf("unexpected mods: %+v", list.Mods)
	}
}

func TestMoltenRewriteArgs(t *testing.T) {
	cases := []struct {
		in   []string
		want []string
	}{
		{[]string{"/data/bin/molten", "mod", "list"}, []string{"/data/bin/molten", "molten", "mod", "list"}},
		{[]string{`C:\data\bin\molten.exe`, "hello"}, []string{`C:\data\bin\molten.exe`, "molten", "hello"}},
		{[]string{"/data/bin/wsh", "molten", "help"}, []string{"/data/bin/wsh", "molten", "help"}},
		{[]string{"molten"}, []string{"molten", "molten"}},
		{[]string{}, []string{}},
	}
	for _, c := range cases {
		got := moltenRewriteArgs(c.in)
		if strings.Join(got, "|") != strings.Join(c.want, "|") {
			t.Errorf("moltenRewriteArgs(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestMoltenCommandRouting(t *testing.T) {
	cases := map[string]string{
		"molten mod list --json":     "list",
		"molten mod enable x":        "enable",
		"molten help":                "help",
		"molten hello --json world":  "molten",
		"molten --timeout 5 hello":   "molten",
		"molten mod validate a b":    "validate",
		"molten mod remove some-mod": "remove",
	}
	for line, want := range cases {
		found, _, err := rootCmd.Find(strings.Fields(line))
		if err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		if found.Name() != want {
			t.Errorf("%q routes to %q, want %q", line, found.Name(), want)
		}
	}
}

func TestMoltenParseRunOptions(t *testing.T) {
	opts, err := moltenParseRunOptions([]string{"--json", "--timeout", "5", "deploy", "--json", "-x", "arg"})
	if err != nil {
		t.Fatal(err)
	}
	if !opts.Json || opts.TimeoutSec != 5 || opts.Command != "deploy" || strings.Join(opts.Args, " ") != "--json -x arg" {
		t.Fatalf("unexpected options: %+v", opts)
	}
	opts, err = moltenParseRunOptions([]string{"--timeout=9", "x"})
	if err != nil || opts.TimeoutSec != 9 || opts.Json {
		t.Fatalf("unexpected options: %+v, %v", opts, err)
	}
	opts, err = moltenParseRunOptions(nil)
	if err != nil || opts.Command != "" || opts.TimeoutSec != MoltenRunDefaultTimeoutSec {
		t.Fatalf("unexpected options: %+v, %v", opts, err)
	}
	for _, bad := range [][]string{{"--timeout"}, {"--timeout", "0", "x"}, {"--timeout=abc"}, {"--verbose", "x"}} {
		if _, err := moltenParseRunOptions(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}

func TestMoltenStateFile(t *testing.T) {
	configDir := t.TempDir()
	state, err := moltenReadState(moltenStateFile(configDir))
	if err != nil || len(state.Enabled) != 0 {
		t.Fatalf("a missing state file means nothing enabled: %+v, %v", state, err)
	}
	changed, err := moltenSetEnabled(configDir, "b", true)
	if err != nil || !changed {
		t.Fatalf("enable b: %v %v", changed, err)
	}
	moltenSetEnabled(configDir, "a", true)
	changed, err = moltenSetEnabled(configDir, "a", true)
	if err != nil || changed {
		t.Fatalf("enabling twice must report no change: %v %v", changed, err)
	}
	data, _ := os.ReadFile(moltenStateFile(configDir))
	if string(data) != "{\n  \"enabled\": [\n    \"a\",\n    \"b\"\n  ]\n}\n" {
		t.Fatalf("unexpected state file: %q", data)
	}
	moltenSetEnabled(configDir, "a", false)
	state, _ = moltenReadState(moltenStateFile(configDir))
	if strings.Join(state.Enabled, ",") != "b" {
		t.Fatalf("unexpected enabled list: %q", state.Enabled)
	}
	os.WriteFile(moltenStateFile(configDir), []byte("{oops"), 0644)
	if _, err := moltenSetEnabled(configDir, "c", true); err == nil {
		t.Fatal("an invalid state file must be reported, not overwritten")
	}
}

func TestMoltenNewMod(t *testing.T) {
	configDir := t.TempDir()
	dir, err := moltenNewMod(configDir, "3d.view_x", "", "Test mod")
	if err != nil {
		t.Fatal(err)
	}
	var manifest MoltenTemplateManifest
	data, _ := os.ReadFile(filepath.Join(dir, "mod.json"))
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Id != "3d.view_x" || manifest.Name != "3d.view_x" || manifest.ApiVersion != 1 || manifest.Main != "main.js" {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
	main, _ := os.ReadFile(filepath.Join(dir, "main.js"))
	if !strings.Contains(string(main), `"mod-3d-view-x"`) || !strings.Contains(string(main), "export function activate(api)") {
		t.Fatalf("unexpected main.js:\n%s", main)
	}
	state, _ := moltenReadState(moltenStateFile(configDir))
	if len(state.Enabled) != 0 {
		t.Fatal("a new mod must stay disabled")
	}
	if _, err := moltenNewMod(configDir, "3d.view_x", "", ""); err == nil {
		t.Fatal("creating an existing mod must fail")
	}
	for _, bad := range []string{"../evil", "Upper", "", "a/b", ".hidden"} {
		if _, err := moltenNewMod(configDir, bad, "", ""); err == nil {
			t.Errorf("id %q should be refused", bad)
		}
	}
}

func TestMoltenExistingModDir(t *testing.T) {
	configDir := t.TempDir()
	os.MkdirAll(filepath.Join(configDir, "mods", "real"), 0755)
	os.WriteFile(filepath.Join(configDir, "mods", "file"), []byte("x"), 0644)
	if _, err := moltenExistingModDir(configDir, "real"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"missing", "file", "..", "../mods"} {
		if _, err := moltenExistingModDir(configDir, id); err == nil {
			t.Errorf("%q should be refused", id)
		}
	}
}

func TestMoltenRemoveMod(t *testing.T) {
	configDir := t.TempDir()
	dataDir := t.TempDir()
	trashDir := t.TempDir()
	now := time.Date(2026, 10, 1, 12, 30, 0, 0, time.UTC)
	for i := 0; i < 2; i++ {
		if _, err := moltenNewMod(configDir, "gone", "", ""); err != nil {
			t.Fatal(err)
		}
		moltenSetEnabled(configDir, "gone", true)
		moltenSetTrusted(dataDir, "gone", "Gone", now)
		dest, err := moltenRemoveMod(configDir, dataDir, trashDir, "gone", now)
		if err != nil {
			t.Fatal(err)
		}
		want := filepath.Join(trashDir, "gone")
		if i == 1 {
			want = filepath.Join(trashDir, "gone 2026-10-01 12.30.00")
		}
		if dest != want {
			t.Fatalf("removal %d went to %q, want %q", i, dest, want)
		}
		if _, err := os.Stat(filepath.Join(dest, "mod.json")); err != nil {
			t.Fatalf("the removed mod must be kept whole: %v", err)
		}
	}
	state, _ := moltenReadState(moltenStateFile(configDir))
	if len(state.Enabled) != 0 {
		t.Fatal("a removed mod must be disabled")
	}
	if trusted, _ := moltenIsTrusted(dataDir, "gone"); trusted {
		t.Fatal("removing a mod must forget that it was trusted")
	}
	moltenNewMod(configDir, "other", "", "")
	dest, err := moltenRemoveMod(configDir, dataDir, "", "other", now)
	if err != nil || dest != filepath.Join(dataDir, "molten", "removed", "other") {
		t.Fatalf("without a trash the mod goes under data: %q, %v", dest, err)
	}
	if _, err := moltenRemoveMod(configDir, dataDir, trashDir, "other", now); err == nil {
		t.Fatal("removing a missing mod must fail")
	}
}

func TestFormatMoltenValidation(t *testing.T) {
	out := formatMoltenValidation([]MoltenValidationResult{
		{Id: "good", Ok: true},
		{Id: "bad", Problems: []MoltenValidationProblem{
			{File: "main.js", Line: 3, Column: 7, Message: "Unexpected token"},
			{File: "mod.json", Message: "\"name\" must be a non-empty string"},
		}},
	})
	want := "good: ok\nbad: main.js:3:7: Unexpected token\nbad: mod.json: \"name\" must be a non-empty string\n"
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
	if formatMoltenValidation(nil) != "no mods to validate\n" {
		t.Fatal("empty validation output")
	}
}

func TestFormatMoltenHelpAndUnknown(t *testing.T) {
	out := formatMoltenHelp(&MoltenModList{Commands: []MoltenCommandInfo{{Name: "hello", ModId: "greet", Description: "Say hello"}}})
	if !strings.Contains(out, "mod validate [id...]") || !strings.Contains(out, "hello") || !strings.Contains(out, "(greet)") {
		t.Fatalf("unexpected help:\n%s", out)
	}
	if !strings.Contains(formatMoltenHelp(nil), "(none: enable a mod") {
		t.Fatal("help without mod commands")
	}
	if msg := formatMoltenUnknownCommand("x", []string{"a", "b"}); !strings.Contains(msg, "available: a, b") {
		t.Fatalf("unexpected message: %s", msg)
	}
}

// `molten --json mod list` puts the options before the subcommand; moltenRunModSubcommand finds it on moltenModCmd.
func TestMoltenModSubcommandAfterOptions(t *testing.T) {
	opts, err := moltenParseRunOptions([]string{"--json", "mod", "validate", "a", "b"})
	if err != nil || opts.Command != "mod" {
		t.Fatalf("unexpected options: %+v, %v", opts, err)
	}
	sub, rest, err := moltenModCmd.Find(opts.Args)
	if err != nil || sub != moltenModValidateCmd || strings.Join(rest, " ") != "a b" {
		t.Fatalf("found %q with %q (%v)", sub.Name(), rest, err)
	}
}

func TestMoltenUnknownModSubcommandFails(t *testing.T) {
	saved := WshExitCode
	defer func() { WshExitCode = saved }()
	WshExitCode = 0
	moltenModRun(moltenModCmd, []string{"nope"})
	if WshExitCode != 1 {
		t.Fatalf("an unknown mod subcommand must exit 1, got %d", WshExitCode)
	}
}

func TestMoltenTrustFile(t *testing.T) {
	dataDir := t.TempDir()
	now := time.Date(2026, 10, 1, 12, 30, 0, 0, time.FixedZone("CEST", 2*3600))
	if trusted, err := moltenIsTrusted(dataDir, "a"); err != nil || trusted {
		t.Fatalf("a missing trust file trusts nothing: %v %v", trusted, err)
	}
	if err := moltenSetTrusted(dataDir, "a", "Mod A", now); err != nil {
		t.Fatal(err)
	}
	moltenSetTrusted(dataDir, "b", "Mod B", now)
	trust, err := moltenReadTrust(moltenTrustFile(dataDir))
	if err != nil {
		t.Fatal(err)
	}
	if trust.Trusted["a"] != (MoltenTrustEntry{Name: "Mod A", TrustedAt: "2026-10-01T10:30:00Z"}) || len(trust.Trusted) != 2 {
		t.Fatalf("unexpected trust file: %+v", trust)
	}
	forgotten, err := moltenForgetTrust(dataDir, "a")
	if err != nil || !forgotten {
		t.Fatalf("forget a: %v %v", forgotten, err)
	}
	forgotten, _ = moltenForgetTrust(dataDir, "a")
	if forgotten {
		t.Fatal("forgetting twice must report no change")
	}
	if trusted, _ := moltenIsTrusted(dataDir, "b"); !trusted {
		t.Fatal("other mods keep their trust")
	}
	os.WriteFile(moltenTrustFile(dataDir), []byte("{oops"), 0644)
	if err := moltenSetTrusted(dataDir, "c", "C", now); err == nil {
		t.Fatal("an invalid trust file must be reported, not overwritten")
	}
}

func TestMoltenTrustAnswerError(t *testing.T) {
	if err := moltenTrustAnswerError("m", "trusted"); err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"declined": "was not trusted: it stays disabled",
		"timeout":  "no answer within 5 minutes",
		"maybe":    "unexpected answer",
	}
	for answer, want := range cases {
		err := moltenTrustAnswerError("m", answer)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("answer %q: got %v, want %q", answer, err, want)
		}
	}
}
