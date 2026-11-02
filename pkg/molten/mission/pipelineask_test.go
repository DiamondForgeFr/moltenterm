// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
)

type fakeAsk struct {
	lock    sync.Mutex
	running bool
	sent    []agenthandoff.AppRequest
}

func (f *fakeAsk) setRunning(on bool) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.running = on
}

func (f *fakeAsk) env(guide string) pipelineAskEnv {
	return pipelineAskEnv{
		running: func(string) bool {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.running
		},
		send: func(_ context.Context, req agenthandoff.AppRequest) (agenthandoff.AppSent, error) {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.sent = append(f.sent, req)
			return agenthandoff.AppSent{Status: agenthandoff.StatusTyped, To: "Olivia"}, nil
		},
		guide: func() string { return guide },
		poll:  time.Millisecond,
	}
}

// No agent in the terminal: nothing is sent, the window starts one first.
func TestPipelineAskWithoutAgent(t *testing.T) {
	f := &fakeAsk{}
	got, err := askPipelineAgent(context.Background(), f.env(""), PipelineAskRequest{BlockId: "term", Dir: "/work/app"})
	if err != nil || got.Status != PipelineAskNoAgent || len(f.sent) != 0 {
		t.Fatalf("got %+v, %v, sent %d", got, err, len(f.sent))
	}
}

// A running agent is reused: the screen's context and the guide go to it.
func TestPipelineAskReusesTheAgent(t *testing.T) {
	f := &fakeAsk{running: true}
	got, err := askPipelineAgent(context.Background(), f.env("/data/pipeline-brief/pipeline-writing-guide.md"),
		PipelineAskRequest{BlockId: "term", Dir: "/work/app", Project: "App", Context: "Step 4: the validation request."})
	if err != nil || got.Status != PipelineAskSent || got.Delivery != agenthandoff.StatusTyped || got.To != "Olivia" {
		t.Fatalf("got %+v, %v", got, err)
	}
	req := f.sent[0]
	if req.ToBlockId != "term" || req.Context != "Step 4: the validation request." {
		t.Errorf("request: %+v", req)
	}
	if !strings.Contains(req.Goal, "App") || !strings.Contains(req.Goal, "pipeline-writing-guide.md") {
		t.Errorf("goal: %q", req.Goal)
	}
}

// Without a guide in this build the request still goes, without naming one.
func TestPipelineAskWithoutGuide(t *testing.T) {
	f := &fakeAsk{running: true}
	if _, err := askPipelineAgent(context.Background(), f.env(""), PipelineAskRequest{BlockId: "term", Dir: "/work/app"}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(f.sent[0].Goal, "First read") || !strings.Contains(f.sent[0].Goal, "app") {
		t.Errorf("goal: %q", f.sent[0].Goal)
	}
}

// Wait: an agent just started is waited for, then asked.
func TestPipelineAskWaitsForTheAgent(t *testing.T) {
	f := &fakeAsk{}
	done := make(chan PipelineAskResult, 1)
	go func() {
		got, err := askPipelineAgent(context.Background(), f.env(""), PipelineAskRequest{BlockId: "term", Dir: "/work/app", Wait: true})
		if err != nil {
			t.Errorf("ask: %v", err)
		}
		done <- got
	}()
	f.setRunning(true)
	if got := <-done; got.Status != PipelineAskSent {
		t.Fatalf("got %+v", got)
	}
}

func TestPipelineAskGivesUpWhenNoAgentShows(t *testing.T) {
	f := &fakeAsk{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := askPipelineAgent(ctx, f.env(""), PipelineAskRequest{BlockId: "term", Dir: "/work/app", Wait: true}); err == nil {
		t.Fatal("asked although no agent ran")
	}
	if len(f.sent) != 0 {
		t.Errorf("sent %d", len(f.sent))
	}
}

func TestPipelineAskChecks(t *testing.T) {
	f := &fakeAsk{running: true}
	bad := []PipelineAskRequest{
		{Dir: "/work/app"},
		{BlockId: "term", Dir: "work/app"},
		{BlockId: "term", Dir: "/work/app", Context: strings.Repeat("x", maxPipelineAskChars+1)},
	}
	for _, req := range bad {
		if _, err := askPipelineAgent(context.Background(), f.env(""), req); err == nil {
			t.Errorf("accepted %+v", req)
		}
	}
}

func TestPipelineBriefDir(t *testing.T) {
	if got := pipelineBriefDir("/data/cache/setup-answers"); got != "/data/cache/pipeline-brief" {
		t.Errorf("got %q", got)
	}
}
