// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Welcome back (FR-SHELL-019, DS-SHELL-020): when durable sessions kept running while MoltenTerm was closed (quit,
// update, crash), the first start after says so once, in one notification: how many kept running, then one line per
// session with news, most urgent first. MoltenTerm's last moment alive is a heartbeat file wavesrv rewrites every
// half minute: it covers a clean quit, an update and a crash alike, to within the beat, without a hook in Wave's
// shutdown.

const (
	aliveFileName     = "alive.json"
	aliveBeat         = 30 * time.Second
	welcomeBackSettle = time.Second
	// The notification's actions are capped (molten.MaxNotificationActions): the most urgent lines open their pane,
	// the last action the Sessions view, which lists them all.
	welcomeBackPaneActions = 2
	welcomeBackKeyPrefix   = "sessions:welcomeback:"
	// "sessions", not "agent": the sessions may be plain shells (#748). It shares the agents' subject.
	welcomeBackSource   = "sessions"
	welcomeBackLabelMax = 24

	// must match frontend/moltenterm-shell/sessions/sessions-store.ts
	ShowSessionGesture  = "sessions:show"
	OpenSessionsGesture = "sessions:open"

	// The news a line tells, most urgent first.
	NewsFailed   = "failed"
	NewsWaiting  = "waiting"
	NewsFinished = "finished"
	NewsExited   = "exited"
	NewsOutput   = "output"
)

var newsRank = map[string]int{NewsFailed: 0, NewsWaiting: 1, NewsFinished: 2, NewsExited: 3, NewsOutput: 4}

type aliveRecord struct {
	Ts int64 `json:"ts"`
}

