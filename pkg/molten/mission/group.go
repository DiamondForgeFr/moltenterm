// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Group resolution in the collector (FR-MC-026, DS-MC-017): the groups come from the workspace links and each linked
// project's pipeline file (pkg/molten/group.go); each member gets a state summary made only of what Mission Control
// already knows of it. Asking about a group never fetches, never calls gh and never runs a command in a member's
// folder (NFR-MC-007), and nothing is written in any project (NFR-MC-006).
//
// For the stories built on it: the rail (#348) and the group strip (#349) ask GroupsCommand and follow GroupsEvent;
// a member's Worst is the rail badge. Stale dependencies (#350) raise a member to GroupWorstAmber in memberWorst.

// must match the names in frontend/moltenterm-shell/mission/group-model.ts and cmd/wsh/cmd/wshcmd-molten-project.go
const (
	GroupsCommand   = "moltenmissiongroups"
	GroupsEvent     = "molten:mission:groups"
	GroupWorstRed   = "red"
	GroupWorstAmber = "amber"
	groupsTimeout   = 20 * time.Second
)

// GitHub conclusions that make a run red. A cancelled run is left out: a newer push usually cancelled it.
var githubFailureConclusions = map[string]bool{
	"failure": true, "error": true, "timed_out": true, "action_required": true, "startup_failure": true,
}

type GroupsRequest struct {
	// With a folder, only the group it is a member of (none when it is in no group).
	Dir string `json:"dir,omitempty"`
}

// GroupMemberState is a member's state summary, from the collector's cache and MoltenTerm's own records.
type GroupMemberState struct {
	// The folder is gone; the link stays until the user removes it.
	Missing bool `json:"missing,omitempty"`
	// When the collector last read the member's git; 0 when it never did (its workspace was never opened).
	CollectedAt int64  `json:"collectedat,omitempty"`
	Trunk       string `json:"trunk,omitempty"`
	TrunkSha    string `json:"trunksha,omitempty"`
	// The local CI's say on the trunk head: success, failure, running or missing; empty without a local CI.
	TrunkCi string `json:"trunkci,omitempty"`
	// GitHub's runs on the trunk's newest run commit: success, failure or running; empty when unknown.
	RemoteCi    string `json:"remoteci,omitempty"`
	RemoteCiUrl string `json:"remoteciurl,omitempty"`
	// The last build run: its state (running, success, failure, cancelled, lost) and declared id.
	Build   string `json:"build,omitempty"`
	BuildId string `json:"buildid,omitempty"`
	BuildAt int64  `json:"buildat,omitempty"`
	// The last public release and the newest release tag (a candidate included).
	ReleaseTag string `json:"releasetag,omitempty"`
	LastTag    string `json:"lasttag,omitempty"`
	// The member's declared dependencies, each evaluated (FR-MC-029); a stale one raises the badge to amber.
	Deps []DependencyState `json:"deps,omitempty"`
	// The badge: red (CI or build failed) over amber (stale dependency) over none. A running job gives none.
	Worst string `json:"worst,omitempty"`
}

type GroupMemberInfo struct {
	molten.GroupMember
	State GroupMemberState `json:"state"`
}

type GroupInfo struct {
	Key     string            `json:"key"`
	Name    string            `json:"name"`
	Members []GroupMemberInfo `json:"members"`
	// The worst member state.
	Worst string `json:"worst,omitempty"`
}

type GroupsAnswer struct {
	Groups []GroupInfo `json:"groups"`
}

type Groups struct {
	lock sync.Mutex
	// One refresh pass at a time; the refreshes asked meanwhile make one more pass, not one each.
	refreshing   bool
	refreshAgain bool
	collector    *Collector
	ci          *Ci
	runs        *Runs
	links       func(ctx context.Context) ([]molten.GroupLink, error)
	read        func(dir string) molten.ProjectInfo
	readDeps    func(dir string) (string, []molten.PipelineDependency)
	run         Runner
	now         func() time.Time
	publish     func(GroupsAnswer)
	// Tells the stale dependencies in the notification center; nil in tests that do not look.
	notify func(DependencyNotices) error
	// The last published model, so a refresh that changed nothing of the groups is not told again.
	published string
	// The last notices told, so a refresh that changed none of them does not read the notifications again.
	noticed string
	// The last evaluation of each declared dependency, by depCacheKey.
	deps map[string]DependencyState
	// Syncs (FR-MC-030): the no-change acknowledgements, where the sources' worktrees go, the dependents syncing and
	// the worktrees in use. Without UseSync, Sync is not available.
	acks      *DepAcks
	treesDir  string
	syncing   map[string]bool
	syncTrees map[string]bool
}

