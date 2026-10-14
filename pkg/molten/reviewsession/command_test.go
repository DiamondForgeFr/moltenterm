// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

// FR-REV-004 AC3: Claude Code runs with the editing tools, gh and git push denied, in the default mode set over the
// user's, with molten-review alone and allowed, and the review guide.
func TestClaudeReviewArgs(t *testing.T) {
	args := ClaudeReviewArgs("/data/molten/agent-launch/review-mcp-x.json", "/data/guide.md")
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"--permission-mode default", "--strict-mcp-config", "--mcp-config=/data/molten/agent-launch/review-mcp-x.json",
		"--allowedTools mcp__molten-review", "--append-system-prompt-file /data/guide.md",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in %q", want, joined)
		}
	}
	deny := slices.Index(args, "--disallowedTools")
	if deny < 0 {
		t.Fatalf("no --disallowedTools in %q", joined)
	}
	for i, tool := range []string{"Edit", "Write", "NotebookEdit", "Bash(gh *)", "Bash(git push *)"} {
		if args[deny+1+i] != tool {
			t.Errorf("denied tool %d: %q, want %q", i, args[deny+1+i], tool)
		}
	}
	// The variadic --disallowedTools ends at the next option.
	if next := args[deny+1+len(ClaudeDeniedTools)]; !strings.HasPrefix(next, "--") {
		t.Errorf("the denied tools are followed by %q", next)
	}
	data, err := claudeReviewMcpJSON("/data/bin/molten")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		McpServers map[string]struct {
			Type    string   `json:"type"`
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &doc); err != nil || len(doc.McpServers) != 1 {
		t.Fatalf("mcp config %s: %v", data, err)
	}
	server := doc.McpServers[mcpreview.ServerName]
	if server.Type != "stdio" || server.Command != "/data/bin/molten" || strings.Join(server.Args, " ") != "mcp review" {
		t.Errorf("server %+v", server)
	}
}

// FR-REV-004 AC3: Codex runs in the read-only sandbox, with molten-review in place of the user's servers, the two
// environment variables the server needs forwarded, and the guide as developer instructions; every -c value is TOML.
func TestCodexReviewArgs(t *testing.T) {
	guide := "# Review\nDo not \"push\".\\"
	args := CodexReviewArgs("/Users/me/Library/Application Support/moltenterm/bin/molten", guide)
	if args[0] != "--sandbox" || args[1] != "read-only" {
		t.Fatalf("args %q", args)
	}
	var values []string
	for i, a := range args {
		if a == "-c" {
			values = append(values, args[i+1])
		}
	}
	if len(values) != 2 {
		t.Fatalf("-c values %q", values)
	}
	var servers struct {
		McpServers map[string]struct {
			Command string   `toml:"command"`
			Args    []string `toml:"args"`
			EnvVars []string `toml:"env_vars"`
		} `toml:"mcp_servers"`
	}
	if _, err := toml.Decode(values[0], &servers); err != nil {
		t.Fatalf("%q: %v", values[0], err)
	}
	server, ok := servers.McpServers[mcpreview.ServerName]
	if !ok || len(servers.McpServers) != 1 || server.Command != "/Users/me/Library/Application Support/moltenterm/bin/molten" ||
		strings.Join(server.Args, " ") != "mcp review" || !slices.Contains(server.EnvVars, mcpreview.SessionTokenVarName) ||
		!slices.Contains(server.EnvVars, "WAVETERM_JWT") {
		t.Errorf("servers %+v", servers)
	}
	var instructions struct {
		DeveloperInstructions string `toml:"developer_instructions"`
	}
	if _, err := toml.Decode(values[1], &instructions); err != nil || instructions.DeveloperInstructions != guide {
		t.Errorf("instructions %q: %v", instructions.DeveloperInstructions, err)
	}
}

func TestCommandLineQuoting(t *testing.T) {
	line := CommandLine("claude", []string{"--mcp-config=/a b/c.json", "Bash(gh *)", "Edit", "it's"})
	want := `claude '--mcp-config=/a b/c.json' 'Bash(gh *)' Edit 'it'"'"'s'`
	if line != want {
		t.Errorf("got  %s\nwant %s", line, want)
	}
}
