/**
 * 信息面板组件（官方素材版，2026-08）。
 * - TurnOrderBar：顺位 + 玩家色点 + AI 徽章 + 已花费（当前玩家高亮，AI 思考呼吸灯）
 * - HandBar：官方卡面图 + 中文名（地点卡=城市，产业卡=产业，百搭角标），他人只显牌数
 * - PlayerBoard：现金（钱币图标）/收入等级/VP + 已建板块与面板堆叠的官方板块缩略图
 * - LogPanel：action_applied 流（中文行动摘要）
 *
 * 煤/铁市场与收入轨已搬上官方版图（BoardSvg），不再有独立侧边栏组件。
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { INCOME_LEVEL_SPACES, MERCHANTS, TILES, incomeLevelAt } from '@brass/engine';
import type { Action, Card, IndustryType, MerchantId, PlayerIndex } from '@brass/engine';
import type { FilteredState, RoomState } from '@brass/protocol';
import { INDUSTRY_STYLE, PLAYER_COLORS, PLAYER_COLOR_KEYS } from '../board/BoardSvg';
import { cardFaceKey, cardFromId, cardName, describeAction, industryName, locationName, merchantName } from './display';
import { actionCardsText, buildRounds, incomeSuffix } from './eraLog';
import { INDUSTRY_ORDER } from './interactions';
import { DiscardModal } from './DiscardModal';
import { PlayerMat } from './PlayerMat';
import type { LogEntry } from './store';

/** 座位显示名：有房间信息用昵称，否则 玩家{seat+1}。 */
export function playerName(room: RoomState | undefined, seat: PlayerIndex): string {
  const info = room?.seats.find((s) => s !== null && s.seat === seat);
  return info?.nickname ?? `玩家${seat + 1}`;
}

/** 座位 AI 徽章：房间信息标记 isAI 时渲染（无房间信息或对局外不渲染）。 */
export function AIBadge({
  room,
  seat,
}: {
  room: RoomState | undefined;
  seat: PlayerIndex;
}): ReactElement | null {
  const info = room?.seats.find((s) => s !== null && s.seat === seat);
  if (info === undefined || info === null || !info.isAI) return null;
  return <span className="ai-badge">AI</span>;
}

/** 玩家色点（官方四色，与棋盘板块底色一致）。 */
export function ColorDot({ seat }: { seat: PlayerIndex }): ReactElement {
  return (
    <span
      className="color-dot"
      style={{ background: PLAYER_COLORS[seat] ?? '#7f8c8d' }}
      aria-hidden="true"
    />
  );
}

