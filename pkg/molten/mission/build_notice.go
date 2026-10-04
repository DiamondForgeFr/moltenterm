// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"fmt"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The end of a local build is told in the notification center (FR-MC-014), once, wherever the user is: a build runs
// for minutes and nobody waits on the Timeline for it. A build the user cancelled is not told; an outcome older than
// NoticeWindow is history, not news.

const (
	NoticeWindow         = 6 * time.Hour
	timelineView         = "molten-timeline"
	revealPathGesture    = "path:reveal"
	deliveredWithinStart = 60 * time.Second
)

func deliveredManifest(rec RunRecord, manifest *BuildManifest) *BuildManifest {
	if manifest == nil || rec.Commit == "" || manifest.Commit != rec.Commit {
		return nil
	}
	builtAt, err := time.Parse(time.RFC3339, manifest.BuiltAt)
	if err != nil || builtAt.UnixMilli() < rec.StartedAt-deliveredWithinStart.Milliseconds() {
		return nil
	}
	return manifest
}

func runEnded(rec RunRecord) bool {
	return rec.State != RunStateRunning
}

// buildNotice is what to tell about a build run that ended, if anything.
func buildNotice(rec RunRecord, manifest *BuildManifest, projectName string, now time.Time) (molten.NotificationInput, bool) {
	if rec.Kind != RunKindBuild || rec.Told || !runEnded(rec) || rec.State == RunStateCancelled {
		return molten.NotificationInput{}, false
	}
	ended := rec.FinishedAt
	if ended == 0 {
		ended = now.UnixMilli()
	}
	if now.UnixMilli()-ended > NoticeWindow.Milliseconds() {
		return molten.NotificationInput{}, false
	}
	name := fmt.Sprintf("%s %s", projectName, rec.Title)
	open := molten.NotificationAction{Id: "open", Label: "Open the project", Kind: "open", View: timelineView}
	if rec.State == RunStateSuccess {
		input := molten.NotificationInput{Source: "build", Kind: "info", Title: name + " is built",
			Message: fmt.Sprintf("Build %s finished.", shortSha(rec.Commit)), Actions: []molten.NotificationAction{open}}
		if delivered := deliveredManifest(rec, manifest); delivered != nil {
			product := delivered.ProductName
			if product == "" {
				product = name
			}
			input.Title = product + " is ready"
			input.Message = fmt.Sprintf("Build %s delivered to the local builds folder (%d commit(s) since the previous one).",
				shortSha(delivered.Commit), len(delivered.Notes))
		}
		if rec.Artifact != "" {
			reveal := molten.NotificationAction{Id: "reveal", Label: "Show in Finder", Kind: "gesture", Gesture: revealPathGesture,
				Args: map[string]any{"path": filepath.Clean(rec.Artifact)}, Lasting: true}
			input.Actions = []molten.NotificationAction{reveal, open}
		}
		return input, true
	}
	return molten.NotificationInput{Source: "build", Kind: "error", Title: fmt.Sprintf("The %s build stopped", name),
		Message: "Its run card shows at which step, and the end of its log.", Actions: []molten.NotificationAction{open}}, true
}

// UseNotifier lets the runs tell the end of a build; wavesrv writes it in the notification center.
func (r *Runs) UseNotifier(notify func(RunRecord, molten.NotificationInput)) {
	r.notify = notify
}

func (r *Runs) claimTold(runId string) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	if r.told[runId] {
		return false
	}
	r.told[runId] = true
	return true
}

// settle tells a build's end once: the record keeps Told, written before the notification goes out.
func (r *Runs) settle(rec *RunRecord) {
	if r.notify == nil || rec.Told || !runEnded(*rec) || rec.Kind != RunKindBuild || !r.claimTold(rec.Id) {
		return
	}
	pipeline := molten.ValidatePipeline(rec.Dir).Pipeline
	projectName := filepath.Base(rec.Dir)
	var manifest *BuildManifest
	if pipeline != nil {
		if pipeline.Name != "" {
			projectName = pipeline.Name
		}
		manifest = readBuildManifest(buildManifestPath(rec.Dir, findBuild(pipeline, rec.StepId)))
	}
	input, ok := buildNotice(*rec, manifest, projectName, r.now())
	rec.Told = true
	r.writeRecord(*rec)
	if ok {
		go r.notify(*rec, input)
	}
}
