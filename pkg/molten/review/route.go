// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The Review tab reaches wavesrv on a leaf of its router answering plain command names, like the review sessions:
// nothing is declared in pkg/wshrpc. Must match frontend/moltenterm-shell/review/review-client.ts.
const (
	RouteId = "molten:review"
	// WPS event with a PR's review store (scope: mcpreview.ScopeOf(repo, number)).
	UpdateEvent = "molten:review:update"

	OpenCommand     = "moltenreviewopen"
	FilesCommand    = "moltenreviewfiles"
	FileCommand     = "moltenreviewfile"
	CompareCommand  = "moltenreviewcompare"
	WorktreeCommand = "moltenreviewworktree"
	StateCommand    = "moltenreviewstate"
	ViewedCommand   = "moltenreviewviewed"
	ShownCommand    = "moltenreviewshown"
	AiPaneCommand   = "moltenreviewaipane"
	// Validate (FR-REV-012): the plan, the merge and its cancel are a MoltenTerm window's only.
	MergePlanCommand   = "moltenreviewmergeplan"
	MergeCommand       = "moltenreviewmerge"
	MergeCancelCommand = "moltenreviewmergecancel"
	// Comments (FR-REV-003): saved, deleted and moved to a new head from a MoltenTerm window only.
	CommentCommand   = "moltenreviewcomment"
	UncommentCommand = "moltenreviewcommentdelete"
	RelocateCommand  = "moltenreviewrelocate"
)

const (
	logPrefix      = "molten: review:"
	routeQueueSize = 64
	// A file list or a compare may fetch the PR's branches; a worktree may be created.
	gitTimeout     = 90 * time.Second
	controlTimeout = 15 * time.Second
)

type WorktreeRequest struct {
	Dir     string `json:"dir"`
	Number  int    `json:"number"`
	HeadRef string `json:"headref"`
	HeadOid string `json:"headoid"`
}

type WorktreeResult struct {
	Worktree string `json:"worktree"`
	// Kind: mcpreview.WorktreeAgent (the agent's worktree holds the branch) or WorktreeReview (MoltenTerm's detached one).
	Kind string `json:"kind"`
	Ms   int64  `json:"ms"`
}

// Service is the Review tab's backend.
type Service struct {
	differ  *Differ
	store   *Store
	git     reviewsession.GitRunner
	dataDir string
	publish func(k PrKey, state State)
	merger  *Merger
	// cleaner: the cleanup after the merge (FR-REV-013); nil in the tests that do not need it.
	cleaner *Cleaner

	lock      sync.Mutex
	treeLocks map[string]*sync.Mutex
}

func MakeService(dataDir string, git reviewsession.GitRunner, publish func(k PrKey, state State)) *Service {
	store := MakeStore(dataDir)
	return &Service{differ: MakeDiffer(git), store: store, git: git, dataDir: dataDir, publish: publish, merger: MakeMerger(store, ExecGh, publish), treeLocks: map[string]*sync.Mutex{}}
}

func (s *Service) treeLock(key string) *sync.Mutex {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.treeLocks[key] == nil {
		s.treeLocks[key] = &sync.Mutex{}
	}
	return s.treeLocks[key]
}

// Worktree prepares the PR's review worktree at the head (DS-REV-004): the agent's worktree when it holds the branch,
// else MoltenTerm's detached one, created or moved. The developer's checkout is never touched.
func (s *Service) Worktree(ctx context.Context, req WorktreeRequest) (WorktreeResult, error) {
	if err := checkDir(req.Dir); err != nil {
		return WorktreeResult{}, err
	}
	if req.Number <= 0 || !reviewsession.ValidRef(req.HeadRef) || !isOid(req.HeadOid) {
		return WorktreeResult{}, fmt.Errorf("number, headref and headoid must name the PR's head")
	}
	lock := s.treeLock(req.Dir + "#" + fmt.Sprint(req.Number))
	lock.Lock()
	defer lock.Unlock()
	started := time.Now()
	tree, kind, err := reviewsession.ResolveWorktree(ctx, s.git, s.dataDir, req.Dir, req.Number, req.HeadRef, req.HeadOid)
	if err != nil {
		return WorktreeResult{}, err
	}
	return WorktreeResult{Worktree: tree, Kind: kind, Ms: time.Since(started).Milliseconds()}, nil
}

