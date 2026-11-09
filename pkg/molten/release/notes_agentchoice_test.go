// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package release

import (
	"bytes"
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentchoice"
)

// #845: without versions.notesagent, the notes are written by the project's coding agent in its non-interactive form;
// a chosen agent that is not installed is said, and the notes come from the commit subjects.
func TestNotesAgentFollowsTheProjectsCodingAgent(t *testing.T) {
	serialTest(t, "sets the variables of the notes agent and of the chosen coding agent in the process environment")
	ctx := context.Background()
	for _, k := range []string{NotesAiEnv, NotesAgentEnv, agentchoice.EnvVar, agentchoice.MissingEnvVar} {
		t.Setenv(k, "")
	}
	var out bytes.Buffer
	e := &Env{Dir: "/p", Out: &out}
	if argv := e.notesAgent(ctx, &Project{}, ""); argv != nil {
		t.Fatalf("outside MoltenTerm, nothing declared: %v", argv)
	}
	if argv := e.notesAgent(ctx, &Project{NotesAgent: []string{"my-agent"}}, ""); !reflect.DeepEqual(argv, []string{"my-agent"}) {
		t.Errorf("the project's command first: %v", argv)
	}
	t.Setenv(agentchoice.EnvVar, "codex")
	// #2121: read-only, the release worktree and the project untrusted so their .codex/ does not load.
	wantCodex := []string{"codex", "exec", "--sandbox", "read-only", "-c", "mcp_servers={}",
		"-c", `projects={"/wt"={trust_level="untrusted"},"/p"={trust_level="untrusted"}}`, "-"}
	if argv := e.notesAgent(ctx, &Project{}, "/wt"); !reflect.DeepEqual(argv, wantCodex) {
		t.Errorf("Mission Control's agent: %v", argv)
	}
	t.Setenv(agentchoice.EnvVar, "")
	t.Setenv(agentchoice.MissingEnvVar, "codex")
	if argv := e.notesAgent(ctx, &Project{}, ""); argv != nil || !strings.Contains(out.String(), "Codex, the coding agent chosen for this project, is not installed") {
		t.Errorf("missing: %v %q", argv, out.String())
	}
	t.Setenv(agentchoice.MissingEnvVar, "")
	asked := ""
	e.CodingAgent = func(ctx context.Context, dir string) (agentchoice.Choice, bool) {
		asked = dir
		return agentchoice.Choice{Agent: "claude", Source: agentchoice.SourceProject, Chosen: "claude"}, true
	}
	wantClaude := []string{"claude", "-p", "--setting-sources", "user", "--strict-mcp-config",
		"--disallowed-tools", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"}
	if argv := e.notesAgent(ctx, &Project{}, "/wt"); !reflect.DeepEqual(argv, wantClaude) || asked != "/p" {
		t.Errorf("a terminal asks MoltenTerm: %v %q", argv, asked)
	}
	t.Setenv(NotesAiEnv, "off")
	if argv := e.notesAgent(ctx, &Project{}, ""); argv != nil {
		t.Errorf("off: %v", argv)
	}
}