func MakeGroups(collector *Collector, ci *Ci, runs *Runs, run Runner, links func(ctx context.Context) ([]molten.GroupLink, error), publish func(GroupsAnswer), notify func(DependencyNotices) error) *Groups {
	return &Groups{collector: collector, ci: ci, runs: runs, run: run, links: links, read: molten.ReadProject, readDeps: ReadDependsOn,
		now: time.Now, publish: publish, notify: notify, deps: map[string]DependencyState{}}
}

// WorkspaceLinks reads the workspace → project links in the rail's order: Wave's workspace list keeps the database's
// order, which is the order read here.
func WorkspaceLinks(ctx context.Context) ([]molten.GroupLink, error) {
	workspaces, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](ctx, waveobj.OType_Workspace)
	if err != nil {
		return nil, err
	}
	links := []molten.GroupLink{}
	for _, ws := range workspaces {
		dir := ws.Meta.GetString(molten.ProjectMetaKey, "")
		if dir == "" {
			continue
		}
		links = append(links, molten.GroupLink{WorkspaceId: ws.OID, WorkspaceName: ws.Name, Dir: dir})
	}
	return links, nil
}

// trunkRemoteCi sums up GitHub's runs on the trunk: the runs of the trunk's newest run commit, red when one failed,
// running while one is not completed, green when all succeeded.
func trunkRemoteCi(raw json.RawMessage, trunk string) (string, string) {
	if len(raw) == 0 || trunk == "" {
		return "", ""
	}
	var runs []struct {
		HeadBranch string `json:"headBranch"`
		HeadSha    string `json:"headSha"`
		Status     string `json:"status"`
		Conclusion string `json:"conclusion"`
		Url        string `json:"url"`
	}
	if json.Unmarshal(raw, &runs) != nil {
		return "", ""
	}
	sha := ""
	state, url := "", ""
	for _, run := range runs {
		if run.HeadBranch != trunk {
			continue
		}
		if sha == "" {
			sha = run.HeadSha
		}
		if run.HeadSha != sha {
			continue
		}
		conclusion := strings.ToLower(run.Conclusion)
		switch {
		case githubFailureConclusions[conclusion]:
			return CiStateFailure, run.Url
		case !strings.EqualFold(run.Status, "completed"):
			state, url = CiStateRunning, run.Url
		case conclusion == "success" && state == "":
			state, url = CiStateSuccess, run.Url
		}
	}
	return state, url
}

func memberWorst(state GroupMemberState) string {
	if state.TrunkCi == CiStateFailure || state.RemoteCi == CiStateFailure || state.Build == RunStateFailure {
		return GroupWorstRed
	}
	for _, dep := range state.Deps {
		if dep.Flagged() {
			return GroupWorstAmber
		}
	}
	return ""
}

func worstOf(a string, b string) string {
	if a == GroupWorstRed || b == GroupWorstRed {
		return GroupWorstRed
	}
	if a == GroupWorstAmber || b == GroupWorstAmber {
		return GroupWorstAmber
	}
	return ""
}

func (g *Groups) memberState(group *molten.ProjectGroup, member molten.GroupMember, fresh bool) GroupMemberState {
	dir := member.Dir
	state := GroupMemberState{}
	if g.run != nil && g.readDeps != nil {
		state.Deps = g.memberDeps(group, member, fresh)
	}
	if g.collector == nil {
		state.Worst = memberWorst(state)
		return state
	}
	snap, known := g.collector.Cached(dir)
	if known {
		state.Missing = snap.Missing
		state.CollectedAt = snap.GitAt
	}
	if git := snap.Git; git != nil {
		state.Trunk = git.Trunk
		for _, branch := range git.Branches {
			if branch.Name == git.Trunk {
				state.TrunkSha = branch.Sha
			}
		}
		state.ReleaseTag = git.LastPublic
		if len(git.Tags) > 0 {
			state.LastTag = git.Tags[0].Name
		}
	}
	if snap.Github != nil {
		state.RemoteCi, state.RemoteCiUrl = trunkRemoteCi(snap.Github.Runs, state.Trunk)
	}
	if g.ci != nil && state.TrunkSha != "" {
		if verdict, err := g.ci.Status(dir, state.TrunkSha); err == nil {
			state.TrunkCi = verdict.Status
		}
	}
	if g.runs != nil {
		for _, rec := range g.runs.List(dir) {
			if rec.Kind != RunKindBuild {
				continue
			}
			state.Build, state.BuildId, state.BuildAt = rec.State, rec.StepId, rec.StartedAt
			break
		}
	}
	state.Worst = memberWorst(state)
	return state
}

