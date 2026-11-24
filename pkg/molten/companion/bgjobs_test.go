// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2502: what a background command is called, and what a sub-agent's transcript says it is waiting for.

func TestClassifyBackgroundCommand(t *testing.T) {
	t.Parallel()
	cases := []struct {
		command string
		kind    string
		arg     string
	}{
		{"npx vitest run frontend/a.test.ts", molten.JobVitest, ""},
		{"cd frontend && npx --no-install vitest run src/a.test.ts 2>&1 | tail -20", molten.JobVitest, ""},
		{"./node_modules/.bin/vitest --run", molten.JobVitest, ""},
		{"pnpm exec vitest", molten.JobVitest, ""},
		{"yarn vitest run", molten.JobVitest, ""},
		{"FORCE_COLOR=0 CI=1 go test ./pkg/molten/... -count=1", molten.JobGoTest, ""},
		{"cd /work/app && go test -count=50 -run '^TestX$' ./pkg/molten/companion/", molten.JobGoTest, ""},
		{"time go test ./...", molten.JobGoTest, ""},
		{"task build:frontend:dev", molten.JobBuildFrontend, ""},
		{"task build:server", molten.JobBuildBackend, ""},
		{"task build:backend:quickdev", molten.JobBuildBackend, ""},
		{"task build:wsh", molten.JobBuildBackend, ""},
		{"task build:preview", molten.JobBuild, ""},
		{"task package", molten.JobBuild, ""},
		{"task perf:bundle", molten.JobPerf, ""},
		{"task -v perf:quick", molten.JobPerf, ""},
		{"task check:ts", molten.JobCheck, ""},
		{"npm run build", molten.JobNpmRun, "build"},
		{"npm run lint:fix -- --quiet", molten.JobNpmRun, "lint:fix"},
		{"npm run test:pre-push", molten.JobTests, ""},
		{"npm test", molten.JobTests, ""},
		{"pnpm run build", molten.JobNpmRun, "build"},
		{"yarn build", molten.JobNpmRun, "build"},
		{"node scripts/moltenterm-affected.mjs --run", molten.JobAffected, ""},
		{"molten ci run", molten.JobMoltenCi, ""},
		{"/opt/app/bin/molten ci status --job frontend", molten.JobMoltenCi, ""},
		{"caffeinate -i npx vitest run", molten.JobVitest, ""},
		{"nohup timeout 600 go test ./... &", molten.JobGoTest, ""},
		{`bash -c "cd app && npx vitest run"`, molten.JobVitest, ""},
		{"echo start; npx vitest run; echo done", molten.JobVitest, ""},
		{"bash /private/tmp/scratch/runs-2496.sh", molten.JobCommand, ""},
		{"sleep 600", molten.JobCommand, ""},
		{"git push origin HEAD", molten.JobCommand, ""},
		{"go build ./...", molten.JobCommand, ""},
		{"npm install", molten.JobCommand, ""},
		{"task unknown-thing", molten.JobCommand, ""},
		{"", molten.JobCommand, ""},
	}
	for _, tc := range cases {
		kind, arg := classifyBackgroundCommand(tc.command)
		if kind != tc.kind || arg != tc.arg {
			t.Errorf("%q: %s %q, want %s %q", tc.command, kind, arg, tc.kind, tc.arg)
		}
	}
}

func TestClassifyBackgroundCommandCutsALongScriptName(t *testing.T) {
	t.Parallel()
	_, arg := classifyBackgroundCommand("npm run " + strings.Repeat("a", 200))
	if len(arg) != maxJobArgLength {
		t.Errorf("a script's name is cut to %d: %d", maxJobArgLength, len(arg))
	}
}

var jobsClock = time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)

func jobStamp(ago time.Duration) string {
	return jobsClock.Add(-ago).Format("2006-01-02T15:04:05.000Z")
}

func jobMs(ago time.Duration) int64 {
	return jobsClock.Add(-ago).UnixMilli()
}

// bgCallRecord is the record that holds a background tool call of a sub-agent.
func bgCallRecord(toolId string, command string, ago time.Duration) string {
	quoted, _ := json.Marshal(command)
	return `{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"I run it."},{"type":"tool_use","id":"` + toolId + `","name":"Bash","input":{"command":` + string(quoted) + `,"description":"run","run_in_background":true}}]},"timestamp":"` + jobStamp(ago) + `"}`
}

// bgResultRecord is the record that answers it with the task's id, as Claude Code writes it.
func bgResultRecord(toolId string, taskId string, ago time.Duration) string {
	return `{"type":"user","isSidechain":true,"message":{"role":"user","content":[{"tool_use_id":"` + toolId + `","type":"tool_result","content":"Command running in background with ID: ` + taskId + `.","is_error":false}]},"uuid":"u","timestamp":"` + jobStamp(ago) + `","toolUseResult":{"stdout":"","stderr":"","interrupted":false,"backgroundTaskId":"` + taskId + `"}}`
}

