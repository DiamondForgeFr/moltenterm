// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// Every form in which an agent CLI writes its task list into its transcript, one fixture each (#2576). The companion's
// Plan block shows the list these give: a form no adapter reads shows an empty Plan, the gap #2576 closed. When an
// agent CLI changes its task tool, add a fixture of the new form here (from the CLI's docs or a session of your own,
// never a developer's real transcripts): the test then fails until its adapter reads it.
var taskListForms = []struct {
	fixture string
	agent   string
	form    string
	want    []Todo
}{
	{
		fixture: "claude-todowrite.jsonl",
		agent:   "claude",
		form:    "TodoWrite: the whole list each call (older versions, CLAUDE_CODE_ENABLE_TASKS=0)",
		want: []Todo{
			{Text: "Read the demo", Status: TodoCompleted},
			{Text: "Tidy it", Status: TodoInProgress},
			{Text: "Run the tests", Status: TodoPending},
		},
	},
	{
		fixture: "claude-tasks.jsonl",
		agent:   "claude",
		form:    "TaskCreate (id in the result) and TaskUpdate (taskId, id or task_id; status deleted removes)",
		want: []Todo{
			{Text: "Read the ticket", Status: TodoCompleted},
			{Text: "Fix the parser", Status: TodoInProgress},
			{Text: "Run the tests", Status: TodoPending},
		},
	},
	{
		fixture: "claude-tasklist.jsonl",
		agent:   "claude",
		form:    "TaskList and TaskGet results, read from the middle of a session (ids with gaps)",
		want: []Todo{
			{Text: "Brief the agent", Status: TodoCompleted},
			{Text: "Follow ticket 2576", Status: TodoCompleted},
			{Text: "Review the pull request", Status: TodoInProgress},
		},
	},
	{
		fixture: "claude-taskreminder.jsonl",
		agent:   "claude",
		form:    "task_reminder attachment: the whole list, then TaskUpdate by id",
		want: []Todo{
			{Text: "Route the delegation", Status: TodoCompleted},
			{Text: "Follow the agent", Status: TodoCompleted},
			{Text: "Report to the developer", Status: TodoInProgress},
		},
	},
	{
		fixture: "codex-updateplan.jsonl",
		agent:   "codex",
		form:    "update_plan function call: the whole plan each call",
		want: []Todo{
			{Text: "Find the typo", Status: TodoCompleted},
			{Text: "Fix it", Status: TodoInProgress},
			{Text: "Run the checks", Status: TodoPending},
		},
	},
	{
		fixture: "codex-planupdate.jsonl",
		agent:   "codex",
		form:    "plan_update event",
		want: []Todo{
			{Text: "Read the logs", Status: TodoCompleted},
			{Text: "Patch the reader", Status: TodoInProgress},
		},
	},
	{
		fixture: "codex-todolist-item.jsonl",
		agent:   "codex",
		form:    "TodoList item ({text, completed}); a text-only Plan item leaves the list",
		want: []Todo{
			{Text: "Map the forms", Status: TodoCompleted},
			{Text: "Guard each one", Status: TodoPending},
		},
	},
	{
		fixture: "kimi-todolist.jsonl",
		agent:   "kimi",
		form:    "TodoList tool call: the whole list each call; a call without todos leaves it",
		want: []Todo{
			{Text: "Inspect the fixture", Status: TodoCompleted},
			{Text: "Run the checks", Status: TodoInProgress},
		},
	},
}

func TestEveryTaskListFormShowsItsList(t *testing.T) {
	t.Parallel()
	for _, tc := range taskListForms {
		t.Run(tc.fixture, func(t *testing.T) {
			t.Parallel()
			a := AdapterFor(tc.agent)
			if a == nil {
				t.Fatalf("no companion adapter for %q", tc.agent)
			}
			s := MakeSession()
			parseFile(t, a, s, filepath.Join("tasklists", tc.fixture))
			if got := s.Todos(); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("%s (%s):\n got %+v\nwant %+v", tc.agent, tc.form, got, tc.want)
			}
		})
	}
}

// Each fixture is in the table, and each table row has its fixture: a form cannot be added untested.
func TestEveryTaskListFixtureIsAForm(t *testing.T) {
	t.Parallel()
	entries, err := os.ReadDir(filepath.Join("testdata", "tasklists"))
	if err != nil {
		t.Fatal(err)
	}
	var files, forms []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".jsonl") {
			files = append(files, e.Name())
		}
	}
	agents := map[string]bool{}
	for _, tc := range taskListForms {
		forms = append(forms, tc.fixture)
		agents[tc.agent] = true
	}
	sort.Strings(files)
	sort.Strings(forms)
	if !reflect.DeepEqual(files, forms) {
		t.Errorf("fixtures %v, forms %v", files, forms)
	}
	// An agent the companion supports without a task-list form would show an empty Plan block.
	for _, agent := range SupportedAgents {
		if !agents[agent] {
			t.Errorf("no task-list form for %s: add one fixture per form its transcripts hold", agent)
		}
	}
}