// Get resolves the groups now: the links and the members' files are read on every request, so a member that removed
// its `group` is out at once, and a member that added it is in. The dependencies keep their last evaluation, except
// the ones never read; each collector refresh reads them all again.
func (g *Groups) Get(req GroupsRequest) (GroupsAnswer, error) {
	return g.resolve(req, false)
}

func (g *Groups) resolve(req GroupsRequest, fresh bool) (GroupsAnswer, error) {
	ctx, cancel := context.WithTimeout(context.Background(), groupsTimeout)
	defer cancel()
	links, err := g.links(ctx)
	if err != nil {
		return GroupsAnswer{}, fmt.Errorf("reading the workspaces: %w", err)
	}
	groups := molten.ResolveGroups(links, g.read)
	if req.Dir != "" {
		if err := checkDir(req.Dir); err != nil {
			return GroupsAnswer{}, err
		}
		group := molten.FindGroup(groups, filepath.Clean(req.Dir))
		groups = []molten.ProjectGroup{}
		if group != nil {
			groups = append(groups, *group)
		}
	}
	answer := GroupsAnswer{Groups: []GroupInfo{}}
	for i := range groups {
		group := &groups[i]
		info := GroupInfo{Key: group.Key, Name: group.Name, Members: []GroupMemberInfo{}}
		for _, member := range group.Members {
			state := g.memberState(group, member, fresh)
			info.Members = append(info.Members, GroupMemberInfo{GroupMember: member, State: state})
			info.Worst = worstOf(info.Worst, state.Worst)
		}
		answer.Groups = append(answer.Groups, info)
	}
	if fresh && req.Dir == "" {
		members := map[string]bool{}
		for _, group := range groups {
			for _, member := range group.Members {
				members[member.Dir] = true
			}
		}
		g.pruneDeps(members)
	}
	return answer, nil
}

// withoutCheckTimes is the model less the time each dependency was read, which changes on every pass.
func withoutCheckTimes(answer GroupsAnswer) GroupsAnswer {
	copied := GroupsAnswer{Groups: make([]GroupInfo, len(answer.Groups))}
	for i, group := range answer.Groups {
		members := make([]GroupMemberInfo, len(group.Members))
		for j, member := range group.Members {
			deps := make([]DependencyState, len(member.State.Deps))
			for k, dep := range member.State.Deps {
				dep.CheckedAt = 0
				deps[k] = dep
			}
			member.State.Deps = deps
			members[j] = member
		}
		group.Members = members
		copied.Groups[i] = group
	}
	return copied
}

func (g *Groups) changed(answer GroupsAnswer) bool {
	data, err := json.Marshal(withoutCheckTimes(answer))
	if err != nil {
		return false
	}
	g.lock.Lock()
	defer g.lock.Unlock()
	if string(data) == g.published {
		return false
	}
	g.published = string(data)
	return true
}

// Refreshed evaluates the dependencies again, publishes the groups when a collector refresh changed them (a CI
// verdict, a build, a tag, a member's file, a dependency) and tells the stale dependencies.
func (g *Groups) Refreshed() {
	if g == nil || g.publish == nil {
		return
	}
	// Refreshes of several projects end together: one pass at a time keeps an older model from being told last, and
	// the ones asked during a pass are served by a single pass after it.
	if !g.claimRefresh() {
		return
	}
	for {
		g.refreshPass()
		if !g.refreshNext() {
			return
		}
	}
}

func (g *Groups) claimRefresh() bool {
	g.lock.Lock()
	defer g.lock.Unlock()
	if g.refreshing {
		g.refreshAgain = true
		return false
	}
	g.refreshing = true
	return true
}

func (g *Groups) refreshNext() bool {
	g.lock.Lock()
	defer g.lock.Unlock()
	if g.refreshAgain {
		g.refreshAgain = false
		return true
	}
	g.refreshing = false
	return false
}

func (g *Groups) refreshPass() {
	defer func() {
		panichandler.PanicHandler("molten:mission:groups", recover())
	}()
	answer, err := g.resolve(GroupsRequest{}, true)
	if err != nil {
		log.Printf("molten: resolving the project groups: %v\n", err)
		return
	}
	if g.changed(answer) {
		g.publish(answer)
	}
	g.tellDependencies(answer)
}

func publishGroups(answer GroupsAnswer) {
	wps.Broker.Publish(wps.WaveEvent{Event: GroupsEvent, Data: answer})
}
