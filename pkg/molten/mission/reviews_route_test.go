// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// FR-REV-014 AC4: the review list answers local terminals and windows only.
func TestReviewsAnswerLocalSourcesOnly(t *testing.T) {
	l := &routeLink{output: make(chan []byte, 1), localSource: func(source string, ingressLinkId baseds.LinkId) bool {
		return source == "proc:local"
	}}
	l.answer(wshutil.RpcMessage{Command: ReviewsCommand, ReqId: "r1", Source: "proc:remote", Data: map[string]any{"dir": "/p"}}, baseds.NoLinkId)
	var resp wshutil.RpcMessage
	if err := json.Unmarshal(<-l.output, &resp); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(resp.Error, "local terminals only") {
		t.Errorf("remote source: %+v", resp)
	}
	l.localSource = nil
	l.answer(wshutil.RpcMessage{Command: ReviewsCommand, ReqId: "r2", Source: "proc:local", Data: map[string]any{"dir": "/p"}}, baseds.NoLinkId)
	if err := json.Unmarshal(<-l.output, &resp); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(resp.Error, "local terminals only") {
		t.Errorf("no source check: %+v", resp)
	}
}
