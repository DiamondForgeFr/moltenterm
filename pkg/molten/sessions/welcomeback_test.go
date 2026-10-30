// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const wbClosed = int64(1_000_000_000)
const wbNow = wbClosed + int64(10*time.Minute/time.Millisecond)

func wbSession(id string, patch func(*molten.DurableSession)) molten.DurableSession {
	s := molten.DurableSession{
		Id:            id,
		StartedAt:     wbClosed - int64(2*time.Hour/time.Millisecond),
		WorkspaceId:   "ws1",
		WorkspaceName: "moltenterm",
		TabId:         "tab1",
		BlockId:       "block-" + id,
		Folder:        "/home/u/moltenterm",
		Command:       "zsh at prompt",
	}
	if patch != nil {
		patch(&s)
	}
	return s
}

func intPtr(v int) *int { return &v }

func TestBuildWelcomeBackNothing(t *testing.T) {
	sessions := []molten.DurableSession{wbSession("a", nil)}
	if wb := BuildWelcomeBack(WelcomeBackFacts{ClosedAt: 0, Now: wbNow, Sessions: sessions}); wb.Survived != 0 || len(wb.Lines) != 0 {
		t.Errorf("first start told %+v", wb)
	}
	started := []molten.DurableSession{wbSession("b", func(s *molten.DurableSession) { s.StartedAt = wbClosed + 5 })}
	wb := BuildWelcomeBack(WelcomeBackFacts{ClosedAt: wbClosed, Now: wbNow, Sessions: started})
	if wb.Survived != 0 {
		t.Errorf("a session started after the start counted as survived: %+v", wb)
	}
	if _, ok := WelcomeBackNotification(wb, wbNow); ok {
		t.Error("a notification with nothing to say")
	}
}

func TestBuildWelcomeBackOrderAndText(t *testing.T) {
	sessions := []molten.DurableSession{
		wbSession("quiet", nil),
		wbSession("prompt-output", nil),
		wbSession("build", func(s *molten.DurableSession) { s.Command = "npm run build" }),
		wbSession("done", func(s *molten.DurableSession) {
			s.Agent, s.AgentName, s.AgentState = "claude", "Claude Code", molten.AgentStateDone
			s.Worktree = &molten.SessionWorktree{Path: "/wt/x", Branch: "feature/12-x"}
		}),
		wbSession("waiting", func(s *molten.DurableSession) {
			s.Agent, s.AgentName, s.AgentState = "codex", "Codex", molten.AgentStateWaiting
		}),
	}
	exited := []ExitedJob{
		{Job: &waveobj.Job{OID: "ok", Cmd: "/bin/zsh", CmdStartTs: wbClosed - 1000, CmdExitTs: wbClosed + 10, CmdExitCode: intPtr(0)}, WorkspaceName: "site"},
		{Job: &waveobj.Job{OID: "bad", Cmd: "/bin/zsh", CmdStartTs: wbClosed - 1000, CmdExitTs: wbClosed + 10, CmdExitCode: intPtr(2)}, WorkspaceName: "site"},
		{Job: &waveobj.Job{OID: "before", Cmd: "/bin/zsh", CmdStartTs: wbClosed - 1000, CmdExitTs: wbClosed - 10, CmdExitCode: intPtr(0)}},
	}
	wb := BuildWelcomeBack(WelcomeBackFacts{
		ClosedAt:     wbClosed,
		Now:          wbNow,
		Sessions:     sessions,
		OutputGrowth: map[string]int64{"prompt-output": 40, "build": 900},
		Exited:       exited,
	})
	if wb.Survived != 5 {
		t.Errorf("survived %d", wb.Survived)
	}
	got := []string{}
	for _, line := range wb.Lines {
		got = append(got, line.JobId+":"+line.News)
	}
	want := "bad:failed waiting:waiting done:finished ok:exited build:output"
	if strings.Join(got, " ") != want {
		t.Errorf("lines %v, want %s", got, want)
	}
	done := wb.Lines[2]
	if done.Text != "moltenterm · Claude Code · in feature/12-x, running for 2 h 10 min: finished" {
		t.Errorf("text %q", done.Text)
	}
	if !strings.Contains(wb.Lines[0].Text, "exited with status 2") {
		t.Errorf("failed exit text %q", wb.Lines[0].Text)
	}

	input, ok := WelcomeBackNotification(wb, 42)
	if !ok {
		t.Fatal("no notification")
	}
	if input.Title != "5 sessions kept running while MoltenTerm was closed" || input.Kind != "warning" || input.Key != welcomeBackKeyPrefix+"42" {
		t.Errorf("notification %+v", input)
	}
	if strings.Count(input.Message, "; ") != len(wb.Lines)-1 {
		t.Errorf("message %q", input.Message)
	}
	if len(input.Actions) != 3 || input.Actions[0].Args["id"] != "waiting" || input.Actions[1].Args["id"] != "done" || input.Actions[2].Gesture != OpenSessionsGesture {
		t.Errorf("actions %+v", input.Actions)
	}
	// The windows word the title and the buttons by their codes (#656).
	if input.TitleText == nil || input.TitleText.Code != "sessions.welcomeback.keptother" || input.TitleText.Vars["count"] != "5" {
		t.Errorf("title text %+v", input.TitleText)
	}
	if input.Actions[0].LabelText == nil || input.Actions[0].LabelText.Code != "sessions.welcomeback.show" || input.Actions[2].LabelText.Code != "sessions.welcomeback.open" {
		t.Errorf("action texts %+v %+v", input.Actions[0].LabelText, input.Actions[2].LabelText)
	}
	if len(input.Actions) > molten.MaxNotificationActions {
		t.Errorf("%d actions over the cap", len(input.Actions))
	}
	// The message's code, worded with the English dictionary, is the English message (#750).
	en := loadWbLocale(t, "en")
	if got := wordWb(t, en, input.MessageText); got != input.Message {
		t.Errorf("worded message\n%q\nwant\n%q", got, input.Message)
	}
	fr := loadWbLocale(t, "fr")
	if got := wordWb(t, fr, done.TextText); got != "moltenterm · Claude Code · dans feature/12-x, en cours depuis 2 h 10 min\u00a0: terminé" {
		t.Errorf("French line %q", got)
	}
}

