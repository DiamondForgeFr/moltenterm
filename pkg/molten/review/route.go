// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
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
	// Comments (FR-REV-003, FR-REV-009): saved, staged, dropped, discussed and moved to a new head from a MoltenTerm
	// window only.
	CommentCommand      = "moltenreviewcomment"
	CommentStateCommand = "moltenreviewcommentstate"
	RewriteCommand      = "moltenreviewcommentrewrite"
	DiscussCommand      = "moltenreviewcommentdiscuss"
	RelocateCommand     = "moltenreviewrelocate"
	// Publish review (FR-REV-010): the language, the translations, the summary and the post are a MoltenTerm window's
	// only; no agent tool reaches them (NFR-REV-003).
	PublishInfoCommand = "moltenreviewpublishinfo"
	TranslateCommand   = "moltenreviewtranslate"
	TranslationCommand = "moltenreviewtranslation"
	SummaryCommand     = "moltenreviewsummary"
	PublishCommand     = "moltenreviewpublish"
)

const (
	logPrefix = "molten: review:"
	// A file list or a compare may fetch the PR's branches; a worktree may be created.
	gitTimeout     = 90 * time.Second
	controlTimeout = 15 * time.Second
	// Post review lists, posts and checks on GitHub, one call per file comment.
	publishTimeout = 4 * time.Minute
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
	// publishNotes: a project's notes changed (FR-REV-008); nil in the tests that do not need it.
	publishNotes func(notes Notes)
	merger       *Merger
	// cleaner: the cleanup after the merge (FR-REV-013); nil in the tests that do not need it.
	cleaner *Cleaner
	// handoff: what `molten review` asks of the terminal's window (FR-REV-014).
	handoff HandoffEnv
	// restarter: Restart work (FR-REV-011); nil in the tests that do not need it.
	restarter *Restarter
	// forecaster: the Reviews list's conflict forecast (FR-REV-023); nil in the tests that do not need it.
	forecaster *Forecaster
	// batch: the batch merge by an agent (FR-REV-025); nil in the tests that do not need it.
	batch *BatchRunner
	// discuss sends a comment to the PR's review session (FR-REV-009); reviewsession.Discuss outside the tests.
	discuss func(ctx context.Context, req mcpreview.DiscussRequest) (mcpreview.AskResult, error)
	// translate asks the PR's review session for the translations (FR-REV-010); reviewsession.Translate outside the
	// tests.
	translate func(ctx context.Context, req mcpreview.TranslateRequest) (mcpreview.AskResult, error)
	// gh: the developer's gh for Post review and the publication language (FR-REV-010).
	gh GhRunner
	// publishSetting: the review:publishlanguage setting; readFile reads a project file (nil when absent).
	publishSetting func() string
	readFile       func(path string) []byte
	languages      languageCache

	lock      sync.Mutex
	treeLocks map[string]*sync.Mutex
	// publishing: the PRs whose review is being posted.
	publishing map[PrKey]bool
}

func MakeService(dataDir string, git reviewsession.GitRunner, publish func(k PrKey, state State)) *Service {
	store := MakeStore(dataDir)
	merger := MakeMerger(store, ExecGh, publish)
	merger.reviewer = ReviewerName
	return &Service{
		differ: MakeDiffer(git), store: store, git: git, dataDir: dataDir, publish: publish,
		merger: merger, gh: ExecGh, readFile: readProjectFile, treeLocks: map[string]*sync.Mutex{},
	}
}

