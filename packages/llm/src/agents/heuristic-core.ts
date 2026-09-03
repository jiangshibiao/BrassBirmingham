/**
 * heuristic-core：jsb 系列启发式 AI 的共享核心（2026-09-02 重构）。
 *
 * 此前 jsb-v20260831/0901/0902 三个文件互为 2100+ 行的近似复制；重构后
 * 全部逻辑（CFG + 评分 + 2-ply 前瞻 + 局面估值叶）收敛到本文件，
 * 每个版本 = createHeuristicPlugin({ meta, overrides }) 的小文件
 * （overrides 即该版本相对 BASE_CFG 的"配置即差异"）。
 *
 * 设计约定（供新版本作者）：
 * - 共享"轮子"都在本文件：盘面解析/翻面概率/局面估值/2-ply 前瞻，
 *   权重全部经 CFG（含 overrides）传入——读者看版本文件即可知道
 *   该版改了哪些参数、引入了什么机制；
 * - 版本想引入共享决策之外的特殊处理时，import { buildAgent } 自行
 *   组合 decide（在共享决策前后加自己的逻辑），特殊代码留在版本文件里。
 *
 * 行为等价性由 bench/fingerprint.ts 逐局 VP 序列对比保证（重构前后
 * 4 个版本 × 8 局全部逐字节一致，见 bench/docs/2026-09-02-refactor.md）。
 */
import {
  BREWERY_BARRELS,
  COAL_MARKET_PRICES,
  IRON_MARKET_PRICES,
  LINK_EXTRA_ENDPOINTS,
  LINKS,
  LOCATIONS,
  MERCHANTS,
  applyAction,
  buildDeck,
  buyCoalCost,
  buyIronCost,
  canBuyCoalFromMarket,
  coalSources,
  enumerateActions,
  enumerateBuilds,
  incomeLevelAt,
  ironSources,
  merchantHasUsableBarrel,
  marketSellRevenue,
  playerNetwork,
  reachableFrom,
  stableStringify,
  type Action,
  type GameState,
  type IndustryType,
  type LocationId,
  type MerchantId,
  type NetworkNode,
  type PlacedTile,
  type PlayerIndex,
  type TileDef,
} from '@brass/engine';

import type { AgentPlugin } from './contract.js';

/** 版本差异的深度部分（每版本只需写与 BASE_CFG 不同的叶子）。 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K];
};

export interface HeuristicPluginOptions {
  meta: AgentPlugin['meta'];
  /** 深度合并到 BASE_CFG 的版本差异。 */
  overrides?: DeepPartial<Cfg>;
  /** 调参环境变量名（bench 消融注入用，生产不设；读 <var> 与 <var>_FLIP）。 */
  tuneEnvVar?: string;
}

const BASE_CFG = {
  value: {
    vp: 1.0,
    moneyBase: 0.12,
    incomeBase: 0.25,
    flex: 0.8,
    ownOverbuildVpLoss: 1.0,
    /** 运河时代 L2+ 板块双计分权重（0=关闭/1×；1=完整 2×）：
     * era.ts scoreFlippedIndustries 在 canalToRail 与 finalScore 各跑一遍，
     * 运河翻面的 L2+ 板块（时代末不移除）两时代各计一次 VP——只计 1× 会
     * 系统性低估运河 L2+ 翻面（高手 meta：L2+ 运河放置计两次是运河时代
     * 最重要目标）。×100/复测终验：1.0 档 69%+62% vs 0831，0.5 档仅 57%。 */
    canalDoubleScoreScale: 1.0,
    // unflippedVpShare / leafIncomeScale 属 MCTS 叶评估器，未移植。
  },
  era: {
    canalEarly: { incomeAdd: 1.8, incomeFrac: 0.6, moneyMult: 0.55, networkW: 0.1, alpha: 0.6, endgameRounds: 2.0 },
    canalLate: { incomeAdd: 1.8, incomeFrac: 0.6, moneyMult: 0.55, networkW: 0.1, alpha: 0.6, endgameRounds: 2.0 },
    railEarly: { incomeAdd: 1.2, incomeFrac: 0.5, moneyMult: 0.8, networkW: 1.0, alpha: 0.6, endgameRounds: 1.0 },
    railLate: { incomeAdd: 0.0, incomeFrac: 0.0, moneyMult: 5.0 / 3.0, networkW: 0.85, alpha: 0.35, endgameRounds: 1.0 },
  },
  discount: { floor: 0.3, span: 0.5 },
  flip: {
    floor: 0.05,
    cap: 0.9,
    sellout: 0.9,
    coalDemandCanal: 0.55,
    coalDemandRail: 0.85,
    ironDemandCanal: 0.4,
    ironDemandRail: 0.5,
    scarcityBonus: 0.35,
    islandCoalCanalBase: 0.12,
    islandCoalCanalHeatBonus: 0.18,
    islandCoalCanalCap: 0.4,
    islandCoalCanalPriceBase: 5.0,
    islandCoalCanalPriceSpan: 3.0,
    islandCoalRailBase: 0.6,
    islandCoalRailHeatBonus: 0.25,
    islandCoalRailCap: 0.9,
    islandCoalRailPriceBase: 4.0,
    islandCoalRailPriceSpan: 4.0,
    breweryCanalNoDemand: 0.25,
    brewerySurplus: 0.45,
    brewerySatisfied: 0.7,
    breweryRailDemandBuffer: 1.0,
    sellableBase: 0.12,
    sellableMerchantWithBeer: 0.6,
    sellableMerchantOnly: 0.1,
    sellableNoMerchant: -0.6,
    sellableOpenLink: 0.1,
    handEmptyPenalty: 10.0,
    handOneCardPenalty: 5.0,
    handFewCardsPenalty: 2.0,
    planNoMerchant: 0.15,
    planNoBeer: 0.3,
    planReady: 0.7,
    /** 商人需求稀缺折价强度（0=关闭）：全图该产业剩余商人需求格（含 any 格）
     * 是全场未来卖出次数的硬上限；当 需求格 < 全场未翻该产业板块数（含本块）
     * 时，翻面概率按比例衰减——多名玩家抢同一条商人需求 → 造了卖不掉。
     * S3 栈 ×100-200 终验有效：1.0。 */
    merchantScarcityWeight: 1.0,
    /** 按板块真实 beerToFlip 估啤酒可得性（0=上游语义恒 need=1；1=真实桶数）：
     * 制造 L5/陶 L3/L5 需 2 桶才能卖，need=1 高估其翻面概率（终局审计头号
     * 漏项：制造 L5 每局 ~1 块未翻）。S3 栈 ×100-200 终验有效。 */
    realBeerNeed: 1,
    /** 出售动数窗硬门（0=关闭；1=开启）：时代剩余动数（roundsRemaining×2，
     * 扣掉本建造动）已少于己方未翻可售板块数（含本块）时，新可售板块必砸
     * 手里 → flipProb 压到 floor。防末动建可售板块无卖动可跟的纯废动。 */
    sellActionWindow: 1,
    /** 2 桶板块的自有酒折扣（1=不变，默认待消融）：beerToFlip=2 的板块
     * （制造 L5/陶 L3/L5）在自有酒桶 <2 时 flipProb 乘本值——建造时点的
     * 连通酒估计（含商人酒/对手酒）到卖出时点常已被喝走，只有自有酒桶
     * 是可靠弹药（0903 审计：制造 L5 仍 0.76/局未翻的头号漏项）。 */
    ownBeer2Discount: 1.0,
    /** 可售板块自有酒门槛惩罚（0=关闭，默认待消融）：铁路时代建可售板块，
     * 若自有酒桶 < beerToFlip 且手上没有酒厂牌可造桶，视为大概率砸手里
     * （真人回放：AI 建 L5 制造厂仅 1 自有桶,翻面需 2,终局未翻=£16 纯亏）。 */
    railSellableNoOwnBeerPenalty: 0,
    /** 酒厂牌豁免的最高 beerToFlip（默认 1）：beerToFlip ≤ 本值时手上有酒厂牌
     * 即可豁免自有酒门槛（造 1 桶容易兑现）；beerToFlip ≥ 2 的板块
     * （制造 L5/陶 L3/L5）不再豁免——必须自有酒桶 ≥2，防止"带张酒厂牌就敢
     * 建 L5 却永远造不出第二桶"（0903 败局复盘：P0 带 1 桶+酒厂牌建 L5 未翻）。 */
    railSellableNoOwnBeerCardExemptMaxLevel: 1,
    /** 孤岛煤无法翻面时的惩罚系数（1=不变，默认待消融）：非连通商人位的
     * 孤岛煤且市场吃不下全部方块时 flipProb 乘本值——利克煤终局未翻的教训
     * （hint 1：小连通块里煤无法翻面，给一个很大的惩罚）。 */
    isolatedCoalUnflippableMult: 1.0,
    // ── 以下为插件新增（上游无）。C6 消融链 ×500 终验（2026-08-31，62.6% vs
    // 母体 36.2%）证明：收官窗/库存衰减复杂机制全是净负贡献，默认全部关闭；
    // 有效的只有 sell/network 里三个加量常数项。代码保留供后续调参。 ──
    /** 收官窗口基准动数：可售板块翻面期望打满所需的时代剩余动数（造完还需 sell 动）。
     * 0=整块关闭（默认关闭：×500 消融为净负）。 */
    sellWindowFull: 0,
    /** 窗口加权：每点需啤酒 / 每点 VP 面值 / 每 £1 造价 追加的窗口动数。 */
    sellWindowPerBeer: 1.0,
    sellWindowPerVp: 0.3,
    sellWindowPerCost: 0.1,
    /** 库存队列衰减底数：按己方未翻面可售板块的 VP 面值（/sellQueueVpNorm）加权。
     * 1=无衰减（默认：×500 消融为净负）。 */
    sellQueueDecay: 1.0,
    /** 队列衰减的 VP 归一（衰减指数 = 库存 VP 总和 / 本值）。 */
    sellQueueVpNorm: 8.0,
    /** 队列衰减的时代门控(0=关闭,全时代生效;0.6=时代进度>60%才生效——
     * 中期库存是正常产能,末段才该惩罚)。 */
    sellQueueEraGate: 0,
    /** 资源板(煤/铁)收官窗口动数（0=关闭,默认；翻面靠全场消耗,窗口要求比可售板更宽）。 */
    resourceWindowFull: 0,
    /** 酒厂收官窗口动数（0=关闭,默认；翻面靠全场喝酒,末轮建=桶必剩）。
     * 关闭后"首桶豁免"逻辑随之失效（hint 3 的酒桶留存由 railCertaintyBonus 等
     * 间接覆盖）。 */
    breweryWindowFull: 0,
  },
  build: {
    unaffordablePerPound: 0.3,
    linkSelfValueShare: 0.5,
    selfSufficiencyPerCube: 0.15,
    ironScarcityShare: 0.6,
    marketCashBackShare: 0.4,
    marketSelloutBonus: 1.5,
    coalSpikePriceBase: 5.0,
    coalSpikePriceSpan: 3.0,
    coalSpikePerSold: 1.9,
    coalSpikeCanalMult: 1.25,
    scarcityValuePerUnit: 0.6,
    leftoverPerCube: 0.5,
    islandCoalCanalPenalty: -0.5,
    islandCoalRailBase: 1.2,
    islandCoalRailPerCube: 0.25,
    islandIronValue: 1.2,
    expansionPerLink: 0.1,
    railCoalShortage: 3.0,
    railCoalShortagePerLevel: 0.2,
    railCoalShortageCubesBase: 0.7,
    railCoalShortagePerCube: 0.15,
    costEfficiencyCap: 2.0,
    merchantReachableBonus: 0.6,
    beerAvailableBonus: 0.8,
    beerMissingPenalty: -0.3,
    brewerySurplusPenaltyPerBarrel: 0.6,
    brewerySellSupportWithDemand: 0.8,
    brewerySellSupportBase: 0.4,
    railBreweryValue: 2.0,
    freeRidingThreshold: 0.5,
    freeRidingBonus: 0.8,
    planBonus: 0.5,
    /** 流派跳级罚(0=关闭,默认：×500 消融为净负):plan 产业场上已有板块时,
     * 再建其 L1/L2 低级板的罚分。 */
    planSkipLowPenalty: 0,
    /** 触发流派跳级罚的最高板块等级(含)。 */
    planSkipLowMaxLevel: 2,
    /** 改建对手煤/铁厂的拆除定价系数(0=关闭,默认：×500 消融为净负)。 */
    opponentOverbuildDeny: 0,
    /** 改建目标是当前 VP 领先者时的追加狙击奖。 */
    opponentOverbuildLeaderBonus: 0,
    railLateBeerBonus: 1.2,
    /** 棉花流冲刺奖（2026-09-03 用户 hint，0=关闭）：铁路时代建 L3+ 棉且
     * 自有酒桶时的方向性加值（铁路再冲 3-4 张 L3/L4 棉，配自酒卖）。 */
    cottonRushBonus: 0,
    /** 运河后期 L1 建造惩罚（0=关闭，默认待消融）：运河进度 <35% 时建 L1
     * 板块的风险扣分——L1 未翻在运河末被移除=纯亏（审计：全场每局 ~0.6 块
     * L1 建了没翻，含棉 L1/煤 L1/制造 L1）。 */
    canalLateL1Penalty: 0,
    /** 铁路中后期造煤惩罚（0=关闭，默认待消融）：铁路进度 <本门限时，
     * 煤矿建造的风险扣分——真人回放显示 AI 铁路时代场均 4-5 座煤（真人 ~1），
     * 同期连接普遍 4-8 VP 而煤仅 2-4 VP，无脑造煤是明确的负优化。 */
    railCoalLatePenalty: 0,
    /** 造煤惩罚的铁路进度门限（eraFrac 低于此值 = 中后期）。 */
    railCoalLateGate: 0.5,
    /** 运河末首桶留存奖（0=关闭，默认待消融）：运河收官时若场上还没有自己的
     * 未翻酒厂，建酒厂的额外奖励——铁路开局双轨（£15+2煤+1啤酒）的弹药，
     * 运河末留 1 桶比多翻一个低级酒厂值钱（hint 4 前半）。 */
    canalEndBeerReserveBonus: 0,
    /** 近商城市 L2 建造奖（0=关闭，默认待消融）：运河后期在近商城市
     * （德比/伯明翰/科尔布鲁克代尔/斯托克）建 L2+ 板块的额外奖励——
     * 这些城市离贸易商近，铁路时代从它们开始连接抢分（hint 4 后半推论）。 */
    canalEndL2NearMerchantBonus: 0,
    /** 德比 L2 建造奖（0=关闭，默认待消融）：德比周围路分稳定最高，
     * 运河后期在德比建 L2+ 板块的额外奖励（hint 4 补充：德比稳定很高）。 */
    canalEndL2DerbyBonus: 0,
    /** 近商城市（非德比）按贸易商可收产业种类的每类奖励（0=关闭，默认待消融）：
     * 伯明翰/科尔布鲁克代尔/斯托克的权重与附近贸易商能卖的种类挂钩——
     * 卖的种类越多，这附近未来的建筑越多，权重相应提升（hint 4 补充）。 */
    canalEndL2NearMerchantPerDiversity: 0,
    /** 酒厂售卖支持奖（0=关闭，默认待消融）：铁路时代若场上有未翻可售板块
     * 且自有酒桶不足，建酒厂的额外奖励——"造酒厂桶给卖货供弹"的组合
     * （hint 3 后半：每次造出酒桶会给 2 个桶，造两个建筑再一起造酒桶+卖出）。 */
    railBrewerySellSupportBonus: 0,
    /** 同城已有己方 Link 数 × 本值（0=关闭，默认待消融）：在一个城市连了好
     * 几条路后，在此城造建筑的额外连通度分（hint 2 后半：更应倾向于在
     * 高连通城市建造——连通度分吃得多）。 */
    cityLinkBonus: 0,
    /** 铁路时代高价值可售板块建造奖（0=关闭，默认待消融）：L3+ 棉/陶/制造
     * 的额外奖励——真人回放显示人类靠高价值可售板块批量卖出（棉 L3/L4、
     * 陶 L1，单次 10-21 VP）拉开分差，AI 则偏向可靠翻面的低价值煤铁。 */
    railHighLevelSellableBonus: 0,
  },
  network: {
    accessPerLocationCard: 0.6,
    accessPerIndustryCard: 0.1,
    merchantBonus: 1.5,
    explorationBase: 1.6,
    explorationPerLink: 0.3,
    planBonus: 0.5,
    beerLockBonus: 1.2,
    doubleTempoRailEarly: 1.2,
    doubleTempoOther: 0.6,
    doubleFarmLockBonus: 0.8,
    doubleSurchargeWeight: 1.0,
    /** 铁路 Link 每当前图标的确定性溢价（时代末必得分,对抗建筑翻面不确定性）。
     * C6 ×500 终验有效项：0.7（hint 2：铁路低值建筑不如修高分路）。 */
    railCertaintyBonus: 0.7,
    /** 对手翻面分享惩罚（0=关闭，默认待消融）：我铺的连接让对手在该城的
     * 未翻板块得以卖出翻面时，按对手未翻 VP 面值 × 本值从我的 Link 分中
     * 扣减——基础设施白送对手翻面是隐性亏损（对手建模第一项）。 */
    opponentFlipSharePenalty: 0,
  },
  develop: {
    railEraTile: 0.35,
    canalEraTile: 0.12,
    perLevel: 0.18,
    railUnlockBonus: 0.25,
    breweryLv1Bonus: 0.55,
    ironPriceVeryCheapBonus: 3.0,
    ironPriceCheapBonus: 2.0,
    ironPriceMarginalBonus: 0.5,
    ironPriceExpensivePenalty: -1.5,
    canalBonus: 0.15,
    planBonus: 0.3,
    buildableCardBonus: 0.3,
    ironScarcityCost: 0.6,
    secondTargetScale: 0.4,
    canalScale: 2.0,
    canalSingleTargetPenalty: 2.0,
    canalDoubleTargetBonus: 0.5,
    canalCountLimit: 4.0,
    railCountLimit: 1.0,
    overLimitSteepness: 2.0,
    /** 研发方向引导（2026-09-03 用户复盘 hint，0=关闭）：各产业各级研发的方向性
     * 加值（仅运河时代）——棉花流研发 L1×2+L2×2 冲 L3；酒厂 L1 必研发；
     * 陶瓷 L2 冲 L3；制造 L3/L4 适合研发（L5 反而配合 Link 吃分）。 */
    dirCottonL1: 0,
    dirCottonL2: 0,
    dirBreweryL1: 0,
    dirPotteryL2: 0,
    dirManuL34: 0,
    /** 解锁板块实际价值系数（0=关闭）：研发解锁出 L3+ 可售板块且该产业可售时，
     * 按其 VP 面值 × 本系数追加——棉花流冲 L3/陶瓷冲 L3/制造冲 L5 的精确引导，
     * 只对真实解锁出的高价值板块生效（避免无差别灌水）。 */
    unlockSellableVpScale: 0,
    /** 解锁板块真实建造分系数（0=关闭，默认待消融）：研发目标加值 =
     * 解锁出的板块的 scoreBuildOp（含 flipProb/商人/啤酒校验）× 本系数——
     * 研发只在"解锁出的板块确实值得建"时升值（棉花冲 L3 的精确版：
     * 不是无脑灌研发，而是解锁 L3 且 L3 真能建能卖时才推）。 */
    unlockBuildValueScale: 0,
  },
  sell: {
    developBonusValue: 0.5,
    // tileIncomeShare 在上游仅用于售卖目标排序（本插件对 engine 枚举的
    // 组合评分，用不到），urgency/baseline/stream/vpScale 如下。
    urgencyBonus: 3.0,
    /** 运河末 L1 可售板块清仓奖励/块（未翻将被移除,纯亏;hint:运河末没翻面=亏）。
     * C6 ×500 终验有效项：3.0。 */
    canalEndL1Bonus: 3.0,
    railLateBaselineBonus: 1.2,
    /** 铁路末段每点待售 VP 面值的兑现奖(hint 1:终局高价值未翻=纯亏,
     * 末段"卖掉贵的"优于"再建新的"——0=关闭)。C6 ×500 终验有效项：0.3。 */
    railLateVpScale: 0.3,
    incomeStreamShare: 0.5,
    /** 出售 VP 折现地板：运河早期出售的 VP 折算下限。0.1→0.25 抬高运河
     * 出售吸引力 → 运河翻面变多、双计分利用率上升（内战均分唯一提升项，
     * ×100 终验 109.4→110.2；vs 0831 63%/vs 0829 77% 复核不劣）。 */
    vpScaleFloor: 0.25,
    vpScaleSpan: 0.5,
    /** 批量出售奖/块（0=关闭）：一次卖 N 块只花 1 动，高手 meta 是攒 2-3 块
     * 一次卖（动作≈5 VP 机会成本）。S3 栈 ×100-200 终验有效：1.5（3.0 过调）。 */
    batchBonus: 1.5,
    /** 库存积压紧迫奖/块（0=关闭，默认待消融）：己方每块未翻可售板块
     * 给出售行动加战略分——动作才是瓶颈、翻面才是兑现（审计：全场每局
     * ~17 VP 面值造了卖不掉，主因是卖动在行动竞争中输给建动）。 */
    inventoryUrgency: 0,
    /** 用掉商人最后一桶的狙击奖（0=关闭，默认待消融）：卖出时若用掉某商人
     * 最后一桶且对手有该商人可收的未翻板块，按对手未翻 VP 面值 × 本值
     * 奖励——让对手 12-20 VP 的卖出流产（对手建模第二项，高手常规武器）。 */
    denyLastBarrelBonus: 0,
  },
  loan: {
    amount: 30,
    incomePenalty: 3,
    comboCashThreshold: 24.0,
    comboMinRoundsLeft: 1.5,
    comboScale: 0.7,
    idleCashThreshold: 18.0,
    idleBonus: 2.0,
    floorDeepDebtIncome: -7,
    floorDeepDebtPenalty: 7.0,
    floorDebtIncome: -4,
    floorDebtPenalty: 2.0,
    floorBreakevenIncome: 0,
    floorBreakevenPenalty: 0.3,
    richHeavyCash: 55.0,
    richHeavyPenalty: 5.0,
    richModerateCash: 42.0,
    richModeratePenalty: 2.4,
    richLightCash: 30.0,
    richLightPenalty: 1.0,
    unlockMinAfterScore: 0.8,
    unlockBonus: 3.2,
    // startupMaxRound: 2 / canalLateMinRound: 6 是"时代内轮数"，本引擎
    // round 跨时代累计，改用时代进度近似（见 scoreLoan 注释）。
    startupMaxProgress: 0.25,
    startupLowCashThreshold: 18.0,
    startupLowCashBonus: 6.0,
    startupBonus: 0.5,
    canalLateMinProgress: 0.625,
    canalLateCashThreshold: 30.0,
    canalLateLowCashBonus: 2.8,
    canalLateBonus: 1.8,
  },
  scout: {
    lowKeep: 1.0,
    highKeep: 1.8,
    desiredHighValue: 2,
    maxRefresh: 5.0,
    deadDiscardValue: 0.96,
    aliveDiscardPenalty: 0.48,
    passFallbackScore: -0.5,
  },
  cards: {
    locationBase: 1.15,
    industryBase: 1.0,
    wildBase: 3.8,
    duplicatePenalty: 0.48,
    wildDuplicateBonus: 0.35,
    cityFullResourceUpgradePenalty: 0.45,
    cityFullUselessPenalty: 1.05,
    cityTargetBonus: 0.28,
    cityTargetCap: 3,
    industryTargetBonus: 0.22,
    industryTargetCap: 3,
    industryNoTargetPenalty: 0.65,
    canalIndustryDuplicatePenalty: 0.22,
  },
  lookahead: {
    /** 首动候选宽度（每类 Top-K 进 2-ply 前瞻）：3→5 让更多的第一步动作进入完整前瞻评估，
     * 经测试，这是唯一能提升决策质量的调整（×100：+1.9 VP）；K=8/全宽反而更差。
     * 注意：secondActionK 只取 topPerType(...)[0] 全局最优，K 值实际无效。 */
    firstActionK: 5,
    secondActionK: 2,
    lowMoneyThreshold: 15,
    endTurnPenaltyScale: 6.5,
    endTurnIncomeExempt: 2.5,
    endTurnNegativeIncomeWeight: 1.4,
    endTurnIncomeWeight: 0.9,
    endTurnRailEraTerm: 1.0,
    endTurnCanalEraTerm: 0.8,
    endTurnRunwayBase: 0.6,
    endTurnRunwaySpan: 0.4,
    /** 对手回应（MaxN）扣减权重（0=关闭，默认待消融）：我方回合结束后，
     * 下一位对手贪心最佳行动的分数从己方价值中扣减（4 人非零和各自最大化）。 */
    opponentResponseWeight: 0,
    /** 推演复核局数（0=关闭，默认待消融）：对价值前 rolloutTopK 名候选各跑
     * K 局随机推演到终局，均分显著更优者改选（最后一块结构拼图：
     * 用模拟代替静态估值裁决顶部候选）。 */
    rolloutK: 0,
    /** 推演复核的候选数（取价值前 N 名）。 */
    rolloutTopK: 2,
    /** 改选所需的最小均分优势（防噪声误判）。 */
    rolloutMargin: 3.0,
    /** 仅当两个候选的价值差小于该阈值时，才触发推演（将模拟次数只用于候选价值接近的情况，
     * 它们才是真正的难决策；差距明显的交给启发式）。 */
    rolloutDeltaThreshold: 2.0,
    /** 仅对前 K 个首动候选评估对手回应（成本 ≈ 每候选一次全量打分）。 */
    opponentResponseK: 2,
    /** 四连动（yo-yo）前瞻权重（0=关闭，默认待消融）：本轮我是最后行动者
     * 且本回合结束后锁定下轮先手（spent 最低）时，追加评估下轮最佳两动——
     * 末位少花 → 首位连动 4 次，高手常规武器（顺位规则：spent 升序稳定重排）。 */
    fourActionWeight: 0,
    /** 下轮第二动计入比例（0=只评下轮首动）：完整的四连动 = 本轮 2 动 +
     * 下轮 2 动，第二动按本系数折算（<1 体现深度不确定性）。 */
    fourActionSecondShare: 0,
  },
  /** 局面估值叶（上游 MCTS 叶评估器 evaluate_position 移植）：2-ply 前瞻的
   * 叶子从"只看现金惩罚"升级为完整局面评估，等效延展决策视野。
   * 定案 weight=0.5（n=200 复测 71.5% vs 0901；0.7/1.0/2.0 均更差，
   * 2.0 时行动分被稀释至 47%）。 */
  leaf: {
    /** 叶评估总权重（0=关闭）。 */
    weight: 0.5,
    /** 未翻面板 VP 折算份额（上游 unflipped_vp_share）。 */
    unflippedVpShare: 0.25,
    /** 收入折算放大（上游 leaf_income_scale：收入是持续现金流）。 */
    incomeScale: 3.0,
    /** Link 当前图标分折算（乘时代 networkW 之外再乘本值）。 */
    linkShare: 1.0,
    /** 现金折算（乘时代 moneyW 之外再乘本值）。 */
    moneyShare: 1.0,
    /** 手牌灵活性：每百搭/每张手牌的折算（CFG.value.flex 之外再乘本值）。 */
    flexShare: 0.3,
    flexPerWild: 3.0,
    flexPerCard: 0.5,
    /** 次动也用局面叶甄选的权重（0=关闭，默认待消融）：次动候选按
     * "行动分 + weight×本值×行动后局面"重排，次动决策同样获得局势评判。 */
    secondActionEval: 0,
    /** 未翻面板按真实 flipProb 折算（0=固定 share 粗估；1=精确概率，
     * 默认待消融）——叶评估与建造评分共享同一翻面模型，叶值逼近短程模拟。 */
    realFlipProb: 0,
  },
  guardrails: {
    banBuildLv1Brewery: true,
    banDevelopIronLv2Plus: true,
    banDevelopBreweryLv2Canal: true,
    developBreweryPenaltyBase: 1.8,
    developBreweryPenaltyPerLevel: 0.2,
    developCoalPenaltyBase: 1.5,
    developCoalPenaltyPerLevel: 0.2,
  },
};

