/**
 * 本时代打出记录弹层：实体规则"弃牌堆公开"的按玩家视图——各座位本时代已打出的
 * 牌按打出顺序展示（数据来自服务端 session 簿记,resume/重放后仍完整）。
 * - 运河时代每列首张为开局暗置卡背（规则书 p.5 步骤 9:每玩家各暗弃 1 张垫底,不公开）;
 * - Wild 卡弃置回供应区,不入列;时代切换（弃牌合洗进新牌堆）后列表重计、无暗置首张。
 */
import type { ReactElement } from 'react';
import type { Card, PlayerIndex } from '@brass/engine';
import type { FilteredState, RoomState } from '@brass/protocol';
import { PLAYER_COLORS } from '../board/BoardSvg';
import { cardName } from './display';
import { cardImageSrc, playerName } from './Panels';

export function DiscardModal({
  state,
  playedCards,
  room,
  onClose,
  onlySeat,
}: {
  state: FilteredState;
  playedCards: Card[][];
  room?: RoomState | undefined;
  onClose: () => void;
  /** 单人模式:只显示该座位的打出记录(个人版图上的查看按钮用)。 */
  onlySeat?: PlayerIndex | undefined;
}): ReactElement {
  const faceDown = state.era === 'canal' ? 1 : 0;
  const seats = onlySeat !== undefined ? [onlySeat] : state.players.map((_, i) => i as PlayerIndex);
  return (
    <div className="modal-backdrop" data-testid="discard-modal" onClick={onClose}>
      <section className="score-modal discard-modal" onClick={(e) => e.stopPropagation()}>
        <header className="score-modal-head">
          <h3>{onlySeat !== undefined ? `${playerName(room, onlySeat)} 的打出记录` : '本时代打出记录'}</h3>
          <button
            type="button"
            className="modal-close"
            data-testid="discard-modal-close"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="discard-columns">
          {seats.map((i) => {
            const cards = playedCards[i] ?? [];
            return (
              <div className="discard-col" key={i} data-testid={`discard-col-${i}`}>
                <div className="discard-col-head">
                  <span
                    className="color-dot"
                    style={{ background: PLAYER_COLORS[i as PlayerIndex] }}
                  />
                  {playerName(room, i as PlayerIndex)}（{cards.length + faceDown}）
                </div>
                <div className="discard-cards">
                  {faceDown === 1 ? (
                    <span className="discard-cell">
                      <img
                        className="discard-card discard-card-back"
                        src="/assets/cards/back.png"
                        alt="开局暗置"
                      />
                      <span className="discard-card-name">暗置</span>
                      <span className="card-tip">开局暗置（不公开）</span>
                    </span>
                  ) : null}
                  {cards.map((c) => (
                    <span className="discard-cell" key={c.id}>
                      <img className="discard-card" src={cardImageSrc(c)} alt={cardName(c)} />
                      <span className="discard-card-name">{cardName(c)}</span>
                      <span className="card-tip">{cardName(c)}</span>
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/**
 * 行动日志弹窗(合并原"打出记录"与底部日志):上方为各玩家本时代打出的牌
 * (同 DiscardModal),下方按玩家分列、按轮分组记录从开局(本时代)到现在的行动
 * ——每行 = 动作 + 实际盈亏 + 出牌文本(与个人版图历史同款风格)。
 */
import type { Action } from '@brass/engine';
import { cardFromId, describeAction } from './display';
import { actionCardsText, buildRounds, incomeSuffix, type EraActionEntry } from './eraLog';

/** 行动行文案:搜寻简化为"搜寻"(不再写"弃 3 张换 2 张百搭")。 */
function actionLineText(a: Action): string {
  return a.type === 'scout' ? '搜寻' : describeAction(a);
}

export function ActionLogModal({
  state,
  playedCards,
  eraActions,
  room,
  onClose,
  logStyle = 'split',
  seatsOrder,
}: {
  state: FilteredState;
  playedCards: Card[][];
  eraActions: EraActionEntry[][];
  room?: RoomState | undefined;
  onClose: () => void;
  /** 日志风格(偏好设置):split=上卡牌下日志(统一分隔线);grouped=按回合分组。 */
  logStyle?: 'split' | 'grouped' | undefined;
  /** 列顺序(初始顺位;缺省按座位号)。 */
  seatsOrder?: PlayerIndex[] | undefined;
}): ReactElement {
  const faceDown = state.era === 'canal' ? 1 : 0;
  const seats = seatsOrder ?? state.players.map((_, i) => i as PlayerIndex);

  /** 该座位本时代的打出卡面列(共用)。 */
  const cardsBlock = (i: PlayerIndex, cards: Card[]) => (
    <div className="discard-cards">
      {faceDown === 1 ? (
        <span className="discard-cell">
          <img className="discard-card discard-card-back" src="/assets/cards/back.png" alt="开局暗置" />
          <span className="discard-card-name">暗置</span>
          <span className="card-tip">开局暗置（不公开）</span>
        </span>
      ) : null}
      {cards.map((c) => (
        <span className="discard-cell" key={c.id}>
          <img className="discard-card" src={cardImageSrc(c)} alt={cardName(c)} />
          <span className="discard-card-name">{cardName(c)}</span>
          <span className="card-tip">{cardName(c)}</span>
        </span>
      ))}
    </div>
  );

  const historyBlock = (i: PlayerIndex) => {
    // 上下分隔:从第 1 轮展示到当前轮(正序)
    const rounds = buildRounds(state, eraActions[i] ?? [], false);
    if (rounds.length === 0) return <p className="era-actions-empty">本时代尚未行动</p>;
    return rounds.map((r) => (
      <div key={r.round} className="compact-history-round">
        <span className="compact-history-label">
          第 {r.round} 轮{incomeSuffix(r.round, r.actions)}
        </span>
        {r.actions.filter((a) => a.note !== 'round-income').map((a, k) => (
          <span key={k} className="compact-history-act">
            {actionLineText(a.action)}
            {(
              <em className={`compact-round-delta ${a.moneyDelta >= 0 ? 'pos' : 'neg'}`}>
                {a.moneyDelta > 0 ? `+£${a.moneyDelta}` : a.moneyDelta < 0 ? `−£${-a.moneyDelta}` : '+£0'}
              </em>
            )}
            <em className="compact-history-card">{actionCardsText(a.action)}</em>
          </span>
        ))}
      </div>
    ));
  };

  /** 某一轮打出的卡(每个行动 1 张;搜寻弃 3 张,该轮合计可达 4 张)。 */
  const roundCards = (r: { round: number; actions: EraActionEntry[] }): Card[] =>
    r.actions
      .filter((a) => a.note !== 'round-income')
      .flatMap((a) =>
        a.action.type === 'scout'
          ? a.action.cardIds.map((id) => cardFromId(id))
          : [cardFromId(a.action.cardId)],
      );

  const colHead = (i: PlayerIndex, count: number) => (
    <div className="discard-col-head">
      <span className="color-dot" style={{ background: PLAYER_COLORS[i] }} />
      {playerName(room, i)}（{count}）
    </div>
  );

  return (
    <div className="modal-backdrop" data-testid="action-log-modal" onClick={onClose}>
      <section className="score-modal discard-modal action-log-modal" onClick={(e) => e.stopPropagation()}>
        <header className="score-modal-head">
          <h3>行动日志</h3>
          <button type="button" className="modal-close" data-testid="action-log-close" onClick={onClose}>
            ×
          </button>
        </header>
        {logStyle === 'split' ? (
          <>
            {/* 风格 A:上方按回合逐行展示当轮卡牌(每行一回合,搜寻 4 张一行;
                统一分隔线;下方按轮次正序展示日志) */}
            <div className="discard-columns action-log-columns">
              {seats.map((i) => {
                const rounds = buildRounds(state, eraActions[i] ?? [], false);
                const total = (eraActions[i] ?? []).reduce(
                  (s, a) => s + (a.note === 'round-income' ? 0 : a.action.type === 'scout' ? 3 : 1),
                  0,
                );
                return (
                  <div className="discard-col" key={i}>
                    {colHead(i, total + faceDown)}
                    {rounds.length === 0 ? (
                      <p className="era-actions-empty">本时代尚未行动</p>
                    ) : (
                      rounds.map((r) => (
                        <div key={r.round} className="action-log-group-cards action-log-round-row">
                          {r.round === 1 && faceDown === 1 ? (
                            <span className="discard-cell">
                              <img
                                className="discard-card discard-card-back"
                                src="/assets/cards/back.png"
                                alt="开局暗置"
                              />
                              <span className="card-tip">开局暗置（不公开）</span>
                            </span>
                          ) : null}
                          {roundCards(r).map((c) => (
                            <span className="discard-cell" key={c.id}>
                              <img className="discard-card" src={cardImageSrc(c)} alt={cardName(c)} />
                              <span className="discard-card-name">{cardName(c)}</span>
                              <span className="card-tip">{cardName(c)}</span>
                            </span>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                );
              })}
            </div>
            <hr className="action-log-divider" />
            <div className="discard-columns action-log-columns">
              {seats.map((i) => (
                <div className="discard-col" key={i}>
                  {/* 上下分隔模式:整窗统一滚轮,每列不再单独滚动 */}
                  <div className="action-log-history no-scroll">{historyBlock(i)}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          /* 风格 B:按回合分组——每组一行当轮卡牌 + 一/两行行动,玩家间对齐 */
          <div className="discard-columns action-log-columns">
            {seats.map((i) => {
              const rounds = buildRounds(state, eraActions[i] ?? []);
              return (
                <div className="discard-col" key={i}>
                  {colHead(i, (playedCards[i] ?? []).length + faceDown)}
                  {rounds.length === 0 ? (
                    <p className="era-actions-empty">本时代尚未行动</p>
                  ) : (
                    rounds.map((r) => {
                      const cards = roundCards(r);
                      return (
                        <div key={r.round} className="action-log-group">
                          <span className="action-log-group-label">
                            第 {r.round} 轮{incomeSuffix(r.round, r.actions)}
                          </span>
                          <div className="action-log-group-cards">
                            {r.round === 1 && faceDown === 1 ? (
                              <span className="discard-cell">
                                <img
                                  className="discard-card discard-card-back"
                                  src="/assets/cards/back.png"
                                  alt="开局暗置"
                                />
                                <span className="card-tip">开局暗置（不公开）</span>
                              </span>
                            ) : null}
                            {cards.map((c) => (
                              <span className="discard-cell" key={c.id}>
                                <img className="discard-card" src={cardImageSrc(c)} alt={cardName(c)} />
                                <span className="discard-card-name">{cardName(c)}</span>
                                <span className="card-tip">{cardName(c)}</span>
                              </span>
                            ))}
                          </div>
                          {r.actions.filter((a) => a.note !== 'round-income').map((a, k) => (
                            <span key={k} className="compact-history-act">
                              {actionLineText(a.action)}
                              {(
                                <em className={`compact-round-delta ${a.moneyDelta >= 0 ? 'pos' : 'neg'}`}>
                                  {a.moneyDelta > 0 ? `+£${a.moneyDelta}` : a.moneyDelta < 0 ? `−£${-a.moneyDelta}` : '+£0'}
                                </em>
                              )}
                            </span>
                          ))}
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
