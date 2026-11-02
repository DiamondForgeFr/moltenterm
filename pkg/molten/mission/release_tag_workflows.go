// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/pipelinesetup"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The workflows a pushed tag starts (#1040): without them the release panel waited for a run, or a GitHub release,
// that nothing would ever start. They are read at the tag, as GitHub reads them, with the release setup's detection
// (pkg/molten/pipelinesetup workflows.go).

const (
	// No run of a workflow the tag should start appeared this long after the tag: the panel stops waiting and says so.
	releaseTagRunGrace = 10 * time.Minute
	maxTagWorkflows    = 64
)

// A workflow the pushed tag starts.
type ReleaseTagWorkflow struct {
	File string `json:"file"`
	Name string `json:"name,omitempty"`
	// Its page on GitHub; read only once its run is overdue.
	Url string `json:"url,omitempty"`
	// It can be started by hand on the tag: workflow_dispatch, no required input.
	Dispatch bool `json:"dispatch"`
	// It publishes a GitHub release, as far as its steps tell.
	Publishes bool `json:"publishes"`
}

type ReleaseTagWorkflows struct {
	Workflows []ReleaseTagWorkflow `json:"workflows"`
	// None of them started a run within releaseTagRunGrace of the tag.
	Overdue bool `json:"overdue"`
}

type ReleaseDispatchRequest struct {
	Dir      string `json:"dir"`
	Tag      string `json:"tag"`
	Workflow string `json:"workflow"`
}

func (r *Runs) tagRunGraceOf() time.Duration {
	if r.tagRunGrace > 0 {
		return r.tagRunGrace
	}
	return releaseTagRunGrace
}

// workflowsAtTag reads the repository's workflows at the tag; false when they cannot be read.
func (r *Runs) workflowsAtTag(ctx context.Context, dir string, tag string) ([]pipelinesetup.Workflow, bool) {
	ref := "refs/tags/" + tag
	out, err := r.git(ctx, dir, "git", "ls-tree", "--name-only", ref+":"+pipelinesetup.WorkflowsDir)
	if err != nil {
		if _, verr := r.git(ctx, dir, "git", "rev-parse", "-q", "--verify", ref+"^{commit}"); verr == nil {
			// The tag is here but has no workflow folder.
			return nil, true
		}
		return nil, false
	}
	var rtn []pipelinesetup.Workflow
	for _, name := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if !(strings.HasSuffix(name, ".yml") || strings.HasSuffix(name, ".yaml")) || len(rtn) >= maxTagWorkflows {
			continue
		}
		data, err := r.git(ctx, dir, "git", "show", ref+":"+path.Join(pipelinesetup.WorkflowsDir, name))
		if err != nil {
			continue
		}
		if wf, ok := pipelinesetup.ParseWorkflow(name, data); ok {
			rtn = append(rtn, wf)
		}
	}
	return rtn, true
}

func (r *Runs) tagCreated(ctx context.Context, dir string, tag string) (time.Time, bool) {
	out, err := r.git(ctx, dir, "git", "for-each-ref", "--format=%(creatordate:unix)", "refs/tags/"+tag)
	if err != nil {
		return time.Time{}, false
	}
	seconds, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.Unix(seconds, 0), true
}

// readTagWorkflows sets facts.TagWorkflows, nil when the workflows at the tag cannot be read.
func (r *Runs) readTagWorkflows(ctx context.Context, dir string, facts *ReleaseFacts) {
	workflows, ok := r.workflowsAtTag(ctx, dir, facts.Tag)
	if !ok {
		return
	}
	tw := &ReleaseTagWorkflows{Workflows: []ReleaseTagWorkflow{}}
	for _, wf := range workflows {
		if !wf.RunsOnTag(facts.Tag) {
			continue
		}
		tw.Workflows = append(tw.Workflows, ReleaseTagWorkflow{
			File:      wf.File,
			Name:      wf.Name,
			Dispatch:  wf.Dispatch && len(wf.RequiredInputs) == 0,
			Publishes: wf.Role == pipelinesetup.RolePublish || slices.Contains(wf.Ships, pipelinesetup.TargetGithubRelease),
		})
	}
	facts.TagWorkflows = tw
	if len(tw.Workflows) == 0 || len(facts.Runs) > 0 || facts.GithubError != "" {
		return
	}
	created, ok := r.tagCreated(ctx, dir, facts.Tag)
	if !ok || r.now().Sub(created) < r.tagRunGraceOf() {
		return
	}
	tw.Overdue = true
	if out, err := ghJson(ctx, r.git, dir, "repo", "view", "--json", "url"); err == nil {
		var repo struct {
			Url string `json:"url"`
		}
		if json.Unmarshal(out, &repo) == nil && strings.HasPrefix(repo.Url, "https://") {
			for i := range tw.Workflows {
				tw.Workflows[i].Url = strings.TrimSuffix(repo.Url, "/") + "/actions/workflows/" + tw.Workflows[i].File
			}
		}
	}
}

// DispatchTagWorkflow starts by hand, on the tag, a workflow the tag should have started and did not (#1040).
func (r *Runs) DispatchTagWorkflow(req ReleaseDispatchRequest) error {
	facts, err := r.ReleaseFactsOf(req.Dir)
	if err != nil {
		return err
	}
	if facts.Tag != req.Tag || !facts.TagExists {
		return errNotFollowed(req.Tag)
	}
	if facts.TagWorkflows != nil {
		for _, wf := range facts.TagWorkflows.Workflows {
			if wf.File != req.Workflow || !wf.Dispatch {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), releaseFactsTimeout)
			defer cancel()
			_, err := r.git(ctx, filepath.Clean(req.Dir), "gh", "workflow", "run", wf.File, "--ref", req.Tag)
			return err
		}
	}
	return uimsg.Errorf(uimsg.Make("mission.release.noDispatch", "workflow", req.Workflow, "tag", req.Tag),
		"%s is not a workflow %s starts that can be dispatched", req.Workflow, req.Tag)
}
