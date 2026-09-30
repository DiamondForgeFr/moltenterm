// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { cn, fireAndForget } from "@/util/util";
import { WaveAIModel } from "./waveai-model";

interface NoAIModeMessageProps {
    className?: string;
}

// Replaces Wave's "telemetry required" screen: Moltenterm ships no AI of its own,
// so the panel waits for a mode that the user defines in waveai.json.
const NoAIModeMessage = ({ className }: NoAIModeMessageProps) => {
    return (
        <div className={cn("flex flex-col h-full", className)}>
            <div className="flex-grow"></div>
            <div className="flex items-center justify-center p-8 text-center">
                <div className="max-w-md space-y-6">
                    <div className="space-y-4">
                        <i className="fa fa-sparkles text-accent text-5xl"></i>
                        <h2 className="text-2xl font-semibold text-foreground">Bring your own AI</h2>
                        <p className="text-secondary leading-relaxed">
                            Moltenterm ships no AI model and sends nothing to a cloud of its own. Add a mode that uses
                            your own provider key or a local model (Ollama, LM Studio…) to waveai.json, and this panel
                            will use it.
                        </p>
                    </div>
                    <button
                        onClick={() => fireAndForget(() => WaveAIModel.getInstance().openWaveAIConfig())}
                        className="bg-accent/80 hover:bg-accent text-background px-4 py-2 rounded-lg font-medium cursor-pointer"
                    >
                        Open waveai.json
                    </button>
                </div>
            </div>
            <div className="flex-grow-[2]"></div>
        </div>
    );
};

NoAIModeMessage.displayName = "NoAIModeMessage";

export { NoAIModeMessage };
