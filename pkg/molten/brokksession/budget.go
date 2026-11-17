// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

const (
	budgetDayLayout = "2006-01-02"
	budgetFileName  = "brokkphrases.json"
)

// PhraseBudget is how many times his model was asked on one local day.
type PhraseBudget struct {
	Day   string `json:"day"`
	Calls int    `json:"calls"`
}

// readBudgetFile reads the count kept in path; an empty budget when there is none or it cannot be read, which only
// costs a day's budget given back.
func readBudgetFile(path string) PhraseBudget {
	data, err := os.ReadFile(path)
	if err != nil {
		return PhraseBudget{}
	}
	var budget PhraseBudget
	if err := json.Unmarshal(data, &budget); err != nil || budget.Calls < 0 {
		return PhraseBudget{}
	}
	return budget
}

func writeBudgetFile(path string, budget PhraseBudget) error {
	data, err := json.Marshal(budget)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return fileutil.AtomicWriteFile(path, data, 0o600)
}

func liveBudgetPath() string {
	return filepath.Join(wavebase.GetWaveDataDir(), budgetFileName)
}

func liveLoadBudget() PhraseBudget {
	return readBudgetFile(liveBudgetPath())
}

func liveSaveBudget(budget PhraseBudget) {
	if err := writeBudgetFile(liveBudgetPath(), budget); err != nil {
		log.Printf("[brokksession] the day's phrasings could not be saved: %v\n", err)
	}
}
