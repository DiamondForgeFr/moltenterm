// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

func noticeTexts(r mcpbrowser.CallResult) []string {
	var rtn []string
	for _, c := range r.Content {
		if strings.HasPrefix(c.Text, "Notice from MoltenTerm:") {
			rtn = append(rtn, c.Text)
		}
	}
	return rtn
}

func control(t *testing.T, m *Manager, action string) {
	t.Helper()
	if err := m.Control("tab:t1", ControlRequest{BlockId: userTab.PanelId, BrowserTabId: userTab.BrowserTabId, Action: action}); err != nil {
		t.Fatalf("%s: %v", action, err)
	}
}

// TC-971-5: the agent learns of a share in its next tool result, once, and tabs_context marks the tab until then.
func TestShareReachesTheAgentOnce(t *testing.T) {
	m, _, _ := makeWorld(t)
	sa := hello(t, m, "proc:a", "tok-a", "a")
	share(t, m, sa, false)
	r := call(m, "proc:a", sa, mcpbrowser.ToolTabsContext, `{}`)
	entry := sharedEntry(t, r)
	if entry.Note != noteSharedJustNow || entry.State != TabStateActive {
		t.Fatalf("a shared tab is active and marked: %+v", entry)
	}
	notices := noticeTexts(r)
	if len(notices) != 1 || !strings.Contains(notices[0], "shared tab 1 (bank.example) with you") ||
		!strings.Contains(notices[0], "rather than opening another tab") {
		t.Fatalf("the share notice rides on the next result: %q", text(r))
	}
	if r.Content[0].Text == notices[0] {
		t.Fatalf("the notice comes after the result's own content")
	}
	r = call(m, "proc:a", sa, mcpbrowser.ToolTabsContext, `{}`)
	if len(noticeTexts(r)) != 0 || sharedEntry(t, r).Note != "" {
		t.Fatalf("told once: %q", text(r))
	}
}

// TC-971-3, TC-971-4: Take over and Give back are the user's explicit acts; after Take over emain stops holding back
// the user's input, the agent's calls say to ask or wait, and Give back reaches the agent.
func TestTakeOverAndGiveBackReachTheAgent(t *testing.T) {
	m, env, _ := makeWorld(t)
	sa := hello(t, m, "proc:a", "tok-a", "a")
	share(t, m, sa, false)
	call(m, "proc:a", sa, mcpbrowser.ToolTabsContext, `{}`)
	env.SetControl(userTab, true)
	control(t, m, ControlTakeOver)
	if env.controlled(userTab) {
		t.Fatalf("after Take over the page is the user's again in emain")
	}
	r := call(m, "proc:a", sa, mcpbrowser.ToolGetPageText, `{"tabId":1}`)
	expectError(t, r, mcpbrowser.ErrTakenOver)
	if !strings.Contains(mcpbrowser.ErrTakenOver, "do not open another tab") {
		t.Fatalf("the takenover sentence tells the agent not to duplicate the tab: %q", mcpbrowser.ErrTakenOver)
	}
	if entry := sharedEntry(t, call(m, "proc:a", sa, mcpbrowser.ToolTabsContext, `{}`)); entry.State != TabStateTakenOver {
		t.Fatalf("tabs_context says the user uses the tab: %+v", entry)
	}
	control(t, m, ControlGiveBack)
	if !env.controlled(userTab) {
		t.Fatalf("Give back hands control back to emain")
	}
	r = call(m, "proc:a", sa, mcpbrowser.ToolTabsContext, `{}`)
	if entry := sharedEntry(t, r); entry.Note != noteGivenBack || entry.State != TabStateActive {
		t.Fatalf("given back: %+v", entry)
	}
	if notices := noticeTexts(r); len(notices) != 1 || !strings.Contains(notices[0], "gave tab 1 back to you") {
		t.Fatalf("the give back notice: %q", text(r))
	}
}

// TC-971-6: sharing again a tab the user took over from the same agent gives it back.
func TestShareAgainGivesATakenOverTabBack(t *testing.T) {
	m, env, _ := makeWorld(t)
	sa := hello(t, m, "proc:a", "tok-a", "a")
	share(t, m, sa, false)
	call(m, "proc:a", sa, mcpbrowser.ToolTabsContext, `{}`)
	control(t, m, ControlTakeOver)
	if res := share(t, m, sa, false); res.Result != ShareResultShared {
		t.Fatalf("share again: %+v", res)
	}
	if !env.controlled(userTab) {
		t.Fatalf("sharing again hands control back to emain")
	}
	r := call(m, "proc:a", sa, mcpbrowser.ToolTabsContext, `{}`)
	if entry := sharedEntry(t, r); entry.State != TabStateActive || entry.Note != noteGivenBack {
		t.Fatalf("the tab is active again: %+v", entry)
	}
	if len(noticeTexts(r)) != 1 {
		t.Fatalf("one notice: %q", text(r))
	}
	if res := share(t, m, sa, false); res.Result != ShareResultShared {
		t.Fatalf("sharing an active tab again changes nothing: %+v", res)
	}
	if len(noticeTexts(call(m, "proc:a", sa, mcpbrowser.ToolTabsContext, `{}`))) != 0 {
		t.Fatalf("no notice for a tab that was already the agent's")
	}
}

func TestNoticesStayBounded(t *testing.T) {
	s := &session{}
	for i := int64(1); i <= maxNotices+5; i++ {
		s.addNotice(i, noteSharedJustNow, sharedNotice(i, ""))
	}
	s.addNotice(maxNotices+5, noteGivenBack, givenBackNotice(maxNotices+5))
	if len(s.notices) != maxNotices || s.notices[len(s.notices)-1].note != noteGivenBack {
		t.Fatalf("bounded, one per tab, the latest kept: %d %+v", len(s.notices), s.notices[len(s.notices)-1])
	}
}