func readProjectFile(path string) []byte {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return data
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
			AskRebase:  service.AskRebase,
			Notify:     attention.PublishNotification,
			ResolveNotices: func(ctx context.Context, keyPrefix string) error {
				return attention.ResolveNotificationsExcept(ctx, keyPrefix, nil)
			},
			DataDir: wavebase.GetWaveDataDir(),
		})
		service.restarter = MakeRestarter(service.store, liveRestartEnv(git))
		service.forecaster = MakeForecaster(ForecastEnv{
			Git:      liveForecastGit,
			StoreDir: filepath.Join(wavebase.GetWaveDataDir(), "molten", "forecast"),
			Rules:    makeForecastRules(service.merger).Rules,
			Publish: func(f Forecast) {
				wps.Broker.Publish(wps.WaveEvent{Event: ForecastEvent, Scopes: []string{f.Dir}, Data: f})
			},
		})
		service.batch = MakeBatchRunner(BatchEnv{
			Gh:      ExecGh,
			Merger:  service.merger,
			Agents:  service.restarter,
			DataDir: wavebase.GetWaveDataDir(),
			Publish: func(run BatchRun) {
				wps.Broker.Publish(wps.WaveEvent{Event: BatchEvent, Scopes: []string{run.Dir}, Data: run})
			},
		})
		service.merger.greenOnly = func() bool {
			return wconfig.GetWatcher().GetFullConfig().Settings.ReviewValidateGreenOnly
		}
		service.publishNotes = func(notes Notes) {
			wps.Broker.Publish(wps.WaveEvent{Event: NotesEvent, Scopes: []string{NotesScope(notes.Repo)}, Data: notes})
		}
		SetPostMerge(service)
		service.handoff = defaultHandoffEnv()
		service.discuss = reviewsession.Discuss
		service.translate = reviewsession.Translate
		service.publishSetting = func() string {
			return wconfig.GetWatcher().GetFullConfig().Settings.ReviewPublishLanguage
		}
		if _, err := localroute.Register(wshutil.DefaultRouter, (&routeLink{service: service}).route()); err != nil {
			log.Printf("%s route not started: %v\n", logPrefix, err)
			return
		}
		// The PRs the developer validated are merged even across a restart (FR-REV-026 AC2).
		service.batch.Resume()
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

// SessionPosted keeps what the review session posts that outlives it: the briefing (FR-REV-005 AC4), the answers to
// the developer's questions (FR-REV-006), the comment proposals and the replies on comments (FR-REV-009).
func (s *Service) SessionPosted(update mcpreview.Update) {
	post := update.Post
	if post == nil {
		return
	}
	k := PrKey{Repo: update.Repo, Number: update.Number}
	var err error
	what := ""
	switch post.Kind {
	case mcpreview.PostBriefing:
		what = "the briefing"
		b := Briefing{Markdown: post.Markdown, HeadOid: post.HeadOid, Agent: post.Agent, At: post.At}
		_, err = s.changed(s.store.SetBriefing(k, b))
	case mcpreview.PostProposal:
		what = "the comment proposal"
		_, err = s.changed(s.store.AddProposal(k, *post))
	case mcpreview.PostReply:
		what = "the reply on a comment"
		_, err = s.changed(s.store.AddReply(k, *post))
	case mcpreview.PostExplanation:
		what = "the explanation"
		_, err = s.changed(s.store.SetExplanation(k, explanationOf(*post)))
	case mcpreview.PostTranslation:
		what = "the translation"
		_, err = s.changed(s.store.SetTranslation(k, post.CommentId, post.Text, post.Lang, false))
	default:
		return
	}
	if err != nil {
		log.Printf("%s %s#%d: %s could not be kept: %v\n", logPrefix, k.Repo, k.Number, what, err)
	}
}