func (s *Service) changed(state State, changed bool, err error) (State, error) {
	if err == nil && changed && s.publish != nil {
		s.publish(PrKey{Repo: state.Repo, Number: state.Number}, state)
	}
	return state, err
}

var startOnce sync.Once

// Start registers the Review tab's route on wavesrv's router; it starts with Mission Control. Nothing runs until a
// Review tab asks (NFR-REV-002).
func Start() {
	startOnce.Do(func() {
		git := func(ctx context.Context, dir string, args ...string) ([]byte, error) {
			return mission.ExecRunner(ctx, dir, "git", args...)
		}
		service := MakeService(wavebase.GetWaveDataDir(), git, func(k PrKey, state State) {
			wps.Broker.Publish(wps.WaveEvent{Event: UpdateEvent, Scopes: []string{mcpreview.ScopeOf(k.Repo, k.Number)}, Data: state})
		})
		service.cleaner = MakeCleaner(CleanupEnv{
			Run:        cleanupRunner,
			Terminals:  mission.WorktreeTerminalsOf,
			AgentState: agentStateOf,
			EndSession: reviewsession.EndSession,
			DataDir:    wavebase.GetWaveDataDir(),
		})
		SetPostMerge(service)
		link := &routeLink{service: service, output: make(chan []byte, routeQueueSize), localSource: localSourceOnLink}
		if _, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, RouteId); err != nil {
			log.Printf("%s route not started: %v\n", logPrefix, err)
			return
		}
		rpcClient := wshclient.GetBareRpcClient()
		rpcClient.EventListener.On(mcpreview.Event, func(event *wps.WaveEvent) {
			var update mcpreview.Update
			if utilfn.ReUnmarshal(&update, event.Data) != nil {
				return
			}
			service.SessionPosted(update)
		})
		wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: mcpreview.Event, AllScopes: true}, nil)
	})
}

// SessionPosted keeps what the review session posts that outlives it: the briefing (FR-REV-005 AC4).
func (s *Service) SessionPosted(update mcpreview.Update) {
	post := update.Post
	if post == nil || post.Kind != mcpreview.PostBriefing {
		return
	}
	k := PrKey{Repo: update.Repo, Number: update.Number}
	b := Briefing{Markdown: post.Markdown, HeadOid: post.HeadOid, Agent: post.Agent, At: post.At}
	if _, err := s.changed(s.store.SetBriefing(k, b)); err != nil {
		log.Printf("%s %s#%d: the briefing could not be kept: %v\n", logPrefix, k.Repo, k.Number, err)
	}
}

func agentStateOf(blockId string) string {
	run, ok := attention.AgentRun(blockId)
	if !ok || !run.Running {
		return ""
	}
	return run.State
}

func localSourceOnLink(source string, ingressLinkId baseds.LinkId) bool {
	return localroute.OnLink(wshutil.DefaultRouter, source, ingressLinkId)
}

type routeLink struct {
	service *Service
	output  chan []byte
	// localSource tells whether a request's source is a local terminal or a window on the link it came in on.
	localSource func(source string, ingressLinkId baseds.LinkId) bool
}

func (l *routeLink) GetPeerInfo() string {
	return RouteId
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
	// Source checks take the router's lock, which is held while it calls SendRpcMessage.
	go l.answer(req, ingressLinkId)
	return true
}

