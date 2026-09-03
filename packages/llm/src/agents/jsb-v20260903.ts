/**
 * jsb-v20260903：启发式 AI 调优版——基于 jsb-v20260902b 继续迭代。
 *
 * 方向（2026-09-03，用户复盘终局给出的研发 hint）：
 * - 棉花流：运河研发掉 ≥2 张 L1 + 全部 L2 棉，冲 1-2 张 L3（配自酒卖）；
 *   铁路再冲 3-4 张 L3/L4；重视现金流。
 * - 酒厂：L1 必研发掉；后期按放桶情况再研发 0-2 张。
 * - 陶瓷：玩法则研发掉 L2 冲 L3。
 * - 制造厂：L1 少建、L2 尚可、L3/L4 适合研发、L5 配合 Link 吃分。
 *
 * 本文件为 heuristic-core 的配置壳；核心逻辑见 ./heuristic-core.ts。
 */
import { createHeuristicPlugin } from './heuristic-core.js';

export default createHeuristicPlugin({
  meta: {
    name: 'jsb-v20260903',
    version: '2.0.0',
    description: '启发式评分 AI 调优版（0902b 迭代：研发方向引导——棉花流/酒厂研发/陶瓷 L3/制造 L5）',
    author: 'brass-birmingham',
  },
  overrides: {
    lookahead: { fourActionWeight: 0.5 },
    leaf: { realFlipProb: 1, weight: 0.9 },
    flip: { railSellableNoOwnBeerPenalty: 2.0 },
  },
  tuneEnvVar: 'BRASS_TUNE5',
});
