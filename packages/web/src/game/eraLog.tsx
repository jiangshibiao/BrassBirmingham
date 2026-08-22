/**
 * 时代行动簿记的共享展示工具（行动日志弹窗与个人版图历史共用）：
 * eraActions = 各座位本时代全部行动及实际现金变化（服务端结算时记录）;
 * note='round-income' 为轮末收入合成条目（不占每轮行动名额）。
 */
import type { Action } from '@brass/engine';
import type { ReactNode } from 'react';
import type { FilteredState } from '@brass/protocol';
import { cardFromId, cardName } from './display';

export interface EraActionEntry {
  action: Action;
  moneyDelta: number;
  note?: 'round-income';
}

/** 按回合分组（真实行动占名额:运河首轮 1、其余 2;note 条目附进当前轮）。 */
export function buildRounds(
  state: FilteredState,
  actions: EraActionEntry[],
  newestFirst = true,
): { round: number; actions: EraActionEntry[] }[] {
  const apr = (r: number): number => (state.era === 'canal' && r === 1 ? 1 : 2);
  const rounds: { round: number; actions: EraActionEntry[] }[] = [];
  // 按原顺序走一遍:真实行动占每轮名额;
  // 轮末收入(note)不占名额,时序上在收官行动之后,直接附进当前这轮——
  // 收入为 0 的轮没有条目,不能过滤后按序索引(稀疏数组会挂错轮)
  let current: { round: number; actions: EraActionEntry[] } | null = null;
  let used = 0;
  for (const a of actions) {
    if (a.note === 'round-income') {
      current?.actions.push(a);
      continue;
    }
    if (current === null || used >= apr(current.round)) {
      current = { round: rounds.length + 1, actions: [] };
      rounds.push(current);
      used = 0;
    }
    current.actions.push(a);
    used += 1;
  }
  return newestFirst ? rounds.reverse() : rounds;
}

/** 该轮的轮末收入合计（无则 null）。 */
export function roundIncome(entries: EraActionEntry[]): number | null {
  const inc = entries.filter((a) => a.note === 'round-income').reduce((s, a) => s + a.moneyDelta, 0);
  const has = entries.some((a) => a.note === 'round-income');
  return has ? inc : null;
}

/** 轮标签内联收入（着色与行动盈亏一致）:"（收入 +£30）/（收入 −£3）/（收入 +£0）"。
 *  第 1 轮一律不标（首轮收入必为 0,标记只是噪音）。 */
export function incomeSuffix(round: number, entries: EraActionEntry[]): ReactNode {
  if (round === 1) return null;
  const inc = roundIncome(entries);
  if (inc === null) return null;
  return (
    <>
      （收入{' '}
      <em className={`compact-round-delta ${inc >= 0 ? 'pos' : 'neg'}`}>
        {inc >= 0 ? `+£${inc}` : `−£${-inc}`}
      </em>
      ）
    </>
  );
}

/** 行动对应的牌文本（搜寻 = 3 张弃牌以 + 相连）。 */
export function actionCardsText(a: Action): string {
  return a.type === 'scout'
    ? a.cardIds.map((id) => cardName(cardFromId(id))).join('+')
    : cardName(cardFromId(a.cardId));
}
