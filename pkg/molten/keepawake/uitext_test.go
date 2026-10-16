// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"fmt"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The keep-awake sentences carry their codes for the windows (#656); the English stays what it was.

func TestDenyReasonText(t *testing.T) {
	cases := []struct {
		reason string
		code   string
		vars   map[string]string
	}{
		{"", "", nil},
		{reasonQuestion, "keepawake.deny.question", nil},
		{reasonKeychain, "keepawake.deny.keychain", nil},
		{reasonRemove + "/etc/x", "keepawake.deny.remove", map[string]string{"detail": "/etc/x"}},
		{reasonForcePush + "main", "keepawake.deny.forcepush", map[string]string{"detail": "main"}},
		{reasonCredential + "~/.ssh/id", "keepawake.deny.credential", map[string]string{"detail": "~/.ssh/id"}},
		{reasonOpaque + reasonTooDeep, "keepawake.deny.toodeep", nil},
		{reasonOpaque + "python" + reasonStdinDetail, "keepawake.deny.stdin", map[string]string{"program": "python"}},
		{reasonOpaque + "xargs", "keepawake.deny.opaque", map[string]string{"detail": "xargs"}},
		{"something else", "", nil},
	}
	for _, c := range cases {
		text := DenyReasonText(c.reason)
		if c.code == "" {
			if text != nil {
				t.Errorf("%q: got %+v, want none", c.reason, text)
			}
			continue
		}
		if text == nil || text.Code != c.code || fmt.Sprint(text.Vars) != fmt.Sprint(c.vars) {
			t.Errorf("%q: got %+v, want %s %v", c.reason, text, c.code, c.vars)
		}
	}
}

func TestReasonsText(t *testing.T) {
	list := []reason{
		agentReason(molten.AgentIdClaude, reasonAgentWorking),
		agentReason(molten.AgentIdCodex, reasonAgentBackground),
		commandReason(""),
		commandReason("npm test"),
		{rank: reasonMission, text: missionReason},
		commandReason("make"),
	}
	reasons := sortReasons(list)
	texts := reasonsText(reasons)
	if len(texts) != len(reasons) {
		t.Fatalf("%d texts for %d reasons", len(texts), len(reasons))
	}
	for i, text := range texts {
		if text == nil || text.Code == "" {
			t.Errorf("%q has no code", reasons[i])
		}
	}
	if last := texts[len(texts)-1]; last.Code != "keepawake.why.more" || last.Vars["count"] == "" {
		t.Fatalf("the last reason %q got %+v", reasons[len(reasons)-1], last)
	}
	if text := reasonsText([]string{"Command: npm test"})[0]; text.Code != "keepawake.why.command" || text.Vars["command"] != "npm test" {
		t.Fatalf("command: %+v", text)
	}
}

func TestSessionApprovalText(t *testing.T) {
	report := molten.AgentIntegrationReport{Agent: molten.AgentIdClaude}
	cases := []struct {
		agent     string
		remote    bool
		hasReport bool
		code      string
	}{
		{molten.AgentIdClaude, true, true, "keepawake.session.remote"},
		{"gemini", false, true, "keepawake.session.unsupported"},
		{molten.AgentIdClaude, false, false, "keepawake.session.nolauncher"},
		{molten.AgentIdClaude, false, true, "keepawake.session.tooold"},
	}
	for _, c := range cases {
		approved, english, text := SessionApprovalText(c.agent, c.remote, report, c.hasReport, false)
		wantApproved, wantEnglish := SessionApproval(c.agent, c.remote, report, c.hasReport, false)
		if approved != wantApproved || english != wantEnglish || text == nil || text.Code != c.code {
			t.Errorf("%+v: %v %q %+v", c, approved, english, text)
		}
	}
}