export function TurnOrderBar({
  state,
  room,
  thinkingSeats,
  overlay = false,
}: {
  state: FilteredState;
  room?: RoomState | undefined;
  /** ai_thinking 中的座位（M3）：高亮并显示"思考中…"。 */
  thinkingSeats?: readonly PlayerIndex[] | undefined;
  /** 叠加模式：官方式圆形头像横排 + 本轮花费钱币堆，绝对定位于版图左下角。 */
  overlay?: boolean;
}): ReactElement {
  const current = state.turnOrder[state.currentPlayerIdx];
  if (overlay) {
    // 官方式顺位轨:圆形角色头像按顺位横排,本轮花费的钱堆在该玩家头像旁
    // (钱币逐层叠放 + 数字),当前玩家金圈,AI 思考中呼吸灯。不遮版图。
    return (
      <section className="turn-order-bar overlay" aria-label="行动顺位">
        <ol data-testid="turn-order" className="turn-track">
          {state.turnOrder.map((seat) => {
            const player = state.players[seat];
            const thinking = thinkingSeats?.includes(seat) ?? false;
            const spent = player?.spentThisRound ?? 0;
            const colorKey = PLAYER_COLOR_KEYS[seat] ?? 'purple';
            const classes = [seat === current ? 'current' : '', thinking ? 'thinking' : '']
              .filter((c) => c !== '')
              .join(' ');
            return (
              <li
                key={seat}
                data-player={seat}
                className={classes === '' ? undefined : classes}
                title={`${playerName(room, seat)}｜本轮已花 £${spent}`}
              >
                <img
                  className="turn-avatar"
                  src={`/assets/players/${colorKey}.png`}
                  alt={playerName(room, seat)}
                  style={{ borderColor: PLAYER_COLORS[seat] ?? '#7f8c8d' }}
                />
                {spent > 0 ? (
                  <span className="turn-spent" data-testid={`turn-spent-${seat}`}>
                    <span className="turn-coins" aria-hidden="true">
                      {Array.from({ length: Math.min(spent, 4) }, (_, i) => (
                        <img key={i} src="/assets/coins/1.png" alt="" />
                      ))}
                    </span>
                    <span className="turn-spent-num">£{spent}</span>
                  </span>
                ) : null}
                {thinking ? <span className="thinking-dot" aria-label="思考中" /> : null}
              </li>
            );
          })}
        </ol>
      </section>
    );
  }
  return (
    <section className={`turn-order-bar${overlay ? ' overlay' : ''}`}>
      <h3>行动顺位</h3>
      <ol data-testid="turn-order">
        {state.turnOrder.map((seat, rank) => {
          const player = state.players[seat];
          const thinking = thinkingSeats?.includes(seat) ?? false;
          const classes = [seat === current ? 'current' : '', thinking ? 'thinking' : '']
            .filter((c) => c !== '')
            .join(' ');
          return (
            <li key={seat} data-player={seat} className={classes === '' ? undefined : classes}>
              {overlay ? <span className="turn-rank">{rank + 1}</span> : null}
              <ColorDot seat={seat} />
              <span className="player-name">{playerName(room, seat)}</span>{' '}
              <AIBadge room={room} seat={seat} />
              <span className="turn-money">
                <img className="coin-icon" src="/assets/coins/1.png" alt="" />£{player?.money ?? 0}
              </span>
              <span className="turn-vp">{player?.vp ?? 0} 分</span>
              <span>已花 £{player?.spentThisRound ?? 0}</span>
              {thinking ? <span className="thinking-badge"> 思考中…</span> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * 卡面图路径：一个牌面可能有多张官方美术（fetch-assets 输出 face.png / face@2.png …），
 * 按引擎卡 id 的副本序号轮转，同名牌各副本美术不同（贴近实体牌堆观感）。
 */
const CARD_VARIANTS: Record<string, number> = {
  'ind-brewery': 3,
  'ind-coal': 2,
  'ind-iron': 2,
  'ind-cotton-manufacturer': 3,
};

export function cardImageSrc(card: Card): string {
  const face = cardFaceKey(card);
  const variants = CARD_VARIANTS[face] ?? 1;
  if (variants <= 1) return `/assets/cards/${face}.png`;
  const n = Number(card.id.split('-').pop() ?? '0');
  const pick = (Number.isFinite(n) ? n : 0) % variants;
  return `/assets/cards/${face}${pick === 0 ? '' : `@${pick + 1}`}.png`;
}

export function HandBar({
  state,
  seat,
  selectedCard,
  onSelect,
  overlay = false,
  scoutMode,
  handRaise = 'single',
}: {
  state: FilteredState;
  seat: PlayerIndex;
  selectedCard?: string | null;
  onSelect?: ((cardId: string) => void) | undefined;
  /** 宽屏:绝对定位叠在地图下缘,只露卡牌顶部,悬停整张浮出。 */
  overlay?: boolean | undefined;
  /** 搜寻选牌模式:点手牌 = 选/弃搜寻弃牌(与搜寻行的卡牌按钮绑定)。 */
  scoutMode?: { picks: string[]; onToggle: (cardId: string) => void } | null | undefined;
  /** 卡牌悬浮效果(偏好设置):single=悬停提起单张;all=悬停整排提起,选中单张固定。 */
  handRaise?: 'single' | 'all' | undefined;
}): ReactElement {
  const self = state.players[seat];
  // 手牌自定义排序(纯前端,服务端不关心手牌顺序):dragOrder 保存拖拽后的卡牌 id 序列;
  // 每次渲染与快照手牌对账——仍在手牌的按自定义序,新摸的牌追加在尾
  const [dragOrder, setDragOrder] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<{ id: string; after: boolean } | null>(null);
  const handCards = self?.hand.kind === 'full' ? self.hand.cards : [];
  const displayCards = (() => {
    if (dragOrder.length === 0) return handCards;
    const byId = new Map(handCards.map((c) => [c.id, c]));
    const known = dragOrder.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
    const knownSet = new Set(known.map((c) => c.id));
    return [...known, ...handCards.filter((c) => !knownSet.has(c.id))];
  })();
  const clearDrag = (): void => {
    setDragId(null);
    setDropMark(null);
  };
  const handleDrop = (targetId: string, after: boolean): void => {
    if (dragId === null || dragId === targetId) {
      clearDrag();
      return;
    }
    const ids = displayCards.map((c) => c.id).filter((id) => id !== dragId);
    let idx = ids.indexOf(targetId);
    if (idx === -1) {
      clearDrag();
      return;
    }
    if (after) idx += 1;
    ids.splice(idx, 0, dragId);
    setDragOrder(ids);
    clearDrag();
  };
  // 已有选定(行动牌或搜寻弃牌)时,其余牌悬停不再提起;被选中的牌保持提起(固定悬浮)
  const hasSelection =
    scoutMode !== null && scoutMode !== undefined
      ? scoutMode.picks.length > 0
      : selectedCard !== null && selectedCard !== undefined;
  const noRaise = overlay === true && handRaise === 'single' && hasSelection;
  const modeAll = overlay === true && handRaise === 'all';
  const classes = [
    'hand-bar',
    overlay ? 'overlay' : '',
    modeAll ? 'mode-all' : '',
    hasSelection ? 'has-selection' : '',
    noRaise ? 'no-raise' : '',
  ]
    .filter((c) => c !== '')
    .join(' ');
  return (
    <section className={classes} data-testid="hand-bar">
      <div className="own-hand">
        {displayCards.map((card) => {
          const isWild = card.kind === 'wild-location' || card.kind === 'wild-industry';
          const selected =
            scoutMode !== null && scoutMode !== undefined
              ? scoutMode.picks.includes(card.id)
              : selectedCard === card.id;
          const classes = [
            'hand-card',
            isWild ? 'wild' : '',
            selected ? 'selected' : '',
            dragId === card.id ? 'dragging' : '',
            dropMark?.id === card.id ? (dropMark.after ? 'drop-after' : 'drop-before') : '',
          ]
            .filter((c) => c !== '')
            .join(' ');
          return (
            <button
              key={card.id}
              type="button"
              data-testid={`hand-card-${card.id}`}
              className={classes}
              draggable
              onDragStart={(e) => {
                setDragId(card.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', card.id);
              }}
              onDragOver={(e) => {
                if (dragId === null || dragId === card.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = e.currentTarget.getBoundingClientRect();
                setDropMark({ id: card.id, after: e.clientX > rect.left + rect.width / 2 });
              }}
              onDrop={(e) => {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                handleDrop(card.id, e.clientX > rect.left + rect.width / 2);
              }}
              onDragEnd={clearDrag}
              onClick={() =>
                scoutMode !== null && scoutMode !== undefined
                  ? scoutMode.onToggle(card.id)
                  : onSelect?.(card.id)
              }
            >
              <img className="hand-card-art" src={cardImageSrc(card)} alt={cardName(card)} />
              <span className="hand-card-name">{cardName(card)}</span>
              <span className="card-tip">{cardName(card)}</span>
              {isWild ? <span className="wild-badge">百搭</span> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * 玩家板块图：现金/收入等级/VP + 已建板块（官方板块缩略图）+ 面板堆叠（未建）。
 * 默认展开本人、折叠他人（点击标题展开/收起）。全部纯渲染，只读 state。
 */
export function PlayerBoard({
  state,
  seat,
  room,
  defaultOpen = false,
  pulse = false,
  compact = false,
  activeTurn = false,
  buildStatus,
  playedCards,
  eraActions,
  roundNow,
  turnHold,
  onTileDragStart,
  hiddenTopInd,
  stackView,
  developPicks,
  buildPicks,
  developBinRef,
}: {
  state: FilteredState;
  seat: PlayerIndex;
  room?: RoomState | undefined;
  /** 初始展开（本人面板传 true，他人折叠）。 */
  defaultOpen?: boolean;
  /** 行动播报：该座位刚执行行动,面板描边脉冲(聚光灯窗口内,约 5s)。 */
  pulse?: boolean;
  /** 宽屏紧凑模式:单行头部(不换行),省略 meta 与已建板块区,默认铺开。 */
  compact?: boolean;
  /** 当前回合进行中(思考/行动全程):面板持续发光(稳态,区别于脉冲)。 */
  activeTurn?: boolean;
  /** 各产业可建性标注(本人回合的本人面板;明细行内显示,如 "✓ 可建造"/"还需 £3")。 */
  buildStatus?: Partial<Record<IndustryType, string>> | undefined;
  /** 该座位本时代已打出的牌(右上"打出"按钮的单人记录用)。 */
  playedCards?: Card[] | undefined;
  /** 本时代全部行动及实际现金变化(服务端结算时记录;note='round-income' 为轮末收入)。 */
  eraActions?: { action: Action; moneyDelta: number; note?: 'round-income' }[] | undefined;
  /** 时代内当前轮号(由全座位 eraActions 推算;引擎 state.round 跨时代不重置,
   *  不能直接拿来匹配时代内分组的轮次)。缺省回退 state.round。 */
  roundNow?: number | undefined;
  /** 扣住的回合(轮末停顿时非空):当前轮尚无行动时回落展示刚结束那轮。 */
  turnHold?: PlayerIndex | null | undefined;
  /** 按下产业栈顶板块开始拖拽(宽屏拖拽建造/研发,仅紧凑面板用)。 */
  onTileDragStart?: ((ind: IndustryType, e: React.PointerEvent<HTMLElement | SVGElement>) => void) | undefined;
  /** 正在拖拽中的产业(该栈顶 token 从版图上即时消失)。 */
  hiddenTopInd?: IndustryType | null | undefined;
  /** 个人版图风格(偏好设置收口):mat=桌游风格;list=列表风格(原"明细")。 */
  stackView?: 'mat' | 'list' | undefined;
  /** 研发暂存中的产业(每个出现一次 = 暂存移除 1 块;版面计数同步 -1,归零置灰)。 */
  developPicks?: IndustryType[] | undefined;
  /** 建造暂存中的产业(已落槽/落点待确认:版面栈顶 token 同步 -1,与研发暂存同机制)。 */
  buildPicks?: IndustryType[] | undefined;
  /** 垃圾桶(研发拖放目标)的容器 ref——只有拖到垃圾桶上松手才算研发。 */
  developBinRef?: React.LegacyRef<HTMLDivElement> | undefined;
}): ReactElement {
  const [open, setOpen] = useState<boolean>(defaultOpen || compact);
  // 单人打出记录弹层开关(版图/明细切换旁的"打出"按钮)
  const [discardOpen, setDiscardOpen] = useState(false);
  // 前几回合动作下拉(第二行末尾箭头)
  const [historyOpen, setHistoryOpen] = useState(false);
  // 堆叠视图:版图(官方玩家面板美术)/明细(#19 列表)——记住玩家选择
  // (jsdom 等环境无 localStorage,降级为会话内状态)
  const storage = typeof localStorage === 'undefined' ? null : localStorage;
  const [matView, setMatViewState] = useState<boolean>(
    () => storage?.getItem('brass-stack-view') !== 'list',
  );
  const setMatView = (v: boolean): void => {
    setMatViewState(v);
    storage?.setItem('brass-stack-view', v ? 'mat' : 'list');
  };
  const self = state.players[seat];
  if (self === undefined) return <></>;
  const level = incomeLevelAt(self.incomeSpace);
  const colorKey = ['purple', 'yellow', 'orange', 'teal'][seat] ?? 'purple';

  // 面板堆叠：按原版玩家板展示全部板块（TILES 数值表），每级 = 官方缩略图 + 剩余数 +
  // 翻面得分/收入增加；剩余数从 players[i].tiles 数出（建完置灰）。
  const remainingByTile = new Map<string, number>();
  for (const def of self.tiles) {
    const key = `${def.industry}-${def.level}`;
    remainingByTile.set(key, (remainingByTile.get(key) ?? 0) + 1);
  }
  // 研发/建造暂存同步减量(每暂存一次该产业,其最低级剩余 -1;归零显示耗尽)
  for (const ind of [...(developPicks ?? []), ...(buildPicks ?? [])]) {
    const top = TILES.filter((t) => t.industry === ind)
      .map((d) => d.level)
      .find((lv) => (remainingByTile.get(`${ind}-${lv}`) ?? 0) > 0);
    if (top !== undefined) remainingByTile.set(`${ind}-${top}`, (remainingByTile.get(`${ind}-${top}`) ?? 1) - 1);
  }

  // 单人打出记录数据(稀疏数组,按座位号入桶)
  const playedCardsAll: Card[][] =
    playedCards !== undefined ? Object.assign([], { [seat]: playedCards }) as Card[][] : [];

  if (compact) {
    // 第一行:顺位 + 名称 + 钱(椭圆底);行末"打出"按钮
    const rank = state.turnOrder.indexOf(seat) + 1;
    // 本时代行动按回合分组(最新轮在前);本回合行动取当前轮组——
    // 刷新后 log 只剩残尾,但 eraActions 是服务端全量簿记,记录不丢
    const rounds = buildRounds(state, eraActions ?? [], true);
    // roundEndPending(轮末结算挂起,等 held 玩家确认回合)时轮次已指向"下一轮",
    // 而刚结束那轮才是要展示的——此时取最新一轮;否则按时代内当前轮号 roundNow
    // 匹配(缺省回退 state.round)。轮末停顿(turnHold 非空且新一轮还无人行动)同样回落
    const acts = (
      state.roundEndPending
        ? (rounds[0]?.actions ?? [])
        : (rounds.find((r) => r.round === (roundNow ?? state.round))?.actions ??
          (turnHold !== null && turnHold !== undefined ? (rounds[0]?.actions ?? []) : []))
    ).filter((a) => a.note !== 'round-income');
    return (
      <section
        className={`player-board compact${pulse ? ' pulse' : ''}${activeTurn ? ' active-turn' : ''}`}
        data-testid={`player-board-${seat}`}
        style={pulse || activeTurn ? ({ '--pulse-color': PLAYER_COLORS[seat] ?? '#f0c964' } as CSSProperties) : undefined}
      >
        <div className="compact-head">
          <span className="compact-rank" style={{ borderColor: PLAYER_COLORS[seat] }} data-testid={`compact-rank-${seat}`}>
            {rank > 0 ? `#${rank}` : '—'}
          </span>
          <ColorDot seat={seat} />
          <span className="player-name">{playerName(room, seat)}</span>
          <AIBadge room={room} seat={seat} />
          <span className="head-money money-oval">£{self.money}</span>
          {playedCards !== undefined ? (
            <button
              type="button"
              className="discard-open-btn"
              data-testid={`discard-open-${seat}`}
              title="按顺序查看该玩家本时代打出的全部牌"
              onClick={() => setDiscardOpen(true)}
            >
              打出
            </button>
          ) : null}
        </div>
        <div className="compact-round" data-testid={`compact-round-${seat}`}>
          <div className="compact-round-acts">
            {acts.length === 0 ? (
              <span className="compact-round-line">本回合未行动</span>
            ) : (
              acts.map((a, i) => (
                <span className="compact-round-line" key={i}>
                  {describeAction(a.action)}
                  <em className={`compact-round-delta ${a.moneyDelta >= 0 ? 'pos' : 'neg'}`}>
                    {a.moneyDelta > 0 ? `+£${a.moneyDelta}` : a.moneyDelta < 0 ? `−£${-a.moneyDelta}` : '+£0'}
                  </em>
                  <em className="compact-history-card">{actionCardsText(a.action)}</em>
                </span>
              ))
            )}
          </div>
          <button
            type="button"
            className="history-toggle"
            data-testid={`history-toggle-${seat}`}
            aria-expanded={historyOpen}
            title="展开前几回合的动作"
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            {historyOpen ? '▾' : '▸'}
          </button>
        </div>
        {historyOpen ? (
          <div className="compact-history" data-testid={`compact-history-${seat}`}>
            {rounds.length === 0 ? (
              <p className="era-actions-empty">本时代尚未行动</p>
            ) : (
              rounds.map((r) => (
                <div key={r.round} className="compact-history-round">
                  <span className="compact-history-label">
                    第 {r.round} 轮{incomeSuffix(r.round, r.actions)}
                  </span>
                  {r.actions
                    .filter((a) => a.note !== 'round-income')
                    .map((a, i) => (
                      <span key={i} className="compact-history-act">
                        {describeAction(a.action)}
                        <em className="compact-history-card">{actionCardsText(a.action)}</em>
                      </span>
                    ))}
                </div>
              ))
            )}
          </div>
        ) : null}
        <div className="board-stack" data-testid={`player-board-stack-${seat}`}>
          <div
            className="develop-bin"
            data-testid={`develop-bin-${seat}`}
            ref={developBinRef}
            title="拖到此处研发(移除该产业最低级板块)"
          >
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
              <path
                d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          {(stackView ?? 'mat') === 'mat' ? (
            <PlayerMat
              tiles={self.tiles}
              playerColor={PLAYER_COLORS[seat] ?? '#7f8c8d'}
              colorKey={colorKey as 'purple' | 'yellow' | 'orange' | 'teal'}
              onTileDragStart={onTileDragStart}
              hiddenTopInd={hiddenTopInd}
              stagedRemovals={[...(developPicks ?? []), ...(buildPicks ?? [])]}
            />
          ) : (
            INDUSTRY_ORDER.map((ind) => {
              // 栈顶(有剩余的最低级)可拖拽:拖到地图城市=建造,拖出地图/版图=研发
              const topLevel = TILES.filter((t) => t.industry === ind)
                .map((d) => d.level)
                .find((lv) => (remainingByTile.get(`${ind}-${lv}`) ?? 0) > 0);
              return (
              <div key={ind} className="board-ind">
                <span className="board-ind-name" style={{ color: INDUSTRY_STYLE[ind].fill }}>
                  {industryName(ind)}
                </span>
                {buildStatus?.[ind] !== undefined ? (
                  <span
                    className={`board-ind-status${buildStatus[ind]!.startsWith('✓') ? ' ok' : ''}`}
                    data-testid={`build-status-${seat}-${ind}`}
                  >
                    {buildStatus[ind]}
                  </span>
                ) : null}
                <span className="board-ind-list">
                  {TILES.filter((t) => t.industry === ind).map((def) => {
                    const remaining = remainingByTile.get(`${ind}-${def.level}`) ?? 0;
                    const cost =
                      `£${def.costMoney}` +
                      (def.costCoal > 0 ? ` 煤${def.costCoal}` : '') +
                      (def.costIron > 0 ? ` 铁${def.costIron}` : '');
                    const isTop = def.level === topLevel;
                    const dragging = isTop && hiddenTopInd === ind;
                    return (
                      <span
                        key={def.level}
                        className={`stack-tile${remaining === 0 ? ' exhausted' : ''}`}
                        data-testid={`player-board-stack-${seat}-${ind}-${def.level}`}
                        title={`${industryName(ind)} Lv${def.level}｜建造成本 ${cost}｜翻面得 ${def.vp} 分、收入 +${def.incomeAdvance} 级`}
                        style={{
                          ...(isTop && onTileDragStart !== undefined && remaining > 0 ? { cursor: 'grab' } : {}),
                          ...(dragging ? { opacity: 0.25 } : {}),
                        }}
                        onPointerDown={
                          isTop && onTileDragStart !== undefined && remaining > 0
                            ? (e) => onTileDragStart(ind, e)
                            : undefined
                        }
                      >
                        <img
                          src={`/assets/tiles/${ind}-${def.level}-${colorKey}.png`}
                          alt={`${industryName(ind)} Lv${def.level}`}
                        />
                        <span className="stack-tile-count">×{remaining}</span>
                        <span className="stack-tile-sub">Lv{def.level}</span>
                      </span>
                    );
                  })}
                </span>
              </div>
              );
            })
          )}
        </div>
        {discardOpen ? (
          <DiscardModal
            state={state}
            playedCards={playedCardsAll}
            room={room}
            onlySeat={seat}
            onClose={() => setDiscardOpen(false)}
          />
        ) : null}
      </section>
    );
  }

  // 聚合已建板块（board.slots 全部城市 × 槽位，挑出属于本座位的）
  const builtTiles: { industry: IndustryType; level: number; flipped: boolean; resources: number; location: string }[] = [];
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (const tile of slots) {
      if (tile === null || tile.player !== seat) continue;
      builtTiles.push({
        industry: tile.tile.industry,
        level: tile.tile.level,
        flipped: tile.flipped,
        resources: tile.resources,
        location: loc,
      });
    }
  }
  const [levelStart, levelEnd] = INCOME_LEVEL_SPACES(level);

  return (
    <section
      className={`player-board${pulse ? ' pulse' : ''}${activeTurn ? ' active-turn' : ''}`}
      data-testid={`player-board-${seat}`}
      style={pulse || activeTurn ? ({ '--pulse-color': PLAYER_COLORS[seat] ?? '#f0c964' } as CSSProperties) : undefined}
    >
      <button
        type="button"
        className="player-board-head"
        data-testid={`player-board-toggle-${seat}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ColorDot seat={seat} />
        <span className="player-name">{playerName(room, seat)}</span>
        <AIBadge room={room} seat={seat} />
        <span className={`level-chip${seat === state.turnOrder[state.currentPlayerIdx] ? ' current' : ''}`}>
          收入等级 {level}
        </span>
        <span className="head-money">
          <img className="coin-icon" src="/assets/coins/1.png" alt="" />£{self.money}
        </span>
        <span className="head-vp">{self.vp} 分</span>
        <span className="board-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="player-board-body">
          <p className="board-meta" data-testid={`player-board-meta-${seat}`}>
            收入格 {self.incomeSpace}（等级 {level} 区间 {levelStart}–{levelEnd}）· 现金 £{self.money} · {self.vp} 分
          </p>
          <div className="board-built" data-testid={`player-board-built-${seat}`}>
            <h4>已建板块</h4>
            {builtTiles.length === 0 ? (
              <p className="board-empty">尚未建造</p>
            ) : (
              <div className="board-tile-row">
                {(() => {
                  const perIndustry = new Map<IndustryType, number>();
                  return builtTiles.map((t, i) => {
                    const indIdx = perIndustry.get(t.industry) ?? 0;
                    perIndustry.set(t.industry, indIdx + 1);
                    return (
                      <span
                        key={i}
                        className={`board-tile-thumb${t.flipped ? ' flipped' : ''}`}
                        data-testid={`player-board-tile-${seat}-${t.industry}-${indIdx}`}
                        title={`${industryName(t.industry)} Lv${t.level} @ ${locationName(t.location)}${t.flipped ? '（已翻面）' : ''}`}
                      >
                        <img
                          src={`/assets/tiles/${t.industry}-${t.level}-${colorKey}${t.flipped ? '-back' : ''}.png`}
                          alt={industryName(t.industry)}
                        />
                        <span className="board-tile-sub">Lv{t.level}</span>
                      </span>
                    );
                  });
                })()}
              </div>
            )}
          </div>
          <div className="board-stack" data-testid={`player-board-stack-${seat}`}>
            <div className="board-stack-head">
              <h4>面板堆叠（未建）</h4>
              {playedCards !== undefined ? (
                <button
                  type="button"
                  className="discard-open-btn"
                  data-testid={`discard-open-${seat}`}
                  title="查看该玩家本时代打出的牌"
                  onClick={() => setDiscardOpen(true)}
                >
                  打出
                </button>
              ) : null}
              <span className="stack-view-toggle" role="group" aria-label="堆叠视图切换">
                <button
                  type="button"
                  className={matView ? 'active' : ''}
                  data-testid={`stack-view-mat-${seat}`}
                  onClick={() => setMatView(true)}
                >
                  版图
                </button>
                <button
                  type="button"
                  className={matView ? '' : 'active'}
                  data-testid={`stack-view-list-${seat}`}
                  onClick={() => setMatView(false)}
                >
                  明细
                </button>
              </span>
            </div>
            {matView ? (
              <PlayerMat
                tiles={self.tiles}
                playerColor={PLAYER_COLORS[seat] ?? '#7f8c8d'}
                colorKey={colorKey as 'purple' | 'yellow' | 'orange' | 'teal'}
              />
            ) : (
            INDUSTRY_ORDER.map((ind) => (
              <div key={ind} className="board-ind">
                <span className="board-ind-name" style={{ color: INDUSTRY_STYLE[ind].fill }}>
                  {industryName(ind)}
                </span>
                {buildStatus?.[ind] !== undefined ? (
                  <span
                    className={`board-ind-status${buildStatus[ind]!.startsWith('✓') ? ' ok' : ''}`}
                    data-testid={`build-status-${seat}-${ind}`}
                  >
                    {buildStatus[ind]}
                  </span>
                ) : null}
                <span className="board-ind-list">
                  {TILES.filter((t) => t.industry === ind).map((def) => {
                    const remaining = remainingByTile.get(`${ind}-${def.level}`) ?? 0;
                    const cost =
                      `£${def.costMoney}` +
                      (def.costCoal > 0 ? ` 煤${def.costCoal}` : '') +
                      (def.costIron > 0 ? ` 铁${def.costIron}` : '');
                    return (
                      <span
                        key={def.level}
                        className={`stack-tile${remaining === 0 ? ' exhausted' : ''}`}
                        data-testid={`player-board-stack-${seat}-${ind}-${def.level}`}
                        title={`${industryName(ind)} Lv${def.level}｜建造成本 ${cost}｜翻面得 ${def.vp} 分、收入 +${def.incomeAdvance} 级`}
                      >
                        <img
                          src={`/assets/tiles/${ind}-${def.level}-${colorKey}.png`}
                          alt={`${industryName(ind)} Lv${def.level}`}
                        />
                        <span className="stack-tile-count">×{remaining}</span>
                        <span className="stack-tile-sub">
                          Lv{def.level}｜翻 {def.vp}分 +{def.incomeAdvance}收
                        </span>
                      </span>
                    );
                  })}
                </span>
              </div>
            ))
            )}
          </div>
        </div>
      ) : null}
      {discardOpen ? (
        <DiscardModal
          state={state}
          playedCards={playedCardsAll}
          room={room}
          onlySeat={seat}
          onClose={() => setDiscardOpen(false)}
        />
      ) : null}
    </section>
  );
}

/** 行动日志弹窗(宽屏顶部"行动日志"按钮打开;经典布局仍用底部 LogPanel)。 */
export function LogModal({
  log,
  room,
  onClose,
}: {
  log: LogEntry[];
  room?: RoomState | undefined;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="modal-backdrop" data-testid="log-modal" onClick={onClose}>
      <section className="score-modal log-modal" onClick={(e) => e.stopPropagation()}>
        <header className="score-modal-head">
          <h3>行动日志</h3>
          <button type="button" className="modal-close" data-testid="log-modal-close" onClick={onClose}>
            ×
          </button>
        </header>
        {log.length === 0 ? (
          <p data-testid="log-empty">暂无行动</p>
        ) : (
          <ol className="log-scroll log-modal-scroll">
            {log.map((entry) => {
              const bonus = merchantBonusNote(entry.events);
              return (
                <li key={entry.seq} data-testid="log-entry">
                  #{entry.seq} {playerName(room, entry.player)}：{actionSummary(entry.action)}
                  {bonus !== null ? <span className="log-bonus">（{bonus}）</span> : null}
                  {entry.degraded === true ? <span className="degraded-badge">（已降级）</span> : null}
                  {entry.reason !== undefined ? (
                    <blockquote className="log-reason">{entry.reason}</blockquote>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

/** 行动一句话摘要（日志用）：与 ActionBar 确认区共用 display.describeAction。 */
export function actionSummary(action: Action): string {
  return describeAction(action);
}

/** 商人奖励文案(项 6:用了商人桶后奖励可见)。 */
function merchantBonusNote(events: unknown[]): string | null {
  const bonuses = events.filter(
    (e): e is { kind: 'merchant-bonus'; merchant: MerchantId } =>
      typeof e === 'object' && e !== null && (e as { kind?: unknown }).kind === 'merchant-bonus',
  );
  if (bonuses.length === 0) return null;
  return bonuses
    .map((e) => {
      const b = MERCHANTS[e.merchant].bonus;
      const text =
        b.type === 'vp'
          ? `+${b.amount} VP`
          : b.type === 'money'
            ? `+£${b.amount}`
            : b.type === 'income'
              ? `收入 +${b.amount} 格`
              : '免费研发 1 块';
      return `${merchantName(e.merchant)}：${text}`;
    })
    .join('、');
}

export function LogPanel({
  log,
  room,
}: {
  log: LogEntry[];
  room?: RoomState | undefined;
}): ReactElement {
  const listRef = useRef<HTMLOListElement>(null);
  // 历史滚动框:用户滚轮上翻查看历史时保持位置;停在底部附近时新行动自动跟底
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (el !== null && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [log.length]);
  const onScroll = (): void => {
    const el = listRef.current;
    if (el === null) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return (
    <section className="log-panel">
      <h3>行动日志</h3>
      {log.length === 0 ? (
        <p data-testid="log-empty">暂无行动</p>
      ) : (
        <ol ref={listRef} className="log-scroll" onScroll={onScroll}>
          {log.map((entry) => {
            const bonus = merchantBonusNote(entry.events);
            return (
              <li key={entry.seq} data-testid="log-entry">
                #{entry.seq} {playerName(room, entry.player)}：{actionSummary(entry.action)}
                {bonus !== null ? <span className="log-bonus" data-testid="log-bonus">（{bonus}）</span> : null}
                {entry.degraded === true ? (
                  <span className="degraded-badge">（已降级）</span>
                ) : null}
                {entry.reason !== undefined ? (
                  <blockquote className="log-reason">{entry.reason}</blockquote>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
