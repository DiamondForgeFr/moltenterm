// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentchoice

import (
	"reflect"
	"slices"
	"testing"
)

// #2392: the companion's ticket sentences come from the text they are given alone. Claude Code runs with no built-in
// tool (--tools "") on top of every guard of the quick form and a deny list of every reading tool; Codex, whose shell
// no documented switch takes away, and the agents without a quick form have no text-only form.
func TestTextOnlyPrintArgv(t *testing.T) {
	quick := QuickPrintArgv("claude", "/p")
	got := TextOnlyPrintArgv("claude", "/p")
	want := append([]string{"claude", "-p", "--tools", ""}, quick[2:]...)
	want = append(want, ClaudeNoReadTools...)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("claude: %q", got)
	}
	deny := slices.Index(got, "--disallowed-tools")
	if deny < 0 || slices.Index(got, "--tools") > deny {
		t.Errorf("--tools must come before --disallowed-tools, which takes every argument after it: %q", got)
	}
	for _, tool := range []string{"Bash", "Read", "Glob", "Grep", "WebFetch", "Skill", "ToolSearch", "Agent"} {
		if !slices.Contains(got[deny+1:], tool) {
			t.Errorf("%s is not denied: %q", tool, got)
		}
	}
	for _, id := range []string{"codex", "kimi", "gemini"} {
		if TextOnlyPrintArgv(id, "/p") != nil {
			t.Errorf("%s has no text-only form", id)
		}
	}
}

func TestTextOnlyEnvKeepsOnlyWhatTheRunNeeds(t *testing.T) {
	environ := []string{
		"HOME=/home/me", "USER=me", "LANG=fr_FR.UTF-8", "PATH=/usr/bin",
		"ANTHROPIC_API_KEY=sk-test", "OPENAI_API_KEY=sk-other", "WAVETERM_JWT=secret", "GITHUB_TOKEN=gh-secret",
		"MOLTENTERM_DATA_HOME=/data", "SSH_AUTH_SOCK=/tmp/agent.sock", "broken",
	}
	got := TextOnlyEnv("claude", environ, "/login/bin:/usr/bin")
	want := []string{"PATH=/login/bin:/usr/bin", "HOME=/home/me", "USER=me", "LANG=fr_FR.UTF-8", "ANTHROPIC_API_KEY=sk-test"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("env: %q, want %q", got, want)
	}
}
