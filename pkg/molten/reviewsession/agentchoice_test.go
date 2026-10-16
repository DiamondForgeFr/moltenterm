// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

// #845 AC2: the assisted review starts the project's chosen agent; a chosen agent that is not installed is reported
// with the installed ones, never replaced.
func TestStartHonoursTheProjectsAgent(t *testing.T) {
	repo := makeTestRepo(t)
	f := makeFakeWave()
	f.installed = map[string]bool{"claude": true, "codex": true}
	env := f.env(repo, t.TempDir())
	project := "codex"
	env.ProjectAgent = func(dir string) string {
		if dir == repo.project {
			return project
		}
		return ""
	}
	env.GlobalAgent = func() string { return "claude" }
	m := MakeManager(env)
	res, err := m.Start(context.Background(), "tab1", startReq(repo))
	if err != nil || res.Status != mcpreview.StatusStarted || res.Session.Agent != "codex" {
		t.Fatalf("start: %+v %v", res, err)
	}
	blockId := <-f.typedCh
	if !strings.HasPrefix(f.typed[blockId], "codex ") {
		t.Errorf("typed %q", f.typed[blockId])
	}
	if err := m.End(context.Background(), mcpreview.SessionKey{Id: res.Session.Id}); err != nil {
		t.Fatal(err)
	}
	f.installed = map[string]bool{"claude": true}
	res, err = m.Start(context.Background(), "tab1", startReq(repo))
	if err != nil || res.Status != mcpreview.StatusNoAgent || res.Reason != mcpreview.ReasonAgentMissing || res.AgentName != "Codex" ||
		!reflect.DeepEqual(res.Installed, []string{"claude"}) {
		t.Fatalf("missing: %+v %v", res, err)
	}
	req := startReq(repo)
	req.Agent = "claude"
	res, err = m.Start(context.Background(), "tab1", req)
	if err != nil || res.Status != mcpreview.StatusStarted || res.Session.Agent != "claude" {
		t.Fatalf("the developer's pick: %+v %v", res, err)
	}
	<-f.typedCh
}