type Cfg = typeof BASE_CFG;

type AnyObj = Record<string, unknown>;

/** base 深拷贝 + over 递归覆盖（CFG 为纯数据，JSON 克隆即可）。 */
function deepMerge(base: AnyObj, over: AnyObj): AnyObj {
  const out = JSON.parse(JSON.stringify(base)) as AnyObj;
  const merge = (dst: AnyObj, src: AnyObj): void => {
    for (const [k, v] of Object.entries(src)) {
      const d = dst[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && d && typeof d === 'object' && !Array.isArray(d)) {
        merge(d as AnyObj, v as AnyObj);
      } else {
        dst[k] = v;
      }
    }
  };
  merge(out, over);
  return out;
}

/**
 * 以一份冻结的 CFG 构建一个独立 agent 实例（全部评分函数闭包于 CFG）。
 * 开放给版本文件做自定义组合：某版本想在共享决策之上加自己的特殊处理
 * （额外打分项、决策前/后加工）时，直接 import 本函数包一层 decide 即可，
 * 不必复制核心逻辑（见 createHeuristicPlugin 的用法）。
 */
export function buildAgent(CFG: Cfg, meta: AgentPlugin['meta']): { decide: (args: { state: GameState; seat: PlayerIndex; legal: Action[] }) => Action } {

/** 一时代轮数（context.rs ERA_ROUNDS，仅用于把"时代剩余"归一到 0..1）。 */
const ERA_ROUNDS = 8.0;

const MERCHANT_IDS = Object.keys(MERCHANTS) as MerchantId[];

/** 近商城市（hint 4：德比/伯明翰/科尔布鲁克代尔/斯托克——离贸易商近，
 * 铁路时代从它们开始连接抢分，运河时代在上面留 L2 建筑的需求应调高）。 */
const NEAR_MERCHANT_CITIES: ReadonlySet<string> = new Set([
  'derby',
  'birmingham',
  'coalbrookdale',
  'stoke-on-trent',
]);

function isMerchantNode(x: string): x is MerchantId {
  return Object.prototype.hasOwnProperty.call(MERCHANTS, x);
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------------------
// plan.rs — 四相位 + 生产计划（流派）
// ---------------------------------------------------------------------------

type Phase = 'canal-early' | 'canal-late' | 'rail-early' | 'rail-late';

/** 本时代剩余卡牌（牌堆 + 全部手牌）：本引擎时代进度的唯一可靠来源。 */
function cardsRemaining(state: GameState): number {
  return state.deck.length + state.players.reduce((s, p) => s + p.hand.length, 0);
}

/** 时代开始时的卡牌总量（wild 不进牌堆；弃牌堆底 = playerCount 张不在循环内）。 */
function eraCardsTotal(state: GameState): number {
  return buildDeck(state.playerCount).length - state.playerCount;
}

/** 时代进度 0..1（已消耗卡牌比例）。 */
function eraProgress(state: GameState): number {
  const total = eraCardsTotal(state);
  if (total <= 0) return 1;
  return clamp01(1 - cardsRemaining(state) / total);
}

/** 估算本时代剩余轮数（每轮每玩家消耗 2 张；运河首轮 1 张的误差可忽略）。 */
function roundsRemaining(state: GameState): number {
  return cardsRemaining(state) / (2 * state.playerCount);
}

/** 上游按"时代内 round <= 4"分早晚；本引擎 round 跨时代累计，改用时代进度。 */
function eraPhase(state: GameState): Phase {
  const early = eraProgress(state) <= 0.45;
  return state.era === 'canal'
    ? early
      ? 'canal-early'
      : 'canal-late'
    : early
      ? 'rail-early'
      : 'rail-late';
}

interface Plan {
  industry: IndustryType;
  count: number;
  beerNeeded: number;
}

const SELLABLE: IndustryType[] = ['cotton', 'manufacturer', 'pottery'];
const CITY_IDS = Object.entries(LOCATIONS)
  .filter(([, def]) => def.region !== 'farm')
  .map(([id]) => id);

/** 版图上各产业的空槽图标数（仅城市）。 */
function vacantBoardSlots(state: GameState): Map<IndustryType, number> {
  const counts = new Map<IndustryType, number>();
  for (const loc of CITY_IDS) {
    const def = LOCATIONS[loc]!;
    const slots = state.board.slots[loc]!;
    for (let i = 0; i < def.slots.length; i++) {
      if (slots[i] !== null && slots[i] !== undefined) continue;
      for (const ind of def.slots[i]!.industries) {
        counts.set(ind, (counts.get(ind) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** 手牌对某产业的建造支持度（0..3）。 */
function handSupport(state: GameState, pid: PlayerIndex, ind: IndustryType): number {
  let support = 0;
  for (const card of state.players[pid]!.hand) {
    if (card.kind === 'location') {
      const def = LOCATIONS[card.location];
      if (!def || def.region === 'farm') continue;
      const slots = state.board.slots[card.location]!;
      const ok = def.slots.some(
        (s, i) =>
          s.industries.includes(ind) && (slots[i] === null || slots[i] === undefined),
      );
      if (ok) support += 1;
    } else if (card.kind === 'industry') {
      if (card.industries.includes(ind)) support += 1;
    } else if (card.kind === 'wild-industry') {
      support += 1;
    }
  }
  return Math.min(3, support);
}

/** 玩家面板栈顶板块（next_tile）。 */
function nextTile(state: GameState, pid: PlayerIndex, ind: IndustryType): TileDef | undefined {
  return state.players[pid]!.tiles.find((t) => t.industry === ind);
}

/** 面板栈内第 off 块（tile_after）。 */
function tileAfter(state: GameState, pid: PlayerIndex, ind: IndustryType, off: number): TileDef | undefined {
  let i = 0;
  for (const t of state.players[pid]!.tiles) {
    if (t.industry !== ind) continue;
    if (i === off) return t;
    i += 1;
  }
  return undefined;
}

/** 计算生产计划：版面容量 × 剩余板块 × 手牌支持 × 售卖概率 × 啤酒保障。 */
function computePlan(state: GameState, ctx: EvalCtx): Plan {
  const slots = vacantBoardSlots(state);
  const fallback: Plan = { industry: 'cotton', count: 0, beerNeeded: 0 };
  let best = fallback;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const ind of SELLABLE) {
    const stack = state.players[ctx.pid]!.tiles.filter((t) => t.industry === ind);
    const remaining = stack.length;
    const avail = slots.get(ind) ?? 0;
    if (remaining === 0 || avail === 0) continue;
    const count = Math.min(remaining, avail);
    let vpSum = 0;
    let beers = 0;
    for (const t of stack.slice(0, count)) {
      vpSum += t.vp;
      beers += t.beerToFlip;
    }
    const avgVp = vpSum / count;
    const ownBeer = ownedBeerBarrels(state, ctx.pid);
    const beerFactor =
      ownBeer >= beers ? 1.0 : Math.min(1, 0.4 + 0.6 * (ownBeer / Math.max(1, beers)));
    const handFactor = 0.5 + 0.25 * handSupport(state, ctx.pid, ind);
    const score =
      count * avgVp * planFlipProbability(state, ctx, ind) * beerFactor * handFactor;
    if (score > bestScore) {
      bestScore = score;
      best = { industry: ind, count, beerNeeded: beers };
    }
  }
  return bestScore === Number.NEGATIVE_INFINITY ? fallback : best;
}

// ---------------------------------------------------------------------------
// context.rs — EvalContext（相位权重 + 货币折算 + 时代谓词）
// ---------------------------------------------------------------------------

interface EraProfile {
  phase: Phase;
  incomeW: number;
  moneyW: number;
  networkW: number;
  alpha: number;
  endgameRounds: number;
}

interface EvalCtx {
  pid: PlayerIndex;
  phase: Phase;
  profile: EraProfile;
  roundsRemaining: number;
  eraFrac: number;
  plan: Plan;
  targets: BuildTargetRef[];
  /** 手牌按下标的保留价值（低 = 适合弃）。 */
  cardKeep: number[];
  cardKeepById: Map<string, number>;
}

function eraProfileOf(phase: Phase, eraFrac: number): EraProfile {
  const p =
    phase === 'canal-early'
      ? CFG.era.canalEarly
      : phase === 'canal-late'
        ? CFG.era.canalLate
        : phase === 'rail-early'
          ? CFG.era.railEarly
          : CFG.era.railLate;
  return {
    phase,
    incomeW: CFG.value.incomeBase * (p.incomeAdd + p.incomeFrac * eraFrac),
    moneyW: CFG.value.moneyBase * p.moneyMult,
    networkW: p.networkW,
    alpha: p.alpha,
    endgameRounds: p.endgameRounds,
  };
}

const isCanalPhase = (phase: Phase): boolean =>
  phase === 'canal-early' || phase === 'canal-late';

/** 未来收益折现（future_discount）：时代剩得越多，未来越值钱。 */
function futureDiscount(ctx: EvalCtx): number {
  return CFG.discount.floor + CFG.discount.span * ctx.eraFrac;
}

function isEraEndgame(ctx: EvalCtx): boolean {
  return ctx.roundsRemaining <= ctx.profile.endgameRounds;
}

/** 缓存键里不含 develops（实例追踪、随仿真变化），按 (state,pid) 记忆化。 */
const CTX_CACHE = new WeakMap<GameState, Map<PlayerIndex, EvalCtx>>();

function getCtx(state: GameState, pid: PlayerIndex): EvalCtx {
  let perPlayer = CTX_CACHE.get(state);
  if (!perPlayer) {
    perPlayer = new Map();
    CTX_CACHE.set(state, perPlayer);
  }
  const hit = perPlayer.get(pid);
  if (hit) return hit;

  const phase = eraPhase(state);
  const remain = roundsRemaining(state);
  const eraFrac = clamp01(remain / ERA_ROUNDS);
  const targets = buildTargetsOf(state, pid);
  const hand = state.players[pid]!.hand;
  const cardKeep = hand.map((_, i) => cardKeepScore(state, pid, i, targets));
  const ctx: EvalCtx = {
    pid,
    phase,
    profile: eraProfileOf(phase, eraFrac),
    roundsRemaining: remain,
    eraFrac,
    plan: { industry: 'cotton', count: 0, beerNeeded: 0 },
    targets,
    cardKeep,
    cardKeepById: new Map(hand.map((c, i) => [c.id, cardKeep[i]!])),
  };
  ctx.plan = computePlan(state, ctx);
  perPlayer.set(pid, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// value.rs — ScoreParts 评分货币 + 市场模型 + Link 图标估值
// ---------------------------------------------------------------------------

/** 一个行动的评分分解（经济含义分列；total 是唯一折算点）。 */
interface ScoreParts {
  vp: number;
  money: number;
  income: number;
  flex: number;
  strategic: number;
  risk: number;
}

function parts(init?: Partial<ScoreParts>): ScoreParts {
  return { vp: 0, money: 0, income: 0, flex: 0, strategic: 0, risk: 0, ...init };
}

function addParts(a: ScoreParts, b: ScoreParts): void {
  a.vp += b.vp;
  a.money += b.money;
  a.income += b.income;
  a.flex += b.flex;
  a.strategic += b.strategic;
  a.risk += b.risk;
}

/** ScoreParts::total —— 折算成可比较的 VP 等值。 */
function totalOf(ctx: EvalCtx, p: ScoreParts): number {
  return (
    p.vp * CFG.value.vp +
    p.money * ctx.profile.moneyW +
    p.income * ctx.profile.incomeW +
    p.flex * CFG.value.flex +
    p.strategic +
    p.risk
  );
}

interface MarketSale {
  cash: number;
  sold: number;
  total: number;
  flips: boolean;
}

/** 建成即卖市场仿真（与引擎 applyBuild 同一口径：从最贵空格填起）。 */
function simulateMarketSale(state: GameState, isCoal: boolean, cubes: number): MarketSale {
  const prices = isCoal ? COAL_MARKET_PRICES : IRON_MARKET_PRICES;
  const filled = isCoal ? state.coalMarket : state.ironMarket;
  const { revenue, sold } = marketSellRevenue(prices, filled, cubes);
  return { cash: revenue, sold, total: cubes, flips: sold === cubes && cubes > 0 };
}

/** 市场饥渴度：1 = 市场全空（饥饿），0 = 市场全满。 */
function marketScarcity(state: GameState, isCoal: boolean): number {
  const capacity = isCoal ? COAL_MARKET_PRICES.length : IRON_MARKET_PRICES.length;
  const filled = isCoal ? state.coalMarket : state.ironMarket;
  return clamp01((capacity - filled) / capacity);
}

/** 买价热度窗口 (price - base) / span，截到 0..1。 */
function priceHeat(price: number, base: number, span: number): number {
  return clamp01((price - base) / span);
}

/** 市场买 1 块煤的当前价格（市场空 → 兜底价 £8），上游 coal_price()。 */
function coalPrice(state: GameState): number {
  return buyCoalCost(state, 1);
}

/** 市场买 1 块铁的当前价格（市场空 → 兜底价 £6），上游 iron_price()。 */
function ironPrice(state: GameState): number {
  return buyIronCost(state, 1);
}

/** 节点当前 Link 图标分：商人位 2；城市/农场 = 已翻面板块 linkIcons 和。 */
function linkIconsAt(state: GameState, node: NetworkNode): number {
  if (isMerchantNode(node)) return 2;
  let v = 0;
  for (const t of state.board.slots[node] ?? []) {
    if (t && t.flipped) v += t.tile.linkIcons;
  }
  return v;
}

/** 空节点的未来 Link 图标潜力：农场未建 2；城市每空槽 1（可建酒厂 2）。 */
function futureLinkNodePotential(state: GameState, node: NetworkNode): number {
  if (isMerchantNode(node)) return 0;
  const def = LOCATIONS[node];
  if (!def) return 0;
  const slots = state.board.slots[node] ?? [];
  if (def.region === 'farm') return slots.every((t) => t === null) ? 2 : 0;
  let total = 0;
  for (let i = 0; i < def.slots.length; i++) {
    if (slots[i] !== null && slots[i] !== undefined) continue;
    total += def.slots[i]!.industries.includes('brewery') ? 2 : 1;
  }
  return total;
}

/** (current, future)：新 Link（含 via 农场端点）带来的 Link 图标分。 */
function linkCurrentAndPotentialVps(
  state: GameState,
  linkIndex: number,
): { current: number; future: number } {
  const l = LINKS[linkIndex]!;
  const endpoints: NetworkNode[] = [l.a, l.b, ...(LINK_EXTRA_ENDPOINTS[linkIndex] ?? [])];
  let current = 0;
  let future = 0;
  for (const e of endpoints) {
    current += linkIconsAt(state, e);
    future += futureLinkNodePotential(state, e);
  }
  return { current, future };
}

// ---------------------------------------------------------------------------
// board.rs — 共享盘面查询
// ---------------------------------------------------------------------------

/** 商人位是否收该产业（精确图标或万能）。 */
function merchantAccepts(state: GameState, id: MerchantId, ind: IndustryType): boolean {
  const m = state.merchants[id];
  return m.tiles.some((t) => t === 'any' || t === ind);
}

/** 商人位"收该产业的板块格"旁是否还有桶。 */
function merchantHasBeerFor(state: GameState, id: MerchantId, ind: IndustryType): boolean {
  return merchantHasUsableBarrel(state.merchants[id], ind);
}

/** loc 是否连通任一收该产业的商人位。 */
function merchantReachable(state: GameState, loc: LocationId, ind: IndustryType): boolean {
  const reach = reachableFrom(state, [loc]);
  return MERCHANT_IDS.some((id) => reach.has(id) && merchantAccepts(state, id, ind));
}

/** 全图收该产业的剩余商人需求格数（含 any 格）——未来全图卖出次数硬上限。 */
function merchantTilesLeftFor(state: GameState, ind: IndustryType): number {
  let n = 0;
  for (const id of MERCHANT_IDS) {
    for (const t of state.merchants[id].tiles) {
      if (t === 'any' || t === ind) n += 1;
    }
  }
  return n;
}

/** 全场（含对手）未翻面的该产业可售板块数——抢同一条商人需求的竞争者。 */
function unflippedSellableCount(state: GameState, ind: IndustryType): number {
  let n = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && !t.flipped && t.tile.sellable && t.tile.industry === ind) n += 1;
    }
  }
  return n;
}

/** loc 是否连通任一"有桶（不限产业）"的商人位。 */
function beerBarrelReachable(state: GameState, loc: LocationId): boolean {
  const reach = reachableFrom(state, [loc]);
  return MERCHANT_IDS.some((id) => {
    if (!reach.has(id)) return false;
    const m = state.merchants[id];
    return m.barrels.some((b, i) => b && m.tiles[i] !== 'blank');
  });
}

/**
 * loc 处可用的啤酒桶数量估计：自己未翻面酒厂（全图）+ 连通的对手酒厂 +
 * 连通的商人桶（任意产业格，估计用）。
 */
function countBeerSources(state: GameState, at: LocationId, pid: PlayerIndex): number {
  const reach = reachableFrom(state, [at]);
  let n = 0;
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (const t of slots) {
      if (!t || t.flipped || t.tile.industry !== 'brewery' || t.resources <= 0) continue;
      if (t.player === pid || reach.has(loc)) n += t.resources;
    }
  }
  for (const id of MERCHANT_IDS) {
    if (!reach.has(id)) continue;
    const m = state.merchants[id];
    n += m.barrels.filter((b, i) => b && m.tiles[i] !== 'blank').length;
  }
  return n;
}

/** 是否有足够啤酒支撑 need 桶的售卖。 */
function beerAvailable(state: GameState, loc: LocationId, pid: PlayerIndex, need: number): boolean {
  return countBeerSources(state, loc, pid) >= need || beerBarrelReachable(state, loc);
}

/** 自己未翻面酒厂（含农场）上的啤酒桶总数。 */
function ownedBeerBarrels(state: GameState, pid: PlayerIndex): number {
  let n = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.player === pid && t.tile.industry === 'brewery' && !t.flipped) {
        n += t.resources;
      }
    }
  }
  return n;
}

/** 场上己方未翻面酒厂数量（hint 3：留 1 桶进铁路开局双修抢分的"在场"证据）。 */
function ownUnflippedBreweryCount(state: GameState, pid: PlayerIndex): number {
  let n = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.player === pid && t.tile.industry === 'brewery' && !t.flipped) n += 1;
    }
  }
  return n;
}

