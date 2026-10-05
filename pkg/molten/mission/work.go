// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
)

// Running work across every project (FR-MC-019), for the notification center: the builds, release and adapter steps
// and local CI runs still going, with what can be said of their progress. The panel stops them through the same
// commands as the Project tab and the CI panel.

const (
	WorkKindCi = "ci"
	// No measure of progress: the bar is indeterminate.
	WorkProgressUnknown = -1
)

type WorkItem struct {
	Id        string `json:"id"`
	Kind      string `json:"kind"`
	Dir       string `json:"dir"`
	Title     string `json:"title"`
	Detail    string `json:"detail,omitempty"`
	StartedAt int64  `json:"startedat"`
	// From 0 to 1, or -1 when the work does not say.
	Progress float64 `json:"progress"`
}

func runWork(rec RunRecord) WorkItem {
	item := WorkItem{Id: rec.Id, Kind: rec.Kind, Dir: rec.Dir, Title: rec.Title, StartedAt: rec.StartedAt, Progress: WorkProgressUnknown}
	if len(rec.Phases) > 0 {
		item.Detail = rec.Phases[len(rec.Phases)-1]
	}
	if rec.Preparing {
		item.Detail = "preparing"
	}
	return item
}

// ciWork measures a CI run by its jobs that ended.
func ciWork(rec CiRunRecord) WorkItem {
	item := WorkItem{Id: rec.Id, Kind: WorkKindCi, Dir: rec.Dir, Title: "Local CI", StartedAt: rec.StartedAt, Progress: WorkProgressUnknown}
	if rec.Branch != "" && !commitIdRegex.MatchString(rec.Branch) {
		item.Title = "Local CI on " + rec.Branch
	}
	done := 0
	for _, job := range rec.Jobs {
		switch job.Status {
		case CiStateRunning:
			item.Detail = job.Name
		case CiStateQueued:
		default:
			done++
		}
	}
	if len(rec.Jobs) > 0 {
		item.Progress = float64(done) / float64(len(rec.Jobs))
	}
	return item
}

// runningRuns lists the runs still going in every project: the records name their project.
func (r *Runs) runningRuns() []RunRecord {
	projects, err := os.ReadDir(r.baseDir)
	if err != nil {
		return nil
	}
	var rtn []RunRecord
	for _, project := range projects {
		if !project.IsDir() {
			continue
		}
		runs, _ := os.ReadDir(filepath.Join(r.baseDir, project.Name()))
		dir := ""
		for _, run := range runs {
			var rec RunRecord
			data, err := os.ReadFile(filepath.Join(r.baseDir, project.Name(), run.Name(), RunFileName))
			if err != nil || json.Unmarshal(data, &rec) != nil {
				continue
			}
			if rec.State == RunStateRunning {
				dir = rec.Dir
				break
			}
		}
		if dir == "" {
			continue
		}
		// List settles runs whose process is gone, so the panel never shows work that stopped.
		for _, rec := range r.List(dir) {
			if rec.State == RunStateRunning {
				rtn = append(rtn, rec)
			}
		}
	}
	return rtn
}

func (c *Ci) runningRuns() []CiRunRecord {
	c.lock.Lock()
	active := map[string]string{}
	for key, run := range c.active {
		active[key] = run.runId
	}
	c.lock.Unlock()
	var rtn []CiRunRecord
	for key, runId := range active {
		var rec CiRunRecord
		data, err := os.ReadFile(filepath.Join(c.baseDir, key, "runs", runId, ciRunFileName))
		if err != nil || json.Unmarshal(data, &rec) != nil || rec.Status != CiStateRunning {
			continue
		}
		rtn = append(rtn, rec)
	}
	return rtn
}

// RunningWork lists what runs now in every project, oldest first.
func RunningWork(runs *Runs, ci *Ci) []WorkItem {
	items := []WorkItem{}
	if runs != nil {
		for _, rec := range runs.runningRuns() {
			items = append(items, runWork(rec))
		}
	}
	if ci != nil {
		for _, rec := range ci.runningRuns() {
			items = append(items, ciWork(rec))
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].StartedAt < items[j].StartedAt })
	return items
}
