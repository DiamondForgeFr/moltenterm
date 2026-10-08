// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"reflect"
	"sort"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The windows reach Update terminal through a leaf of wavesrv's router answering plain command names, like the agent
// states (attention/agentroute.go); the outdated terminals are published on an event whenever the list changes.

const (
	routeQueueSize  = 64
	publishInterval = 3 * time.Second
	storeTimeout    = 5 * time.Second
	// An update waits for an agent to exit and a new shell to start.
	runTimeout       = time.Minute
	reportsQueueSize = 64
)

// Shell is how wavesrv's block controller replaces and types into a terminal; set by pkg/blockcontroller at init
// (this package cannot import it).
type Shell struct {
	Replace   func(ctx context.Context, blockId string, cwd string, notice string) error
	SendInput func(blockId string, data []byte) error
}

var shellLock sync.Mutex
var shell Shell

func UseShell(s Shell) {
	shellLock.Lock()
	defer shellLock.Unlock()
	shell = s
}

func getShell() Shell {
	shellLock.Lock()
	defer shellLock.Unlock()
	return shell
}

// promptWatchers tells an update the moment a replaced shell shows its first prompt.
type promptWatchers struct {
	lock     sync.Mutex
	watchers map[string][]chan struct{}
}

func (p *promptWatchers) watch(blockId string) (<-chan struct{}, func()) {
	p.lock.Lock()
	defer p.lock.Unlock()
	ch := make(chan struct{}, 1)
	p.watchers[blockId] = append(p.watchers[blockId], ch)
	return ch, func() { p.release(blockId, ch) }
}

func (p *promptWatchers) release(blockId string, ch chan struct{}) {
	p.lock.Lock()
	defer p.lock.Unlock()
	list := p.watchers[blockId]
	for i, c := range list {
		if c == ch {
			p.watchers[blockId] = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(p.watchers[blockId]) == 0 {
		delete(p.watchers, blockId)
	}
}

func (p *promptWatchers) prompt(blockId string) {
	p.lock.Lock()
	defer p.lock.Unlock()
	for _, ch := range p.watchers[blockId] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

type genReport struct {
	blockId string
	gen     int
}

// service is the running part: the publisher of the outdated terminals, the generation recorder and the updater.
type service struct {
	updater *Updater
	prompts *promptWatchers
	reports chan genReport
	poke    chan struct{}

	lock    sync.Mutex
	last    []OutdatedTerminal
	version int64
}

func loadJob(ctx context.Context, blockId string) (*waveobj.Block, *waveobj.Job, error) {
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return nil, nil, err
	}
	if block == nil || block.JobId == "" {
		return block, nil, nil
	}
	job, err := wstore.DBGet[*waveobj.Job](ctx, block.JobId)
	if err != nil {
		return block, nil, err
	}
	return block, job, nil
}

func makeService() *service {
	s := &service{
		prompts: &promptWatchers{watchers: map[string][]chan struct{}{}},
		reports: make(chan genReport, reportsQueueSize),
		poke:    make(chan struct{}, 1),
	}
	s.updater = MakeUpdater(Env{
		LoadJob:     loadJob,
		ReadTable:   proctree.Read,
		ReadArgs:    attention.ReadProcessArgs,
		Cwd:         proctree.Cwd,
		AgentRun:    attention.AgentRun,
		FindSession: companion.FindResumeSession,
		SendInput: func(blockId string, data []byte) error {
			sendInput := getShell().SendInput
			if sendInput == nil {
				return fmt.Errorf("no terminal input")
			}
			return sendInput(blockId, data)
		},
		Replace: func(ctx context.Context, blockId string, cwd string, notice string) error {
			replace := getShell().Replace
			if replace == nil {
				return fmt.Errorf("no shell restart")
			}
			return replace(ctx, blockId, cwd, notice)
		},
		WatchPrompt: s.prompts.watch,
	})
	return s
}

// observe runs on the terminal output path: it only queues.
func (s *service) observe(blockId string, mark attention.ShellMark) {
	switch mark.Kind {
	case attention.ShellMarkPrompt:
		s.prompts.prompt(blockId)
	case attention.ShellMarkGeneration:
		select {
		case s.reports <- genReport{blockId: blockId, gen: mark.Gen}:
		default:
		}
	}
}

// recordGeneration raises the job's reported generation; the same or a lower one (output replayed after a
// reconnect) changes nothing, so the time it was reached stays the first one.
func recordGeneration(ctx context.Context, r genReport, now time.Time) (bool, error) {
	_, job, err := loadJob(ctx, r.blockId)
	if err != nil || job == nil {
		return false, err
	}
	_, reported, _ := ShellGeneration(job)
	if r.gen <= reported {
		return false, nil
	}
	meta := waveobj.MetaMapType{ShellGenMetaKey: r.gen, ShellGenAtMetaKey: now.UnixMilli()}
	return true, wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Job, job.OID), meta, false)
}