/** 手上是否有可造酒厂的牌（酒厂产业牌或百搭产业牌）。 */
function hasBreweryCardInHand(state: GameState, pid: PlayerIndex): boolean {
  return state.players[pid]!.hand.some(
    (c) => (c.kind === 'industry' && c.industries.includes('brewery')) || c.kind === 'wild-industry',
  );
}

/** 该城市附近（连通可达）贸易商可收的产业种类数（棉/制造/陶；'any' 按 3 种计）。 */
function merchantDiversityFor(state: GameState, loc: LocationId): number {
  const reach = reachableFrom(state, [loc]);
  const kinds = new Set<IndustryType>();
  for (const id of MERCHANT_IDS) {
    if (!reach.has(id)) continue;
    for (const t of state.merchants[id].tiles) {
      if (t === 'blank') continue;
      if (t === 'any') {
        kinds.add('cotton');
        kinds.add('manufacturer');
        kinds.add('pottery');
      } else {
        kinds.add(t);
      }
    }
  }
  return kinds.size;
}

/** 场上己方某产业的板块数（已建出的流派"在场"证据）。 */
function countOwnTilesOnBoard(state: GameState, pid: PlayerIndex, ind: IndustryType): number {
  let n = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.player === pid && t.tile.industry === ind) n += 1;
    }
  }
  return n;
}