type WelcomeBackLine struct {
	News     string      `json:"news"`
	Text     string      `json:"text"`
	TextText *uimsg.Text `json:"texttext,omitempty"`
	// What runs, for the line's button.
	What        string `json:"what"`
	JobId       string `json:"jobid"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	TabId       string `json:"tabid,omitempty"`
	BlockId     string `json:"blockid,omitempty"`
	ExitCode    *int   `json:"exitcode,omitempty"`
}

type WelcomeBack struct {
	// Sessions started before MoltenTerm closed and still running.
	Survived int               `json:"survived"`
	Lines    []WelcomeBackLine `json:"lines"`
}

// The facts of one start the summary is built from, gathered once the durable jobs have reconnected.
type WelcomeBackFacts struct {
	ClosedAt int64
	Now      int64
	Sessions []molten.DurableSession
	// By job: how many bytes of output reached MoltenTerm since this start (the replay of what ran while closed).
	OutputGrowth map[string]int64
	// Jobs whose command exited while MoltenTerm was closed.
	Exited []ExitedJob
}

type ExitedJob struct {
	Job           *waveobj.Job
	WorkspaceId   string
	WorkspaceName string
	TabId         string
	BlockId       string
	Folder        string
}

func aliveFile(dataDir string) string {
	return filepath.Join(dataDir, "molten", aliveFileName)
}

func readAlive(dataDir string) int64 {
	data, err := os.ReadFile(aliveFile(dataDir))
	if err != nil {
		return 0
	}
	var rec aliveRecord
	if json.Unmarshal(data, &rec) != nil {
		return 0
	}
	return rec.Ts
}

func writeAlive(dataDir string, ts int64) error {
	path := aliveFile(dataDir)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, _ := json.Marshal(aliveRecord{Ts: ts})
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// FormatRunFor says how long a session has run: "3 min", "2 h 5 min", "4 d".
func FormatRunFor(ms int64) string {
	d := time.Duration(ms) * time.Millisecond
	switch {
	case d < time.Minute:
		return "under a minute"
	case d < time.Hour:
		return fmt.Sprintf("%d min", int(d.Minutes()))
	case d < 24*time.Hour:
		h := int(d.Hours())
		m := int(d.Minutes()) - h*60
		if m == 0 {
			return fmt.Sprintf("%d h", h)
		}
		return fmt.Sprintf("%d h %d min", h, m)
	}
	return fmt.Sprintf("%d d", int(d.Hours()/24))
}

// runForText is FormatRunFor as the window words it.
func runForText(ms int64) *uimsg.Text {
	d := time.Duration(ms) * time.Millisecond
	switch {
	case d < time.Minute:
		return uimsg.Make("sessions.welcomeback.duration.underminute")
	case d < time.Hour:
		return uimsg.Make("sessions.welcomeback.duration.min", "m", fmt.Sprintf("%d", int(d.Minutes())))
	case d < 24*time.Hour:
		h := int(d.Hours())
		m := int(d.Minutes()) - h*60
		if m == 0 {
			return uimsg.Make("sessions.welcomeback.duration.h", "h", fmt.Sprintf("%d", h))
		}
		return uimsg.Make("sessions.welcomeback.duration.hmin", "h", fmt.Sprintf("%d", h), "m", fmt.Sprintf("%d", m))
	}
	return uimsg.Make("sessions.welcomeback.duration.d", "d", fmt.Sprintf("%d", int(d.Hours()/24)))
}

func sessionPlace(s molten.DurableSession) string {
	if s.Worktree != nil && s.Worktree.Branch != "" {
		return s.Worktree.Branch
	}
	if s.Worktree != nil && s.Worktree.Path != "" {
		return filepath.Base(s.Worktree.Path)
	}
	if s.Folder != "" {
		return filepath.Base(s.Folder)
	}
	return ""
}

func lineText(workspace string, what string, place string, ranMs int64, news string) string {
	parts := []string{}
	if workspace != "" {
		parts = append(parts, workspace)
	}
	parts = append(parts, what)
	if place != "" {
		parts = append(parts, "in "+place)
	}
	text := strings.Join(parts, " · ")
	if ranMs > 0 {
		text += ", running for " + FormatRunFor(ranMs)
	}
	return text + ": " + news
}

// lineTextCoded is lineText as the window words it; the workspace and what run are data.
func lineTextCoded(workspace string, what string, place string, ranMs int64, news *uimsg.Text) *uimsg.Text {
	head := what
	if workspace != "" {
		head = workspace + " · " + what
	}
	rtn := uimsg.Make("sessions.welcomeback.line", "head", head, "place", "", "ran", "").With("news", news)
	if place != "" {
		rtn.With("place", uimsg.Make("sessions.welcomeback.place", "place", place))
	}
	if ranMs > 0 {
		rtn.With("ran", uimsg.Make("sessions.welcomeback.ran").With("duration", runForText(ranMs)))
	}
	return rtn
}

func exitNews(job *waveobj.Job) (string, string, *uimsg.Text) {
	if job.CmdExitCode != nil && *job.CmdExitCode == 0 {
		return NewsExited, "exited (0)", uimsg.Make("sessions.welcomeback.news.exitedzero")
	}
	if job.CmdExitCode != nil {
		code := fmt.Sprintf("%d", *job.CmdExitCode)
		return NewsFailed, "exited with status " + code, uimsg.Make("sessions.welcomeback.news.exitedstatus", "status", code)
	}
	if job.CmdExitSignal != "" {
		return NewsFailed, "ended by " + job.CmdExitSignal, uimsg.Make("sessions.welcomeback.news.endedby", "signal", job.CmdExitSignal)
	}
	return NewsExited, "exited", uimsg.Make("sessions.welcomeback.news.exited")
}

func sessionNews(s molten.DurableSession, growth int64) (string, string, *uimsg.Text) {
	if s.Agent != "" {
		switch s.AgentState {
		case molten.AgentStateError:
			return NewsFailed, "failed", uimsg.Make("sessions.welcomeback.news.failed")
		case molten.AgentStateWaiting:
			return NewsWaiting, "waits for you", uimsg.Make("sessions.welcomeback.news.waiting")
		case molten.AgentStateDone:
			return NewsFinished, "finished", uimsg.Make("sessions.welcomeback.news.finished")
		}
	}
	// A shell at its prompt redraws it on reconnect: only a running command's output is news.
	if growth > 0 && !strings.HasSuffix(s.Command, atPromptSuffix) {
		return NewsOutput, "new output", uimsg.Make("sessions.welcomeback.news.output")
	}
	return "", "", nil
}

// BuildWelcomeBack is pure: nothing on a first start (no heartbeat yet), and nothing when no session survived and none
// ended while MoltenTerm was closed.
func BuildWelcomeBack(f WelcomeBackFacts) WelcomeBack {
	rtn := WelcomeBack{Lines: []WelcomeBackLine{}}
	if f.ClosedAt <= 0 {
		return rtn
	}
	for _, s := range f.Sessions {
		if s.StartedAt <= 0 || s.StartedAt >= f.ClosedAt {
			continue
		}
		rtn.Survived++
		news, label, labelText := sessionNews(s, f.OutputGrowth[s.Id])
		if news == "" {
			continue
		}
		what := s.AgentName
		if what == "" {
			what = s.Command
		}
		rtn.Lines = append(rtn.Lines, WelcomeBackLine{
			News:        news,
			Text:        lineText(s.WorkspaceName, what, sessionPlace(s), f.Now-s.StartedAt, label),
			TextText:    lineTextCoded(s.WorkspaceName, what, sessionPlace(s), f.Now-s.StartedAt, labelText),
			What:        what,
			JobId:       s.Id,
			WorkspaceId: s.WorkspaceId,
			TabId:       s.TabId,
			BlockId:     s.BlockId,
		})
	}
	for _, e := range f.Exited {
		job := e.Job
		if job == nil || job.CmdExitTs <= f.ClosedAt || job.CmdStartTs <= 0 || job.CmdStartTs >= f.ClosedAt {
			continue
		}
		news, label, labelText := exitNews(job)
		place := ""
		if e.Folder != "" {
			place = filepath.Base(e.Folder)
		}
		ranMs := job.CmdExitTs - job.CmdStartTs
		rtn.Lines = append(rtn.Lines, WelcomeBackLine{
			News:        news,
			Text:        lineText(e.WorkspaceName, shellName(job, nil), place, ranMs, label),
			TextText:    lineTextCoded(e.WorkspaceName, shellName(job, nil), place, ranMs, labelText),
			What:        shellName(job, nil),
			JobId:       job.OID,
			WorkspaceId: e.WorkspaceId,
			TabId:       e.TabId,
			BlockId:     e.BlockId,
			ExitCode:    job.CmdExitCode,
		})
	}
	sort.SliceStable(rtn.Lines, func(i, j int) bool { return newsRank[rtn.Lines[i].News] < newsRank[rtn.Lines[j].News] })
	return rtn
}

func plural(n int, one string, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

func clipLabel(text string) string {
	runes := []rune(text)
	if len(runes) <= welcomeBackLabelMax {
		return text
	}
	return string(runes[:welcomeBackLabelMax-1]) + "…"
}

// WelcomeBackNotification is the summary as one notification; false when there is nothing to say.
func WelcomeBackNotification(wb WelcomeBack, startTs int64) (molten.NotificationInput, bool) {
	if wb.Survived == 0 && len(wb.Lines) == 0 {
		return molten.NotificationInput{}, false
	}
	title := plural(wb.Survived, "session", "sessions") + " kept running while MoltenTerm was closed"
	titleText := uimsg.Make("sessions.welcomeback.keptother", "count", fmt.Sprintf("%d", wb.Survived))
	if wb.Survived == 1 {
		titleText = uimsg.Make("sessions.welcomeback.keptone")
	}
	if wb.Survived == 0 {
		title = plural(len(wb.Lines), "session", "sessions") + " ended while MoltenTerm was closed"
		titleText = uimsg.Make("sessions.welcomeback.endedother", "count", fmt.Sprintf("%d", len(wb.Lines)))
		if len(wb.Lines) == 1 {
			titleText = uimsg.Make("sessions.welcomeback.endedone")
		}
	}
	texts := make([]string, 0, len(wb.Lines))
	for _, line := range wb.Lines {
		texts = append(texts, line.Text)
	}
	// The lines joined as Message joins them: each join holds a line and the rest of the list.
	var messageText *uimsg.Text
	for i := len(wb.Lines) - 1; i >= 0; i-- {
		if messageText == nil {
			messageText = wb.Lines[i].TextText
			continue
		}
		messageText = uimsg.Make("sessions.welcomeback.join").With("first", wb.Lines[i].TextText).With("rest", messageText)
	}
	kind := "info"
	if len(wb.Lines) > 0 && (wb.Lines[0].News == NewsFailed || wb.Lines[0].News == NewsWaiting) {
		kind = "warning"
	}
	input := molten.NotificationInput{
		Key:         fmt.Sprintf("%s%d", welcomeBackKeyPrefix, startTs),
		Source:      welcomeBackSource,
		Title:       title,
		TitleText:   titleText,
		Message:     strings.Join(texts, "; "),
		MessageText: messageText,
		Kind:        kind,
	}
	for i, line := range wb.Lines {
		if len(input.Actions) >= welcomeBackPaneActions {
			break
		}
		// A session that ended has no pane to show any more.
		if line.News == NewsExited || line.ExitCode != nil {
			continue
		}
		input.Actions = append(input.Actions, molten.NotificationAction{
			Id:        fmt.Sprintf("show%d", i),
			Label:     "Show " + clipLabel(line.What),
			LabelText: uimsg.Make("sessions.welcomeback.show", "what", clipLabel(line.What)),
			Kind:      "gesture",
			Gesture:   ShowSessionGesture,
			Args:      map[string]any{"id": line.JobId},
			Lasting:   true,
		})
	}
	input.Actions = append(input.Actions, molten.NotificationAction{
		Id:        "sessions",
		Label:     "Open Sessions",
		LabelText: uimsg.Make("sessions.welcomeback.open"),
		Kind:      "gesture",
		Gesture:   OpenSessionsGesture,
		Lasting:   true,
	})
	return input, true
}

func outputSizes(ctx context.Context, jobs []*waveobj.Job) map[string]int64 {
	rtn := map[string]int64{}
	for _, job := range jobs {
		if file, err := filestore.WFS.Stat(ctx, job.OID, jobcontroller.JobOutputFileName); err == nil && file != nil {
			rtn[job.OID] = file.Size
		}
	}
	return rtn
}

func exitedWhileClosed(ctx context.Context, closedAt int64) []ExitedJob {
	jobs, err := wstore.DBGetAllObjsByType[*waveobj.Job](ctx, waveobj.OType_Job)
	if err != nil {
		return nil
	}
	var rtn []ExitedJob
	for _, job := range jobs {
		if job.JobKind != "" && job.JobKind != jobKindShell {
			continue
		}
		if job.CmdExitTs <= closedAt || job.CmdStartTs <= 0 || job.CmdStartTs >= closedAt {
			continue
		}
		e := ExitedJob{Job: job, BlockId: job.AttachedBlockId}
		if e.BlockId != "" {
			if block, err := wstore.DBGet[*waveobj.Block](ctx, e.BlockId); err == nil && block != nil {
				e.Folder = block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
				e.TabId = parentTabId(block)
			}
		}
		if e.TabId != "" {
			if wsId, err := wstore.DBFindWorkspaceForTabId(ctx, e.TabId); err == nil {
				e.WorkspaceId = wsId
				if ws, err := wstore.DBGet[*waveobj.Workspace](ctx, wsId); err == nil && ws != nil {
					e.WorkspaceName = ws.Name
				}
			}
		}
		rtn = append(rtn, e)
	}
	return rtn
}

type welcomeBackRun struct {
	ready    chan struct{}
	startTs  int64
	closedAt int64
	before   map[string]int64
}

// startWelcomeBack reads the last heartbeat, then the output sizes before the startup reconnects replay anything, then
// beats; off wavesrv's start, which does not wait for it.
func startWelcomeBack() *welcomeBackRun {
	r := &welcomeBackRun{ready: make(chan struct{}), startTs: time.Now().UnixMilli()}
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:sessions:welcomeback", recover())
		}()
		defer close(r.ready)
		dataDir := wavebase.GetWaveDataDir()
		r.closedAt = readAlive(dataDir)
		go beat(dataDir)
		if r.closedAt <= 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), reconnectTimeout)
		defer cancel()
		jobs, _ := wstore.DBGetAllObjsByType[*waveobj.Job](ctx, waveobj.OType_Job)
		r.before = outputSizes(ctx, jobs)
	}()
	return r
}

// finish tells the summary once the startup reconnects are done.
func (r *welcomeBackRun) finish(src *liveSources) {
	<-r.ready
	if r.closedAt <= 0 {
		return
	}
	time.Sleep(welcomeBackSettle)
	ctx, cancel := context.WithTimeout(context.Background(), reconnectTimeout)
	defer cancel()
	data, err := src.Build()
	if err != nil {
		log.Printf("molten: welcome back not built: %v\n", err)
		return
	}
	live := make([]*waveobj.Job, 0, len(data.Sessions))
	for _, s := range data.Sessions {
		live = append(live, &waveobj.Job{OID: s.Id})
	}
	growth := map[string]int64{}
	for id, size := range outputSizes(ctx, live) {
		growth[id] = size - r.before[id]
	}
	wb := BuildWelcomeBack(WelcomeBackFacts{
		ClosedAt:     r.closedAt,
		Now:          time.Now().UnixMilli(),
		Sessions:     data.Sessions,
		OutputGrowth: growth,
		Exited:       exitedWhileClosed(ctx, r.closedAt),
	})
	input, ok := WelcomeBackNotification(wb, r.startTs)
	if !ok {
		return
	}
	if err := attention.PublishNotification(ctx, input); err != nil {
		log.Printf("molten: welcome back notification: %v\n", err)
		return
	}
	log.Printf("molten: welcome back: %d sessions survived, %d with news\n", wb.Survived, len(wb.Lines))
}

func beat(dataDir string) {
	defer func() {
		panichandler.PanicHandler("molten:sessions:alive", recover())
	}()
	for {
		if err := writeAlive(dataDir, time.Now().UnixMilli()); err != nil {
			log.Printf("molten: heartbeat not written: %v\n", err)
		}
		time.Sleep(aliveBeat)
	}
}
