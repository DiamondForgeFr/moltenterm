// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
)

// Environment approvals (FR-MC-037): a GitHub job bound to a protected environment waits until a reviewer approves it,
// and the run's status reads "waiting" meanwhile. The release panel names the environment and links the run, for a
// run the tag started and for a step that dispatched one.

const ghRunStatusWaiting = "waiting"

var ghRunUrlRegex = regexp.MustCompile(`^https://[^/]+/([^/]+)/([^/]+)/actions/runs/(\d+)`)

// pendingApproval reads a step's log: the environment of its last `▶ approval:` line, unless an `▶ approved:` line
// for it came after.
func pendingApproval(log []byte) *ReleaseApproval {
	var last *ReleaseApproval
	for _, m := range approvalRegex.FindAllSubmatch(log, -1) {
		if string(m[1]) == "approved" {
			last = nil
			continue
		}
		last = &ReleaseApproval{Environment: string(m[2]), Url: string(m[3])}
	}
	return last
}

type ghPendingDeployment struct {
	Environment struct {
		Name string `json:"name"`
	} `json:"environment"`
}

// waitingApprovals reads the environments the waiting runs wait on; a run whose answer cannot be read is skipped.
func (r *Runs) waitingApprovals(ctx context.Context, dir string, runs []ReleaseGhRun) []ReleaseApproval {
	rtn := []ReleaseApproval{}
	for _, run := range runs {
		if run.Status != ghRunStatusWaiting {
			continue
		}
		m := ghRunUrlRegex.FindStringSubmatch(run.Url)
		if m == nil {
			continue
		}
		out, err := ghJson(ctx, r.git, dir, "api", fmt.Sprintf("repos/%s/%s/actions/runs/%s/pending_deployments", m[1], m[2], m[3]))
		if err != nil {
			continue
		}
		var pending []ghPendingDeployment
		if json.Unmarshal(out, &pending) != nil {
			continue
		}
		for _, p := range pending {
			if p.Environment.Name != "" {
				rtn = append(rtn, ReleaseApproval{Environment: p.Environment.Name, Url: run.Url, Workflow: run.WorkflowName})
			}
		}
	}
	return rtn
}