/** 场上己方未翻面可售板块的 VP 面值总和（排队等收官资源的"库存"）。 */
function ownUnflippedSellableVp(state: GameState, pid: PlayerIndex): number {
  let n = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.player === pid && !t.flipped && t.tile.sellable) n += t.tile.vp;
    }
  }
  return n;
}

/** 某城市对手（非 pid）未翻面板块的 VP 面值总和（基础设施白送对手翻面的隐性亏损口径）。 */
function opponentsUnflippedVpAt(state: GameState, pid: PlayerIndex, loc: NetworkNode): number {
  if (isMerchantNode(loc)) return 0;
  let n = 0;
  for (const t of state.board.slots[loc] ?? []) {
    if (t && t.player !== pid && !t.flipped) n += t.tile.vp;
  }
  return n;
}

/** 对手（非 pid）未翻可售板块中某商人可收的 VP 面值总和（狙击该商人最后一桶的价值口径）。 */
function opponentsUnflippedSellableVpFor(state: GameState, pid: PlayerIndex, merchant: MerchantId): number {
  let n = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.player !== pid && !t.flipped && t.tile.sellable && merchantAccepts(state, merchant, t.tile.industry)) {
        n += t.tile.vp;
      }
    }
  }
  return n;
}

/** 己方未翻面可售板块数（出售动数窗的"库存"口径）。 */
function ownUnflippedSellableCount(state: GameState, pid: PlayerIndex): number {
  let n = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.player === pid && !t.flipped && t.tile.sellable) n += 1;
    }
  }
  return n;
}

/** 自己全部未翻面可售板块翻面所需啤酒总量。 */
function sellableBeerDemand(state: GameState, pid: PlayerIndex): number {
  let n = 0;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && t.player === pid && !t.flipped && t.tile.sellable) {
        n += t.tile.beerToFlip;
      }
    }
  }
  return n;
}

/** loc 相邻（a/b 端点）未建的本时代连接数。 */
function unbuiltNeighborConnections(state: GameState, loc: LocationId): number {
  let n = 0;
  for (let i = 0; i < LINKS.length; i++) {
    const l = LINKS[i]!;
    if (state.era === 'canal' ? !l.canal : !l.rail) continue;
    if (l.a !== loc && l.b !== loc) continue;
    if (state.board.links.some((bl) => bl.linkIndex === i)) continue;
    n += 1;
  }
  return n;
}

/** 玩家是否拥有触及 loc（a/b 端点）的 Link。 */
function ownsLinkTouching(state: GameState, pid: PlayerIndex, loc: LocationId): boolean {
  return state.board.links.some((bl) => {
    if (bl.player !== pid) return false;
    const l = LINKS[bl.linkIndex]!;
    return l.a === loc || l.b === loc;
  });
}

/** 玩家触及 loc（a/b 端点）的己方 Link 数。 */
function ownLinksToCity(state: GameState, pid: PlayerIndex, loc: LocationId): number {
  let n = 0;
  for (const bl of state.board.links) {
    if (bl.player !== pid) continue;
    const l = LINKS[bl.linkIndex]!;
    if (l.a === loc || l.b === loc) n += 1;
  }
  return n;
}

/** 手里有能建 ind 的产业卡 / wild 产业卡。 */
function hasBuildableCard(state: GameState, pid: PlayerIndex, ind: IndustryType): boolean {
  return state.players[pid]!.hand.some(
    (c) => (c.kind === 'industry' && c.industries.includes(ind)) || c.kind === 'wild-industry',
  );
}

/** 建造所需煤铁中能从版面免费源（任何玩家的矿/铁厂）取到的方块比例。 */
function resourceSourceRatio(
  state: GameState,
  pid: PlayerIndex,
  def: TileDef,
  loc: LocationId,
): number {
  const needed = def.costCoal + def.costIron;
  if (needed <= 0) return 1;
  let free = 0;
  if (def.costCoal > 0) {
    const cubes = coalSources(state, pid, loc).reduce((s, x) => s + x.tile.resources, 0);
    free += Math.min(def.costCoal, cubes);
  }
  if (def.costIron > 0) {
    const cubes = ironSources(state).reduce((s, x) => s + x.tile.resources, 0);
    free += Math.min(def.costIron, cubes);
  }
  return clamp01(free / needed);
}


/** 全场某资源方块总数（市场+所有未翻面矿余量）——引擎对手 overbuild 的合法性条件。 */
function globalResourceCubes(state: GameState, ind: 'coal' | 'iron'): number {
  let n = ind === 'coal' ? state.coalMarket : state.ironMarket;
  for (const slots of Object.values(state.board.slots)) {
    for (const t of slots) {
      if (t && !t.flipped && t.tile.industry === ind) n += t.resources;
    }
  }
  return n;
}

/**
 * 本 build 会改建的对手煤/铁厂（引擎 resolveSlot 同款条件:全场该类方块为 0、
 * 同产业、等级严格更低,解析序最高）。返回 null = 不构成对手改建。
 */
function opponentOverbuildTarget(
  state: GameState,
  pid: PlayerIndex,
  industry: IndustryType,
  loc: LocationId,
  newTile: TileDef,
): PlacedTile | null {
  if (industry !== 'coal' && industry !== 'iron') return null;
  if (globalResourceCubes(state, industry) !== 0) return null;
  const defs = LOCATIONS[loc]?.slots ?? [];
  const slots = state.board.slots[loc] ?? [];
  for (let i = 0; i < defs.length; i++) {
    if (!defs[i]!.industries.includes(industry)) continue;
    const t = slots[i];
    if (t && t.player !== pid && t.tile.industry === industry && t.tile.level < newTile.level) {
      return t;
    }
  }
  return null;
}

/** 当前 VP 领先者（不含 pid 自己；并列取序号最小,确定性）。 */
function vpLeader(state: GameState, pid: PlayerIndex): PlayerIndex | null {
  let best: PlayerIndex | null = null;
  let bestVp = -1;
  state.players.forEach((pl, i) => {
    if (i === pid) return;
    if (pl.vp > bestVp) {
      bestVp = pl.vp;
      best = i as PlayerIndex;
    }
  });
  return best;
}

/**
 * 本 build 会覆盖的己方板块（引擎规范化解析：对手 overbuild → 空槽 →
 * 己方 overbuild"同产业、等级严格更低、取最低级"）。返回 null = 不覆盖己方。
 */
function overbuiltOwnTile(
  state: GameState,
  pid: PlayerIndex,
  industry: IndustryType,
  loc: LocationId,
  slotIndex: number | undefined,
  newTile: TileDef,
): PlacedTile | null {
  const slots = state.board.slots[loc] ?? [];
  if (slotIndex !== undefined) {
    const t = slots[slotIndex];
    return t && t.player === pid ? t : null;
  }
  // 还有兼容空槽时引擎不会落到己方 overbuild。
  const defs = LOCATIONS[loc]?.slots ?? [];
  const hasEmptyCompatible = defs.some(
    (s, i) => s.industries.includes(industry) && slots[i] === null,
  );
  if (hasEmptyCompatible) return null;
  let best: PlacedTile | null = null;
  for (const t of slots) {
    if (!t || t.player !== pid) continue;
    if (t.tile.industry !== industry || t.tile.level >= newTile.level) continue;
    if (!best || t.tile.level < best.tile.level) best = t;
  }
  return best;
}

/** 新连通激活的手牌：(新进网地点卡数, 产业卡数)。 */
function handAccessGain(
  state: GameState,
  pid: PlayerIndex,
  a: NetworkNode,
  b: NetworkNode,
): { locCards: number; indCards: number } {
  const net = playerNetwork(state, pid);
  let locCards = 0;
  let indCards = 0;
  for (const card of state.players[pid]!.hand) {
    if (card.kind === 'location') {
      if (!net.has(card.location) && (card.location === a || card.location === b)) {
        locCards += 1;
      }
    } else if (card.kind === 'industry') {
      indCards += 1;
    }
  }
  return { locCards, indCards };
}

// ---------------------------------------------------------------------------
// probability.rs — 统一翻面概率模型
// ---------------------------------------------------------------------------

function flipProbability(
  state: GameState,
  ctx: EvalCtx,
  ind: IndustryType,
  loc: LocationId | null,
): number {
  const w = CFG.flip;
  let base: number;
  if (ind === 'coal' || ind === 'iron') {
    const cubes = nextTile(state, ctx.pid, ind)?.resourcesPlaced ?? 1;
    base = resourceFlip(state, ctx, ind, cubes, loc);
  } else if (ind === 'brewery') {
    // 本引擎 brewery 板块 resourcesPlaced 恒 0，放桶数按时代（BREWERY_BARRELS）。
    base = breweryFlip(state, ctx, BREWERY_BARRELS[state.era]);
  } else {
    base = sellableFlip(state, ctx, ind, loc, state.players[ctx.pid]!.hand.length);
    // 出售动数窗硬门：剩余动数卖不完库存（含本块）→ 必砸手里，压到 floor。
    if (w.sellActionWindow > 0) {
      const actionsLeft = Math.max(0, ctx.roundsRemaining * 2 - 1); // 扣本建造动
      const stock = ownUnflippedSellableCount(state, ctx.pid) + 1; // +1 本块
      if (actionsLeft < stock) base = w.floor;
    }
  }
  return Math.min(Math.max(base, w.floor), Math.max(w.cap, w.floor));
}

/** 资源翻面模型：市场饥渴 + 时代需求 + 孤岛煤矿特例。 */
function resourceFlip(
  state: GameState,
  ctx: EvalCtx,
  ind: IndustryType,
  cubes: number,
  loc: LocationId | null,
): number {
  const w = CFG.flip;
  const isCoal = ind === 'coal';
  const scarcity = marketScarcity(state, isCoal);
  // 铁厂随处可卖；煤矿需要连通商人位（版面任一商人位即可，煤卖给市场）。
  const canSell =
    ind === 'iron' ||
    (loc !== null
      ? canBuyCoalFromMarket(state, loc)
      : MERCHANT_IDS.some((id) => state.merchants[id].tiles.length > 0));

  if (isCoal && !canSell) {
    const heatPrice = coalPrice(state);
    const sale = simulateMarketSale(state, isCoal, cubes);
    // 孤岛煤且市场吃不下全部方块 → 大概率砸手里（hint 1：非连通贸易商的小
    // 连通块里煤无法翻面，给一个很大的惩罚——利克煤终局未翻的教训）。
    const unflippableMult = sale.flips ? 1 : w.isolatedCoalUnflippableMult;
    if (isCanalPhase(ctx.phase)) {
      const heat = priceHeat(heatPrice, w.islandCoalCanalPriceBase, w.islandCoalCanalPriceSpan);
      return Math.min(w.islandCoalCanalCap, w.islandCoalCanalBase + w.islandCoalCanalHeatBonus * heat) * unflippableMult;
    }
    const heat = priceHeat(heatPrice, w.islandCoalRailPriceBase, w.islandCoalRailPriceSpan);
    return Math.min(w.islandCoalRailCap, w.islandCoalRailBase + w.islandCoalRailHeatBonus * heat) * unflippableMult;
  }

  const sale = simulateMarketSale(state, isCoal, cubes);
  if (canSell && sale.flips) return w.sellout;

  const eraDemand = isCoal
    ? isCanalPhase(ctx.phase)
      ? w.coalDemandCanal
      : w.coalDemandRail
    : isCanalPhase(ctx.phase)
      ? w.ironDemandCanal
      : w.ironDemandRail;
  return Math.min(w.cap, eraDemand + w.scarcityBonus * scarcity);
}

/** 酒厂翻面模型：真实啤酒需求 vs 供给（含本厂新桶）。 */
function breweryFlip(state: GameState, ctx: EvalCtx, nextCubes: number): number {
  const w = CFG.flip;
  const demand =
    sellableBeerDemand(state, ctx.pid) + (isCanalPhase(ctx.phase) ? 0 : w.breweryRailDemandBuffer);
  const barrels = ownedBeerBarrels(state, ctx.pid) + nextCubes;
  if (demand <= 0.5 && isCanalPhase(ctx.phase)) return w.breweryCanalNoDemand;
  if (barrels > demand) return w.brewerySurplus;
  return w.brewerySatisfied;
}

/** 可售板块翻面模型：连通收该产业的商人 + 有啤酒 + 手牌不太穷。 */
function sellableFlip(
  state: GameState,
  ctx: EvalCtx,
  ind: IndustryType,
  loc: LocationId | null,
  handLen: number,
): number {
  const w = CFG.flip;
  if (loc === null) {
    // 计划层视角：只看版面级可行性。
    if (!MERCHANT_IDS.some((id) => merchantAccepts(state, id, ind))) return w.planNoMerchant;
    const beerOk =
      ownedBeerBarrels(state, ctx.pid) > 0 ||
      MERCHANT_IDS.some((id) => merchantAccepts(state, id, ind) && merchantHasBeerFor(state, id, ind));
    let b = beerOk ? w.planReady : w.planNoBeer;
    if (w.merchantScarcityWeight > 0) {
      const supply = merchantTilesLeftFor(state, ind);
      const demand = unflippedSellableCount(state, ind) + 1;
      const ratio = Math.min(1, supply / demand);
      b *= 1 - w.merchantScarcityWeight + w.merchantScarcityWeight * ratio;
    }
    return b;
  }

  let b = w.sellableBase;
  if (merchantReachable(state, loc, ind)) {
    // 上游此处恒按 need=1 估（概率粗估）；realBeerNeed=1 时按板块真实
    // beerToFlip（制造 L5/陶 L3/L5 需 2 桶，beer_economy 里才用真实桶数）。
    const need = w.realBeerNeed > 0 ? (nextTile(state, ctx.pid, ind)?.beerToFlip ?? 1) : 1;
    b += beerAvailable(state, loc, ctx.pid, need) ? w.sellableMerchantWithBeer : w.sellableMerchantOnly;
    // 2 桶板块的自有酒折扣：自有酒桶 <2 时 flipProb 打折——连通酒估计
    // 到卖出时点常已被喝走，只有自有酒桶是可靠弹药。
    if (need >= 2 && w.ownBeer2Discount < 1 && ownedBeerBarrels(state, ctx.pid) < 2) {
      b *= w.ownBeer2Discount;
    }
  } else {
    b += w.sellableNoMerchant;
  }
  // 商人需求稀缺折价：全图剩余需求格少于全场待翻板块时，按缺口衰减
  // （多名玩家抢同一条商人需求，造的比卖的多 → 造了卖不掉）。
  if (w.merchantScarcityWeight > 0) {
    const supply = merchantTilesLeftFor(state, ind);
    const demand = unflippedSellableCount(state, ind) + 1; // +1 = 本块
    const ratio = Math.min(1, supply / demand);
    b *= 1 - w.merchantScarcityWeight + w.merchantScarcityWeight * ratio;
  }
  if (unbuiltNeighborConnections(state, loc) > 0) b += w.sellableOpenLink;
  if (handLen === 0) b -= w.handEmptyPenalty;
  else if (handLen === 1) b -= w.handOneCardPenalty;
  else if (handLen <= 3) b -= w.handFewCardsPenalty;
  return b;
}

/** 具体建造的翻面概率（build_flip_probability）。 */
function buildFlipProbability(state: GameState, ctx: EvalCtx, ind: IndustryType, loc: LocationId): number {
  return flipProbability(state, ctx, ind, loc);
}

/** 计划产业的翻面概率（plan_flip_probability，版面级视角）。 */
function planFlipProbability(state: GameState, ctx: EvalCtx, ind: IndustryType): number {
  return flipProbability(state, ctx, ind, null);
}

// ---------------------------------------------------------------------------
// cards.rs — 手牌保留价值（card-selection head；低 = 适合弃）
// ---------------------------------------------------------------------------

interface BuildTargetRef {
  industry: IndustryType;
  location: LocationId;
}

