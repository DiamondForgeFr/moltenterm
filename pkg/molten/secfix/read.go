// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Gh runs the project's gh with the repository named and returns its standard output; mission passes its own runner.
type Gh func(ctx context.Context, dir string, args ...string) ([]byte, error)

const (
	// One gh call is bounded, and so is the whole assessment its caller bounds.
	callTimeout = 40 * time.Second
	// What could not be read is tried again after this: a run's report may not be uploaded yet, a network may be down.
	errorTtl = 2 * time.Minute
	// The trunk's latest runs change with every push.
	listTtl  = time.Minute
	cacheMax = 256
	// How many of the trunk's latest completed runs are looked at for the scan's verdict.
	trunkRunsRead  = 6
	trunkRunsLimit = 8
	maxArtifact    = 16 << 20
	readersAtOnce  = 3
)

// Reader reads what a failed scan says, and keeps what it read: a run's report or log never changes, so each is read once
// per run and attempt (a rerun is another job id), however often the list is asked for.
type Reader struct {
	lock  sync.Mutex
	now   func() time.Time
	cache map[string]cached
	order []string
}

type cached struct {
	at    time.Time
	ttl   time.Duration
	value any
}

func MakeReader() *Reader {
	return &Reader{now: time.Now, cache: map[string]cached{}}
}

// recall returns what was kept under the key while it is still valid; a zero ttl keeps it for good.
func (r *Reader) recall(key string) (any, bool) {
	r.lock.Lock()
	defer r.lock.Unlock()
	entry, ok := r.cache[key]
	if !ok {
		return nil, false
	}
	if entry.ttl > 0 && r.now().Sub(entry.at) >= entry.ttl {
		delete(r.cache, key)
		return nil, false
	}
	return entry.value, true
}

func (r *Reader) remember(key string, value any, ttl time.Duration) {
	r.lock.Lock()
	defer r.lock.Unlock()
	if _, ok := r.cache[key]; !ok {
		r.order = append(r.order, key)
	}
	r.cache[key] = cached{at: r.now(), ttl: ttl, value: value}
	for len(r.order) > cacheMax {
		delete(r.cache, r.order[0])
		r.order = r.order[1:]
	}
}

func callGh(ctx context.Context, gh Gh, dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	return gh(ctx, dir, args...)
}

func shortError(err error) string {
	return CleanLine(err.Error(), 100)
}

func reportKey(decl *Declaration) string {
	if decl == nil || decl.Report == nil {
		return ""
	}
	return decl.Report.Artifact + "|" + decl.Report.ReportFile() + "|" + decl.Report.Format
}

// ReadCheck reads the advisories a failed check of a run names: from the report the declaration points at when there is
// one, else from the failed job's log. It never fails: a reading with no advisories says why in its Note.
func (r *Reader) ReadCheck(ctx context.Context, gh Gh, dir string, decl *Declaration, check Check) Reading {
	key := fmt.Sprintf("check:%d:%d:%s", check.RunId, check.JobId, reportKey(decl))
	if value, ok := r.recall(key); ok {
		return value.(Reading)
	}
	reading := r.readCheck(ctx, gh, dir, decl, check)
	ttl := errorTtl
	if len(reading.Advisories) > 0 || reading.Status == StatusScannerInputFailure {
		ttl = 0
	}
	r.remember(key, reading, ttl)
	return reading
}

func (r *Reader) readCheck(ctx context.Context, gh Gh, dir string, decl *Declaration, check Check) Reading {
	if check.RunId <= 0 {
		return Reading{Source: SourceNone, Advisories: []Advisory{}, Cause: CauseNoJob, Note: "the check is not a GitHub Actions run"}
	}
	var notes []string
	// What kept the report from answering, when the declaration points at one: the log's own failure comes after it.
	cause := CauseNoAdvisory
	if decl != nil && decl.Report != nil {
		reading, err := readReport(ctx, gh, dir, decl.Report, check.RunId)
		switch {
		case err != nil:
			notes = append(notes, shortError(err))
			cause = CauseReportUnreadable
		case len(reading.Advisories) > 0 || reading.Status == StatusScannerInputFailure:
			if reading.Status == StatusScannerInputFailure {
				reading.Cause = CauseScannerInputFailure
			}
			return reading
		default:
			notes = append(notes, "the report names no advisory")
		}
	}
	none := func(cause string) Reading {
		return Reading{Source: SourceNone, Advisories: []Advisory{}, Cause: cause, Note: strings.Join(notes, "; ")}
	}
	if check.JobId <= 0 {
		notes = append(notes, "the check has no job whose log could be read")
		return none(CauseNoJob)
	}
	out, err := callGh(ctx, gh, dir, "run", "view", strconv.FormatInt(check.RunId, 10), "--job", strconv.FormatInt(check.JobId, 10), "--log-failed")
	if err != nil {
		notes = append(notes, "the failed log could not be read: "+shortError(err))
		if cause == CauseReportUnreadable {
			return none(cause)
		}
		return none(CauseLogUnreadable)
	}
	if advisories := ParseLog(string(out)); len(advisories) > 0 {
		return Reading{Source: SourceLog, Advisories: advisories, Note: strings.Join(notes, "; ")}
	}
	notes = append(notes, "the failed log names no advisory")
	return none(cause)
}

