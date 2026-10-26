// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"sync"
	"testing"
)

func TestPipelineTabKeyAndName(t *testing.T) {
	if got := PipelineTabKey("/work/app/"); got != "/work/app" {
		t.Errorf("key: got %q", got)
	}
	if got := PipelineTabName(PipelineTabRequest{Dir: "/work/app", Project: "App"}); got != "Pipeline · App" {
		t.Errorf("name: got %q", got)
	}
	if got := PipelineTabName(PipelineTabRequest{Dir: "/work/app/"}); got != "Pipeline · app" {
		t.Errorf("name without project: got %q", got)
	}
	if got := PipelineTabName(PipelineTabRequest{Dir: "/work/app", TabName: "Pipeline · Appli"}); got != "Pipeline · Appli" {
		t.Errorf("window's name: got %q", got)
	}
}

// One tab per project: the tab of another project or a plain tab is never taken for this one's.
func TestFindPipelineTab(t *testing.T) {
	ids := []string{"plain", "other", "mine", "mine-again"}
	keys := []string{"", "/work/other", "/work/app", "/work/app"}
	if got := FindPipelineTab(keys, ids, "/work/app"); got != "mine" {
		t.Errorf("got %q, want mine", got)
	}
	if got := FindPipelineTab(keys, ids, "/work/none"); got != "" {
		t.Errorf("got %q, want none", got)
	}
	if got := FindPipelineTab(keys, ids, ""); got != "" {
		t.Errorf("an empty key matched %q", got)
	}
}

func TestPipelineTabRequestChecks(t *testing.T) {
	bad := []PipelineTabRequest{
		{Dir: "/work/app"},
		{WorkspaceId: "ws"},
		{WorkspaceId: "ws", Dir: "work/app"},
		{WorkspaceId: "ws", Dir: "/work/app", OpenAt: "elsewhere"},
	}
	for _, req := range bad {
		if checkPipelineTabRequest(req) == nil {
			t.Errorf("accepted %+v", req)
		}
	}
	if err := checkPipelineTabRequest(PipelineTabRequest{WorkspaceId: "ws", Dir: "/work/app", OpenAt: "understand"}); err != nil {
		t.Errorf("refused a valid request: %v", err)
	}
}

// Two openings at once reach the maker one after the other, so the second finds the first's tab.
func TestOpenPipelineTabSerializes(t *testing.T) {
	saved := pipelineTabs.open
	defer UsePipelineTabs(saved)
	var lock sync.Mutex
	tabs := map[string]string{}
	created := 0
	UsePipelineTabs(func(_ context.Context, req PipelineTabRequest) (PipelineTabResult, error) {
		lock.Lock()
		defer lock.Unlock()
		key := PipelineTabKey(req.Dir)
		if id, ok := tabs[key]; ok {
			return PipelineTabResult{TabId: id}, nil
		}
		created++
		tabs[key] = "tab-" + key
		return PipelineTabResult{TabId: tabs[key], Created: true}, nil
	})
	var wg sync.WaitGroup
	results := make([]PipelineTabResult, 8)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r, err := openPipelineTab(PipelineTabRequest{WorkspaceId: "ws", Dir: "/work/app"})
			if err != nil {
				t.Errorf("open: %v", err)
			}
			results[i] = r
		}(i)
	}
	wg.Wait()
	if created != 1 {
		t.Fatalf("created %d tabs, want 1", created)
	}
	for _, r := range results {
		if r.TabId != "tab-/work/app" {
			t.Errorf("got tab %q", r.TabId)
		}
	}
}
