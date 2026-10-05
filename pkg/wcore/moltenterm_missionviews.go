// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// legacyTimelineBlocksInProject returns the blocks of the removed Timeline view, switched to the Project view (#233).
// The blocks passed are never modified.
func legacyTimelineBlocksInProject(blocks []*waveobj.Block) []*waveobj.Block {
	var rtn []*waveobj.Block
	for _, block := range blocks {
		if block == nil {
			continue
		}
		meta, changed := molten.ProjectOverviewBlockMeta(block.Meta)
		if !changed {
			continue
		}
		migrated := *block
		migrated.Meta = meta
		rtn = append(rtn, &migrated)
	}
	return rtn
}

// MigrateLegacyTimelineBlocks turns the saved Timeline blocks into Project views (FR-MC-020). Run once at startup,
// before any window loads them; idempotent, since a migrated block no longer matches. The frontend also renders a
// leftover Timeline block as the Project view, for one created after this ran (a stale blockdef, an older wsh).
func MigrateLegacyTimelineBlocks() error {
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		return fmt.Errorf("reading blocks: %w", err)
	}
	migrated := legacyTimelineBlocksInProject(blocks)
	for _, block := range migrated {
		err = wstore.DBUpdate(ctx, block)
		if err != nil {
			return fmt.Errorf("migrating timeline block %s: %w", block.OID, err)
		}
	}
	if len(migrated) > 0 {
		log.Printf("moved %d timeline block(s) to the project view\n", len(migrated))
	}
	return nil
}