func (s *service) recordLoop() {
	defer func() {
		panichandler.PanicHandler("molten:termupdate:record", recover())
	}()
	for r := range s.reports {
		ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
		changed, err := recordGeneration(ctx, r, time.Now())
		cancel()
		if err != nil {
			log.Printf("molten: recording the shell generation of block %s: %v\n", r.blockId, err)
		}
		if changed {
			s.trigger()
		}
	}
}

func (s *service) trigger() {
	select {
	case s.poke <- struct{}{}:
	default:
	}
}

// Outdated lists the outdated terminals now.
func Outdated(ctx context.Context, current int, runOf func(string) (molten.AgentRunInfo, bool)) ([]OutdatedTerminal, error) {
	jobs, err := wstore.DBGetAllObjsByType[*waveobj.Job](ctx, waveobj.OType_Job)
	if err != nil {
		return nil, err
	}
	rtn := []OutdatedTerminal{}
	for _, job := range jobs {
		if !IsLocalShellJob(job, false) {
			continue
		}
		block, err := wstore.DBGet[*waveobj.Block](ctx, job.AttachedBlockId)
		if err != nil || block == nil || block.JobId != job.OID {
			continue
		}
		isCommand := block.Meta.GetString(waveobj.MetaKey_Cmd, "") != ""
		run, hasRun := runOf(block.OID)
		if t, ok := Assess(job, isCommand, run, hasRun, current); ok {
			rtn = append(rtn, t)
		}
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].BlockId < rtn[j].BlockId })
	return rtn, nil
}

func (s *service) refresh() {
	ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
	defer cancel()
	list, err := Outdated(ctx, shellutil.MoltenShellGeneration, attention.AgentRun)
	if err != nil {
		log.Printf("molten: listing outdated terminals: %v\n", err)
		return
	}
	s.lock.Lock()
	if reflect.DeepEqual(list, s.last) {
		s.lock.Unlock()
		return
	}
	s.last = list
	s.version++
	data := OutdatedData{Terminals: list, Version: s.version}
	s.lock.Unlock()
	wps.Broker.Publish(wps.WaveEvent{Event: Event, Data: data})
}

func (s *service) snapshot() OutdatedData {
	s.lock.Lock()
	defer s.lock.Unlock()
	return OutdatedData{Terminals: append([]OutdatedTerminal{}, s.last...), Version: s.version}
}

func (s *service) publishLoop() {
	defer func() {
		panichandler.PanicHandler("molten:termupdate:publish", recover())
	}()
	ticker := time.NewTicker(publishInterval)
	defer ticker.Stop()
	for {
		s.refresh()
		select {
		case <-ticker.C:
		case <-s.poke:
		}
	}
}

type routeLink struct {
	s      *service
	output chan []byte
}

func (l *routeLink) GetPeerInfo() string {
	return Route
}

func (l *routeLink) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-l.output
	return msg, ok
}

func (l *routeLink) SendRpcMessage(msg []byte, ingressLinkId baseds.LinkId, debugStr string) bool {
	var req wshutil.RpcMessage
	if err := json.Unmarshal(msg, &req); err != nil {
		return true
	}
	if req.Command == "" || req.ReqId == "" {
		return true
	}
	go l.answer(req)
	return true
}

func (l *routeLink) answer(req wshutil.RpcMessage) {
	defer func() {
		panichandler.PanicHandler("molten:termupdate:route", recover())
	}()
	resp := wshutil.RpcMessage{ResId: req.ReqId}
	data, err := l.handle(req.Command, req.Data)
	if err != nil {
		resp.Error = err.Error()
	} else {
		resp.Data = data
	}
	out, err := json.Marshal(resp)
	if err != nil {
		return
	}
	l.output <- out
}

func (l *routeLink) handle(command string, data any) (any, error) {
	switch command {
	case ListCommand:
		return l.s.snapshot(), nil
	case CheckCommand, RunCommand:
		var req Request
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if req.BlockId == "" {
			return nil, fmt.Errorf("no terminal given")
		}
		ctx, cancel := context.WithTimeout(context.Background(), runTimeout)
		defer cancel()
		if command == CheckCommand {
			return l.s.updater.Check(ctx, req), nil
		}
		out := l.s.updater.Run(ctx, req)
		l.s.trigger()
		return out, nil
	}
	return nil, fmt.Errorf("unknown terminal update command %q", command)
}

// Start registers the route, follows the shells' marks and starts the publisher; wavesrv calls it once at startup,
// after the agent states (Mission Control's starters).
func Start() {
	s := makeService()
	attention.OnShellMark(s.observe)
	link := &routeLink{s: s, output: make(chan []byte, routeQueueSize)}
	if _, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, Route); err != nil {
		log.Printf("molten: terminal update route not started: %v\n", err)
		return
	}
	go s.recordLoop()
	go s.publishLoop()
}
