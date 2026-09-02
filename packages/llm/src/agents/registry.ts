/**
 * 插件注册表：spec 字符串 → AgentPlugin。
 *
 * 贡献新 AI 的两步（不许动其他文件）：
 * 1. 本目录新增单文件插件（默认导出 AgentPlugin，见 contract.ts 与 heuristic-v20260826.ts）；
 * 2. 在 BUILTIN_PLUGINS 加一行登记。
 *
 * spec 格式：`builtin:<name>`（本目录内置）；`exec:<path>`（外部进程插件，
 * stdio NDJSON，后续切片实现）。缺省 spec = DEFAULT_SPEC。
 */
import type { DecidingAgent, Decision } from '../decision.js';
import type { Action, GameState, PlayerIndex } from '@brass/engine';
import type { AgentContext, AgentPlugin } from './contract.js';
import lmV20260826 from './lm-heuristic-v20260826.js';
import lmV20260829 from './lm-heuristic-v20260829.js';
import jsbV20260831 from './jsb-v20260831.js';
import jsbV20260901 from './jsb-v20260901.js';
import jsbV20260902a from './jsb-v20260902a.js';
import jsbV20260902b from './jsb-v20260902b.js';
import jsbV20260903 from './jsb-v20260903.js';

const BUILTIN_PLUGINS: Record<string, AgentPlugin> = {
  'lm-heuristic-v20260826': lmV20260826,
  'lm-heuristic-v20260829': lmV20260829,
  'jsb-v20260831': jsbV20260831,
  'jsb-v20260901': jsbV20260901,
  'jsb-v20260902a': jsbV20260902a,
  'jsb-v20260902b': jsbV20260902b,
  'jsb-v20260903': jsbV20260903,
};

/** 大厅缺省 AI：jsb-v20260903（0902b 迭代：真实概率叶，vs 0902b 56.2%（×500）、内战 114.3，2026-09-03 切默认）。 */
export const DEFAULT_SPEC = 'builtin:jsb-v20260903';

/** 已登记的内置插件清单（大厅可选列表/跑分用）。 */
export function listAgentPlugins(): AgentPlugin['meta'][] {
  return Object.values(BUILTIN_PLUGINS).map((p) => p.meta);
}

/** 解析 spec → 插件（exec: 尚未实现，明确报错而非静默降级）。 */
export function resolveAgentPlugin(spec: string): AgentPlugin {
  const [kind, name] = spec.split(':', 2);
  if (kind === 'builtin' && name !== undefined && name in BUILTIN_PLUGINS) {
    return BUILTIN_PLUGINS[name]!;
  }
  if (kind === 'exec') {
    throw new Error(`exec: 外部进程插件尚未实现（${spec}）`);
  }
  throw new Error(`未知 AI 插件 spec: ${spec}（可用：${Object.keys(BUILTIN_PLUGINS).map((n) => `builtin:${n}`).join(', ')}）`);
}

/**
 * spec + 上下文 → DecidingAgent（server 统一入口）。
 * 插件只返回 Action；reason/degraded/usage 在此包装成 Decision。
 */
export function createAgent(spec: string, ctx: AgentContext): DecidingAgent {
  const plugin = resolveAgentPlugin(spec);
  const instance = plugin.create(ctx);
  return {
    decide: async (state: GameState, player: PlayerIndex, legal: Action[]): Promise<Decision> => {
      const action = await instance.decide({ state, seat: player, legal });
      return {
        action,
        reason: instance.explain?.() ?? plugin.meta.name,
        degraded: true, // 非 LLM 直连路径（与 HeuristicAgent 旧语义一致）
        usage: { input: 0, output: 0 },
      };
    },
  };
}

/** server aiAgentFactory 适配：(seat, difficulty) → DecidingAgent。 */
export function agentFactoryFromSpec(
  spec: string,
): (seat: PlayerIndex, difficulty?: import('../llm-agent.js').Difficulty) => DecidingAgent {
  return (seat, difficulty) => createAgent(spec, { seat, difficulty });
}