func loadWbLocale(t *testing.T, code string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "frontend", "moltenterm-shell", "i18n", "locales", code+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var dict map[string]any
	if err := json.Unmarshal(raw, &dict); err != nil {
		t.Fatal(err)
	}
	return dict
}

var wbPlaceholder = regexp.MustCompile(`\{(\w+)\}`)

// wordWb words a Text as frontend/moltenterm-shell/i18n/server-text.ts does.
func wordWb(t *testing.T, dict map[string]any, text *uimsg.Text) string {
	t.Helper()
	if text == nil {
		t.Fatal("no text")
	}
	var cur any = dict["server"]
	for _, part := range strings.Split(text.Code, ".") {
		m, _ := cur.(map[string]any)
		cur = m[part]
	}
	template, ok := cur.(string)
	if !ok {
		t.Fatalf("no sentence for %s", text.Code)
	}
	vars := map[string]string{}
	for k, v := range text.Vars {
		vars[k] = v
	}
	for k, p := range text.Parts {
		vars[k] = wordWb(t, dict, p)
	}
	return wbPlaceholder.ReplaceAllStringFunc(template, func(whole string) string {
		if v, ok := vars[whole[1:len(whole)-1]]; ok {
			return v
		}
		return whole
	})
}

func TestWelcomeBackDurationTexts(t *testing.T) {
	en := loadWbLocale(t, "en")
	for _, d := range []time.Duration{20 * time.Second, 3 * time.Minute, 2 * time.Hour, 2*time.Hour + 5*time.Minute, 50 * time.Hour} {
		ms := int64(d / time.Millisecond)
		if got := wordWb(t, en, runForText(ms)); got != FormatRunFor(ms) {
			t.Errorf("%v: worded %q, English %q", d, got, FormatRunFor(ms))
		}
	}
}

func TestWelcomeBackOnlyEnded(t *testing.T) {
	wb := BuildWelcomeBack(WelcomeBackFacts{
		ClosedAt: wbClosed,
		Now:      wbNow,
		Exited:   []ExitedJob{{Job: &waveobj.Job{OID: "x", Cmd: "/bin/bash", CmdStartTs: wbClosed - 1, CmdExitTs: wbClosed + 1, CmdExitSignal: "SIGKILL"}}},
	})
	input, ok := WelcomeBackNotification(wb, 1)
	if !ok || input.Title != "1 session ended while MoltenTerm was closed" {
		t.Errorf("notification %+v", input)
	}
	if !strings.Contains(input.Message, "ended by SIGKILL") {
		t.Errorf("message %q", input.Message)
	}
}

func TestFormatRunFor(t *testing.T) {
	cases := map[time.Duration]string{
		30 * time.Second:            "under a minute",
		12 * time.Minute:            "12 min",
		3 * time.Hour:               "3 h",
		3*time.Hour + 5*time.Minute: "3 h 5 min",
		50 * time.Hour:              "2 d",
	}
	for d, want := range cases {
		if got := FormatRunFor(int64(d / time.Millisecond)); got != want {
			t.Errorf("%v: %q, want %q", d, got, want)
		}
	}
}

func TestAliveFile(t *testing.T) {
	dir := t.TempDir()
	if readAlive(dir) != 0 {
		t.Error("a heartbeat before any was written")
	}
	if err := writeAlive(dir, 1234); err != nil {
		t.Fatal(err)
	}
	if got := readAlive(dir); got != 1234 {
		t.Errorf("read %d", got)
	}
}