func (l *routeLink) answer(req wshutil.RpcMessage, ingressLinkId baseds.LinkId) {
	defer func() {
		panichandler.PanicHandler("molten:review:route", recover())
	}()
	timeout := controlTimeout
	switch req.Command {
	case FilesCommand, FileCommand, CompareCommand, WorktreeCommand, MergePlanCommand, RelocateCommand:
		timeout = gitTimeout
	case CleanupCommand:
		timeout = cleanupTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	source := req.Source
	if l.localSource == nil || !l.localSource(source, ingressLinkId) {
		source = ""
	}
	resp := wshutil.RpcMessage{ResId: req.ReqId}
	data, err := l.handle(ctx, req.Command, source, req.Data)
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

func isWindowSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Tab)
}

func isTerminalSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Proc)
}

func decode[T any](data any) (T, error) {
	var rtn T
	err := utilfn.ReUnmarshal(&rtn, data)
	return rtn, err
}

func (l *routeLink) handle(ctx context.Context, command string, source string, data any) (any, error) {
	if !isWindowSource(source) && !isTerminalSource(source) {
		return nil, fmt.Errorf("reviews are answered to MoltenTerm's windows and local terminals only")
	}
	s := l.service
	switch command {
	case FilesCommand:
		req, err := decode[FilesRequest](data)
		if err != nil {
			return nil, err
		}
		return s.differ.Files(ctx, req)
	case FileCommand:
		req, err := decode[FileRequest](data)
		if err != nil {
			return nil, err
		}
		return s.differ.File(ctx, req)
	case CompareCommand:
		req, err := decode[CompareRequest](data)
		if err != nil {
			return nil, err
		}
		return s.differ.Compare(ctx, req)
	case StateCommand:
		req, err := decode[PrKey](data)
		if err != nil {
			return nil, err
		}
		return s.store.Get(req)
	}
	// What changes the store, a worktree or the tabs is the Review tab's: a terminal, where an agent may run, cannot.
	if !isWindowSource(source) {
		return nil, fmt.Errorf("reviews are changed from a MoltenTerm window")
	}
	switch command {
	case OpenCommand:
		req, err := decode[OpenRequest](data)
		if err != nil {
			return nil, err
		}
		return OpenTab(ctx, req)
	case AiPaneCommand:
		req, err := decode[AiPaneRequest](data)
		if err != nil {
			return nil, err
		}
		return OpenAiPane(ctx, req)
	case WorktreeCommand:
		req, err := decode[WorktreeRequest](data)
		if err != nil {
			return nil, err
		}
		return s.Worktree(ctx, req)
	case ViewedCommand:
		req, err := decode[ViewedRequest](data)
		if err != nil {
			return nil, err
		}
		return s.changed(s.store.SetViewed(req))
	case ShownCommand:
		req, err := decode[ShownRequest](data)
		if err != nil {
			return nil, err
		}
		return s.changed(s.store.Shown(req))
	case MergePlanCommand:
		// A plan is what a merge is bound to: a terminal making one would replace the plan the window shows.
		req, err := decode[MergePlanRequest](data)
		if err != nil {
			return nil, err
		}
		return s.merger.Plan(ctx, req)
	case MergeCommand:
		// NFR-REV-003: the merge follows the developer's click on the plan sheet; no agent tool reaches it.
		req, err := decode[MergeRequest](data)
		if err != nil {
			return nil, err
		}
		return s.merger.Merge(req)
	case MergeCancelCommand:
		req, err := decode[PrKey](data)
		if err != nil {
			return nil, err
		}
		return nil, s.merger.Cancel(req)
	case CleanupCommand:
		req, err := decode[CleanupRequest](data)
		if err != nil {
			return nil, err
		}
		return s.Cleanup(ctx, req)
	case CommentCommand:
		req, err := decode[CommentRequest](data)
		if err != nil {
			return nil, err
		}
		return s.changed(s.store.SaveComment(req))
	case UncommentCommand:
		req, err := decode[CommentDeleteRequest](data)
		if err != nil {
			return nil, err
		}
		return s.changed(s.store.DeleteComment(req))
	case RelocateCommand:
		req, err := decode[RelocateRequest](data)
		if err != nil {
			return nil, err
		}
		return s.changed(s.Relocate(ctx, req))
	}
	return nil, fmt.Errorf("unknown review command %q", command)
}
