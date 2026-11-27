// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func kimiMainToolLine(name string, args map[string]string) string {
	data, _ := json.Marshal(args)
	return `{"type":"context.append_loop_event","agentId":"main","event":{"type":"tool.call","toolCallId":"c","name":` +
		strconvQuote(name) + `,"args":` + string(data) + `}}`
}

// #2572: a Kimi Code session that started in the main checkout and works in a ticket's worktree beside the project
// (../MoltenTerm-1984) is placed there, as a Claude Code or a Codex session is: its panel is then the worktree's
// holder, named and linked, never "an agent" with nowhere to go.
func TestKimiMainSessionFollowsItsToolCalls(t *testing.T) {
	f := makeSiblingTreeFixture(t)
	for _, test := range []struct {
		name  string
		lines []string
		want  string
	}{
		{name: "nothing but its start folder", want: f.main},
		{
			name:  "a shell call's cwd in the sibling worktree",
			lines: []string{kimiToolCwdRecord("main", "args", f.sibling)},
			want:  f.sibling,
		},
		{
			name:  "a shell call's cwd under display",
			lines: []string{kimiToolCwdRecord("main", "display", filepath.Join(f.sibling, "src"))},
			want:  f.sibling,
		},
		{
			name:  "git -C the sibling worktree",
			lines: []string{kimiMainToolLine("Bash", map[string]string{"command": "git -C " + f.sibling + " commit -F msg.txt"})},
			want:  f.sibling,
		},
		{
			name:  "an edit of a file of the sibling worktree",
			lines: []string{kimiMainToolLine("Edit", map[string]string{"path": filepath.Join(f.sibling, "src", "app.ts")})},
			want:  f.sibling,
		},
		{
			name: "back in its own checkout",
			lines: []string{
				kimiToolCwdRecord("main", "args", f.sibling),
				kimiToolCwdRecord("main", "args", f.main),
			},
			want: f.main,
		},
		{
			name: "another repository says nothing",
			lines: []string{
				kimiToolCwdRecord("main", "args", f.sibling),
				kimiToolCwdRecord("main", "args", f.other),
			},
			want: f.sibling,
		},
		{
			name:  "a sub-agent's call is not the session's",
			lines: []string{kimiToolCwdRecord("agent-1", "args", f.sibling)},
			want:  f.main,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, session := writeKimiFixture(t, f.main)
			if len(test.lines) > 0 {
				writeLines(t, session, test.lines...)
			}
			got, ok := MakeKimiAdapter(nil).WorkFolder(session)
			if !ok || got != test.want {
				t.Errorf("work folder: %q %v, want %q", got, ok, test.want)
			}
		})
	}
}