func defaultHandoffEnv() HandoffEnv {
	return HandoffEnv{
		VerifyToken: func(token string) (string, error) {
			rpcCtx, err := wshutil.ValidateAndExtractRpcContextFromToken(token)
			if err != nil {
				return "", err
			}
			if rpcCtx == nil || rpcCtx.BlockId == "" || rpcCtx.IsRouter {
				return "", fmt.Errorf("the token is not a terminal's")
			}
			return rpcCtx.BlockId, nil
		},
		BlockIsLocal: func(ctx context.Context, blockId string) bool {
			block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
			return err == nil && block != nil && conncontroller.IsLocalConnName(block.Meta.GetString(waveobj.MetaKey_Connection, ""))
		},
		WorkspaceOf: func(ctx context.Context, blockId string) (string, error) {
			tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
			if err != nil {
				return "", err
			}
			return wstore.DBFindWorkspaceForTabId(ctx, tabId)
		},
		AgentRunning: func(blockId string) bool {
			run, ok := attention.AgentRun(blockId)
			return ok && run.Running
		},
		Publish: func(workspaceId string, h Handoff) {
			wps.Broker.Publish(wps.WaveEvent{Event: HandoffEvent, Scopes: []string{workspaceId}, Data: h})
		},
	}
}

func agentStateOf(blockId string) string {
	run, ok := attention.AgentRun(blockId)
	if !ok || !run.Running {
		return ""
	}
	return run.State
}

type routeLink struct {
	service *Service
}

// route: what reads a review answers the windows and local terminals (`molten review`), a handoff comes from a local
// terminal only (the window opens the tab or the sheet, and the developer's click there does the rest), and what
// changes the store, a worktree or the tabs is the Review tab's: a terminal, where an agent may run, cannot. A remote
// host never reads or changes a review (FR-REV-014 AC4, #662).
func (l *routeLink) route() localroute.Route {
	return localroute.Route{
		Id: RouteId,
		Policy: localroute.Policy{
			Default: localroute.AllowWindow,
			Commands: map[string]string{
				FilesCommand:          localroute.AllowLocal,
				FileCommand:           localroute.AllowLocal,
				CompareCommand:        localroute.AllowLocal,
				StateCommand:          localroute.AllowLocal,
				MergePlanShownCommand: localroute.AllowLocal,
				NotesCommand:          localroute.AllowLocal,
				HandoffCommand:        localroute.AllowLocalTerminal,
			},
			Refusals: map[string]string{HandoffCommand: "review handoffs come from a local MoltenTerm terminal"},
		},
		Handler: func(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
			ctx, cancel := context.WithTimeout(ctx, commandTimeout(command))
			defer cancel()
			return l.handle(ctx, command, data)
		},
	}
}

func commandTimeout(command string) time.Duration {
	switch command {
	case FilesCommand, FileCommand, CompareCommand, WorktreeCommand, MergePlanCommand, RelocateCommand, DiscussCommand,
		PublishInfoCommand, TranslateCommand, NoteFileCommand, MarkReadyCommand:
		return gitTimeout
	case PublishCommand:
		return publishTimeout
	case CleanupCommand:
		return cleanupTimeout
	case RestartCommand, RebaseCommand, InvestigateCommand:
		return restartTimeout
	}
	return controlTimeout
}

func decode[T any](data any) (T, error) {
	var rtn T
	err := utilfn.ReUnmarshal(&rtn, data)
	return rtn, err
}

