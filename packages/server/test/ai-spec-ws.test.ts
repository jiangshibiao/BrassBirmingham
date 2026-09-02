/**
 * WS 层端到端：AI 席位按版本选择（aiSeats.specs）。
 * - list_agent_plugins：返回已注册插件清单与服务器默认 spec；
 * - create_room(specs) → start_game：AI 席位昵称带插件短名，对局正常推进；
 * - specs 非法：长度不等于 count / 未知 spec → error invalid-config。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness } from './helpers.js';

const PV = 1;
const harness = createTestHarness();
afterEach(async () => {
  await harness.cleanup();
});

describe('WS AI 席位版本选择', () => {
  it('list_agent_plugins：返回插件清单与默认 spec', async () => {
    const server = await harness.startServer();
    const c = await harness.connect(server.port);
    const res = await c.send({ type: 'list_agent_plugins', protocolVersion: PV }, 'agent_plugins');
    const names = (res.plugins as { name: string }[]).map((p) => p.name);
    expect(names).toContain('jsb-v20260902b');
    expect(names).toContain('lm-heuristic-v20260829');
    expect(res.defaultSpec).toBe('builtin:jsb-v20260903');
  });

  it('create_room 带 specs → AI 席位昵称带插件短名，对局推进', async () => {
    const server = await harness.startServer();
    const a = await harness.connect(server.port);
    const credA = await a.send(
      {
        type: 'create_room',
        protocolVersion: PV,
        nickname: 'A',
        config: {
          playerCount: 3,
          seed: 7,
          aiSeats: {
            count: 2,
            difficulty: 'normal',
            specs: ['builtin:jsb-v20260903', 'builtin:lm-heuristic-v20260826'],
          },
        },
      },
      'credentials',
    );
    const roomCreated = (await a.nextMessage('room_state')).room;
    const code = roomCreated.code as string;
    expect(roomCreated.config.aiSeats.specs).toEqual(['builtin:jsb-v20260903', 'builtin:lm-heuristic-v20260826']);
    await a.send({ type: 'start_game', protocolVersion: PV, token: credA.token });
    const roomStarted = (await a.nextMessage('room_state', (m) => m.room.started === true)).room;
    const nicknames = roomStarted.seats.map((s: { nickname: string } | null) => s?.nickname);
    expect(nicknames).toEqual(['A', 'AI-1（jsb-v20260903）', 'AI-2（lm-heuristic-v20260826）']);
    // 对局能推进：等首个快照（AI 席位决策驱动）
    const snap = await a.nextMessage('snapshot');
    expect(snap.state).toBeDefined();
  });

  it('specs 长度不等于 count → error invalid-config', async () => {
    const server = await harness.startServer();
    const a = await harness.connect(server.port);
    await a.send(
      {
        type: 'create_room',
        protocolVersion: PV,
        nickname: 'A',
        config: {
          playerCount: 3,
          aiSeats: { count: 2, difficulty: 'normal', specs: ['builtin:jsb-v20260903'] },
        },
      },
      'error',
    ).then((err) => {
      expect(err.code).toBe('invalid-config');
    });
  });

  it('未知 spec → error invalid-config', async () => {
    const server = await harness.startServer();
    const a = await harness.connect(server.port);
    await a.send(
      {
        type: 'create_room',
        protocolVersion: PV,
        nickname: 'A',
        config: {
          playerCount: 3,
          aiSeats: { count: 1, difficulty: 'normal', specs: ['builtin:no-such-agent'] },
        },
      },
      'error',
    ).then((err) => {
      expect(err.code).toBe('invalid-config');
    });
  });
});
