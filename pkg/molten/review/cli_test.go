// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

type handoffFake struct {
	agent     bool
	remote    bool
	published []Handoff
	scopes    []string
}

func (f *handoffFake) env() HandoffEnv {
	return HandoffEnv{
		VerifyToken: func(token string) (string, error) {
			if token != "good" {
				return "", errors.New("bad token")
			}
			return "block-1", nil
		},
		BlockIsLocal: func(ctx context.Context, blockId string) bool { return !f.remote },
		WorkspaceOf:  func(ctx context.Context, blockId string) (string, error) { return "ws-1", nil },
		AgentRunning: func(blockId string) bool { return f.agent },
		Publish: func(workspaceId string, h Handoff) {
			f.scopes = append(f.scopes, workspaceId)
			f.published = append(f.published, h)
		},
	}
}

func handoffReq(action string) HandoffRequest {
	return HandoffRequest{Token: "good", Action: action, Dir: "/p", Number: 7}
}

func TestHandoffReachesTheTerminalsWorkspace(t *testing.T) {
	f := &handoffFake{}
	for _, action := range []string{HandoffOpen, HandoffPublish, HandoffMerge} {
		res, err := RunHandoff(context.Background(), f.env(), handoffReq(action))
		if err != nil || res.WorkspaceId != "ws-1" || res.At == 0 {
			t.Fatalf("%s: %+v %v", action, res, err)
		}
	}
	if len(f.published) != 3 || f.scopes[0] != "ws-1" || f.published[1].Action != HandoffPublish || f.published[2].Number != 7 {
		t.Errorf("published: %+v %v", f.published, f.scopes)
	}
}

func TestHandoffRefusals(t *testing.T) {
	cases := []struct {
		name string
		fake handoffFake
		req  HandoffRequest
		want string
	}{
		{"agent publish", handoffFake{agent: true}, handoffReq(HandoffPublish), "runs an agent"},
		{"agent merge", handoffFake{agent: true}, handoffReq(HandoffMerge), "runs an agent"},
		{"remote", handoffFake{remote: true}, handoffReq(HandoffOpen), "local MoltenTerm terminals"},
		{"no token", handoffFake{}, HandoffRequest{Action: HandoffOpen, Dir: "/p", Number: 7}, "WAVETERM_JWT"},
		{"bad token", handoffFake{}, HandoffRequest{Token: "bad", Action: HandoffOpen, Dir: "/p", Number: 7}, "not valid"},
		{"cleanup", handoffFake{}, handoffReq("cleanup"), "unknown review action"},
		{"restart", handoffFake{}, handoffReq("restart"), "unknown review action"},
		{"relative dir", handoffFake{}, HandoffRequest{Token: "good", Action: HandoffOpen, Dir: "p", Number: 7}, "absolute"},
		{"no number", handoffFake{}, HandoffRequest{Token: "good", Action: HandoffOpen, Dir: "/p"}, "number"},
	}
	for _, c := range cases {
		f := c.fake
		_, err := RunHandoff(context.Background(), f.env(), c.req)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.name, err)
		}
		if len(f.published) != 0 {
			t.Errorf("%s: the window was asked", c.name)
		}
	}
	f := &handoffFake{agent: true}
	if _, err := RunHandoff(context.Background(), f.env(), handoffReq(HandoffOpen)); err != nil {
		t.Errorf("open shows what the developer sees, also from an agent's terminal: %v", err)
	}
}

func TestHandoffRouteAnswersTerminalsOnly(t *testing.T) {
	service := MakeService(t.TempDir(), nil, nil)
	f := &handoffFake{}
	service.handoff = f.env()
	link := &routeLink{service: service}
	data := map[string]any{"token": "good", "action": HandoffMerge, "dir": "/p", "number": 7}
	if _, err := link.handle(context.Background(), HandoffCommand, wshutil.RoutePrefix_Tab+"x", data); err == nil {
		t.Error("a window does not hand off to itself")
	}
	if _, err := link.handle(context.Background(), HandoffCommand, "", data); err == nil {
		t.Error("a remote source was answered")
	}
	if _, err := link.handle(context.Background(), HandoffCommand, wshutil.RoutePrefix_Proc+"x", data); err != nil {
		t.Fatal(err)
	}
	if len(f.published) != 1 {
		t.Errorf("published: %+v", f.published)
	}
}

func TestMergePlanShownToTerminalsWithoutItsId(t *testing.T) {
	gh := &fakeGh{views: []fakePr{cleanPr()}}
	service := MakeService(t.TempDir(), nil, nil)
	service.merger.gh = gh.run
	link := &routeLink{service: service}
	terminal := wshutil.RoutePrefix_Proc + "x"
	key := map[string]any{"repo": testRepo, "number": 7}
	data, err := link.handle(context.Background(), MergePlanShownCommand, terminal, key)
	if err != nil || data.(*MergePlan) != nil {
		t.Fatalf("no plan yet: %v %v", data, err)
	}
	made, err := link.handle(context.Background(), MergePlanCommand, wshutil.RoutePrefix_Tab+"x", map[string]any{"repo": testRepo, "number": 7, "dir": "/tmp"})
	if err != nil {
		t.Fatal(err)
	}
	data, err = link.handle(context.Background(), MergePlanShownCommand, terminal, key)
	if err != nil {
		t.Fatal(err)
	}
	shown := data.(*MergePlan)
	if shown == nil || shown.Id != "" || shown.HeadOid != made.(MergePlan).HeadOid || len(shown.Checks) == 0 {
		t.Fatalf("shown: %+v", shown)
	}
	if _, err := link.handle(context.Background(), MergeCommand, terminal, map[string]any{"repo": testRepo, "number": 7, "planid": made.(MergePlan).Id}); err == nil {
		t.Error("a terminal merged with the plan's id")
	}
	if len(gh.writes()) != 0 {
		t.Errorf("nothing written: %v", gh.writes())
	}
}
