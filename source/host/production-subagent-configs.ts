import type { TaskSubagentModelConfig } from "../packages/agent/tools/task-cluster-internal.js";
import { createSandBrowserUseSubagentConfig } from "./runner/tools/sand-browser-use-subagent.js";
import { createSandComputerUseSubagentConfig } from "./runner/tools/sand-computer-use-subagent.js";

export function productionParentSubagentConfigs(options: {
  readonly remoteBoxHasDesktop: boolean;
  readonly browserUseOffered: boolean;
}): readonly TaskSubagentModelConfig[] {
  if (options.remoteBoxHasDesktop !== true) return [];
  const configs: TaskSubagentModelConfig[] = [
    createSandComputerUseSubagentConfig({ browserUseOffered: options.browserUseOffered }) as unknown as TaskSubagentModelConfig,
  ];
  if (options.browserUseOffered) {
    configs.push(createSandBrowserUseSubagentConfig() as unknown as TaskSubagentModelConfig);
  }
  return configs;
}
