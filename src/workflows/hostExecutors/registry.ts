import type { ProviderReconciler } from '../resume.js';
import {
  botmuxScheduleExecutor,
  botmuxScheduleReconciler,
  parseScheduleInput,
} from './botmux-schedule.js';
import type { SideEffectingExecutor } from './types.js';

export type RegisteredHostExecutor<Input = unknown, Output = unknown> = {
  executor: SideEffectingExecutor<Input, Output>;
  parseInput(input: unknown): Input;
};

export type HostExecutorRegistry = Map<string, RegisteredHostExecutor>;

export function createDefaultHostExecutorRegistry(): HostExecutorRegistry {
  return new Map([
    [
      'botmux-schedule',
      {
        executor: botmuxScheduleExecutor,
        parseInput: parseScheduleInput,
      } satisfies RegisteredHostExecutor,
    ],
  ]);
}

export function createDefaultProviderReconcilers(): Map<string, ProviderReconciler> {
  return new Map([
    [botmuxScheduleReconciler.provider, botmuxScheduleReconciler],
  ]);
}
