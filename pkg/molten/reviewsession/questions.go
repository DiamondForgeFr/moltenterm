// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/termupdate"
)

// The questions queue (FR-REV-006 AC4): a question asked while the agent works or waits for an answer is kept, shown
// in the AI panel, and typed once the agent is idle, oldest first, each with its own selection. The loop runs only
// while questions wait, and ends with the session. Like the handoffs' queue (agenthandoff), it reads the agent's state
// from its hooks and types through the guarded path, which checks the state again.

const (
	// A busy agent is looked at again this often.
	questionPoll = time.Second
	// After a refusal of the typing path (another program in the foreground, say), which inspects the terminal.
	questionRetry = 3 * time.Second
	// After a question is typed, the agent's turn starts before the next one is considered.
	afterQuestion = 3 * time.Second
	maxQueued     = 20

	queueHoldNote = "The last question is in %s's prompt after what you were typing there: press Enter in its terminal. " +
		"The next questions wait for it."
)

func (m *Manager) sleep(d time.Duration) {
	if m.env.Sleep != nil {
		m.env.Sleep(d)
		return
	}
	time.Sleep(d)
}

// agentBusy says why the session's agent cannot take a question now (Retry), nothing when its hooks report it idle or
// nothing.
func (m *Manager) agentBusy(s *session) TypeOutcome {
	if m.env.AgentRun == nil {
		return TypeOutcome{}
	}
	run, ok := m.env.AgentRun(s.blockId)
	if !ok || !run.Running {
		return TypeOutcome{}
	}
	name := molten.AgentDisplayName(m.recOf(s).Agent)
	switch run.State {
	case molten.AgentStateWorking:
		return TypeOutcome{Retry: true, Reason: termupdate.InputReasonWorking, Message: name + " is working."}
	case molten.AgentStateWaiting:
		return TypeOutcome{Retry: true, Reason: termupdate.InputReasonWaiting, Message: name + " is waiting for your answer."}
	}
	return TypeOutcome{}
}

func (m *Manager) hasQuestions(s *session) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	return len(s.questions) > 0
}

// enqueueQuestion adds a question and starts the queue's loop when none runs; it returns the question with its id
// and its place (1: next).
func (m *Manager) enqueueQuestion(s *session, q mcpreview.QueuedQuestion) (mcpreview.QueuedQuestion, int) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s.nextQuestion++
	q.Id = "q" + strconv.Itoa(s.nextQuestion)
	q.QueuedAt = m.env.Now().UnixMilli()
	if len(s.questions) >= maxQueued {
		s.questions = s.questions[1:]
	}
	s.questions = append(s.questions, q)
	if !s.queueRunning {
		s.queueRunning = true
		go m.runQuestions(s)
	}
	return q, len(s.questions)
}

// CancelQuestion removes a queued question (the AI panel's Remove).
func (m *Manager) CancelQuestion(ctx context.Context, req mcpreview.AskCancelRequest) error {
	m.ensureLoaded(ctx)
	s := m.find(req.SessionKey)
	if s == nil {
		return errors.New(mcpreview.ErrSessionEnded)
	}
	if !m.dropQuestion(s, req.QuestionId) {
		return errors.New("this question is no longer waiting: it was sent or removed")
	}
	m.publish(s, false)
	return nil
}

// dropQuestion removes a question; false when it was not queued. An empty queue holds nothing.
func (m *Manager) dropQuestion(s *session, id string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	for i, q := range s.questions {
		if q.Id != id {
			continue
		}
		s.questions = append(s.questions[:i:i], s.questions[i+1:]...)
		if len(s.questions) == 0 {
			s.queueHold = false
			s.queueNote = queueNote{}
		}
		return true
	}
	return false
}

// nextQueued is the oldest question and whether the queue holds; ok is false when the queue is empty or the
// session ended, and then the loop is marked stopped under the same lock, so a new question starts a new one.
func (m *Manager) nextQueued(s *session) (q mcpreview.QueuedQuestion, hold bool, ok bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.sessions[s.key()] != s {
		s.questions = nil
	}
	if len(s.questions) == 0 {
		s.queueRunning = false
		s.queueHold = false
		return q, false, false
	}
	return s.questions[0], s.queueHold, true
}

// clearQueueNote forgets the queue's note once a question went through; true when there was one.
func (m *Manager) clearQueueNote(s *session) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	had := s.queueNote.text != ""
	s.queueNote = queueNote{}
	return had
}

func (m *Manager) setHold(s *session, hold bool, note queueNote) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s.queueHold = hold
	s.queueNote = note
}

func (m *Manager) runQuestions(s *session) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("%s questions queue panic: %v\n", logPrefix, r)
			m.lock.Lock()
			s.queueRunning = false
			m.lock.Unlock()
		}
	}()
	for {
		q, hold, ok := m.nextQueued(s)
		if !ok {
			return
		}
		busy := m.agentBusy(s)
		if hold {
			// The question typed without Enter starts once the developer presses it: the agent works then.
			if busy.Retry {
				m.setHold(s, false, queueNote{})
				m.publish(s, false)
			}
			m.sleep(questionPoll)
			continue
		}
		if busy.Retry {
			m.sleep(questionPoll)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		out := m.deliverQuestion(ctx, s, q)
		cancel()
		if out.Retry {
			m.sleep(questionRetry)
			continue
		}
		rec := m.recOf(s)
		m.dropQuestion(s, q.Id)
		switch {
		case out.Sent && out.Submitted:
			log.Printf("%s %s#%d: queued question %s sent\n", logPrefix, rec.Repo, rec.Number, q.Id)
			m.setHold(s, false, queueNote{})
		case out.Sent:
			if m.hasQuestions(s) {
				m.setHold(s, true, queueNote{text: fmt.Sprintf(queueHoldNote, molten.AgentDisplayName(rec.Agent)), reason: mcpreview.ReasonQueueHold})
			}
		default:
			log.Printf("%s %s#%d: queued question %s not sent: %s\n", logPrefix, rec.Repo, rec.Number, q.Id, out.Message)
			m.setHold(s, false, queueNote{text: "A queued question could not be sent: " + out.Message, reason: mcpreview.ReasonQueueFailed, cause: out.Reason})
		}
		m.publish(s, false)
		if out.Sent {
			m.sleep(afterQuestion)
		}
	}
}