/** 当前合法建造目标（industry × location 去重，剥掉 cardId 维度）。 */
function buildTargetsOf(state: GameState, pid: PlayerIndex): BuildTargetRef[] {
  const seen = new Set<string>();
  const out: BuildTargetRef[] = [];
  for (const a of enumerateBuilds(state, pid)) {
    if (a.type !== 'build') continue;
    const key = `${a.location}|${a.industry}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ industry: a.industry, location: a.location });
  }
  return out;
}

function cityIsFull(state: GameState, loc: LocationId): boolean {
  return (state.board.slots[loc] ?? []).every((t) => t !== null);
}

/** card_keep_score_with：一张手牌的保留价值。 */
function cardKeepScore(
  state: GameState,
  pid: PlayerIndex,
  cardIndex: number,
  targets: BuildTargetRef[],
): number {
  const w = CFG.cards;
  const hand = state.players[pid]!.hand;
  const card = hand[cardIndex];
  if (!card) return Number.POSITIVE_INFINITY;

  let score =
    card.kind === 'location' ? w.locationBase : card.kind === 'industry' ? w.industryBase : w.wildBase;

  // 重复卡保留价值递减（产业卡宽泛编组：同生产角色在运河时代也不灵活）。
  let dupCount = 0;
  if (card.kind === 'location') {
    dupCount = hand.filter((c) => c.kind === 'location' && c.location === card.location).length;
  } else if (card.kind === 'industry') {
    dupCount = hand.filter((c) => c.kind === 'industry').length;
  }
  score -= w.duplicatePenalty * Math.max(0, dupCount - 1);

  if (card.kind === 'location') {
    const loc = card.location;
    const targetCount = targets.filter((t) => t.location === loc).length;
    if (cityIsFull(state, loc)) {
      // 城满：地点卡仍能绕过 network 做自家资源厂改建（铁路时代），
      // 且手里没有对应产业卡/wild 产业卡可替代时才保留。
      const resourceUpgrade =
        state.era === 'rail' &&
        (LOCATIONS[loc]?.slots ?? []).some((_, slot) => {
          const tile = state.board.slots[loc]?.[slot];
          if (
            !tile ||
            tile.player !== pid ||
            (tile.tile.industry !== 'coal' &&
              tile.tile.industry !== 'iron' &&
              tile.tile.industry !== 'brewery')
          ) {
            return false;
          }
          const next = nextTile(state, pid, tile.tile.industry);
          return (
            next !== undefined &&
            next.level > tile.tile.level &&
            !hand.some(
              (c) =>
                (c.kind === 'industry' && c.industries.includes(tile.tile.industry)) ||
                c.kind === 'wild-industry',
            )
          );
        });
      score -= resourceUpgrade ? w.cityFullResourceUpgradePenalty : w.cityFullUselessPenalty;
    } else {
      score += w.cityTargetBonus * Math.min(w.cityTargetCap, targetCount);
    }
  } else if (card.kind === 'industry') {
    let bestRoleTargets = 0;
    for (const ind of card.industries) {
      bestRoleTargets = Math.max(bestRoleTargets, targets.filter((t) => t.industry === ind).length);
    }
    score +=
      bestRoleTargets === 0
        ? -w.industryNoTargetPenalty
        : w.industryTargetBonus * Math.min(w.industryTargetCap, bestRoleTargets);
    if (state.era === 'canal' && dupCount > 1) score -= w.canalIndustryDuplicatePenalty;
  } else {
    // wild：重复时略降（仍昂贵）。上游此处 duplicate_count 恒 0，奖金实际不触发。
    score += w.wildDuplicateBonus * Math.max(0, dupCount - 1);
  }
  return score;
}

/** 行动所消耗手牌的保留价值（scout 为 3 张之和）。 */
function actionCardKeep(ctx: EvalCtx, action: Action): number {
  if (action.type === 'scout') {
    return action.cardIds.reduce((s, id) => s + (ctx.cardKeepById.get(id) ?? 0), 0);
  }
  return ctx.cardKeepById.get(action.cardId) ?? 0;
}

// ---------------------------------------------------------------------------
// build.rs — BUILD 评分
// ---------------------------------------------------------------------------

interface BuildCost {
  cash: number;
  freeCoal: number;
  freeIron: number;
}

/** 建造成本估计：免费煤（连通矿）/铁（全图）抵扣后按市价补。 */
function buildCostOf(state: GameState, pid: PlayerIndex, def: TileDef, loc: LocationId): BuildCost {
  const freeCoal =
    def.costCoal > 0
      ? Math.min(def.costCoal, coalSources(state, pid, loc).reduce((s, x) => s + x.tile.resources, 0))
      : 0;
  const freeIron =
    def.costIron > 0
      ? Math.min(def.costIron, ironSources(state).reduce((s, x) => s + x.tile.resources, 0))
      : 0;
  const coalBuy = def.costCoal - freeCoal;
  const ironBuy = def.costIron - freeIron;
  const cash =
    def.costMoney + (coalBuy > 0 ? buyCoalCost(state, coalBuy) : 0) + (ironBuy > 0 ? buyIronCost(state, ironBuy) : 0);
  return { cash, freeCoal, freeIron };
}

/** 新煤/铁厂产出方块的市场价值：现金回流 + 尖峰/饥渴战略值 − 存留风险。 */
function marketValue(state: GameState, ctx: EvalCtx, ind: IndustryType, loc: LocationId, cubes: number): ScoreParts {
  const w = CFG.build;
  const isCoal = ind === 'coal';
  // 铁饥渴打折：铁需求平稳、市场回填快，过量产铁有风险。
  const scarcity = marketScarcity(state, isCoal) * (isCoal ? 1.0 : w.ironScarcityShare);

  const marketOk = !isCoal || canBuyCoalFromMarket(state, loc);
  if (!marketOk) {
    const strategic = isCoal
      ? isCanalPhase(ctx.phase)
        ? w.islandCoalCanalPenalty
        : scarcity * (w.islandCoalRailBase + w.islandCoalRailPerCube * cubes)
      : scarcity * w.islandIronValue;
    return parts({ strategic });
  }

  const sale = simulateMarketSale(state, isCoal, cubes);
  const cashBackBonus =
    sale.cash > 0 ? sale.cash * w.marketCashBackShare + (sale.flips ? w.marketSelloutBonus : 0) : 0;
  const coalSpikeBonus =
    isCoal && sale.sold > 0
      ? priceHeat(coalPrice(state), w.coalSpikePriceBase, w.coalSpikePriceSpan) *
        sale.sold *
        w.coalSpikePerSold *
        (isCanalPhase(ctx.phase) ? w.coalSpikeCanalMult : 1.0)
      : 0;
  const scarcityValue = scarcity * (1 + sale.sold) * w.scarcityValuePerUnit;
  // 铁路时代煤被几乎每个行动吃掉，存留不重罚。
  const leftoverPenalty =
    isCoal && !isCanalPhase(ctx.phase) ? 0 : (sale.total - sale.sold) * w.leftoverPerCube;

  return parts({
    money: sale.cash,
    strategic: cashBackBonus + coalSpikeBonus + scarcityValue,
    risk: -leftoverPenalty,
  });
}

/** 啤酒经济：可售板块要商人+酒；酒厂按需求匹配产出。 */
function beerEconomy(state: GameState, ctx: EvalCtx, ind: IndustryType, loc: LocationId, beersToSell: number): ScoreParts {
  const w = CFG.build;
  let strategic = 0;
  const sellable = ind === 'cotton' || ind === 'manufacturer' || ind === 'pottery';
  if (sellable) {
    const hasMerchant = merchantReachable(state, loc, ind);
    if (hasMerchant) strategic += w.merchantReachableBonus;
    if (hasMerchant && beerAvailable(state, loc, ctx.pid, beersToSell)) {
      strategic += w.beerAvailableBonus;
    } else {
      strategic += w.beerMissingPenalty;
    }
  } else if (ind === 'brewery') {
    const tileCubes = BREWERY_BARRELS[state.era];
    const barrels = ownedBeerBarrels(state, ctx.pid) + tileCubes;
    const demand = sellableBeerDemand(state, ctx.pid);
    const surplus = Math.max(0, barrels - demand);
    const sellSupport = demand > 0 ? w.brewerySellSupportWithDemand : w.brewerySellSupportBase;
    strategic +=
      sellSupport +
      (isCanalPhase(ctx.phase) ? 0 : w.railBreweryValue) -
      w.brewerySurplusPenaltyPerBarrel * surplus;
  }
  return parts({ strategic });
}

/** 铁路时代紧急供煤溢价：市场近空时任何合法煤矿都是战略资源。 */
function railCoalShortageBonus(state: GameState, ctx: EvalCtx, ind: IndustryType, level: number, cubes: number): number {
  const w = CFG.build;
  if (ind !== 'coal' || isCanalPhase(ctx.phase)) return 0;
  const shortage = marketScarcity(state, true);
  const levelFactor = 1 + w.railCoalShortagePerLevel * Math.max(0, level - 1);
  const cubesFactor = w.railCoalShortageCubesBase + w.railCoalShortagePerCube * cubes;
  return shortage * levelFactor * cubesFactor * w.railCoalShortage;
}

/** 成本效率：(收入 + VP) / 成本，封顶。 */
function costEfficiency(income: number, vp: number, cost: number): number {
  return cost > 0 ? Math.min(CFG.build.costEfficiencyCap, (income + vp) / cost) : 0;
}

/** 时代末计分倍数：运河时代 L2+ 板块翻面后两时代各计一次 VP
 * （L1 运河末移除只计一次；铁路时代统一 1×）。 */
function eraScoreMult(state: GameState, tile: TileDef): number {
  if (state.era !== 'canal' || tile.level < 2) return 1;
  return 1 + CFG.value.canalDoubleScoreScale;
}

/** score_build_candidate：一个 build 操作（industry × location）的评分。 */
function scoreBuildOp(state: GameState, ctx: EvalCtx, ind: IndustryType, loc: LocationId, slotIndex?: number): number {
  const tile = nextTile(state, ctx.pid, ind);
  if (!tile) return Number.NEGATIVE_INFINITY;
  if (CFG.guardrails.banBuildLv1Brewery && ind === 'brewery' && tile.level === 1) {
    return Number.NEGATIVE_INFINITY;
  }

  const cash = state.players[ctx.pid]!.money;
  const cost = buildCostOf(state, ctx.pid, tile, loc);
  if (cost.cash > cash) {
    // 买不起：重度折价（贷款仍是路径，但不做首选）。
    return -(cost.cash - cash) * CFG.build.unaffordablePerPound;
  }

  const sellableInd = ind === 'cotton' || ind === 'manufacturer' || ind === 'pottery';
  const isResourceInd = ind === 'coal' || ind === 'iron';
  let flipProb = buildFlipProbability(state, ctx, ind, loc);
  if (isResourceInd && CFG.flip.resourceWindowFull > 0) {
    // 资源板收官窗口:翻面靠全场消耗,晚建的矿抽不干=白造(hint:铁路低值建筑不如修路)。
    const actionsLeft = Math.max(0, ctx.roundsRemaining * 2 - 1);
    flipProb *= clamp01(actionsLeft / CFG.flip.resourceWindowFull);
  }
  if (ind === 'brewery' && CFG.flip.breweryWindowFull > 0) {
    // 酒厂收官窗口:翻面靠全场喝酒,末轮建=桶必剩=白送(hint:没动数翻面就别造)。
    // 但首个未翻酒厂免折价(hint 3 后半句:留 1 桶进铁路,开局双修道路抢分——
    // 桶在铁路时代是 15 块双轨的啤酒弹药,比时代末多翻一个低级酒厂值钱)。
    if (ownUnflippedBreweryCount(state, ctx.pid) > 0) {
      const actionsLeft = Math.max(0, ctx.roundsRemaining * 2 - 1);
      flipProb *= clamp01(actionsLeft / CFG.flip.breweryWindowFull);
    }
  }
  if (sellableInd && CFG.flip.sellWindowFull > 0) {
    // "没动数翻面就别造"（插件新增）：可售板块翻面需要造完后还有 sell 动——
    // 收官窗口按板块"身价"加权：VP 面值越高、需啤酒越多、造价越贵，
    // 要求的剩余动数窗口越宽（贵的板砸手里代价大、多酒板收官准备长）。
    // （sellWindowFull=0 整块关闭 = 消融基线。）
    const w = CFG.flip;
    const need =
      w.sellWindowFull +
      w.sellWindowPerBeer * tile.beerToFlip +
      w.sellWindowPerVp * tile.vp +
      w.sellWindowPerCost * tile.costMoney;
    const actionsLeft = Math.max(0, ctx.roundsRemaining * 2 - 1);
    flipProb *= clamp01(actionsLeft / Math.max(1, need));
    // 库存队列衰减：排队等翻面的库存按 VP 面值加权（贵库存更占收官资源）。
    // 时代门控:eraFrac<=gate 前不衰减(中期库存是正常产能,末段才惩罚)。
    const gate = w.sellQueueEraGate;
    const gateFactor = gate <= 0 ? 1 : clamp01((gate - ctx.eraFrac) / gate);
    const queueExponent =
      (ownUnflippedSellableVp(state, ctx.pid) / w.sellQueueVpNorm) *
      (gate <= 0 ? 1 : gateFactor);
    flipProb *= Math.pow(w.sellQueueDecay, queueExponent);
  }
  const linkSelfValue = ownsLinkTouching(state, ctx.pid, loc)
    ? tile.linkIcons * flipProb * CFG.build.linkSelfValueShare
    : 0;
  const isResource = ind === 'coal' || ind === 'iron';
  const resourceSelfSufficiency = isResource ? CFG.build.selfSufficiencyPerCube * tile.resourcesPlaced : 0;

  const p = parts({
    vp: tile.vp * flipProb * eraScoreMult(state, tile) + linkSelfValue,
    income: tile.incomeAdvance * flipProb,
    money: -cost.cash,
    strategic:
      resourceSelfSufficiency +
      CFG.build.expansionPerLink * unbuiltNeighborConnections(state, loc) +
      railCoalShortageBonus(state, ctx, ind, tile.level, tile.resourcesPlaced) +
      costEfficiency(tile.incomeAdvance, tile.vp, cost.cash),
  });

  if (isResource) addParts(p, marketValue(state, ctx, ind, loc, tile.resourcesPlaced));
  addParts(p, beerEconomy(state, ctx, ind, loc, tile.beerToFlip));


  // 免费搭车：建造投入从版面矿/铁厂取（消耗对手方块还帮他们翻面）。
  const ratio = resourceSourceRatio(state, ctx.pid, tile, loc);
  p.strategic += Math.max(0, ratio - CFG.build.freeRidingThreshold) * CFG.build.freeRidingBonus;

  // 覆盖己方板块 = 放弃其时代末 VP。
  const over = overbuiltOwnTile(state, ctx.pid, ind, loc, slotIndex, tile);
  if (over) p.risk -= over.tile.vp * CFG.value.ownOverbuildVpLoss;
  // 运河后期 L1 建造惩罚：运河进度 <35% 时建 L1 板块，未翻在运河末被移除=纯亏。
  if (CFG.build.canalLateL1Penalty > 0 && tile.level === 1 && state.era === 'canal' && ctx.eraFrac < 0.35) {
    p.risk -= CFG.build.canalLateL1Penalty;
  }
  // 酒厂售卖支持奖：铁路时代若场上有未翻可售板块且自有酒桶不足，建酒厂
  // 额外奖励——"造酒厂桶给卖货供弹"的组合（铁路造酒厂给 2 个桶）。
  if (
    CFG.build.railBrewerySellSupportBonus > 0 &&
    ind === 'brewery' &&
    state.era === 'rail' &&
    ownUnflippedSellableCount(state, ctx.pid) > 0 &&
    ownedBeerBarrels(state, ctx.pid) < 2
  ) {
    p.strategic += CFG.build.railBrewerySellSupportBonus;
  }
  // 同城已有己方 Link 数 × 奖励：在一个城市连了好几条路后，在此城造建筑
  // 的额外连通度分（更应倾向于在高连通城市建造）。
  if (CFG.build.cityLinkBonus > 0) {
    p.strategic += ownLinksToCity(state, ctx.pid, loc) * CFG.build.cityLinkBonus;
  }
  // 铁路时代高价值可售板块建造奖：L3+ 棉/陶/制造的额外奖励——人类靠这些
  // 板块批量卖出拉开分差（棉 L3/L4、陶 L1，单次 10-21 VP）。
  if (
    CFG.build.railHighLevelSellableBonus > 0 &&
    sellableInd &&
    tile.level >= 3 &&
    state.era === 'rail'
  ) {
    p.strategic += CFG.build.railHighLevelSellableBonus;
  }
  // 运河末首桶留存奖：运河收官时若还没有自己的未翻酒厂，建酒厂额外奖励
  // （铁路开局双轨的啤酒弹药，运河末留 1 桶比多翻一个低级酒厂值钱）。
  if (
    CFG.build.canalEndBeerReserveBonus > 0 &&
    ind === 'brewery' &&
    isCanalPhase(ctx.phase) &&
    isEraEndgame(ctx) &&
    ownUnflippedBreweryCount(state, ctx.pid) === 0
  ) {
    p.strategic += CFG.build.canalEndBeerReserveBonus;
  }
  // 近商城市 L2 建造奖：运河后期在近商城市建 L2+ 板块，为铁路开局连接抢分。
  // 德比按固定高奖（周围路分稳定最高）；伯明翰/科尔布鲁克代尔/斯托克按
  // 附近贸易商可收产业种类加权（卖的种类越多,这附近未来建筑越多）。
  if (tile.level >= 2 && isCanalPhase(ctx.phase) && NEAR_MERCHANT_CITIES.has(loc)) {
    if (loc === 'derby' && CFG.build.canalEndL2DerbyBonus > 0) {
      p.strategic += CFG.build.canalEndL2DerbyBonus;
    } else if (CFG.build.canalEndL2NearMerchantPerDiversity > 0) {
      p.strategic += merchantDiversityFor(state, loc) * CFG.build.canalEndL2NearMerchantPerDiversity;
    }
  }
  // 铁路中后期造煤惩罚：同期连接普遍 4-8 VP 而煤仅 2-4 VP，无脑造煤是负优化。
  if (
    CFG.build.railCoalLatePenalty > 0 &&
    ind === 'coal' &&
    state.era === 'rail' &&
    ctx.eraFrac < CFG.build.railCoalLateGate
  ) {
    p.risk -= CFG.build.railCoalLatePenalty;
  }
  // 可售板块自有酒门槛（hint 3）：铁路时代建可售板块，若自有酒桶不足以翻面
  // 且手上没有酒厂牌可造桶，视为大概率砸手里——贸易商桶只有 1 个、
  // 铁路时代不可能从其他玩家手里获得桶，自有酒桶是唯一可靠弹药。
  // 酒厂牌豁免仅限 beerToFlip=1（造 1 桶容易兑现）；≥2 桶必须自有酒桶 ≥2。
  if (
    CFG.flip.railSellableNoOwnBeerPenalty > 0 &&
    sellableInd &&
    state.era === 'rail' &&
    ownedBeerBarrels(state, ctx.pid) < tile.beerToFlip &&
    (tile.beerToFlip > CFG.flip.railSellableNoOwnBeerCardExemptMaxLevel ||
      !hasBreweryCardInHand(state, ctx.pid))
  ) {
    p.risk -= CFG.flip.railSellableNoOwnBeerPenalty;
  }

  // 改建对手煤/铁厂（引擎规则:全场该类方块为 0 时同产业更高级可覆盖）——
  // 定向拆除定价:翻面板=对手已得的时代末 VP 与收入流直接蒸发,未翻面板
  // 抹掉其翻面期望与资源;目标是当前 VP 领先者时追加狙击奖。
  const oppTarget = opponentOverbuildTarget(state, ctx.pid, ind, loc, tile);
  if (oppTarget) {
    const denyVp = oppTarget.flipped ? oppTarget.tile.vp : oppTarget.tile.vp * 0.5;
    const denyIncome = oppTarget.flipped ? oppTarget.tile.incomeAdvance * 0.5 : 0;
    p.strategic += (denyVp + denyIncome) * CFG.build.opponentOverbuildDeny;
    if (vpLeader(state, ctx.pid) === oppTarget.player) {
      p.strategic += CFG.build.opponentOverbuildLeaderBonus;
    }
  }

  // 计划（流派）软加成：运河早期先搭经济引擎，不急于锁定可售线。
  if (ctx.plan.count > 0 && ctx.plan.industry === ind && ctx.phase !== 'canal-early') {
    p.strategic += CFG.build.planBonus;
    // 流派跳级:场上已有该产业板块时,再建低级板 = 重复投资(应研发跳级)。
    if (
      CFG.build.planSkipLowPenalty > 0 &&
      tile.level <= CFG.build.planSkipLowMaxLevel &&
      countOwnTilesOnBoard(state, ctx.pid, ind) > 0
    ) {
      p.strategic -= CFG.build.planSkipLowPenalty;
    }
  }

  // 铁路末"有酒才建产业"：有酒可卖的收官建造加分。
  const sellable = ind === 'cotton' || ind === 'manufacturer' || ind === 'pottery';
  if (ctx.phase === 'rail-late' && sellable) {
    const beerOk = countBeerSources(state, loc, ctx.pid) > 0 || beerBarrelReachable(state, loc);
    if (beerOk) p.strategic += CFG.build.railLateBeerBonus;
  }
  // 棉花流冲刺：铁路时代建 L3+ 棉且自有酒桶（铁路再冲 3-4 张 L3/L4 配自酒卖）。
  if (
    CFG.build.cottonRushBonus > 0 &&
    ind === 'cotton' &&
    tile.level >= 3 &&
    !isCanalPhase(ctx.phase) &&
    ownedBeerBarrels(state, ctx.pid) > 0
  ) {
    p.strategic += CFG.build.cottonRushBonus;
  }

  return totalOf(ctx, p);
}

// ---------------------------------------------------------------------------
// network.rs — NETWORK 评分（单条 / 双轨）
// ---------------------------------------------------------------------------

const CANAL_LINK_COST = 3;
const RAIL_LINK_COST = 5;
const RAIL_DOUBLE_LINK_COST = 15;

/** 该铁路的煤成本估计：连通免费矿 → 0；否则市价 1 块（市场空时兜底 £8）。 */
function estimatedLinkCoalCost(state: GameState, linkIndex: number): number {
  const l = LINKS[linkIndex]!;
  const at = [l.a, l.b, ...(LINK_EXTRA_ENDPOINTS[linkIndex] ?? [])].find(
    (e): e is LocationId => !isMerchantNode(e),
  )!;
  const free = coalSources(state, 0, at).reduce((s, x) => s + x.tile.resources, 0);
  return free >= 1 ? 0 : buyCoalCost(state, 1);
}

/** score_network_candidate：单条连接的 ScoreParts。 */
function scoreNetworkLink(state: GameState, ctx: EvalCtx, linkIndex: number, cost: number): ScoreParts {
  const w = CFG.network;
  const l = LINKS[linkIndex]!;
  const a = l.a;
  const b = l.b;

  const { locCards, indCards } = handAccessGain(state, ctx.pid, a, b);
  const flex = locCards * w.accessPerLocationCard + indCards * w.accessPerIndustryCard;

  const { current, future } = linkCurrentAndPotentialVps(state, linkIndex);
  // 时代权重：Rail-Early 铺的网是所有计分的载体，Link 更值钱；
  // 运河时代 networkW 仅 0.1（config.rs 照抄）。
  let vp = (current + futureDiscount(ctx) * future) * ctx.profile.networkW;
  // Link 确定性溢价（hint:铁路低值建筑不如修高分路——Link VP 时代末必得,
  // 不像建筑要看翻面概率脸色;仅铁路时代,运河网反正要拆）。
  if (!isCanalPhase(ctx.phase)) vp += current * CFG.network.railCertaintyBonus;
  // 对手翻面分享惩罚：我铺的连接让对手在该城的未翻板块得以卖出翻面时，
  // 按对手未翻 VP 面值 × 系数从我的 Link 分中扣减——基础设施白送对手
  // 翻面是隐性亏损（对手建模第一项）。
  if (w.opponentFlipSharePenalty > 0) {
    vp -= opponentsUnflippedVpAt(state, ctx.pid, a) * w.opponentFlipSharePenalty;
    vp -= opponentsUnflippedVpAt(state, ctx.pid, b) * w.opponentFlipSharePenalty;
  }

  // 探索先验：本时代头几条进空白区域的连接是溢价。
  const linksBuilt = state.board.links.filter((x) => x.player === ctx.pid).length;
  const exploration = Math.max(0, w.explorationBase - w.explorationPerLink * linksBuilt);

  // 计划（流派）加成：触及"计划产业仍有空槽"的城市 = 打开产能（Canal-Late 起）。
  let planBonus = 0;
  if (
    ctx.plan.count > 0 &&
    ctx.phase !== 'canal-early' &&
    state.players[ctx.pid]!.tiles.some((t) => t.industry === ctx.plan.industry)
  ) {
    for (const e of [a, b]) {
      if (isMerchantNode(e)) continue;
      const def = LOCATIONS[e];
      if (!def || def.region === 'farm') continue;
      const slots = state.board.slots[e]!;
      const ok = def.slots.some(
        (s, i) => s.industries.includes(ctx.plan.industry) && (slots[i] === null || slots[i] === undefined),
      );
      if (ok) {
        planBonus = w.planBonus;
        break;
      }
    }
  }

  // Rail-Early 酒厂农场锁定：农场边锁定啤酒供应。
  const endpoints: NetworkNode[] = [a, b, ...(LINK_EXTRA_ENDPOINTS[linkIndex] ?? [])];
  const beerLock =
    ctx.phase === 'rail-early' && endpoints.some((e) => !isMerchantNode(e) && LOCATIONS[e]?.region === 'farm')
      ? w.beerLockBonus
      : 0;

  const merchantGain = isMerchantNode(a) || isMerchantNode(b) ? w.merchantBonus : 0;

  return parts({
    vp,
    flex,
    money: -cost,
    strategic: merchantGain + exploration + planBonus + beerLock,
  });
}

/** network 行动评分（单条/双条统一）。 */
function scoreNetworkOp(state: GameState, ctx: EvalCtx, action: Extract<Action, { type: 'network' }>): number {
  const links = action.links;
  if (links.length === 0) return Number.NEGATIVE_INFINITY;
  const w = CFG.network;

  if (state.era === 'canal') {
    return totalOf(ctx, scoreNetworkLink(state, ctx, links[0]!, CANAL_LINK_COST));
  }

  if (links.length === 1) {
    const cost = RAIL_LINK_COST + estimatedLinkCoalCost(state, links[0]!);
    return totalOf(ctx, scoreNetworkLink(state, ctx, links[0]!, cost));
  }

  // 双轨：两条单条分和 − 贵出的基价（£15 vs 2×£5，按 money 折算）+ 协同。
  const [i1, i2] = [links[0]!, links[1]!];
  const cost1 = RAIL_LINK_COST + estimatedLinkCoalCost(state, i1);
  const cost2 = RAIL_LINK_COST + estimatedLinkCoalCost(state, i2);
  const s1 = scoreNetworkLink(state, ctx, i1, cost1);
  const s2 = scoreNetworkLink(state, ctx, i2, cost2);
  const surcharge = (RAIL_DOUBLE_LINK_COST - 2 * RAIL_LINK_COST) * w.doubleSurchargeWeight * ctx.profile.moneyW;
  let total = totalOf(ctx, s1) + totalOf(ctx, s2) - surcharge;
  total += ctx.phase === 'rail-early' ? w.doubleTempoRailEarly : w.doubleTempoOther;
  const touchesFarm = [i1, i2].some((i) =>
    [LINKS[i]!.a, LINKS[i]!.b, ...(LINK_EXTRA_ENDPOINTS[i] ?? [])].some(
      (e) => !isMerchantNode(e) && LOCATIONS[e]?.region === 'farm',
    ),
  );
  if (touchesFarm) total += w.doubleFarmLockBonus;
  return total;
}

// ---------------------------------------------------------------------------
// develop.rs — DEVELOP 评分
// ---------------------------------------------------------------------------

/** 研发 2 级+煤/酒厂的机会成本惩罚（护栏）。 */
function developGuardrailPenalty(ind: IndustryType, level: number): number {
  const g = CFG.guardrails;
  if (level < 2) return 0;
  if (ind === 'brewery') return g.developBreweryPenaltyBase + g.developBreweryPenaltyPerLevel * (level - 2);
  if (ind === 'coal') return g.developCoalPenaltyBase + g.developCoalPenaltyPerLevel * (level - 2);
  return 0;
}

/** develop_target_value：移除一块板块的抽象价值（unlocked = 露出的下一级）。 */
function developTargetValue(
  state: GameState,
  ctx: EvalCtx,
  ind: IndustryType,
  removed: TileDef,
  unlocked: TileDef | undefined,
): number {
  const w = CFG.develop;
  let v = removed.railEraBuildable ? w.railEraTile : w.canalEraTile;
  v += w.perLevel * removed.level;
  if (unlocked?.railEraBuildable) v += w.railUnlockBonus;
  // 酒厂是经济引擎（研发 1 级 → 建 2/3/4 级）；运河早期仅铁便宜时做。
  if (ind === 'brewery' && removed.level === 1) {
    v += w.breweryLv1Bonus;
    if (ctx.phase === 'canal-early') {
      // 有效铁价：版面有免费铁 = 0，否则市价（v1 同款映射；上游用市场铁价）。
      const freeIron = ironSources(state).reduce((s, x) => s + x.tile.resources, 0);
      const price = freeIron > 0 ? 0 : ironPrice(state);
      if (price < 2) v += w.ironPriceVeryCheapBonus;
      else if (price <= 2) v += w.ironPriceCheapBonus;
      else if (price <= 3) v += w.ironPriceMarginalBonus;
      else v += w.ironPriceExpensivePenalty;
    }
  }
  if (isCanalPhase(ctx.phase)) v += w.canalBonus;
  // 研发方向引导（用户 hint）：棉花流 L1/L2、酒厂 L1、陶瓷 L2、制造 L3/L4。
  // 仅在产业可售（商人收 + 有啤酒路径）时引导——避免在该产业已死的局里误推。
  if (isCanalPhase(ctx.phase) && developDirectionViable(state, ctx, ind)) {
    if (ind === 'cotton' && removed.level === 1) v += w.dirCottonL1;
    else if (ind === 'cotton' && removed.level === 2) v += w.dirCottonL2;
    else if (ind === 'brewery' && removed.level === 1) v += w.dirBreweryL1;
    else if (ind === 'pottery' && removed.level === 2) v += w.dirPotteryL2;
    else if (ind === 'manufacturer' && (removed.level === 3 || removed.level === 4)) v += w.dirManuL34;
    // 解锁板块实际价值：解锁出 L3+ 可售板块且产业可售时按 VP 面值追加
    // （棉花流冲 L3/陶瓷冲 L3/制造冲 L5 的精确引导，只对真实高价值解锁生效）。
    if (unlocked && unlocked.sellable && unlocked.level >= 3) {
      v += unlocked.vp * w.unlockSellableVpScale;
    }
  }
  // 解锁板块真实建造分：解锁出的板块确实值得建（scoreBuildOp 含 flipProb/
  // 商人/啤酒校验）时，研发才升值——棉花冲 L3 的精确版。
  if (w.unlockBuildValueScale > 0 && unlocked) {
    const loc = ctx.targets.find((t) => t.industry === unlocked.industry)?.location;
    if (loc !== undefined) {
      const buildScore = scoreBuildOp(state, ctx, unlocked.industry, loc);
      if (buildScore > 0) v += buildScore * w.unlockBuildValueScale;
    }
  }
  if (ctx.plan.industry === ind) v += w.planBonus;
  if (hasBuildableCard(state, ctx.pid, ind)) v += w.buildableCardBonus;
  return v - developGuardrailPenalty(ind, removed.level);
}

/** 研发方向引导的可行性门：仅当玩家已用一块 L1 棉花/陶瓷板块"投石问路"
 * （场上已有该产业板块，翻过或没翻过）且该产业仍可售时才引导——
 * 用户流派范式是"先建 L1 确认能卖，再研发整个栈"，避免过早投入
 * （E4r 教训：C1-C3 可行性未明就灌研发，沉没成本拖垮全盘）。 */
function developDirectionViable(state: GameState, ctx: EvalCtx, ind: IndustryType): boolean {
  if (countOwnTilesOnBoard(state, ctx.pid, ind) === 0) return false;
  return MERCHANT_IDS.some((id) => merchantAccepts(state, id, ind));
}

/** score_develop_plans：对一个合法 develop 行动（removals 1|2）评分。 */
function scoreDevelopOp(
  state: GameState,
  ctx: EvalCtx,
  action: Extract<Action, { type: 'develop' }>,
  developsInEra: number,
): number {
  const w = CFG.develop;
  const g = CFG.guardrails;
  const ps = state.players[ctx.pid]!;
  if (action.removals.length === 0) return Number.NEGATIVE_INFINITY;

  // 铁源与成本：免费铁厂方块优先，不足按市价。
  const boardIron = ironSources(state).reduce((s, x) => s + x.tile.resources, 0);
  const ironNeeded = action.removals.length;
  const ironBuy = Math.max(0, ironNeeded - boardIron);
  const ironCost = ironBuy > 0 ? buyIronCost(state, ironBuy) : 0;
  // 上游 can-develop 前置：无免费铁且市价 1 块都付不起 → 不可行。
  if (boardIron === 0 && ironPrice(state) > ps.money) return Number.NEGATIVE_INFINITY;
  if (ironCost > ps.money) return Number.NEGATIVE_INFINITY;

  // 逐次移除求值（同产业第二次移除针对下一级板块）。
  const seen = new Map<IndustryType, number>();
  const values: number[] = [];
  for (const ind of action.removals) {
    const offset = seen.get(ind) ?? 0;
    seen.set(ind, offset + 1);
    const removed = tileAfter(state, ctx.pid, ind, offset);
    if (!removed || !removed.developable) return Number.NEGATIVE_INFINITY;
    if (g.banDevelopIronLv2Plus && ind === 'iron' && removed.level >= 2) {
      return Number.NEGATIVE_INFINITY;
    }
    if (g.banDevelopBreweryLv2Canal && isCanalPhase(ctx.phase) && ind === 'brewery' && removed.level >= 2) {
      return Number.NEGATIVE_INFINITY;
    }
    values.push(developTargetValue(state, ctx, ind, removed, tileAfter(state, ctx.pid, ind, offset + 1)));
  }

  const first = values[0]!;
  const secondValue = values.length > 1 ? values[1]! * w.secondTargetScale : 0;
  // 铁稀缺且研发耗一整动：版面无免费铁时收真实机会成本。
  const ironScarcity = boardIron === 0 ? w.ironScarcityCost : 0;

  const p = parts({ vp: first + secondValue, money: -ironCost });
  if (isCanalPhase(ctx.phase)) {
    p.vp *= w.canalScale;
    p.strategic += values.length > 1 ? w.canalDoubleTargetBonus : -w.canalSingleTargetPenalty;
  }

  // 行动经济护栏：研发次数超限时陡增惩罚（本引擎无 develops 计数，
  // 由插件实例按自身决策追踪，见文件头注释）。
  const limit = isCanalPhase(ctx.phase) ? w.canalCountLimit : w.railCountLimit;
  const over = Math.max(0, developsInEra + 1 - limit);
  p.risk -= over * over * w.overLimitSteepness + over;
  p.risk -= ironScarcity;

  return totalOf(ctx, p);
}

// ---------------------------------------------------------------------------
// sell.rs — SELL 评分
// ---------------------------------------------------------------------------

/** 商人奖励折算成 ScoreParts（vp / £ / 收入格 / 免费研发）。 */
function merchantBonusParts(state: GameState, id: MerchantId): ScoreParts {
  const bonus = MERCHANTS[id].bonus;
  switch (bonus.type) {
    case 'vp':
      return parts({ vp: bonus.amount * CFG.value.vp });
    case 'money':
      return parts({ money: bonus.amount });
    case 'income':
      return parts({ income: bonus.amount });
    case 'develop':
      return parts({ strategic: CFG.sell.developBonusValue });
  }
}

/** score_sell_plans：对一个合法 sell 行动（引擎枚举的组合）评分。 */
function scoreSellOp(state: GameState, ctx: EvalCtx, action: Extract<Action, { type: 'sell' }>): number {
  const w = CFG.sell;
  if (action.sales.length === 0) return Number.NEGATIVE_INFINITY;

  const p = parts();
  for (const sale of action.sales) {
    const placed = state.board.slots[sale.location]?.[sale.slotIndex];
    if (!placed || placed.player !== ctx.pid || placed.flipped) return Number.NEGATIVE_INFINITY;
    p.vp += placed.tile.vp * eraScoreMult(state, placed.tile);
    p.income += placed.tile.incomeAdvance;
    if (sale.useMerchantBeer) addParts(p, merchantBonusParts(state, sale.merchant));
    // 用掉商人最后一桶的狙击奖：让对手该商人可收的未翻板块卖出流产
    // （对手建模：高手常规武器——抢先用掉商人最后一桶可让对手 12-20 VP 的
    // 卖出流产）。
    if (sale.useMerchantBeer && w.denyLastBarrelBonus > 0) {
      const m = state.merchants[sale.merchant];
      const barrelsLeft = m.barrels.filter((b, i) => b && m.tiles[i] !== 'blank').length;
      if (barrelsLeft === 1) {
        p.strategic += opponentsUnflippedSellableVpFor(state, ctx.pid, sale.merchant) * w.denyLastBarrelBonus;
      }
    }
  }

  // 翻面推进收入 = 持续性现金流，显式加计。
  p.income *= 1 + w.incomeStreamShare;

  // 早期卖货主要为收入（VP 随时代末临近权重上升）。
  p.vp *= w.vpScaleFloor + w.vpScaleSpan * (1 - ctx.eraFrac);

  // 时代末紧迫：运河末 1 级可售板块不翻就永久消失；铁路末卖货即收官。
  if (isEraEndgame(ctx)) p.strategic += w.urgencyBonus;
  else if (ctx.phase === 'rail-late') p.strategic += w.railLateBaselineBonus;
  // 批量出售奖：多块一卖摊薄动作机会成本（高手 meta：攒 2-3 块一次卖）。
  if (w.batchBonus > 0) p.strategic += (action.sales.length - 1) * w.batchBonus;
  // 库存积压紧迫：未翻可售板块越多，卖动越紧迫——动作才是瓶颈、翻面才是
  // 兑现（终局审计：全场每局 ~17 VP 面值造了卖不掉，主因是卖动输给建动）。
  if (w.inventoryUrgency > 0) p.strategic += ownUnflippedSellableCount(state, ctx.pid) * w.inventoryUrgency;
  // 铁路末段高价值兑现奖：终局未翻的高 VP 板块是纯亏（hint 1），
  // 末段把贵的卖掉优先于再建新的。
  if (ctx.phase === 'rail-late' && w.railLateVpScale > 0) {
    let sellVp = 0;
    for (const sale of action.sales) {
      const placed = state.board.slots[sale.location]?.[sale.slotIndex];
      if (placed) sellVp += placed.tile.vp;
    }
    p.strategic += sellVp * w.railLateVpScale;
  }
  // 运河末 L1 清仓：按本行动翻面的 L1 块数加奖（酒厂不可售,天然豁免——
  // 留 1 桶进铁路开局双修抢分,见 build 的酒厂窗豁免）。
  if (isCanalPhase(ctx.phase) && isEraEndgame(ctx)) {
    let l1 = 0;
    for (const sale of action.sales) {
      const placed = state.board.slots[sale.location]?.[sale.slotIndex];
      if (placed && placed.tile.level === 1) l1 += 1;
    }
    p.strategic += l1 * w.canalEndL1Bonus;
  }

  return totalOf(ctx, p);
}

// ---------------------------------------------------------------------------
// loan.rs — LOAN 评分
// ---------------------------------------------------------------------------

/** 预算内可负担的最佳建造分（上游 best_affordable_build_score）。 */
function bestAffordableBuildScore(state: GameState, ctx: EvalCtx, budget: number): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const t of ctx.targets) {
    const tile = nextTile(state, ctx.pid, t.industry);
    if (!tile) continue;
    if (buildCostOf(state, ctx.pid, tile, t.location).cash > budget) continue;
    // 注意：上游按预算过滤后仍以真实现金评分（超现金的拿 unaffordable 罚分）。
    const s = scoreBuildOp(state, ctx, t.industry, t.location);
    if (s > best) best = s;
  }
  return best === Number.NEGATIVE_INFINITY ? 0 : best;
}

/** score_loan_result：含同回合 combo 仿真（depth 防递归）。 */
function scoreLoanOp(
  state: GameState,
  ctx: EvalCtx,
  action: Extract<Action, { type: 'loan' }>,
  develops: DevelopCounts,
  depth: number,
): number {
  const w = CFG.loan;
  const pid = ctx.pid;
  const ps = state.players[pid]!;
  const postLoanIncome = incomeLevelAt(ps.incomeSpace) - w.incomePenalty;
  const cash = ps.money;

  const after = bestAffordableBuildScore(state, ctx, cash + w.amount);
  const now = bestAffordableBuildScore(state, ctx, cash);
  const gain = Math.max(0, after - now);

  const p = parts({ income: -w.incomePenalty, strategic: gain });

  // 同回合 combo：贷款后立即解锁一个生产性第二动（Loan → Build/...）。
  if (cash < w.comboCashThreshold && ctx.roundsRemaining > w.comboMinRoundsLeft && depth === 0) {
    try {
      const s1 = applyAction(state, action);
      if (s1.phase !== 'game-over' && s1.turnOrder[s1.currentPlayerIdx] === pid) {
        const simCtx = getCtx(s1, pid);
        let bestSecond = Number.NEGATIVE_INFINITY;
        const seen = new Set<string>();
        for (const a of enumerateActions(s1, pid)) {
          if (a.type === 'loan') continue;
          const key = operationKey(a);
          if (seen.has(key)) continue;
          seen.add(key);
          const s = scoreOp(s1, simCtx, a, develops, depth + 1);
          if (s > bestSecond) bestSecond = s;
        }
        if (bestSecond !== Number.NEGATIVE_INFINITY) {
          p.strategic += Math.max(0, bestSecond) * w.comboScale;
        }
      }
    } catch {
      // 仿真失败则不加 combo 分。
    }
  }

  // 闲置保护：手上的钱什么正事都干不了时就借。
  if (cash < w.idleCashThreshold) p.strategic += w.idleBonus;

  // 解锁加成：贷款让可负担建造出现。
  if (now <= 0 && after > w.unlockMinAfterScore) p.strategic += w.unlockBonus;

  // 创业贷款峰值：运河早期头两轮低现金（上游按时代内 round<=2，此处时代进度近似）。
  if (ctx.phase === 'canal-early' && eraProgress(state) < CFG.loan.startupMaxProgress) {
    p.strategic += cash < w.startupLowCashThreshold ? w.startupLowCashBonus : w.startupBonus;
  }

  // 运河末贷款：借铁路时代启动资金（上游按时代内 round>=6，此处时代进度近似）。
  if (ctx.phase === 'canal-late' && eraProgress(state) >= CFG.loan.canalLateMinProgress) {
    const canFlipSoon = Object.values(state.board.slots).some((slots) =>
      slots.some((t) => t && t.player === pid && !t.flipped && t.tile.sellable),
    );
    if (canFlipSoon && cash < w.canalLateCashThreshold) {
      p.strategic += cash < w.idleCashThreshold ? w.canalLateLowCashBonus : w.canalLateBonus;
    }
  }

  // 收入地板：绝不借进破产螺旋。
  p.risk -=
    postLoanIncome <= w.floorDeepDebtIncome
      ? w.floorDeepDebtPenalty
      : postLoanIncome <= w.floorDebtIncome
        ? w.floorDebtPenalty
        : postLoanIncome <= w.floorBreakevenIncome
          ? w.floorBreakevenPenalty
          : 0;

  // 现金充裕不滥借。
  p.risk -=
    cash >= w.richHeavyCash
      ? w.richHeavyPenalty
      : cash >= w.richModerateCash
        ? w.richModeratePenalty
        : cash >= w.richLightCash
          ? w.richLightPenalty
          : 0;

  return totalOf(ctx, p);
}

// ---------------------------------------------------------------------------
// scout_pass.rs — SCOUT / PASS 评分
// ---------------------------------------------------------------------------

/** scout_hand_refresh_score：搜寻后保留手牌的"急需换新"程度。 */
function handRefreshScore(retainedKeeps: number[]): number {
  const w = CFG.scout;
  if (retainedKeeps.length === 0) return 0;
  const n = retainedKeeps.length;
  const lowRatio = retainedKeeps.filter((s) => s <= w.lowKeep).length / n;
  const highCount = retainedKeeps.filter((s) => s >= w.highKeep).length;
  const highShortfall = clamp01(Math.max(0, w.desiredHighValue - highCount) / w.desiredHighValue);
  const anchor = CFG.cards.locationBase;
  const avg = retainedKeeps.reduce((s, x) => s + x, 0) / n;
  const avgShortfall = clamp01((anchor - avg) / anchor);
  return w.maxRefresh * lowRatio * (0.35 + 0.65 * highShortfall) * avgShortfall;
}

/** score_scout_plan：弃 3 张死卡 + 刷新手牌质量。 */
function scoreScoutOp(state: GameState, ctx: EvalCtx, action: Extract<Action, { type: 'scout' }>): number {
  const w = CFG.scout;
  const discarded = action.cardIds.map((id) => ctx.cardKeepById.get(id) ?? 0);
  if (discarded.length !== 3) return Number.NEGATIVE_INFINITY;
  const deadCount = discarded.filter((s) => s <= 0).length;
  const discardScore = deadCount * w.deadDiscardValue - (3 - deadCount) * w.aliveDiscardPenalty;

  const discardedIds = new Set(action.cardIds);
  const retained = state.players[ctx.pid]!.hand
    .filter((c) => !discardedIds.has(c.id))
    .map((c) => ctx.cardKeepById.get(c.id) ?? 0);
  return discardScore + handRefreshScore(retained);
}

// ---------------------------------------------------------------------------
// 操作层评分分发（scoreOp）+ 候选组装（candidate_actions_k 语义）
// ---------------------------------------------------------------------------

/** 本时代已做 develop 次数（实例追踪；仿真时按首动累加）。 */
interface DevelopCounts {
  canal: number;
  rail: number;
}

function developsInEra(state: GameState, d: DevelopCounts): number {
  return state.era === 'canal' ? d.canal : d.rail;
}

/** 一个合法行动的操作分（不含弃牌维度；同操作不同 cardId 同分）。 */
function scoreOp(state: GameState, ctx: EvalCtx, action: Action, develops: DevelopCounts, depth: number): number {
  switch (action.type) {
    case 'build':
      return scoreBuildOp(state, ctx, action.industry, action.location, action.slotIndex);
    case 'network':
      return scoreNetworkOp(state, ctx, action);
    case 'develop':
      return scoreDevelopOp(state, ctx, action, developsInEra(state, develops));
    case 'sell':
      return scoreSellOp(state, ctx, action);
    case 'loan':
      return scoreLoanOp(state, ctx, action, develops, depth);
    case 'scout':
      return scoreScoutOp(state, ctx, action);
    case 'pass':
      // scout_pass.rs：pass 在统一货币下自然为 0——低于任何正收益行动，
      // 高于任何亏钱行动，不再需要魔法负常数。
      return 0;
  }
}

/** 行动签名（剥 cardId/cardIds）：同操作不同弃牌视为同一候选。 */
function operationKey(action: Action): string {
  if (action.type === 'scout') return 'scout';
  return stableStringify({ ...action, cardId: undefined });
}

/** 候选分组键（上游 Top-K 粒度按行动域）。 */
function typeKey(action: Action): string {
  if (action.type === 'network') return action.links.length > 1 ? 'network2' : 'network1';
  return action.type;
}

/** 各行动域的候选上限：build/network 各 k；develop/sell 各 2（SOURCE_VARIANTS）；其余 1。 */
function typeCap(tk: string, k: number): number {
  if (tk === 'build' || tk === 'network1' || tk === 'network2') return k;
  if (tk === 'develop' || tk === 'sell') return 2;
  return 1;
}

interface Scored {
  action: Action;
  index: number;
  score: number;
  keep: number;
}

/**
 * 给 legal 逐条评分并排序：操作分降序；同分（同操作不同弃牌）取保留价值
 * 最低者；再按原数组序（确定性）。操作分按 operationKey 缓存（loan 的
 * combo 仿真等重活只对每个操作做一次）；scout 的分依赖具体弃牌组合
 * （op 签名恒为 'scout'），不参与缓存、逐条评分。
 */
function scoreLegal(state: GameState, ctx: EvalCtx, legal: Action[], develops: DevelopCounts, depth: number): Scored[] {
  const cache = new Map<string, number>();
  const scored = legal.map((action, index) => {
    let score: number;
    if (action.type === 'scout') {
      score = scoreOp(state, ctx, action, develops, depth);
    } else {
      const key = operationKey(action);
      const hit = cache.get(key);
      if (hit === undefined) {
        score = scoreOp(state, ctx, action, develops, depth);
        cache.set(key, score);
      } else {
        score = hit;
      }
    }
    return { action, index, score, keep: actionCardKeep(ctx, action) };
  });
  scored.sort((a, b) => b.score - a.score || a.keep - b.keep || a.index - b.index);
  return scored;
}

/** 按行动域各取 Top-K（candidate_actions_k 的候选组装语义），-inf 不进候选。 */
function topPerType(scored: Scored[], k: number): Scored[] {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const out: Scored[] = [];
  for (const x of scored) {
    if (x.score === Number.NEGATIVE_INFINITY) continue;
    const op = operationKey(x.action);
    if (seen.has(op)) continue;
    const tk = typeKey(x.action);
    const n = counts.get(tk) ?? 0;
    if (n >= typeCap(tk, k)) continue;
    seen.add(op);
    counts.set(tk, n + 1);
    out.push(x);
  }
  return out;
}

// ---------------------------------------------------------------------------
// lookahead.rs — 确定性 2-ply 同回合前瞻（choose_action）
// ---------------------------------------------------------------------------

/** 回合末现金惩罚：低现金且收入没起来时结束回合是危险的。 */
function endOfTurnPenalty(state: GameState, pid: PlayerIndex, incomeBefore: number): number {
  const lw = CFG.lookahead;
  const p = state.players[pid]!;
  if (p.money >= lw.lowMoneyThreshold) return 0;
  const incomeAfter = incomeLevelAt(p.incomeSpace);
  if (incomeAfter - incomeBefore >= lw.endTurnIncomeExempt) return 0;
  const scarcity = clamp01((lw.lowMoneyThreshold - p.money) / lw.lowMoneyThreshold);
  const incomeTerm = incomeAfter < 0 ? lw.endTurnNegativeIncomeWeight : lw.endTurnIncomeWeight;
  const runway = clamp01(roundsRemaining(state) / ERA_ROUNDS);
  const eraTerm = state.era === 'rail' ? lw.endTurnRailEraTerm : lw.endTurnCanalEraTerm;
  const runwayTerm = lw.endTurnRunwayBase + lw.endTurnRunwaySpan * (1 - runway);
  return -lw.endTurnPenaltyScale * scarcity * incomeTerm * eraTerm * runwayTerm;
}

/**
 * 局面估值（上游 MCTS 叶评估器 evaluate_position 移植）：已入账 VP +
 * 版面已翻/未翻 VP 估计（运河 L2+ 按双计分口径）+ Link 当前图标 +
 * 现金/收入折算 + 手牌灵活性。候选间比较时常量部分不影响排序，
 * 叶子提供的是行动分之外的局面视野（未翻面板潜力、Link 潜力、收入流）。
 */
function evaluatePosition(state: GameState, pid: PlayerIndex): number {
  const w = CFG.leaf;
  const p = state.players[pid]!;
  const phase = eraPhase(state);
  const profile = eraProfileOf(phase, clamp01(roundsRemaining(state) / ERA_ROUNDS));
  // realFlipProb=1 时未翻面板按真实 flipProb 折算（叶评估从粗估升级为
  // 与建造评分同款的精确概率——"从仅 mcts 叶再拓展"：叶值逼近短程模拟）。
  const leafCtx = w.realFlipProb > 0 ? getCtx(state, pid) : null;
  let flipped = 0;
  let unflipped = 0;
  for (const [loc, slots] of Object.entries(state.board.slots)) {
    for (const t of slots) {
      if (!t || t.player !== pid) continue;
      if (t.flipped) {
        flipped += t.tile.vp * eraScoreMult(state, t.tile);
      } else if (leafCtx) {
        unflipped += t.tile.vp * flipProbability(state, leafCtx, t.tile.industry, loc as LocationId) * eraScoreMult(state, t.tile);
      } else {
        unflipped += t.tile.vp * w.unflippedVpShare * eraScoreMult(state, t.tile);
      }
    }
  }
  let linkVp = 0;
  for (const bl of state.board.links) {
    if (bl.player !== pid) continue;
    const def = LINKS[bl.linkIndex]!;
    for (const e of [def.a, def.b, ...(LINK_EXTRA_ENDPOINTS[bl.linkIndex] ?? [])]) {
      linkVp += linkIconsAt(state, e);
    }
  }
  const income = incomeLevelAt(p.incomeSpace);
  const wilds = p.hand.filter((c) => c.kind === 'wild-location' || c.kind === 'wild-industry').length;
  const flex = wilds * w.flexPerWild + p.hand.length * w.flexPerCard;
  return (
    p.vp * CFG.value.vp +
    (flipped + unflipped) * CFG.value.vp +
    linkVp * profile.networkW * w.linkShare +
    p.money * profile.moneyW * w.moneyShare +
    income * profile.incomeW * w.incomeScale +
    flex * CFG.value.flex * w.flexShare
  );
}

/** 随机推演到终局（LCG 种子保证确定性），返回 pid 座位的终局 VP。 */
function randomRollout(state: GameState, pid: PlayerIndex, rngSeed: number): number {
  let s = state;
  let seed = rngSeed >>> 0;
  const rand = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
  let steps = 0;
  while (s.phase !== 'game-over') {
    const player = s.turnOrder[s.currentPlayerIdx]!;
    const legal = enumerateActions(s, player);
    if (legal.length === 0) break;
    s = applyAction(s, legal[Math.floor(rand() * legal.length)]!);
    if (++steps > 100_000) break;
  }
  return s.players[pid]!.vp;
}

/** choose_action：首动候选 × 次动最优的确定性前瞻，返回 legal 中的最佳行动。 */
function chooseAction(state: GameState, pid: PlayerIndex, legal: Action[], develops: DevelopCounts): Action {
  const ctx = getCtx(state, pid);
  const incomeBefore = incomeLevelAt(state.players[pid]!.incomeSpace);
  const scored = scoreLegal(state, ctx, legal, develops, 0);
  const firstCandidates = topPerType(scored, CFG.lookahead.firstActionK);

  let best: { action: Action; value: number } | null = null;
  const ranked: { action: Action; value: number }[] = [];
  for (const c1 of firstCandidates) {
    let s1: GameState;
    try {
      s1 = applyAction(state, c1.action);
    } catch {
      continue;
    }
    let value = c1.score;
    let endState = s1;
    // 同一玩家继续行动（2 动回合的第 1 动后）→ 评估最佳第 2 动
    if (s1.phase !== 'game-over' && s1.turnOrder[s1.currentPlayerIdx] === pid) {
      const develops1: DevelopCounts =
        c1.action.type === 'develop'
          ? state.era === 'canal'
            ? { canal: develops.canal + 1, rail: develops.rail }
            : { canal: develops.canal, rail: develops.rail + 1 }
          : develops;
      const s1Ctx = getCtx(s1, pid);
      const secondScored = scoreLegal(s1, s1Ctx, enumerateActions(s1, pid), develops1, 0);
      let bestSecond = topPerType(secondScored, CFG.lookahead.secondActionK)[0];
      // 次动也用局面叶甄选（leaf.secondActionEval）：不只按行动分，按
      // "行动分 + 叶权重×行动后局面"重排前 K 名——次动决策同样获得局势评判。
      if (bestSecond && CFG.leaf.weight > 0 && CFG.leaf.secondActionEval > 0) {
        let bestV = Number.NEGATIVE_INFINITY;
        for (const c2 of topPerType(secondScored, CFG.lookahead.secondActionK)) {
          try {
            const s2 = applyAction(s1, c2.action);
            const v = c2.score + CFG.leaf.weight * CFG.leaf.secondActionEval * evaluatePosition(s2, pid);
            if (v > bestV) {
              bestV = v;
              bestSecond = c2;
            }
          } catch {
            // 仿真失败的候选保持原序。
          }
        }
      }
      if (bestSecond) {
        value = c1.score + ctx.profile.alpha * Math.max(0, bestSecond.score);
        try {
          endState = applyAction(s1, bestSecond.action);
        } catch {
          endState = s1;
        }
      }
    }
    value += endOfTurnPenalty(endState, pid, incomeBefore);
    // 局面估值叶（weight=0 关闭）：行动分之外的局势评判，将决策范围进一步延伸到未翻开牌、
    // Link、收入流和手牌，但不止于此。
    if (CFG.leaf.weight > 0) value += CFG.leaf.weight * evaluatePosition(endState, pid);
    // 四连动（yo-yo）前瞻：本回合打完轮次已推进且下轮由我先手（spent 最低
    // 锁定）→ 追加评估下轮最佳行动的先手价值（此时全场机会未被对手抢走，
    // endState 上的贪心分即"先挑"价值）。少花钱保先手的候选自然被该奖青睐。
    if (
      CFG.lookahead.fourActionWeight > 0 &&
      endState.phase !== 'game-over' &&
      endState.round !== state.round &&
      endState.turnOrder[endState.currentPlayerIdx] === pid &&
      roundsRemaining(endState) > 0
    ) {
      const nextCtx = getCtx(endState, pid);
      const nextScored = scoreLegal(endState, nextCtx, enumerateActions(endState, pid), develops, 0);
      const nextBest = nextScored[0];
      if (nextBest && nextBest.score > 0) {
        value += CFG.lookahead.fourActionWeight * nextBest.score;
        // 完整四连动：下轮第二动也按系数计入（先手连打两动的全部价值）。
        if (CFG.lookahead.fourActionSecondShare > 0) {
          try {
            const s3 = applyAction(endState, nextBest.action);
            if (s3.phase !== 'game-over' && s3.turnOrder[s3.currentPlayerIdx] === pid) {
              const s3Ctx = getCtx(s3, pid);
              const thirdScored = scoreLegal(s3, s3Ctx, enumerateActions(s3, pid), develops, 0);
              const thirdBest = thirdScored[0];
              if (thirdBest && thirdBest.score > 0) {
                value += CFG.lookahead.fourActionWeight * CFG.lookahead.fourActionSecondShare * thirdBest.score;
              }
            }
          } catch {
            // 仿真失败则只计首动。
          }
        }
      }
    }
    // 对手回应（MaxN，opponentResponseWeight=0 关闭）：我方回合结束后，
    // 下一位对手按自身贪心打出的最佳行动是其局面增益——从己方价值中扣减
    // （4 人非零和按 MaxN 各自最大化，上游 mcts-stage3 同款建模）。
    // 仅对前 opponentResponseK 个首动候选评估（成本 ≈ 每次额外一次全量打分）。
    if (CFG.lookahead.opponentResponseWeight > 0 && firstCandidates.indexOf(c1) < CFG.lookahead.opponentResponseK) {
      if (endState.phase !== 'game-over') {
        const opp = endState.turnOrder[endState.currentPlayerIdx]!;
        if (opp !== pid) {
          const oppCtx = getCtx(endState, opp);
          const oppScored = scoreLegal(endState, oppCtx, enumerateActions(endState, opp), develops, 0);
          const oppBest = oppScored[0];
          if (oppBest && oppBest.score > 0) value -= CFG.lookahead.opponentResponseWeight * oppBest.score;
        }
      }
    }
    if (!best || value > best.value) best = { action: c1.action, value };
    ranked.push({ action: c1.action, value });
  }

  // 推演复核（rolloutK>0）：对价值前 rolloutTopK 名各跑 K 局随机推演到终局，
  // 若次名均分显著超过榜首（>rolloutMargin），改选次名。
  // 仅在两个候选的价值接近（< rolloutDeltaThreshold）时触发，将模拟次数留给真正的难决策。
  if (
    CFG.lookahead.rolloutK > 0 &&
    ranked.length >= 2 &&
    ranked[0]!.value - ranked[1]!.value < CFG.lookahead.rolloutDeltaThreshold
  ) {
    ranked.sort((a, b) => b.value - a.value);
    const top = ranked.slice(0, Math.max(2, CFG.lookahead.rolloutTopK));
    let bestRoll = -1;
    let bestIdx = 0;
    for (let i = 0; i < top.length; i++) {
      let sum = 0;
      for (let k = 0; k < CFG.lookahead.rolloutK; k++) {
        try {
          const s1 = applyAction(state, top[i]!.action);
          sum += randomRollout(s1, pid, 0x9e3779b9 ^ (i * 0x10001 + k));
        } catch {
          sum += 0;
        }
      }
      const mean = sum / CFG.lookahead.rolloutK;
      if (mean > bestRoll) {
        bestRoll = mean;
        bestIdx = i;
      }
    }
    if (bestIdx > 0 && bestRoll > 0) {
      const topMean = (() => {
        let sum = 0;
        for (let k = 0; k < CFG.lookahead.rolloutK; k++) {
          try {
            const s1 = applyAction(state, top[0]!.action);
            sum += randomRollout(s1, pid, 0x9e3779b9 ^ k);
          } catch {
            sum += 0;
          }
        }
        return sum / CFG.lookahead.rolloutK;
      })();
      if (bestRoll > topMean + CFG.lookahead.rolloutMargin) best = { action: top[bestIdx]!.action, value: bestRoll };
    }
  }

  // 兜底（上游 pass_decision 语义：无候选时也有 pass=0 在 scored 里）。
  return (best ?? scored[0]!).action;
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------


  const develops: DevelopCounts = { canal: 0, rail: 0 };
  return {
    decide: ({ state, seat, legal }: { state: GameState; seat: PlayerIndex; legal: Action[] }) => {
      if (legal.length === 0) throw new Error(`${meta.name}: no legal actions`);
      const action = chooseAction(state, seat, legal, develops);
      if (action.type === 'develop') {
        if (state.era === 'canal') develops.canal += 1;
        else develops.rail += 1;
      }
      return action;
    },
  };
}

/** 插件工厂：版本差异（overrides）+ 可选调参环境变量 → AgentPlugin。 */
export function createHeuristicPlugin(opts: HeuristicPluginOptions): AgentPlugin {
  return {
    meta: opts.meta,
    create: () => {
      const CFG = deepMerge(BASE_CFG as unknown as AnyObj, (opts.overrides ?? {}) as AnyObj) as unknown as Cfg;
      if (opts.tuneEnvVar) {
        const flipEnv = process.env[`${opts.tuneEnvVar}_FLIP`];
        if (flipEnv) Object.assign(CFG.flip as unknown as AnyObj, JSON.parse(flipEnv));
        const allEnv = process.env[opts.tuneEnvVar];
        if (allEnv) {
          const o = JSON.parse(allEnv) as Record<string, Record<string, unknown>>;
          for (const [k, v] of Object.entries(o)) {
            const sect = (CFG as unknown as AnyObj)[k];
            if (sect && typeof sect === 'object') {
              for (const [kk, vv] of Object.entries(v)) {
                const sub = (sect as AnyObj)[kk];
                if (sub && typeof sub === 'object') Object.assign(sub, vv as AnyObj);
                else (sect as AnyObj)[kk] = vv;
              }
            }
          }
        }
      }
      return buildAgent(CFG, opts.meta);
    },
  };
}