func (l *routeLink) handle(ctx context.Context, command string, data any) (any, error) {
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
	case MergePlanShownCommand:
		req, err := decode[PrKey](data)
		if err != nil {
			return nil, err
		}
		return s.merger.Shown(req)
	case HandoffCommand:
		req, err := decode[HandoffRequest](data)
		if err != nil {
			return nil, err
		}
		return RunHandoff(ctx, s.handoff, req)
	case NotesCommand:
		req, err := decode[NotesRequest](data)
		if err != nil {
			return nil, err
		}
		return s.store.GetNotes(req.Repo)
	case ForecastCommand:
		req, err := decode[ForecastRequest](data)
		if err != nil {
			return nil, err
		}
		if s.forecaster == nil {
			return nil, fmt.Errorf("the conflict forecast is not available")
		}
		return s.forecaster.Get(req)
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
	case PrStateCommand:
		req, err := decode[PrStateRequest](data)
		if err != nil {
			return nil, err
		}
		return s.merger.PrState(ctx, req)
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
	case CommentStateCommand:
		req, err := decode[CommentStateRequest](data)
		if err != nil {
			return nil, err
		}
		return s.changed(s.store.SetCommentState(req))
	case RewriteCommand:
		req, err := decode[RewriteRequest](data)
		if err != nil {
			return nil, err
		}
		return s.changed(s.store.UseRewrite(req))
	case DiscussCommand:
		req, err := decode[DiscussRequest](data)
		if err != nil {
			return nil, err
		}
		return s.Discuss(ctx, req)
	case RelocateCommand:
		req, err := decode[RelocateRequest](data)
		if err != nil {
			return nil, err
		}
		return s.changed(s.Relocate(ctx, req))
	case PublishInfoCommand:
		req, err := decode[PublishInfoRequest](data)
		if err != nil {
			return nil, err
		}
		return s.PublishInfo(ctx, req)
	case TranslateCommand:
		req, err := decode[TranslateRequest](data)
		if err != nil {
			return nil, err
		}
		return s.Translate(ctx, req)
	case TranslationCommand:
		req, err := decode[TranslationRequest](data)
		if err != nil {
			return nil, err
		}
		return s.changed(s.store.SetTranslation(req.PrKey, req.Id, req.Text, req.Lang, true))
	case SummaryCommand:
		req, err := decode[SummaryRequest](data)
		if err != nil {
			return nil, err
		}
		return s.changed(s.store.SetSummary(req))
	case PublishCommand:
		// NFR-REV-003: GitHub gets the review only on the developer's click in the Publish sheet.
		req, err := decode[PublishRequest](data)
		if err != nil {
			return nil, err
		}
		return s.Publish(ctx, req)
	case RestartCommand:
		// The developer's click on Restart work: an agent reached from a terminal never restarts another one's work.
		req, err := decode[RestartRequest](data)
		if err != nil {
			return nil, err
		}
		return s.Restart(ctx, req)
	case RebaseCommand:
		// The developer's click on Ask for a rebase (#683): like Restart work, never an agent's from a terminal.
		req, err := decode[RebaseRequest](data)
		if err != nil {
			return nil, err
		}
		return s.AskRebase(ctx, req)
	case InvestigateCommand:
		// The developer's click on Investigate (#797): like Ask for a rebase, never an agent's from a terminal.
		req, err := decode[InvestigateRequest](data)
		if err != nil {
			return nil, err
		}
		return s.AskInvestigate(ctx, req)
	case MarkReadyCommand:
		// The developer's click on Mark ready for review (#687): GitHub notifies the reviewers, so never a terminal's.
		req, err := decode[MarkReadyRequest](data)
		if err != nil {
			return nil, err
		}
		return s.MarkReady(ctx, req)
	case QueueAddCommand, QueueWithdrawCommand, BatchGetCommand, BatchCancelCommand, BatchDismissCommand:
		// NFR-REV-003: a PR joins or leaves the merge queue on the developer's clicks in a window only.
		return s.handleBatch(command, data)
	case NoteKeepCommand:
		req, err := decode[NoteKeepRequest](data)
		if err != nil {
			return nil, err
		}
		return s.notesChanged(s.store.KeepNote(req))
	case NoteRenameCommand:
		req, err := decode[NoteRenameRequest](data)
		if err != nil {
			return nil, err
		}
		return s.notesChanged(s.store.RenameNote(req))
	case NoteDeleteCommand:
		req, err := decode[NoteDeleteRequest](data)
		if err != nil {
			return nil, err
		}
		return s.notesChanged(s.store.DeleteNote(req))
	case NoteFileCommand:
		req, err := decode[NoteFileRequest](data)
		if err != nil {
			return nil, err
		}
		return s.NoteFile(ctx, req)
	}
	return nil, fmt.Errorf("unknown review command %q", command)
}
