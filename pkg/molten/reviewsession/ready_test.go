// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// #638: while a just-started session's agent is starting (tools not connected, or connected but its hooks not reported
// yet), Ask, Discuss and Translate type nothing and say Starting; once it is ready, or after the grace periods, they
// type as before.
func TestTypeWaitsForStartingAgent(t *testing.T) {
	repo := makeTestRepo(t)
	f := makeFakeWave()
	env := f.env(repo, t.TempDir())
	var lock sync.Mutex
	now := time.UnixMilli(1_000_000)
	env.Now = func() time.Time {
		lock.Lock()
		defer lock.Unlock()
		return now
	}
	advance := func(d time.Duration) {
		lock.Lock()
		defer lock.Unlock()
		now = now.Add(d)
	}
	hooked := false
	env.AgentHooked = func(blockId string) bool { return hooked }
	var typed []string
	env.TypePrompt = func(ctx context.Context, blockId string, line string) TypeOutcome {
		typed = append(typed, line)
		return TypeOutcome{Sent: true, Submitted: true}
	}
	m := MakeManager(env)
	ctx := context.Background()
	key := mcpreview.SessionKey{Repo: "Owner/Repo", Number: 7}
	if _, err := m.Start(ctx, "", startReq(repo)); err != nil {
		t.Fatal(err)
	}
	blockId := <-f.typedCh
	anchor := &mcpreview.Anchor{Path: "main.go", Side: mcpreview.SideRight, Line: 3, HeadOid: repo.head, Excerpt: "func main() {"}
	comment := mcpreview.CommentRef{Id: "c-1", Kind: mcpreview.KindComment, Subject: "line", Text: "Pourquoi ?", Lang: "fr"}
	translate := mcpreview.TranslateRequest{SessionKey: key, Lang: "en", Items: []mcpreview.TranslateItem{{Id: "c-1", Text: "Pourquoi ?"}}}
	sendAll := func() []mcpreview.AskResult {
		ask, err1 := m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Question: "why?"})
		discuss, err2 := m.Discuss(ctx, mcpreview.DiscussRequest{SessionKey: key, Anchor: anchor, Comment: comment, Message: "ok?"})
		tr, err3 := m.Translate(ctx, translate)
		if err1 != nil || err2 != nil || err3 != nil {
			t.Fatalf("errors %v %v %v", err1, err2, err3)
		}
		return []mcpreview.AskResult{ask, discuss, tr}
	}
	held := func(step string) {
		t.Helper()
		for i, out := range sendAll() {
			if !out.Starting || out.Sent || out.Queued || out.Busy || !strings.Contains(out.Message, "is starting") {
				t.Errorf("%s: action %d %+v", step, i, out)
			}
		}
		if len(typed) != 0 {
			t.Errorf("%s: typed %q", step, typed)
		}
	}
	held("tools not connected")
	if q := m.find(key).questions; len(q) != 0 {
		t.Errorf("a starting agent's question was queued: %+v", q)
	}

	token := f.blocks[blockId].Meta.GetMap(waveobj.MetaKey_CmdEnv).GetString(mcpreview.SessionTokenVarName, "")
	if _, err := m.Hello(ctx, "proc:5", mcpreview.HelloRequest{Token: "jwt-" + blockId, SessionToken: token}); err != nil {
		t.Fatal(err)
	}
	advance(2 * time.Second)
	held("connected, hooks not reported")

	hooked = true
	for i, out := range sendAll() {
		if out.Starting || !out.Sent || !out.Submitted {
			t.Errorf("ready: action %d %+v", i, out)
		}
	}
	if len(typed) != 3 {
		t.Errorf("ready: typed %q", typed)
	}

	// An agent without hooks gets the line once its tools have been connected for hookGrace.
	hooked = false
	typed = nil
	advance(hookGrace)
	if out := sendAll(); !out[0].Sent || len(typed) != 3 {
		t.Errorf("no hooks: %+v typed %q", out, typed)
	}
	m.End(ctx, key)
}

// #638: an agent whose tools never connect still gets the line after readyGrace from the session's start.
func TestTypeAfterReadyGrace(t *testing.T) {
	repo := makeTestRepo(t)
	f := makeFakeWave()
	env := f.env(repo, t.TempDir())
	var lock sync.Mutex
	now := time.UnixMilli(1_000_000)
	env.Now = func() time.Time {
		lock.Lock()
		defer lock.Unlock()
		return now
	}
	env.AgentHooked = func(blockId string) bool { return false }
	env.TypePrompt = func(ctx context.Context, blockId string, line string) TypeOutcome {
		return TypeOutcome{Sent: true}
	}
	m := MakeManager(env)
	ctx := context.Background()
	key := mcpreview.SessionKey{Repo: "Owner/Repo", Number: 7}
	if _, err := m.Start(ctx, "", startReq(repo)); err != nil {
		t.Fatal(err)
	}
	<-f.typedCh
	if out, _ := m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Question: "why?"}); !out.Starting {
		t.Errorf("starting %+v", out)
	}
	lock.Lock()
	now = now.Add(readyGrace)
	lock.Unlock()
	if out, _ := m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Question: "why?"}); out.Starting || !out.Sent {
		t.Errorf("after the grace %+v", out)
	}
	m.End(ctx, key)
}