// readReport downloads the run's report artifact into a folder of its own and parses the file the declaration names.
func readReport(ctx context.Context, gh Gh, dir string, spec *ReportSpec, run int64) (Reading, error) {
	tmp, err := os.MkdirTemp("", "molten-secfix-")
	if err != nil {
		return Reading{}, err
	}
	defer os.RemoveAll(tmp)
	selector := "--name="
	if strings.ContainsAny(spec.Artifact, "*?[") {
		selector = "--pattern="
	}
	if _, err := callGh(ctx, gh, dir, "run", "download", strconv.FormatInt(run, 10), "--dir="+tmp, selector+spec.Artifact); err != nil {
		return Reading{}, fmt.Errorf("the report artifact could not be downloaded: %s", shortError(err))
	}
	data, err := findReportFile(tmp, spec.ReportFile())
	if err != nil {
		return Reading{}, err
	}
	reading, err := ParseReport(spec.Format, data)
	if err != nil {
		return Reading{}, fmt.Errorf("the report could not be read: %s", shortError(err))
	}
	return reading, nil
}

// findReportFile reads the report inside the downloaded artifacts: gh puts each artifact in a folder of its own when
// several match, so the file is looked for at any depth, as a regular file only (a link in an artifact is never followed).
func findReportFile(root string, file string) ([]byte, error) {
	var found string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() {
			return nil
		}
		rel, relErr := filepath.Rel(root, p)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if rel == file || strings.HasSuffix(rel, "/"+file) {
			if found == "" || len(rel) < len(found) {
				found = rel
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if found == "" {
		return nil, fmt.Errorf("the artifact holds no %s", CleanLine(file, 60))
	}
	f, err := os.Open(filepath.Join(root, filepath.FromSlash(found)))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxArtifact+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxArtifact {
		return nil, errors.New("the report is too large to read")
	}
	return data, nil
}

// Trunk is what the scan did on the trunk's latest runs.
type Trunk struct {
	// Known: a completed run of the trunk had the check run to a verdict.
	Known   bool
	Failing bool
	Run     int64
	Reading Reading
}

type ghRunItem struct {
	DatabaseId int64 `json:"databaseId"`
}

type ghRunJobs struct {
	Jobs []struct {
		DatabaseId int64  `json:"databaseId"`
		Name       string `json:"name"`
		Conclusion string `json:"conclusion"`
	} `json:"jobs"`
}

// TrunkOf reads the scan's verdict on the trunk: the check's job on the newest completed run of its workflow where it
// ran to a verdict (a skipped job says nothing). A failing verdict comes with the advisories of that run.
func (r *Reader) TrunkOf(ctx context.Context, gh Gh, dir string, trunk string, decl *Declaration, check Check) Trunk {
	if trunk == "" || check.Workflow == "" {
		return Trunk{}
	}
	runs, err := r.trunkRuns(ctx, gh, dir, trunk, check.Workflow)
	if err != nil {
		return Trunk{}
	}
	for i, run := range runs {
		if i == trunkRunsRead {
			break
		}
		jobs, err := r.runJobs(ctx, gh, dir, run)
		if err != nil {
			return Trunk{}
		}
		for _, job := range jobs.Jobs {
			if normalizeName(job.Name) != normalizeName(check.Name) {
				continue
			}
			switch strings.ToLower(job.Conclusion) {
			case "success":
				return Trunk{Known: true, Run: run}
			case "failure", "timed_out", "startup_failure":
				reading := r.ReadCheck(ctx, gh, dir, decl, Check{Name: check.Name, Workflow: check.Workflow, Failed: true, RunId: run, JobId: job.DatabaseId})
				return Trunk{Known: true, Failing: true, Run: run, Reading: reading}
			}
		}
	}
	return Trunk{}
}

func (r *Reader) trunkRuns(ctx context.Context, gh Gh, dir string, trunk string, workflow string) ([]int64, error) {
	key := "trunkruns:" + trunk + ":" + workflow
	if value, ok := r.recall(key); ok {
		return value.([]int64), nil
	}
	out, err := callGh(ctx, gh, dir, "run", "list", "--branch="+trunk, "--workflow="+workflow, "--status=completed", "--limit="+strconv.Itoa(trunkRunsLimit), "--json=databaseId")
	if err != nil {
		return nil, err
	}
	var items []ghRunItem
	if err := json.Unmarshal(out, &items); err != nil {
		return nil, err
	}
	runs := make([]int64, 0, len(items))
	for _, item := range items {
		if item.DatabaseId > 0 {
			runs = append(runs, item.DatabaseId)
		}
	}
	r.remember(key, runs, listTtl)
	return runs, nil
}

// runJobs reads a completed run's jobs once: they never change.
func (r *Reader) runJobs(ctx context.Context, gh Gh, dir string, run int64) (ghRunJobs, error) {
	key := "runjobs:" + strconv.FormatInt(run, 10)
	if value, ok := r.recall(key); ok {
		return value.(ghRunJobs), nil
	}
	out, err := callGh(ctx, gh, dir, "run", "view", strconv.FormatInt(run, 10), "--json=jobs")
	if err != nil {
		return ghRunJobs{}, err
	}
	var jobs ghRunJobs
	if err := json.Unmarshal(out, &jobs); err != nil {
		return ghRunJobs{}, err
	}
	r.remember(key, jobs, 0)
	return jobs, nil
}

// PrFiles lists the files a pull request changes, once per head commit.
func (r *Reader) PrFiles(ctx context.Context, gh Gh, dir string, number int, headOid string) ([]string, error) {
	key := fmt.Sprintf("prfiles:%d:%s", number, headOid)
	if value, ok := r.recall(key); ok {
		return value.([]string), nil
	}
	out, err := callGh(ctx, gh, dir, "api", fmt.Sprintf("repos/{owner}/{repo}/pulls/%d/files", number), "--paginate", "--jq", ".[].filename")
	if err != nil {
		return nil, err
	}
	var files []string
	for _, line := range strings.Split(string(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			files = append(files, path.Clean(line))
		}
	}
	sort.Strings(files)
	ttl := time.Duration(0)
	if headOid == "" {
		ttl = errorTtl
	}
	r.remember(key, files, ttl)
	return files, nil
}
