/**
 * 存档对局回放校验：wq9gs6-2p-full.json(2P 完整对局,78 动)必须被当前引擎
 * 完整重放——任何引擎语义漂移(规则实现变更导致历史行动非法/结果改变)都会在此失败。
 * 同时锁定关键里程碑:运河末轨迹分、终局胜者与总分。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyAction, newGame } from '@brass/engine';
import type { Action, GameState } from '@brass/engine';

interface GameRecord {
  roomCode: string;
  playerCount: 2 | 3 | 4;
  seed: number;
  seats: { seat: number; nickname: string; is_ai: number }[];
  actions: { seq: number; player: number; action: Action }[];
}

const record = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/games/wq9gs6-2p-full.json'), 'utf8'),
) as GameRecord;

describe('存档对局回放(wq9gs6-2p-full, 2P 78 动)', () => {
  it('全部行动可重放;运河末/终局里程碑与记录一致', () => {
    let s: GameState = newGame(record.playerCount, record.seed);
    let canalEndTrack: number[] | null = null;
    for (const row of record.actions) {
      const eraBefore = s.era;
      s = applyAction(s, row.action);
      if (eraBefore === 'canal' && s.era === 'rail') {
        canalEndTrack = s.players.map((p) => p!.vp);
      }
      // 每步不变量:商人桶布尔数组与板块格等长;百搭供应不为负
      for (const m of Object.values(s.merchants)) {
        expect(m.barrels.length).toBe(m.tiles.length);
      }
      expect(s.wildSupply.location).toBeGreaterThanOrEqual(0);
      expect(s.wildSupply.industry).toBeGreaterThanOrEqual(0);
    }
    expect(canalEndTrack).toEqual([39, 44]);
    expect(s.phase).toBe('game-over');
    expect(s.winner).toEqual([0]);
    expect(s.players.map((p) => p!.vp)).toEqual([209, 174]);
    // 终局计分后 links 从版图移除
    expect(s.board.links).toHaveLength(0);
  });
});
