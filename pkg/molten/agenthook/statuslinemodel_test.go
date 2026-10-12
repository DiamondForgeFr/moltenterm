// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"strings"
	"testing"
	"time"
)

// #549: the relay hands over the session's model and effort level with the windows.
func TestParseStatusLineModelAndEffort(t *testing.T) {
	req, err := ParseStatusLineInput([]byte(`{"model":{"id":"claude-opus-5-5","display_name":"Opus"},"effort":{"level":"xhigh"},"thinking":{"enabled":true}}`))
	if err != nil || req.Model != "claude-opus-5-5" || req.ModelName != "Opus" || req.Effort != "xhigh" || req.RateLimits {
		t.Fatalf("got %+v %v", req, err)
	}
	for name, input := range map[string]string{
		"no effort (a model without it)": `{"model":{"id":"claude-haiku-4-5","display_name":"Haiku"}}`,
		"effort not an object":           `{"model":{"id":"m"},"effort":"high"}`,
		"level not a string":             `{"model":{"id":"m"},"effort":{"level":3}}`,
		"level with a control character": `{"model":{"id":"m"},"effort":{"level":"hi\u001bgh"}}`,
		"level too long":                 `{"model":{"id":"m"},"effort":{"level":"` + strings.Repeat("x", 100) + `"}}`,
	} {
		req, err := ParseStatusLineInput([]byte(input))
		if err != nil || req.Effort != "" {
			t.Errorf("%s: %+v %v", name, req, err)
		}
	}
	if req, _ := ParseStatusLineInput([]byte(`{"model":"opus"}`)); req.Model != "" || req.ModelName != "" {
		t.Errorf("a model that is not an object: %+v", req)
	}
}

// A changed effort is handed over at once, even when the windows did not change.
func TestStatusLineSendDueOnAnEffortChange(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(2_000_000, 0)
	req := AgentStatusLineRequest{BlockId: "b1", Model: "claude-opus-5-5", Effort: "high"}
	RecordStatusLineSent(dir, req, true, now)
	if StatusLineSendDue(dir, req, now.Add(time.Second)) {
		t.Fatal("the same report waits")
	}
	req.Effort = "max"
	if !StatusLineSendDue(dir, req, now.Add(time.Second)) {
		t.Fatal("a new effort level goes at once")
	}
}
