// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// depClock gives each commit its own second, in order: staleness compares commit times.
type depClock struct{ next int64 }

func (c *depClock) tick() string {
	c.next++
	return fmt.Sprintf("@%d +0000", 1_800_000_000+c.next)
}

func depGit(t *testing.T, dir string, date string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date, "GIT_CONFIG_NOSYSTEM=1", "HOME="+dir)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func depWrite(t *testing.T, dir string, rel string, content string) {
	t.Helper()
	path := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func depCommit(t *testing.T, clock *depClock, dir string, message string, files map[string]string) string {
	t.Helper()
	for rel, content := range files {
		depWrite(t, dir, rel, content)
	}
	date := clock.tick()
	depGit(t, dir, date, "add", "-A")
	depGit(t, dir, date, "commit", "-q", "-m", message)
	return depGit(t, dir, date, "rev-parse", "HEAD")
}

func depRepo(t *testing.T, clock *depClock, dir string, pipeline string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	depGit(t, dir, clock.tick(), "init", "-q", "-b", "develop")
	depCommit(t, clock, dir, "chore: start", map[string]string{".molten/project.json": pipeline})
}

const depAppPipeline = `{"schema": 1, "name": "Notulia", "group": "Notulia"}`

const depSitePipeline = `{"schema": 1, "name": "notulia-website", "group": " notulia ", "dependson": [
  {"project": "Notulia", "paths": ["features/*.json"], "branch": "develop", "sync": "node scripts/sync-features.mjs", "output": ["src/data/features/*.json"]}
]}`

// The Notulia case (#1151): an app holding the feature registry, and a website reading it.
type depFixture struct {
	clock *depClock
	app   string
	site  string
	group molten.ProjectGroup
}

func makeDepFixture(t *testing.T) *depFixture {
	root := t.TempDir()
	f := &depFixture{clock: &depClock{}, app: filepath.Join(root, "Notulia"), site: filepath.Join(root, "notulia-website")}
	depRepo(t, f.clock, f.app, depAppPipeline)
	depCommit(t, f.clock, f.app, "feat(#1100): feature registry", map[string]string{"features/live-notes.json": `{"plan": "free"}`})
	depRepo(t, f.clock, f.site, depSitePipeline)
	f.group = molten.ProjectGroup{Key: "notulia", Name: "Notulia", Members: []molten.GroupMember{
		{Dir: f.app, Name: "Notulia", Group: "Notulia", Workspaces: []molten.GroupWorkspace{{Id: "w-app", Name: "App"}}},
		{Dir: f.site, Name: "notulia-website", Group: "notulia", Workspaces: []molten.GroupWorkspace{{Id: "w-site", Name: "Site"}}},
	}}
	return f
}

func (f *depFixture) evaluate(t *testing.T, dep molten.PipelineDependency) DependencyState {
	t.Helper()
	return EvaluateDependency(context.Background(), plainRunner, &f.group, f.site, "notulia-website", 0, dep, time.Now())
}

func siteDependency() molten.PipelineDependency {
	return molten.PipelineDependency{Project: "Notulia", Paths: []string{"features/*.json"}, Branch: "develop", Sync: "node scripts/sync-features.mjs",
		Output: []string{"src/data/features/*.json"}}
}

func TestDependencyLifecycle(t *testing.T) {
	f := makeDepFixture(t)
	dep := siteDependency()

	never := f.evaluate(t, dep)
	if never.State != DepStateStale || never.Synced != nil || len(never.Commits) != 1 || never.SourceDir != f.app || never.Ref != "develop" {
		t.Fatalf("a dependency never synced is stale: %+v", never)
	}

	depWrite(t, f.site, "src/data/features/live-notes.json", `{"plan": "free"}`)
	if got := f.evaluate(t, dep); got.State != DepStateUncommitted || !reflect.DeepEqual(got.Uncommitted, []string{"src/data/features/live-notes.json"}) {
		t.Fatalf("synced, not committed: %+v", got)
	}
	depCommit(t, f.clock, f.site, "chore(#7): sync the features", nil)
	if got := f.evaluate(t, dep); got.State != DepStateInSync || got.Synced == nil || got.Trunk != "develop" {
		t.Fatalf("the sync's commit clears the flag: %+v", got)
	}

	// TC-MC-027: the registry change of #1151.
	change := depCommit(t, f.clock, f.app, "feat(#1151): live AI notes move to Pro", map[string]string{"features/live-notes.json": `{"plan": "pro"}`})
	stale := f.evaluate(t, dep)
	if stale.State != DepStateStale || stale.Source == nil || stale.Source.Sha != change {
		t.Fatalf("the registry change makes the site stale: %+v", stale)
	}
	if len(stale.Commits) != 1 || stale.Commits[0].Sha != change || !reflect.DeepEqual(stale.Commits[0].Tickets, []string{"1151"}) {
		t.Fatalf("the flag names the commit and its ticket: %+v", stale.Commits)
	}
	if !reflect.DeepEqual(stale.Changed, []string{"features/live-notes.json"}) || stale.Branch != "develop" || stale.SourceName != "Notulia" {
		t.Fatalf("the flag names the source, the branch and the changed paths: %+v", stale)
	}

	// A change outside paths changes nothing.
	depCommit(t, f.clock, f.app, "docs: readme", map[string]string{"README.md": "hello"})
	if again := f.evaluate(t, dep); again.State != DepStateStale || len(again.Commits) != 1 || again.Source.Sha != change {
		t.Fatalf("a commit outside paths changes nothing: %+v", again)
	}

	// The site syncs again and commits: in sync.
	depCommit(t, f.clock, f.site, "chore(#8): sync the features", map[string]string{"src/data/features/live-notes.json": `{"plan": "pro"}`})
	if got := f.evaluate(t, dep); got.State != DepStateInSync {
		t.Fatalf("in sync after the commit: %+v", got)
	}
	// An output file edited while in sync is no flag.
	depWrite(t, f.site, "src/data/features/live-notes.json", `{"plan": "edited"}`)
	if got := f.evaluate(t, dep); got.State != DepStateInSync {
		t.Fatalf("in sync: %+v", got)
	}
}

func TestDependencyRemoteRefs(t *testing.T) {
	f := makeDepFixture(t)
	dep := siteDependency()
	depCommit(t, f.clock, f.site, "chore: sync", map[string]string{"src/data/features/live-notes.json": "{}"})

	// The source's remote-tracking branch is read when it exists: a local commit not pushed is not the watched branch.
	bare := filepath.Join(filepath.Dir(f.app), "Notulia.git")
	depGit(t, filepath.Dir(f.app), f.clock.tick(), "init", "-q", "--bare", bare)
	depGit(t, f.app, f.clock.tick(), "remote", "add", "origin", bare)
	depGit(t, f.app, f.clock.tick(), "push", "-q", "origin", "develop")
	depCommit(t, f.clock, f.app, "feat(#1151): not pushed yet", map[string]string{"features/live-notes.json": `{"plan": "pro"}`})
	got := f.evaluate(t, dep)
	if got.Ref != "origin/develop" || got.State != DepStateInSync {
		t.Fatalf("origin/develop is watched, and holds no change: %+v", got)
	}
	depGit(t, f.app, f.clock.tick(), "push", "-q", "origin", "develop")
	if got := f.evaluate(t, dep); got.State != DepStateStale {
		t.Fatalf("pushed: stale: %+v", got)
	}

	// The dependent's newest sync wins, local trunk or origin's.
	depGit(t, f.site, f.clock.tick(), "checkout", "-q", "-b", "elsewhere")
	synced := depCommit(t, f.clock, f.site, "chore: sync from another checkout", map[string]string{"src/data/features/live-notes.json": `{"plan": "pro"}`})
	depGit(t, f.site, f.clock.tick(), "checkout", "-q", "develop")
	depGit(t, f.site, f.clock.tick(), "update-ref", "refs/remotes/origin/develop", synced)
	if got := f.evaluate(t, dep); got.State != DepStateInSync || got.Synced.Sha != synced {
		t.Fatalf("the sync on origin/develop counts: %+v", got)
	}
}

// A registry change made on a feature branch before the site's sync and merged after it landed after the sync: stale,
// and the feature commit is listed even though its own date is older than the sync.
func TestDependencyMergedAfterSync(t *testing.T) {
	f := makeDepFixture(t)
	dep := siteDependency()
	depGit(t, f.app, f.clock.tick(), "checkout", "-q", "-b", "feature/1151-pro")
	change := depCommit(t, f.clock, f.app, "feat(#1151): live AI notes move to Pro", map[string]string{"features/live-notes.json": `{"plan": "pro"}`})
	depGit(t, f.app, f.clock.tick(), "checkout", "-q", "develop")
	depCommit(t, f.clock, f.site, "chore: sync", map[string]string{"src/data/features/live-notes.json": `{"plan": "free"}`})
	if got := f.evaluate(t, dep); got.State != DepStateInSync {
		t.Fatalf("the change is not on develop yet: %+v", got)
	}
	depGit(t, f.app, f.clock.tick(), "merge", "-q", "--no-ff", "-m", "Merge pull request #12 from feature/1151-pro", "feature/1151-pro")
	got := f.evaluate(t, dep)
	if got.State != DepStateStale || len(got.Commits) != 1 || got.Commits[0].Sha != change || !reflect.DeepEqual(got.Changed, []string{"features/live-notes.json"}) {
		t.Fatalf("merged after the sync: stale, listing the feature commit: %+v", got)
	}
}

func TestDependencyNotFound(t *testing.T) {
	f := makeDepFixture(t)
	ghost := siteDependency()
	ghost.Project = "Ghost"
	if got := f.evaluate(t, ghost); got.State != DepStateSourceNotFound || got.Problem == "" {
		t.Fatalf("an unknown project: %+v", got)
	}
	noBranch := siteDependency()
	noBranch.Branch = "release/9"
	if got := f.evaluate(t, noBranch); got.State != DepStateBranchNotFound || !strings.Contains(got.Problem, "release/9") {
		t.Fatalf("a missing branch: %+v", got)
	}
	invalid := siteDependency()
	invalid.Output = nil
	if got := f.evaluate(t, invalid); got.State != DepStateInvalid || !strings.Contains(got.Problem, "output is required") {
		t.Fatalf("a malformed declaration: %+v", got)
	}
	// Outside a group no member resolves.
	if got := EvaluateDependency(context.Background(), plainRunner, nil, f.site, "notulia-website", 0, siteDependency(), time.Now()); got.State != DepStateSourceNotFound {
		t.Fatalf("no group: %+v", got)
	}
	// A project that is not a member (unlinked) is never found, even with the right name in the same folder tree.
	alone := molten.ProjectGroup{Key: "notulia", Name: "Notulia", Members: f.group.Members[1:]}
	if got := EvaluateDependency(context.Background(), plainRunner, &alone, f.site, "notulia-website", 0, siteDependency(), time.Now()); got.State != DepStateSourceNotFound {
		t.Fatalf("an unlinked source: %+v", got)
	}
	// The default branch is the source's trunk.
	trunk := siteDependency()
	trunk.Branch = ""
	if got := f.evaluate(t, trunk); got.Branch != "develop" || got.State != DepStateStale {
		t.Fatalf("default branch: %+v", got)
	}
}

func TestCommitTickets(t *testing.T) {
	if got := CommitTickets("feat(#1151): live notes (#1152) and #1151 again"); !reflect.DeepEqual(got, []string{"1151", "1152"}) {
		t.Fatalf("%v", got)
	}
	if got := CommitTickets("chore: nothing"); got != nil {
		t.Fatalf("%v", got)
	}
}

func depGroups(t *testing.T, f *depFixture, notified *[]DependencyNotices) *Groups {
	links := []molten.GroupLink{{WorkspaceId: "w-app", WorkspaceName: "App", Dir: f.app}, {WorkspaceId: "w-site", WorkspaceName: "Site", Dir: f.site}}
	return MakeGroups(nil, nil, nil, plainRunner, func(ctx context.Context) ([]molten.GroupLink, error) { return links, nil },
		func(GroupsAnswer) {}, func(n DependencyNotices) error {
			*notified = append(*notified, n)
			return nil
		})
}

func TestGroupsDependencies(t *testing.T) {
	f := makeDepFixture(t)
	// Two members may depend on each other (AC8).
	depCommit(t, f.clock, f.app, "chore: read the site's pricing", map[string]string{".molten/project.json": `{"schema": 1, "name": "Notulia", "group": "Notulia",
	  "dependson": [{"project": "notulia-website", "paths": ["pricing/*.json"], "output": ["src/pricing.json"]}]}`})
	depCommit(t, f.clock, f.site, "chore: sync", map[string]string{"src/data/features/live-notes.json": "{}"})
	var notified []DependencyNotices
	groups := depGroups(t, f, &notified)

	answer, err := groups.Get(GroupsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(answer.Groups) != 1 || len(answer.Groups[0].Members) != 2 {
		t.Fatalf("one group of two: %+v", answer)
	}
	app, site := answer.Groups[0].Members[0], answer.Groups[0].Members[1]
	if len(app.State.Deps) != 1 || app.State.Deps[0].State != DepStateInSync || app.State.Worst != "" {
		t.Fatalf("the app's own dependency, with no pricing commit yet: %+v", app.State)
	}
	if len(site.State.Deps) != 1 || site.State.Deps[0].State != DepStateInSync || answer.Groups[0].Worst != "" {
		t.Fatalf("the site is in sync: %+v", site.State)
	}

	groups.Refreshed()
	if len(notified) != 1 || len(notified[0].Notices) != 0 {
		t.Fatalf("the first refresh tells the center that nothing is stale: %+v", notified)
	}

	change := depCommit(t, f.clock, f.app, "feat(#1151): live AI notes move to Pro", map[string]string{"features/live-notes.json": `{"plan": "pro"}`})
	// A plain request reuses the last evaluation; a refresh reads again.
	if cached, _ := groups.Get(GroupsRequest{}); cached.Groups[0].Members[1].State.Deps[0].State != DepStateInSync {
		t.Fatal("a plain request reuses the evaluation")
	}
	groups.Refreshed()
	if len(notified) != 2 || len(notified[1].Notices) != 1 {
		t.Fatalf("one notification for the stale dependency: %+v", notified)
	}
	notice := notified[1].Notices[0]
	if notice.Key != DepNotificationKey(f.site, "Notulia", 0) || notice.Source != DepNotificationSource || notice.WorkspaceId != "w-site" || notice.Kind != "warning" {
		t.Fatalf("keyed by dependent and source, in the site's workspace: %+v", notice)
	}
	if notice.Title != "notulia-website is behind Notulia" || !strings.Contains(notice.Message, "features/live-notes.json changed on develop") ||
		!strings.Contains(notice.Message, "#1151") || !strings.Contains(notice.Message, shortSha(change)) {
		t.Fatalf("the notice names the paths, the branch, the ticket and the commit: %+v", notice)
	}
	if len(notice.Actions) != 2 || notice.Actions[0].Gesture != DepSyncGesture || notice.Actions[1].Kind != "open" {
		t.Fatalf("Sync and Open: %+v", notice.Actions)
	}
	if cached, _ := groups.Get(GroupsRequest{}); cached.Groups[0].Worst != GroupWorstAmber || cached.Groups[0].Members[1].State.Worst != GroupWorstAmber {
		t.Fatal("the stale dependency raises the site and the group to amber")
	}

	// A commit outside paths and an uncommitted sync tell nothing new.
	depCommit(t, f.clock, f.app, "docs: readme", map[string]string{"README.md": "x"})
	depWrite(t, f.site, "src/data/features/live-notes.json", `{"plan": "pro"}`)
	groups.Refreshed()
	if len(notified) != 2 {
		t.Fatalf("no second notification: %+v", notified)
	}
	if got, _ := groups.Get(GroupsRequest{}); got.Groups[0].Members[1].State.Deps[0].State != DepStateUncommitted || got.Groups[0].Worst != GroupWorstAmber {
		t.Fatal("synced, not committed stays amber")
	}

	// A later source change updates the same notification.
	depCommit(t, f.clock, f.app, "feat(#1160): another plan change", map[string]string{"features/sync.json": `{}`})
	groups.Refreshed()
	if len(notified) != 3 || len(notified[2].Notices) != 1 || notified[2].Notices[0].Key != notice.Key || !strings.Contains(notified[2].Notices[0].Message, "#1160") {
		t.Fatalf("the same key, with the new commit: %+v", notified)
	}

	// The commit of the sync clears the flag: no notice left, so the center resolves it.
	depCommit(t, f.clock, f.site, "chore(#9): sync", nil)
	groups.Refreshed()
	if len(notified) != 4 || len(notified[3].Notices) != 0 {
		t.Fatalf("cleared: %+v", notified)
	}

	deps, err := groups.Deps(GroupsRequest{Dir: f.site})
	if err != nil || len(deps) != 1 || deps[0].State != DepStateInSync {
		t.Fatalf("molten project deps: %+v %v", deps, err)
	}
}

func TestDependencyNoticesKeepErrors(t *testing.T) {
	member := GroupMemberInfo{GroupMember: molten.GroupMember{Dir: "/p/site", Name: "site"}}
	member.State.Deps = []DependencyState{
		{Index: 0, SourceName: "App", State: DepStateError},
		{Index: 1, SourceName: "app", State: DepStateStale, Branch: "develop", Paths: []string{"a/*"}, Commits: []DependencyCommit{{Sha: "abc"}}},
		{Index: 2, SourceName: "Other", State: DepStateSourceNotFound},
	}
	notices := dependencyNotices(GroupsAnswer{Groups: []GroupInfo{{Members: []GroupMemberInfo{member}}}})
	if !reflect.DeepEqual(notices.Keep, []string{DepNotificationKey("/p/site", "App", 0)}) {
		t.Fatalf("a dependency that could not be read keeps its notification: %+v", notices.Keep)
	}
	if len(notices.Notices) != 1 || notices.Notices[0].Key != DepNotificationKey("/p/site", "app", 1) || len(notices.Notices[0].Actions) != 1 {
		t.Fatalf("a second declaration on the same source has its own key; no Sync without a sync command: %+v", notices.Notices)
	}
	if !strings.Contains(notices.Notices[0].Message, "never synced") {
		t.Fatalf("never synced: %s", notices.Notices[0].Message)
	}
}

// NFR-MC-008: at most 200 ms per dependency on a repository of 10,000 commits.
func TestDependencyCost(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a 10,000-commit repository")
	}
	f := makeDepFixture(t)
	var stream strings.Builder
	const commits = 10000
	for i := 1; i <= commits; i++ {
		path := fmt.Sprintf("src/file%d.txt", i%50)
		if i%100 == 0 {
			path = fmt.Sprintf("features/f%d.json", i%7)
		}
		content := fmt.Sprintf("%d\n", i)
		message := fmt.Sprintf("chore: c%06d", i)
		fmt.Fprintf(&stream, "commit refs/heads/develop\nmark :%d\ncommitter t <t@t> %d +0000\ndata %d\n%s\n", i, 1_900_000_000+i, len(message), message)
		if i == 1 {
			stream.WriteString("from refs/heads/develop^0\n")
		}
		fmt.Fprintf(&stream, "M 644 inline %s\ndata %d\n%s\n", path, len(content), content)
	}
	cmd := exec.Command("git", "fast-import", "--quiet")
	cmd.Dir = f.app
	cmd.Stdin = strings.NewReader(stream.String())
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fast-import: %v\n%s", err, out)
	}
	depGit(t, f.app, f.clock.tick(), "reset", "-q", "--hard", "develop")
	dep := siteDependency()
	f.evaluate(t, dep)
	// The best of three: the bound is the check's own cost, not a busy test machine's.
	var got DependencyState
	took := time.Hour
	for range 3 {
		start := time.Now()
		got = f.evaluate(t, dep)
		took = min(took, time.Since(start))
	}
	if got.State != DepStateStale || !got.MoreCommits {
		t.Fatalf("never synced against 100 registry commits: %+v", got.State)
	}
	if took > 200*time.Millisecond {
		t.Fatalf("one dependency took %v on %d commits", took, commits)
	}
	t.Logf("one dependency on %d commits: %v", commits, took)
}
