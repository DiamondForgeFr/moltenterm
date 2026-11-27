// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"strconv"
	"strings"
)

// Claude Code's task list (#2576, FR-SHELL-018), in the forms its transcripts hold:
//   - TodoWrite {todos: [{content, status, activeForm}]} replaces the whole list (the tool of older versions, and of
//     a session started with CLAUDE_CODE_ENABLE_TASKS=0);
//   - TaskCreate {subject, description, activeForm} adds a task; its id comes only in the result's toolUseResult,
//     {task: {id, subject}}. Ids count from 1 and are never reused, so a deleted task leaves a gap;
//   - TaskUpdate {taskId, status, subject, ...} changes one task, and status "deleted" removes it. The transcript
//     keeps the input as the model wrote it, before Claude Code repairs it: the id may come as id or task_id;
//   - TaskList {} returns the whole list ({tasks: [{id, subject, status}]}), TaskGet {taskId} one task ({task});
//   - the task_reminder attachment repeats the whole list ([{id, subject, status}]) when the tools went unused.
// Since v2.1.268 the tools exist by default only on older models: on the others a session has no native list unless
// it opts in, and the agent publishes its plan with `molten agent plan` (agentdocs/agent-plan.md).

const (
	claudeTaskCreate = "TaskCreate"
	claudeTaskList   = "TaskList"
	claudeTaskGet    = "TaskGet"
)

// claudeTaskCall reads a call of the model's task tools; the calls whose result carries the list are remembered.
func claudeTaskCall(callId string, tool string, input map[string]any, s *Session) {
	switch tool {
	case "TodoWrite":
		if _, ok := input["todos"]; !ok {
			return
		}
		var todos []Todo
		for _, item := range arr(input, "todos") {
			todo := asObj(item)
			text := str(todo, "content")
			if text == "" {
				text = str(todo, "subject")
			}
			if text != "" {
				todos = append(todos, Todo{Text: text, Status: str(todo, "status")})
			}
		}
		s.SetTodos(todos)
	case claudeTaskCreate:
		text := str(input, "subject")
		if text == "" {
			text = str(input, "description")
		}
		if text == "" {
			return
		}
		// The id Claude Code will give it, until the result says the real one.
		key := strconv.Itoa(max(s.nextTaskId, 1))
		s.noteTaskId(key)
		s.UpsertTodo(key, text, str(input, "status"))
		s.noteTaskCall(callId, key)
	case "TaskUpdate":
		key := claudeTaskId(input)
		s.noteTaskId(key)
		s.UpsertTodo(key, str(input, "subject"), str(input, "status"))
	case claudeTaskList, claudeTaskGet:
		s.noteTaskCall(callId, tool)
	}
}

// claudeTaskResult reads the result of a remembered call: a created task's id, the list or the task read back.
func claudeTaskResult(callId string, isError bool, result map[string]any, s *Session) {
	what, ok := s.takeTaskCall(callId)
	if !ok {
		return
	}
	switch what {
	case claudeTaskList:
		if _, has := result["tasks"]; has && !isError {
			claudeReadTaskList(arr(result, "tasks"), s)
		}
	case claudeTaskGet:
		task := obj(result, "task")
		if task != nil && !isError {
			key := claudeTaskId(task)
			s.noteTaskId(key)
			s.UpsertTodo(key, str(task, "subject"), str(task, "status"))
		}
	default:
		// A TaskCreate, remembered by the id it was given at the call.
		if isError {
			s.RekeyTodo(what, "")
			return
		}
		if id := claudeTaskId(obj(result, "task")); id != "" {
			s.noteTaskId(id)
			s.RekeyTodo(what, id)
		}
	}
}

// claudeReadTaskList replaces the list with the one a reminder or a TaskList result holds; an empty one leaves it.
func claudeReadTaskList(items []any, s *Session) {
	var todos []Todo
	for _, item := range items {
		todo := asObj(item)
		text := str(todo, "subject")
		if text == "" {
			text = str(todo, "content")
		}
		if text == "" {
			continue
		}
		key := claudeTaskId(todo)
		s.noteTaskId(key)
		todos = append(todos, Todo{Text: text, Status: str(todo, "status"), key: key})
	}
	if len(todos) > 0 {
		s.SetTodos(todos)
	}
}

// claudeTaskId reads a task's id: taskId, or id / task_id as the model may write it, a number or a string ("#3").
func claudeTaskId(m map[string]any) string {
	for _, field := range []string{"taskId", "id", "task_id"} {
		switch v := m[field].(type) {
		case string:
			if id := strings.TrimPrefix(strings.TrimSpace(v), "#"); id != "" {
				return id
			}
		case float64:
			if v >= 1 {
				return strconv.Itoa(int(v))
			}
		}
	}
	return ""
}

// noteTaskId keeps the next id one more than the highest numeric id seen.
func (s *Session) noteTaskId(id string) {
	if n, err := strconv.Atoi(id); err == nil && n >= s.nextTaskId {
		s.nextTaskId = n + 1
	}
}

// A session keeps at most this many task calls waiting for their result: a result never written does not grow it.
const maxTaskCalls = 200

func (s *Session) noteTaskCall(callId string, what string) {
	if callId == "" {
		return
	}
	if s.taskCalls == nil {
		s.taskCalls = map[string]string{}
	}
	if len(s.taskCalls) >= maxTaskCalls {
		s.taskCalls = map[string]string{}
	}
	s.taskCalls[callId] = what
}

func (s *Session) takeTaskCall(callId string) (string, bool) {
	what, ok := s.taskCalls[callId]
	if ok {
		delete(s.taskCalls, callId)
	}
	return what, ok
}