func tailOf(lines ...string) []byte {
	return []byte(strings.Join(lines, "\n") + "\n")
}

func TestBackgroundTasksNameTheJobAndWhenItStarted(t *testing.T) {
	t.Parallel()
	tail := tailOf(
		bgCallRecord("toolu_a", "cd frontend && npx vitest run", 7*time.Minute), bgResultRecord("toolu_a", "bt1", 7*time.Minute),
		bgCallRecord("toolu_b", "task build:frontend:dev", 3*time.Minute), bgResultRecord("toolu_b", "bt2", 3*time.Minute),
		bgCallRecord("toolu_c", "bash /private/tmp/x/run.sh", time.Minute), bgResultRecord("toolu_c", "bt3", time.Minute),
		bgEndLine("bt2"),
		bgTurnEndLine,
	)
	tasks := claudeBackgroundTasks(tail)
	if len(tasks) != 2 {
		t.Fatalf("the build ended, the tests and the script wait: %+v", tasks)
	}
	if got := tasks[0].job; got.Kind != molten.JobVitest || got.Since != jobMs(7*time.Minute) {
		t.Errorf("the oldest first, named by its command and dated by its launch: %+v", got)
	}
	if got := tasks[1].job; got.Kind != molten.JobCommand || got.Since != jobMs(time.Minute) {
		t.Errorf("a command nobody knows is a command: %+v", got)
	}
	if !claudeBackgroundPending(tail) {
		t.Errorf("pending work is still the #2498 fact")
	}
}

func TestBackgroundTasksNeverKeepTheCommandLine(t *testing.T) {
	t.Parallel()
	tasks := claudeBackgroundTasks(tailOf(
		bgCallRecord("toolu_a", "SECRET_TOKEN=abc123 go test ./private/path/...", time.Minute), bgResultRecord("toolu_a", "bt1", time.Minute),
	))
	raw, _ := json.Marshal(tasks[0].job)
	if strings.Contains(string(raw), "SECRET") || strings.Contains(string(raw), "private") || strings.Contains(string(raw), "abc123") {
		t.Errorf("a job is a kind and a time, never the command: %s", raw)
	}
}

func TestBackgroundTasksOfAMonitorAndAStoppedTask(t *testing.T) {
	t.Parallel()
	tail := tailOf(
		bgCallRecord("toolu_a", "go test ./...", 4*time.Minute), bgResultRecord("toolu_a", "bt1", 4*time.Minute),
		monitorLaunchLine("mon1"),
		bgCallRecord("toolu_c", "npm run build", 2*time.Minute), bgResultRecord("toolu_c", "bt3", 2*time.Minute),
		`{"type":"user","toolUseResult":{"message":"Successfully stopped task: bt3 (npm run build)","task_id":"bt3","task_type":"local_bash"}}`,
	)
	tasks := claudeBackgroundTasks(tail)
	kinds := []string{}
	for _, task := range tasks {
		kinds = append(kinds, task.job.Kind)
	}
	if len(tasks) != 2 || kinds[0] != molten.JobGoTest || kinds[1] != molten.JobCommand {
		t.Fatalf("the Go tests, then a monitor; the stopped build is gone: %v", kinds)
	}
	if tasks[1].job.Since != 0 {
		t.Errorf("a record without a time has no start: %+v", tasks[1].job)
	}
}

func TestBackgroundTasksOfAForegroundCommandAreNone(t *testing.T) {
	t.Parallel()
	foreground := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_f","name":"Bash","input":{"command":"go test ./..."}}]},"timestamp":"` + jobStamp(time.Minute) + `"}`
	result := `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_f","type":"tool_result","content":"ok"}]},"toolUseResult":{"stdout":"ok","stderr":"","interrupted":false}}`
	if tasks := claudeBackgroundTasks(tailOf(foreground, result, bgTurnEndLine)); len(tasks) != 0 {
		t.Errorf("a command that ran in the foreground waits for nothing: %+v", tasks)
	}
}

func TestBackgroundTasksAreFoundAndTheOldestLaunchComesFirst(t *testing.T) {
	t.Parallel()
	var lines []string
	for i := 0; i < 20; i++ {
		id := "toolu_" + string(rune('a'+i))
		lines = append(lines, bgCallRecord(id, "go test ./...", time.Duration(20-i)*time.Minute), bgResultRecord(id, "task"+string(rune('a'+i)), time.Duration(20-i)*time.Minute))
	}
	tasks := claudeBackgroundTasks(tailOf(lines...))
	if len(tasks) != 20 {
		t.Fatalf("every pending task is found: %d", len(tasks))
	}
	for i := 1; i < len(tasks); i++ {
		if tasks[i].job.Since < tasks[i-1].job.Since {
			t.Fatalf("the oldest launch first: %+v", tasks)
		}
	}
}
