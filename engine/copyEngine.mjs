import { randomUUID } from 'node:crypto';
import { CHAINS, ChainExecutionAdapter, solanaTradeFeePct } from './chainAdapters.mjs';
import { pumpCurveCopyFill } from './pumpCurve.mjs';

/**
 * Default 5-Rule Auto-Exit Engine Suggestions & Ranges (exact mofo.gg specification)
 */
export const DEFAULT_EXIT_RULES = {
  takeInitials: {
    enabled: false,
    takeAtPct: 25, // Range: +5% to +1000%
    sellSizePct: 75, // Range: 5% to 95%
  },
  moonbagTrail: {
    enabled: false,
    trailPct: 25, // Range: 5% to 90% off peak
    armsAtPct: 10, // Range: +0% to +500%
  },
  floor: {
    enabled: false,
    openingFloorPct: 45, // Stored as positive drop %: 45 means -45% (Range: 5% to 95%)
    tightensAfterSec: 50, // Range: 1s to 3600s
    tightFloorPct: 20, // Stored as positive drop %: 20 means -20% (Range: 5% to 95%)
  },
  waveCut: {
    enabled: false,
    afterSec: 90, // Range: 5s to 3600s
    needsPeakPct: 5, // Range: +0% to +500%
  },
  hardTimeCap: {
    enabled: false,
    timeCapSec: 300, // Range: 10s to 86400s (5 minutes default)
  },
};

// Ceiling for automatic sell-slippage widening when the Sell Slippage setting is blank
export const AUTO_WIDEN_SELL_SLIPPAGE_MAX_PCT = 30;

export function createDefaultExitRules(overrides = {}) {
  return {
    takeInitials: { ...DEFAULT_EXIT_RULES.takeInitials, ...(overrides.takeInitials || {}) },
    moonbagTrail: { ...DEFAULT_EXIT_RULES.moonbagTrail, ...(overrides.moonbagTrail || {}) },
    floor: { ...DEFAULT_EXIT_RULES.floor, ...(overrides.floor || {}) },
    waveCut: { ...DEFAULT_EXIT_RULES.waveCut, ...(overrides.waveCut || {}) },
    hardTimeCap: { ...DEFAULT_EXIT_RULES.hardTimeCap, ...(overrides.hardTimeCap || {}) },
  };
}

/** The recommended set: what "Auto-Exit" means when the user hasn't tuned any rule. */
export function recommendedExitRules() {
  return createDefaultExitRules({
    takeInitials: { enabled: true },
    moonbagTrail: { enabled: true },
    floor: { enabled: true },
    waveCut: { enabled: true },
    hardTimeCap: { enabled: true },
  });
}

export function activeExitRuleCount(rules) {
  return Object.values(rules || {}).filter((r) => r && r.enabled).length;
}

export function createDefaultUiSettings() {
  return {
    displayName: '',
    timeZone: 'local', // 'local' | 'utc'
    landingTab: 'positions', // tab opened on page load
    confirmSells: true, // ask before 50% / 100% / initials sells
    hideBalances: false, // blur dollar amounts (screen sharing)
    notify: { copies: true, sells: true, skips: true, problems: true, sound: false },
  };
}

/** SOL invested / returned for a closed position. Exact when the SOL price was recorded at the
 *  trades; older records fall back to today's SOL price and are flagged as estimates. */
function closedSol(p, boughtUsd, soldUsd) {
  const exact = p.investedSol != null && p.soldSol != null;
  const px = Number(CHAINS.solana?.nativePriceUsd) || 0;
  const boughtSol = exact ? Number(p.investedSol) : px > 0 ? boughtUsd / px : null;
  const soldSol = exact ? Number(p.soldSol) : px > 0 ? soldUsd / px : null;
  if (boughtSol == null || soldSol == null) return { boughtSol: null, soldSol: null, pnlSol: null, solExact: false };
  return {
    boughtSol: Number(boughtSol.toFixed(4)),
    soldSol: Number(soldSol.toFixed(4)),
    pnlSol: Number((soldSol - boughtSol).toFixed(4)),
    solExact: exact,
  };
}

export class CopyTradingEngine {
  constructor(options = {}) {
    this.adapter = options.adapter || new ChainExecutionAdapter();
    this.listeners = new Set();
    this.resetToInitialState();
  }

  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(eventType, payload = {}) {
    for (const fn of this.listeners) {
      try {
        fn({ type: eventType, payload, timestamp: Date.now() });
      } catch {
        // Ignore listener error
      }
    }
  }

  resetToInitialState() {
    // Clean initial state — zero dummy positions, zero fake follows, zero fake balances
    this.wallets = [
      {
        id: 'w-main',
        index: 1,
        name: 'Main',
        active: true,
        archived: false,
        solanaAddress: '',
        evmAddress: '',
        exportedSolana: false,
        exportedEvm: false,
        balances: {
          solana: { native: 0, stable: 0 },
          bsc: { native: 0, stable: 0 },
          robinhood: { native: 0, stable: 0 },
          arc: { native: 0, stable: 0 },
        },
      },
    ];

    // Account-wide Trade Settings, Entry Filters, Safety Switches, and Risk Limits
    this.settings = {
      selectedChain: 'solana',
      paperTrading: true,
      // Profile, security and notification preferences (Settings page)
      ui: createDefaultUiSettings(),
      buySlippagePct: {
        solana: 15,
        evm: null, // null = dynamic default (at least 3%, or 6% for brand-new coin + token tax)
      },
      sellSlippagePct: null, // null = auto-widening (1% SOL TP/SL/manual, 15% SOL Mirror, 1%->10% EVM)
      priorityFee: {
        mode: 'normal', // 'normal' | 'fast' | 'turbo' | 'custom'
        customSol: 0.002,
      },
      tradingAsset: {
        solana: 'stable', // 'stable' (USDC gasless) | 'native' (SOL)
        bsc: 'stable', // 'stable' (USDC gasless) | 'native' (BNB)
        robinhood: 'stable', // 'stable' (USDG gasless) | 'native' (ETH)
        arc: 'stable', // USDC is Arc's native coin
      },
      // One copy per trader position: once a trader's entry in a coin is copied, their further
      // buys of that coin (top-ups) are not copied until they fully sell. true = copy every buy.
      copyTopUps: false,
      cooldown: {
        enabled: true,
        mode: 'duration', // 'duration' | 'while_holding'
        durationSec: 600, // 10 minutes default
      },
      retryBuys: true,
      maxChasePct: 25, // 1% - 1000%, default 25%
      maxSignalAgeSec: 90, // never copy a buy detected more than 90s after it landed on-chain
      muteWarnings: false,
      filters: {
        pumpOnly: false, // Launchpad-only on EVM
        minMarketCapUsd: null,
        maxMarketCapUsd: null,
        minTraderBuyNative: null,
        maxTraderBuyNative: null,
        stage: 'any', // 'any' | 'pre-grad' | 'graduated'
      },
      safety: {
        blockRiskyCoins: true, // ON by default
        blockMintableSupply: false,
        strictNonPump: false,
      },
      risk: {
        dailyLossLimitUsd: null,
        dailyLossTriggered: false,
        streakLimit: null, // 2 - 20 losses in a row
        exposureLimitUsd: null, // Solana total open cost basis limit
      },
      security: {
        pinSet: false,
        pinCode: null,
        failedPinAttempts: 0,
        pinLockedUntil: 0,
        addressCooldownEnabled: true,
        verifiedAddresses: {
          solana: { address: null, unlockedAt: 0 },
          bsc: { address: null, unlockedAt: 0 },
          robinhood: { address: null, unlockedAt: 0 },
          arc: { address: null, unlockedAt: 0 },
        },
        withdrawals24h: [],
      },
      referrals: {
        code: '',
        customCode: '',
        referredUsers: 0,
        volumeUsd: 0,
        earnedUsd: 0,
        claimedUsd: 0,
      },
    };

    this.follows = [];
    this.buyCooldownMap = new Map();
    this.positions = [];
    this.history = [];
    this.alerts = [];
    // Every realized sell (kept apart from History, so the PnL calendar survives "Clear history")
    this.realizedLog = [];
  }

  getActiveWallet() {
    return this.wallets.find((w) => w.active && !w.archived) || this.wallets[0];
  }

  /** The default wallet: can't be deleted and takes over when the active wallet is deleted.
   *  Older saves have none marked, so the first wallet becomes the default. */
  getDefaultWallet() {
    const list = this.wallets.filter((w) => !w.archived);
    let def = list.find((w) => w.isDefault);
    if (!def && list.length) {
      def = list[0];
      def.isDefault = true;
    }
    return def || null;
  }

  getWalletById(walletId) {
    return this.wallets.find((w) => w.id === walletId) || this.getActiveWallet();
  }

  /**
   * Computes spendable USD balance on a chain for a wallet, respecting native gas reserves.
   */
  getSpendableBalanceUsd(wallet, chainId) {
    if (this.settings.paperTrading) {
      if (wallet.paperBalanceUsd === undefined) {
        wallet.paperBalanceUsd = 10000.0;
      }
      return wallet.paperBalanceUsd;
    }

    const chain = CHAINS[chainId];
    const bal = wallet.balances[chainId] || { native: 0, stable: 0 };
    const assetMode = chainId === 'arc' ? 'stable' : this.settings.tradingAsset[chainId] || 'stable';

    if (chainId === 'arc') {
      return Math.max(0, bal.stable - chain.gasReserveNative);
    }

    if (assetMode === 'stable') {
      return Math.max(0, bal.stable);
    }

    const spendableNative = Math.max(0, bal.native - chain.gasReserveNative);
    return spendableNative * chain.nativePriceUsd;
  }

  debitWalletForBuy(wallet, chainId, totalCostUsd) {
    if (this.settings.paperTrading) {
      if (wallet.paperBalanceUsd === undefined) {
        wallet.paperBalanceUsd = 10000.0;
      }
      wallet.paperBalanceUsd = Math.max(0, Number((wallet.paperBalanceUsd - totalCostUsd).toFixed(2)));
      return;
    }

    const chain = CHAINS[chainId];
    const bal = wallet.balances[chainId];
    const assetMode = chainId === 'arc' ? 'stable' : this.settings.tradingAsset[chainId] || 'stable';

    if (chainId === 'arc') {
      bal.stable = Math.max(0, Number((bal.stable - totalCostUsd).toFixed(4)));
      bal.native = bal.stable;
      return;
    }

    if (assetMode === 'stable') {
      bal.stable = Math.max(0, Number((bal.stable - totalCostUsd).toFixed(4)));
    } else {
      const nativeAmt = totalCostUsd / chain.nativePriceUsd;
      bal.native = Math.max(0, Number((bal.native - nativeAmt).toFixed(6)));
    }
  }

  creditWalletForSell(wallet, chainId, netProceedsUsd, assetModeUsed = 'stable', isPaper = null) {
    // proceeds go back where the position's money came from (paper vs real), whatever the
    // Paper Trading switch says now
    if (isPaper === null ? this.settings.paperTrading : isPaper) {
      if (wallet.paperBalanceUsd === undefined) {
        wallet.paperBalanceUsd = 10000.0;
      }
      wallet.paperBalanceUsd = Number((wallet.paperBalanceUsd + netProceedsUsd).toFixed(2));
      return;
    }

    const chain = CHAINS[chainId];
    const bal = wallet.balances[chainId];

    if (chainId === 'arc') {
      bal.stable = Number((bal.stable + netProceedsUsd).toFixed(4));
      bal.native = bal.stable;
      return;
    }

    if (assetModeUsed === 'stable') {
      bal.stable = Number((bal.stable + netProceedsUsd).toFixed(4));
    } else {
      const nativeAmt = netProceedsUsd / chain.nativePriceUsd;
      bal.native = Number((bal.native + nativeAmt).toFixed(6));
    }
  }

  /**
   * Resolves effective filter for a follow: per-trader filter replaces account-wide filter completely.
   */
  getEffectiveFilters(follow) {
    const ov = follow.filtersOverride || {};
    const acc = this.settings.filters;
    // A per-trader value only overrides the account filter when it is actually set.
    // (Missing keys used to count as "set to undefined" and silently disabled the account filter.)
    const has = (v) => v !== null && v !== undefined;
    const mcOverride = has(ov.minMarketCapUsd) || has(ov.maxMarketCapUsd);
    const buySizeOverride = has(ov.minTraderBuyNative) || has(ov.maxTraderBuyNative);
    const orNull = (v) => (has(v) ? v : null);

    return {
      pumpOnly: has(ov.pumpOnly) ? ov.pumpOnly : acc.pumpOnly,
      pumpOnlySource: has(ov.pumpOnly) ? 'trader' : 'account',
      minMarketCapUsd: mcOverride ? orNull(ov.minMarketCapUsd) : orNull(acc.minMarketCapUsd),
      maxMarketCapUsd: mcOverride ? orNull(ov.maxMarketCapUsd) : orNull(acc.maxMarketCapUsd),
      mcSource: mcOverride ? 'trader' : 'account',
      minTraderBuyNative: buySizeOverride ? orNull(ov.minTraderBuyNative) : orNull(acc.minTraderBuyNative),
      maxTraderBuyNative: buySizeOverride ? orNull(ov.maxTraderBuyNative) : orNull(acc.maxTraderBuyNative),
      buySizeSource: buySizeOverride ? 'trader' : 'account',
      stage: has(ov.stage) ? ov.stage : acc.stage,
      stageSource: has(ov.stage) ? 'trader' : 'account',
    };
  }

  recordSkip({ follow, wallet, signal, reason, chaseGapPct = null, dryRun = false }) {
    // Dry runs (live "would we copy this?" checks) report the decision without touching history
    if (dryRun) return { status: 'skipped', reason, chaseGapPct, dryRun: true };
    const entry = {
      id: `hist-${randomUUID().slice(0, 8)}`,
      status: 'skipped',
      side: signal.side || 'buy',
      cause: 'entry check',
      chainId: follow.chainId,
      walletId: wallet.id,
      walletName: wallet.name,
      traderHandle: follow.handle,
      followId: follow.id,
      traderWallet: follow.traderWallet || null,
      traderTx: signal.signature || null,
      symbol: signal.token.symbol,
      tokenAddress: signal.token.address,
      amountUsd: 0,
      tokens: 0,
      fillPriceUsd: signal.token.currentPriceUsd || null,
      traderPriceUsd: signal.token.traderFillPriceUsd || null,
      chaseGapPct,
      platformFeeUsd: 0,
      networkFeeUsd: 0,
      gasless: false,
      pnlUsd: null,
      pnlPct: null,
      reason,
      txHash: null,
      timestamp: Date.now(),
    };
    this.history.unshift(entry);
    this.emit('copy_skipped', entry);
    return { status: 'skipped', reason, chaseGapPct, entry };
  }

  /**
   * 6-Step Copy Pipeline for an incoming Trader Signal (Buy or Sell).
   */
  async processTraderSignal(signal) {
    const matchingFollows = this.follows.filter(
      (f) =>
        f.chainId === signal.chainId &&
        (f.handle.toLowerCase() === String(signal.traderHandle || '').toLowerCase() ||
          f.traderWallet.toLowerCase() === String(signal.traderWallet || '').toLowerCase())
    );

    const results = [];
    for (const follow of matchingFollows) {
      if (signal.side === 'sell') {
        const res = await this.handleLeaderSellSignal(follow, signal);
        results.push(res);
      } else {
        const res = await this.handleLeaderBuySignal(follow, signal);
        results.push(res);
      }
    }
    return results;
  }

  /**
   * @param {object} opts.dryRun  When true, run every entry check and sizing step but stop
   *                              before execution: nothing is bought, debited or recorded.
   */
  async handleLeaderBuySignal(follow, signal, { dryRun = false } = {}) {
    const wallet = this.getWalletById(follow.walletId);
    const chain = CHAINS[follow.chainId];
    const token = signal.token;

    if (follow.status !== 'copying') {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'your account is paused' });
    }

    const maxAge = follow.chainId === 'solana' ? Number(this.settings.maxSignalAgeSec ?? 90) : 30;
    if (signal.ageSec && signal.ageSec > maxAge) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: `trade is too old to copy (${Math.round(signal.ageSec)}s)` });
    }

    if (this.settings.risk.dailyLossTriggered || follow.pauseReason === 'streak') {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'risk protection is active' });
    }

    const traderBuyUsd = Number(signal.traderBuyUsd ?? 100);
    // Top-up of a coin we already copied in this trader position (they haven't fully sold yet)
    if (!this.settings.copyTopUps && token.address && this.copiedCycleActive(follow.id, token.address)) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'trader is adding to a coin already copied (top-ups not copied)' });
    }

    if (traderBuyUsd < follow.minTradeUsd) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'below your minimum' });
    }

    const effFilters = this.getEffectiveFilters(follow);

    if (effFilters.pumpOnly) {
      if (follow.chainId === 'arc') {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'launchpad-only setting is on' });
      }
      if (!token.isLaunchpad) {
        const reason = follow.chainId === 'solana' ? 'pump-only is on' : 'launchpad-only setting is on';
        return this.recordSkip({ dryRun, follow, wallet, signal, reason });
      }
    }

    if (effFilters.stage && effFilters.stage !== 'any' && token.isLaunchpad && token.stage) {
      if (token.stage !== effFilters.stage) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'launch stage outside your filter' });
      }
    }

    if (token.marketCapUsd !== null && token.marketCapUsd !== undefined) {
      if (effFilters.minMarketCapUsd !== null && token.marketCapUsd < effFilters.minMarketCapUsd) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'market cap outside your filter' });
      }
      if (effFilters.maxMarketCapUsd !== null && token.marketCapUsd >= effFilters.maxMarketCapUsd) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'market cap outside your filter' });
      }
    }

    const traderBuyNative =
      signal.traderBuyNative !== undefined ? signal.traderBuyNative : traderBuyUsd / chain.nativePriceUsd;
    if (traderBuyNative !== null && traderBuyNative !== undefined) {
      if (effFilters.minTraderBuyNative !== null && traderBuyNative < effFilters.minTraderBuyNative) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: "trader's buy size outside your filter" });
      }
      if (effFilters.maxTraderBuyNative !== null && traderBuyNative > effFilters.maxTraderBuyNative) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: "trader's buy size outside your filter" });
      }
    }

    const safetyAudit = await this.adapter.inspectTokenSafety(follow.chainId, token);
    if (safetyAudit.hardBlocked) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: safetyAudit.reason });
    }
    if (this.settings.safety.strictNonPump && !token.isLaunchpad && !safetyAudit.safetyVerified) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'blocked by your safety filter' });
    }
    if (this.settings.safety.blockRiskyCoins) {
      if (follow.chainId === 'solana' && safetyAudit.hasFreezeOrHookOrDelegate) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'blocked by your safety filter' });
      }
      if (follow.chainId !== 'solana' && safetyAudit.hasRiskyOwnerControls) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'blocked by your safety filter' });
      }
    }
    if (this.settings.safety.blockMintableSupply) {
      if (
        (follow.chainId === 'solana' && safetyAudit.isMintable) ||
        (follow.chainId !== 'solana' && safetyAudit.isMintableOrMutable)
      ) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'blocked by your safety filter' });
      }
    }
    if (safetyAudit.snipeTaxPct && safetyAudit.snipeTaxPct > 20) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'snipe tax' });
    }

    if (this.settings.cooldown.enabled) {
      const cooldownKey = `${follow.chainId}:${token.address}`;
      const holdingPos = this.positions.find(
        (p) => p.chainId === follow.chainId && p.tokenAddress === token.address && p.remainingTokens > 0
      );
      if (this.settings.cooldown.mode === 'while_holding' && holdingPos) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'buy cooldown is active' });
      }
      const lastBoughtAt = this.buyCooldownMap.get(cooldownKey);
      if (lastBoughtAt && Date.now() - lastBoughtAt < this.settings.cooldown.durationSec * 1000) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'buy cooldown is active' });
      }
    }

    const followOpenPositions = this.positions.filter(
      (p) => p.followId === follow.id && p.chainId === follow.chainId && p.remainingTokens > 0
    );
    if (followOpenPositions.length >= follow.maxOpenPositions) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'position limit reached' });
    }

    const currentAtRiskUsd = followOpenPositions.reduce((sum, p) => sum + p.remainingCostUsd, 0);
    const remainingAtRiskRoomUsd = Math.max(0, follow.maxAtRiskUsd - currentAtRiskUsd);
    if (remainingAtRiskRoomUsd < 1) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'exposure limit reached for this token' });
    }

    const spendableUsd = this.getSpendableBalanceUsd(wallet, follow.chainId);
    let desiredUsd = 0;
    if (follow.sizing.type === 'fixed') {
      desiredUsd = Number(follow.sizing.amount);
    } else if (follow.sizing.type === 'percent') {
      desiredUsd = spendableUsd * (Number(follow.sizing.amount) / 100);
    } else if (follow.sizing.type === 'proportional') {
      desiredUsd = Math.min(traderBuyUsd, Number(follow.sizing.amount));
    }

    desiredUsd = Math.min(desiredUsd, remainingAtRiskRoomUsd);

    if (desiredUsd < 1) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: "below the venue's minimum" });
    }

    if (follow.chainId === 'solana' && this.settings.risk.exposureLimitUsd !== null) {
      const totalSolanaExposure = this.positions
        .filter((p) => p.chainId === 'solana' && p.remainingTokens > 0)
        .reduce((sum, p) => sum + p.remainingCostUsd, 0);
      if (totalSolanaExposure + desiredUsd > this.settings.risk.exposureLimitUsd) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'total exposure limit reached' });
      }
    }

    if (!dryRun && spendableUsd < desiredUsd) {
      this.alerts.unshift({
        id: `alt-${randomUUID().slice(0, 8)}`,
        level: 'warning',
        title: `Copy skipped — not enough balance (${chain.shortName})`,
        message: `Needed $${desiredUsd.toFixed(2)}, spendable balance was $${spendableUsd.toFixed(2)}.`,
        timestamp: Date.now(),
      });
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'not enough balance' });
    }

    let buySlippagePct = 15;
    if (follow.chainId === 'solana') {
      buySlippagePct = Number(this.settings.buySlippagePct.solana || 15);
    } else {
      const taxPct = (safetyAudit.buyTaxPct || 0) + (safetyAudit.sellTaxPct || 0);
      const baseDefault = token.stage === 'pre-grad' ? 6 : 3;
      if (this.settings.buySlippagePct.evm !== null) {
        buySlippagePct = Number(this.settings.buySlippagePct.evm);
        if (taxPct + baseDefault > buySlippagePct) {
          return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'round-trip cost too high on this token' });
        }
      } else {
        buySlippagePct = baseDefault + taxPct;
      }
    }

    const paper = Boolean(this.settings.paperTrading);
    const real = !paper && this.adapter.useLive?.({ paper, chainId: follow.chainId });
    if (!paper && !real) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'real trading is not set up (add ODEX_TRADER_KEY to .env, or turn Paper Trading on)' });
    }
    const buyAssetMode = follow.chainId === 'arc' ? 'stable' : this.settings.tradingAsset[follow.chainId] || 'stable';

    // A paper copy can never buy cheaper than the trader did: their own buy already pushed the
    // price up, and the market feed (cached up to 60 s) often lags fast launches. Our own paper
    // buys of this token in the last 30 s have pushed it further, so they set a floor too.
    // (Real copies get a real Jupiter quote instead.)
    let quoteToken = paper ? this.paperBuyPriceFloor(follow.chainId, token) : token;
    // pump.fun bonding curve: fill where a copy really lands — after the trader's own buy moved
    // the curve, plus our buy's own move — instead of a flat impact estimate
    if (paper && follow.chainId === 'solana' && (/pump$/i.test(String(token.address || '')) || token.venue === 'pumpfun') && signal.traderBuyNative > 0) {
      const solPx = CHAINS.solana.nativePriceUsd;
      const feePct = solanaTradeFeePct(token).totalPct;
      const c = pumpCurveCopyFill({
        traderPriceUsd: token.traderFillPriceUsd,
        traderSol: signal.traderPoolSol > 0 ? signal.traderPoolSol : signal.traderBuyNative,
        ourSol: (desiredUsd * (1 - feePct / 100)) / solPx,
        solPriceUsd: solPx,
      });
      if (c) {
        // our own copies in the last 30 s already pushed the curve further: never below them
        const ownFloor = Number(quoteToken.currentPriceUsd) > c.postTraderPriceUsd ? Number(quoteToken.currentPriceUsd) / c.postTraderPriceUsd : 1;
        quoteToken = { ...quoteToken, currentPriceUsd: c.postTraderPriceUsd * ownFloor, paperFillPriceUsd: c.fillPriceUsd * ownFloor, liquidityUsd: quoteToken.liquidityUsd };
      }
    }

    let quote;
    try {
      quote = await this.adapter.getSwapQuote({
        chainId: follow.chainId,
        side: 'buy',
        token: quoteToken,
        amountUsd: desiredUsd,
        slippagePct: buySlippagePct,
        paper,
        assetMode: buyAssetMode,
      });
    } catch (err) {
      if (!real) throw err;
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: `real quote failed: ${err.message}` });
    }

    const traderFillPrice = Number(token.traderFillPriceUsd || quote.quotedPriceUsd);
    const chaseGapPct =
      traderFillPrice > 0 ? ((quote.quotedPriceUsd - traderFillPrice) / traderFillPrice) * 100 : 0;

    if (traderFillPrice > 0 && chaseGapPct > this.settings.maxChasePct) {
      return this.recordSkip({
        dryRun,
        follow,
        wallet,
        signal,
        reason: 'price moved too far before we could copy',
        chaseGapPct: Number(chaseGapPct.toFixed(2)),
      });
    }

    if (dryRun) {
      return {
        status: 'would_copy',
        dryRun: true,
        sizeUsd: Number(desiredUsd.toFixed(2)),
        chaseGapPct: Number(chaseGapPct.toFixed(2)),
      };
    }

    const assetMode = follow.chainId === 'arc' ? 'stable' : this.settings.tradingAsset[follow.chainId] || 'stable';
    const gasless = follow.chainId !== 'arc' && assetMode === 'stable';

    let execResult;
    try {
      execResult = await this.adapter.executeSwap({
        chainId: follow.chainId,
        wallet,
        side: 'buy',
        token,
        amountUsd: desiredUsd,
        quote,
        priorityFee: this.settings.priorityFee,
        gasless,
        paper,
        assetMode: buyAssetMode,
        slippagePct: buySlippagePct,
        // first holding of this token opens a token account (rent) — same as a real buy
        newTokenAccount: !this.positions.some((p) => p.tokenAddress === token.address && p.remainingTokens > 0 && Boolean(p.isPaper) === paper),
      });
    } catch (err) {
      if (!real) throw err;
      execResult = { ok: false, error: err.message };
    }
    if (real && (!execResult || execResult.ok === false)) {
      const why = execResult?.error || 'unknown error';
      this.alerts.unshift({
        id: `alt-${randomUUID().slice(0, 8)}`,
        level: 'danger',
        title: execResult?.unknown ? `REAL buy result unknown — check wallet ($${token.symbol})` : `Real buy not executed ($${token.symbol})`,
        message: why,
        timestamp: Date.now(),
      });
      this.emit('alerts_updated', {});
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: `real buy failed: ${why}` });
    }

    // Real fills report exactly what was spent and received; paper fills are modelled
    const spentUsd = Number.isFinite(execResult.spentUsd) ? execResult.spentUsd : desiredUsd;
    const totalDebitUsd = spentUsd + execResult.networkFeeUsd;
    this.debitWalletForBuy(wallet, follow.chainId, totalDebitUsd);

    const netInvestedUsd = Math.max(0.01, desiredUsd - execResult.platformFeeUsd);
    const tokensReceived = Number.isFinite(execResult.tokensReceived) && execResult.tokensReceived > 0 ? execResult.tokensReceived : netInvestedUsd / execResult.fillPriceUsd;
    // entry market cap at OUR fill price (same supply as the feed's market cap), so "Entry MC → now"
    // always moves with the position's own price
    const feedSupply = Number(token.marketCapUsd) > 0 && Number(token.currentPriceUsd) > 0 ? Number(token.marketCapUsd) / Number(token.currentPriceUsd) : null;
    const pumpSupply = /pump$/i.test(String(token.address || '')) || token.venue === 'pumpfun' || token.venue === 'pumpswap' ? 1_000_000_000 : null;
    const entryMc = Math.round(execResult.fillPriceUsd * (pumpSupply || feedSupply || 1e9));

    this.buyCooldownMap.set(`${follow.chainId}:${token.address}`, Date.now());
    if (paper) {
      if (!this.recentOwnBuys) this.recentOwnBuys = new Map();
      this.recentOwnBuys.set(`${follow.chainId}:${token.address}`, { priceUsd: execResult.fillPriceUsd, at: Date.now() });
    }

    const position = {
      id: `pos-${randomUUID().slice(0, 8)}`,
      walletId: wallet.id,
      followId: follow.id,
      traderHandle: follow.handle,
      traderWallet: follow.traderWallet || null,
      traderTx: signal.signature || null,
      chainId: follow.chainId,
      isPaper: paper,
      txHash: execResult.txHash || null,
      tokenAddress: token.address,
      symbol: token.symbol,
      name: token.name || token.symbol,
      imageUrl: token.imageUrl || null,
      launchpad: token.launchpad || chain.launchpad,
      tokenCreatedAt: Number(token.createdAt) || null,
      venue: token.venue || null,
      stage: token.stage || 'pre-grad',
      // only claim "renounced" when mint + freeze authority were actually checked and are empty
      renounced:
        typeof token.renounced === 'boolean'
          ? token.renounced
          : token.safety && 'mintAuthority' in token.safety && 'freezeAuthority' in token.safety
            ? !token.safety.mintAuthority && !token.safety.freezeAuthority
            : null,
      tradingAssetUsed: assetMode,
      entryPriceUsd: execResult.fillPriceUsd,
      currentPriceUsd: execResult.fillPriceUsd,
      peakPriceUsd: execResult.fillPriceUsd,
      entryMarketCapUsd: entryMc,
      currentMarketCapUsd: entryMc,
      peakMarketCapUsd: entryMc,
      liquidityUsd: quote.liquidityUsd,
      sizeUsd: Number(spentUsd.toFixed(4)), // the order size (what was swapped)
      // cost basis = everything this buy took from the balance (size + network fee)
      initialCostUsd: Number(totalDebitUsd.toFixed(4)),
      remainingCostUsd: Number(totalDebitUsd.toFixed(4)),
      // SOL price at the moment of the buy, so the SOL invested stays exact later
      entrySolPriceUsd: CHAINS.solana?.nativePriceUsd || null,
      investedSol: CHAINS.solana?.nativePriceUsd > 0 ? Number((totalDebitUsd / CHAINS.solana.nativePriceUsd).toFixed(6)) : null,
      initialTokens: tokensReceived,
      remainingTokens: tokensReceived,
      realizedPnlUsd: 0,
      initialsTaken: false,
      trailArmed: false,
      exitStuck: false,
      openedAt: Date.now(),
      armedOrders: [],
    };
    this.positions.unshift(position);
    this.markCopiedCycle(follow.id, token.address);

    const receipt = {
      id: `hist-${randomUUID().slice(0, 8)}`,
      status: 'filled',
      side: 'buy',
      cause: 'copied buy',
      isPaper: Boolean(this.settings.paperTrading),
      chainId: follow.chainId,
      walletId: wallet.id,
      walletName: wallet.name,
      traderHandle: follow.handle,
      followId: follow.id,
      traderWallet: follow.traderWallet || null,
      traderTx: signal.signature || null,
      symbol: token.symbol,
      tokenAddress: token.address,
      amountUsd: Number(spentUsd.toFixed(4)),
      tokens: tokensReceived,
      fillPriceUsd: execResult.fillPriceUsd,
      traderPriceUsd: traderFillPrice,
      chaseGapPct: Number(chaseGapPct.toFixed(2)),
      platformFeeUsd: execResult.platformFeeUsd,
      networkFeeUsd: execResult.networkFeeUsd,
      gasless,
      pnlUsd: null,
      pnlPct: null,
      reason: null,
      txHash: execResult.txHash,
      explorerUrl: execResult.explorerUrl || null,
      timestamp: Date.now(),
    };
    this.history.unshift(receipt);

    this.alerts.unshift({
      id: `alt-${randomUUID().slice(0, 8)}`,
      level: 'success',
      title: `Copied @${follow.handle} · Bought $${token.symbol} (${chain.shortName})`,
      message: `$${desiredUsd.toFixed(2)} → ${tokensReceived.toFixed(2)} $${token.symbol} @ $${execResult.fillPriceUsd.toFixed(6)} (${chaseGapPct >= 0 ? '+' : ''}${chaseGapPct.toFixed(1)}% vs trader).`,
      timestamp: Date.now(),
    });

    this.emit('position_opened', { position, receipt });
    return { status: 'filled', position, receipt };
  }

  async handleLeaderSellSignal(follow, signal, { dryRun = false } = {}) {
    const wallet = this.getWalletById(follow.walletId);
    // the trader fully exited: their next buy of this coin is a fresh entry again
    if (!dryRun && Number(signal.sellSharePct ?? 100) >= 99 && signal.token?.address) this.endCopiedCycle(follow.id, signal.token.address);
    if (follow.mode !== 'mirror') {
      return this.recordSkip({
        dryRun,
        follow,
        wallet,
        signal,
        reason:
          follow.mode === 'auto-exit'
            ? "Auto-Exit mode manages exits itself, so trader sells aren't copied"
            : "your Buy & Hold mode doesn't copy sells",
      });
    }

    // prefer a position of the current mode (real vs paper) when both hold this token
    const wantPaper = Boolean(this.settings.paperTrading);
    const pos = [...this.positions].sort((a, b) => (Boolean(a.isPaper) === wantPaper ? 0 : 1) - (Boolean(b.isPaper) === wantPaper ? 0 : 1)).find(
      (p) =>
        p.followId === follow.id &&
        p.chainId === signal.chainId &&
        // match by token address; symbols are not unique (many tokens share a ticker)
        (signal.token.address ? p.tokenAddress === signal.token.address : p.symbol.toLowerCase() === String(signal.token.symbol || '').toLowerCase()) &&
        p.remainingTokens > 0
    );

    if (!pos) {
      return this.recordSkip({
        dryRun,
        follow,
        wallet,
        signal,
        reason: 'nothing tracked to sell for this holding',
      });
    }

    const sellPct = Math.min(100, Math.max(1, Number(signal.sellSharePct || 100)));
    if (dryRun) return { status: 'would_copy', dryRun: true, sellPct };
    return this.executePositionSell(pos.id, {
      sellPct,
      cause: 'Mirror sell',
    });
  }

  async executePositionSell(positionId, opts = {}) {
    // one sell per position at a time: real swaps take seconds and exits are checked every tick
    if (!this.sellsInFlight) this.sellsInFlight = new Set();
    if (this.sellsInFlight.has(positionId)) return { ok: false, error: 'A sell for this position is already in progress.', inFlight: true };
    this.sellsInFlight.add(positionId);
    try {
      return await this.executePositionSellNow(positionId, opts);
    } finally {
      this.sellsInFlight.delete(positionId);
    }
  }

  async executePositionSellNow(positionId, { sellPct = 100, exactTokens = null, cause = 'manual sell' } = {}) {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos || pos.remainingTokens <= 0) {
      return { ok: false, error: 'Position not found or already closed.' };
    }

    const wallet = this.getWalletById(pos.walletId);
    const chain = CHAINS[pos.chainId];

    let fraction = Math.min(1, Math.max(0.01, Number(sellPct) / 100));
    if (exactTokens !== null && exactTokens > 0) {
      fraction = Math.min(1, exactTokens / pos.remainingTokens);
    }

    let tokensSold = pos.remainingTokens * fraction;
    const real = !pos.isPaper && this.adapter.useLive?.({ paper: false, chainId: pos.chainId });
    // a full sell of the only real position in this token sells the whole wallet balance (no dust)
    const othersInMint = this.positions.some((p) => p.id !== pos.id && p.tokenAddress === pos.tokenAddress && p.remainingTokens > 0 && !p.isPaper);
    const tokenAmount = real && fraction >= 0.9999 && !othersInMint ? 'all' : tokensSold;
    const grossValueUsd = tokensSold * pos.currentPriceUsd;

    if (grossValueUsd < 1 && fraction < 1) {
      return { ok: false, error: "what's left was too small to sell (< $1 minimum)." };
    }

    // Sell slippage: a value set in Settings is a hard cap. When it is blank ("Auto-widening"),
    // start from the chain default and widen to cover the quoted price impact (up to a ceiling),
    // so stop-losses and auto-exits on larger positions still execute instead of being refused.
    const userSellSlip =
      this.settings.sellSlippagePct !== null && this.settings.sellSlippagePct !== undefined && this.settings.sellSlippagePct !== ''
        ? Number(this.settings.sellSlippagePct)
        : null;
    const baseSellSlip = pos.chainId === 'solana' ? (cause === 'Mirror sell' ? 15 : 1) : 5;
    // Real sells with no slippage set: Jupiter picks it from live conditions (a fixed 1% fails
    // most pump.fun sells). Paper keeps the modelled default.
    let sellSlippagePct = userSellSlip !== null ? userSellSlip : real ? null : baseSellSlip;

    let quote;
    try {
      quote = await this.adapter.getSwapQuote({
        chainId: pos.chainId,
        side: 'sell',
        token: {
          address: pos.tokenAddress,
          symbol: pos.symbol,
          currentPriceUsd: pos.currentPriceUsd,
          marketCapUsd: pos.currentMarketCapUsd,
          liquidityUsd: pos.liquidityUsd,
        },
        amountUsd: grossValueUsd,
        slippagePct: sellSlippagePct,
        paper: Boolean(pos.isPaper),
        tokenAmount,
        assetMode: pos.tradingAssetUsed,
      });
    } catch (err) {
      if (!real) throw err;
      return this.realSellFailed(pos, err.message, { backoff: Boolean(err.backoff), noTokens: Boolean(err.noTokens) });
    }

    if (!real && userSellSlip === null && quote.priceImpactPct > sellSlippagePct) {
      sellSlippagePct = Math.min(AUTO_WIDEN_SELL_SLIPPAGE_MAX_PCT, Math.ceil((quote.priceImpactPct + 0.5) * 10) / 10);
    }

    // Paper only. A real quote is already the price the swap gets (Jupiter enforces slippage
    // between quote and landing); comparing it to our own, possibly lagging, price would block
    // stop-losses exactly when a coin crashes.
    if (!real && quote.priceImpactPct > sellSlippagePct) {
      // Auto-exits retry on every tick: only raise the alert once per minute per position
      const now = Date.now();
      if (!pos.lastSellBlockedAlertAt || now - pos.lastSellBlockedAlertAt > 60_000) {
        pos.lastSellBlockedAlertAt = now;
        this.alerts.unshift({
          id: `alt-${randomUUID().slice(0, 8)}`,
          level: 'danger',
          title: `Sell not executed — price impact too high ($${pos.symbol})`,
          message: `Price impact (${quote.priceImpactPct.toFixed(2)}%) exceeded sell slippage limit (${sellSlippagePct}%). Raise sell slippage or sell a smaller part.`,
          timestamp: now,
        });
      }
      return {
        ok: false,
        error: `Price impact (${quote.priceImpactPct.toFixed(2)}%) exceeds sell slippage (${sellSlippagePct}%).`,
        realFailed: Boolean(real),
      };
    }

    const gasless = pos.chainId !== 'arc' && pos.tradingAssetUsed === 'stable';
    const execResult = await this.adapter.executeSwap({
      chainId: pos.chainId,
      wallet,
      side: 'sell',
      token: { address: pos.tokenAddress, symbol: pos.symbol, stage: pos.stage, launchpad: pos.launchpad, marketCapUsd: pos.currentMarketCapUsd, createdAt: pos.tokenCreatedAt, venue: pos.venue },
      // paper fee is 1% of what the sale actually fills at (after price impact)
      amountUsd: real ? grossValueUsd : tokensSold * quote.expectedFillPriceUsd,
      quote,
      priorityFee: this.settings.priorityFee,
      gasless,
      paper: Boolean(pos.isPaper),
      tokenAmount,
      assetMode: pos.tradingAssetUsed,
      slippagePct: sellSlippagePct,
    }).catch((err) => {
      if (!real) throw err;
      return { ok: false, error: err.message };
    });
    if (real && (!execResult || execResult.ok === false)) {
      return this.realSellFailed(pos, execResult?.error || 'unknown error', execResult);
    }
    if (real && Number(execResult.tokensSold) > 0) {
      // book exactly what left the wallet
      const actual = Number(execResult.tokensSold);
      if (tokenAmount === 'all' || actual >= pos.remainingTokens * 0.9999) {
        fraction = 1;
        tokensSold = pos.remainingTokens;
      } else {
        fraction = actual / pos.remainingTokens;
        tokensSold = actual;
      }
    }

    const realizedGrossUsd = real && Number.isFinite(execResult.receivedUsd) ? execResult.receivedUsd + execResult.platformFeeUsd : tokensSold * execResult.fillPriceUsd;
    const netProceedsUsd = Math.max(0, realizedGrossUsd - execResult.platformFeeUsd - execResult.networkFeeUsd);
    const costBasisSoldUsd = pos.remainingCostUsd * fraction;
    const pnlUsd = netProceedsUsd - costBasisSoldUsd;
    const pnlPct = costBasisSoldUsd > 0 ? (pnlUsd / costBasisSoldUsd) * 100 : 0;

    pos.remainingTokens = Number((pos.remainingTokens - tokensSold).toFixed(6));
    pos.remainingCostUsd = Number((pos.remainingCostUsd - costBasisSoldUsd).toFixed(4));
    pos.realizedPnlUsd = Number((pos.realizedPnlUsd + pnlUsd).toFixed(4));
    pos.soldUsd = Number(((pos.soldUsd || 0) + netProceedsUsd).toFixed(4));
    pos.soldTokens = Number(((pos.soldTokens || 0) + tokensSold).toFixed(6));
    if (pos.investedSol != null && CHAINS.solana?.nativePriceUsd > 0) pos.soldSol = Number(((pos.soldSol || 0) + netProceedsUsd / CHAINS.solana.nativePriceUsd).toFixed(6));
    pos.lastSellAt = Date.now();

    let positionClosed = false;
    if (fraction >= 0.9999 || pos.remainingTokens <= 0.000001) {
      pos.remainingTokens = 0;
      pos.remainingCostUsd = 0;
      pos.armedOrders = [];
      pos.closedAt = Date.now();
      pos.closeCause = cause;
      this.buyCooldownMap.delete(`${pos.chainId}:${pos.tokenAddress}`);
      positionClosed = true;
      // keep the closed list bounded (newest 300)
      const closed = this.positions.filter((p) => p.remainingTokens <= 0);
      if (closed.length > 300) {
        const drop = new Set(closed.sort((a, b) => (a.closedAt || a.openedAt) - (b.closedAt || b.openedAt)).slice(0, closed.length - 300).map((p) => p.id));
        this.positions = this.positions.filter((p) => !drop.has(p.id));
      }
    }

    this.creditWalletForSell(wallet, pos.chainId, netProceedsUsd, pos.tradingAssetUsed, Boolean(pos.isPaper));

    const receipt = {
      id: `hist-${randomUUID().slice(0, 8)}`,
      status: 'filled',
      side: 'sell',
      cause,
      isPaper: Boolean(pos.isPaper),
      chainId: pos.chainId,
      walletId: wallet.id,
      walletName: wallet.name,
      traderHandle: pos.traderHandle,
      followId: pos.followId || null,
      traderWallet: pos.traderWallet || null,
      symbol: pos.symbol,
      tokenAddress: pos.tokenAddress,
      amountUsd: netProceedsUsd,
      tokens: tokensSold,
      fillPriceUsd: execResult.fillPriceUsd,
      traderPriceUsd: null,
      chaseGapPct: null,
      platformFeeUsd: execResult.platformFeeUsd,
      networkFeeUsd: execResult.networkFeeUsd,
      gasless,
      pnlUsd: Number(pnlUsd.toFixed(2)),
      pnlPct: Number(pnlPct.toFixed(2)),
      reason: null,
      txHash: execResult.txHash,
      explorerUrl: execResult.explorerUrl || null,
      timestamp: Date.now(),
    };
    this.history.unshift(receipt);
    this.realizedLog.push({ t: receipt.timestamp, pnl: receipt.pnlUsd, paper: Boolean(receipt.isPaper), sym: receipt.symbol });
    if (this.realizedLog.length > 20000) this.realizedLog.splice(0, this.realizedLog.length - 20000);

    // Evaluate streak / daily-loss limits only after this sell is in history,
    // so the closing trade's own loss counts toward the 24h limit.
    if (positionClosed) {
      this.evaluateRiskLimitsOnClose(pos, pnlUsd);
    }

    this.alerts.unshift({
      id: `alt-${randomUUID().slice(0, 8)}`,
      level: pnlUsd >= 0 ? 'success' : 'warning',
      title: `Exit filled · ${chain.name} ($${pos.symbol})`,
      message: `Sold ${(fraction * 100).toFixed(0)}% via ${cause} for $${netProceedsUsd.toFixed(2)} (${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} / ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%).`,
      timestamp: Date.now(),
    });

    this.emit('position_sold', { position: pos, receipt });
    return { ok: true, position: pos, receipt };
  }

  async sellInitialsManual(positionId) {
    const pos = this.positions.find((p) => p.id === positionId && p.remainingTokens > 0);
    if (!pos) return { ok: false, error: 'Position not found.' };

    const currentValUsd = pos.remainingTokens * pos.currentPriceUsd;
    if (currentValUsd <= pos.remainingCostUsd) {
      return this.executePositionSell(positionId, { sellPct: 100, cause: 'manual sell (initials underwater → 100%)' });
    }
    const neededPct = Math.min(100, Math.max(1, (pos.remainingCostUsd / currentValUsd) * 100));
    return this.executePositionSell(positionId, { sellPct: neededPct, cause: 'initials taken off' });
  }

  async sellAllPositions({ chainId = null, panic = false } = {}) {
    if (panic) {
      for (const f of this.follows) {
        f.status = 'paused';
        f.pauseReason = 'panic_sell';
      }
    }

    const targets = this.positions.filter(
      (p) => p.remainingTokens > 0 && (!chainId || chainId === 'all' || p.chainId === chainId)
    );

    const results = [];
    for (const pos of targets) {
      const res = await this.executePositionSell(pos.id, {
        sellPct: 100,
        cause: panic ? 'panic sell' : 'sell all',
      });
      results.push(res);
    }

    this.emit('bulk_sell', { panic, chainId, count: results.length });
    return { ok: true, panic, soldCount: results.filter((r) => r.ok).length, results };
  }

  evaluateRiskLimitsOnClose(pos, realizedPnlUsd) {
    const follow = this.follows.find((f) => f.id === pos.followId);
    if (follow) {
      if (realizedPnlUsd < 0) {
        follow.consecutiveLosses = (follow.consecutiveLosses || 0) + 1;
        if (
          this.settings.risk.streakLimit !== null &&
          follow.consecutiveLosses >= this.settings.risk.streakLimit
        ) {
          follow.status = 'paused';
          follow.pauseReason = 'streak';
          this.alerts.unshift({
            id: `alt-${randomUUID().slice(0, 8)}`,
            level: 'danger',
            title: `Losing streak — @${follow.handle}'s buys paused`,
            message: `@${follow.handle} closed ${follow.consecutiveLosses} positions in a row at a loss. Selling and open positions continue normally.`,
            timestamp: Date.now(),
          });
        }
      } else {
        follow.consecutiveLosses = 0;
      }
    }

    if (this.settings.risk.dailyLossLimitUsd !== null) {
      const cutoff = Date.now() - 86_400_000;
      const netLoss24h = this.history
        .filter((h) => h.status === 'filled' && h.side === 'sell' && h.timestamp >= cutoff && h.pnlUsd < 0)
        .reduce((sum, h) => sum + Math.abs(h.pnlUsd), 0);

      if (netLoss24h >= this.settings.risk.dailyLossLimitUsd && !this.settings.risk.dailyLossTriggered) {
        this.settings.risk.dailyLossTriggered = true;
        this.alerts.unshift({
          id: `alt-${randomUUID().slice(0, 8)}`,
          level: 'danger',
          title: 'Daily loss limit hit — buying paused',
          message: `Realized losses over 24h ($${netLoss24h.toFixed(2)}) reached your $${this.settings.risk.dailyLossLimitUsd} limit.`,
          timestamp: Date.now(),
        });
      }
    }
  }

  async evaluatePositionExits(pos, now = Date.now()) {
    if (!pos || pos.remainingTokens <= 0) return null;
    // A real sell can fail (no route, slippage, network). Exit rules mark themselves done
    // before selling, so undo those marks when a real sell did not happen and it is retried.
    const before = { initialsTaken: pos.initialsTaken, timeCapExecuted: pos.timeCapExecuted, armedOrders: Array.isArray(pos.armedOrders) ? pos.armedOrders.slice() : pos.armedOrders };
    if (!pos.isPaper && pos.realTokensMissing) return null;
    const res = await this.evaluatePositionExitRules(pos, now);
    if (res && res.ok === false && res.realFailed) Object.assign(pos, before);
    return res;
  }

  async evaluatePositionExitRules(pos, now = Date.now()) {
    if (!pos || pos.remainingTokens <= 0) return null;

    const follow = this.follows.find((f) => f.id === pos.followId);
    const gainPct = ((pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
    const peakGainPct = ((pos.peakPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
    const dropFromPeakPct =
      pos.peakPriceUsd > 0 ? ((pos.peakPriceUsd - pos.currentPriceUsd) / pos.peakPriceUsd) * 100 : 0;
    const ageSec = Math.max(0, (now - pos.openedAt) / 1000);

    // 1. Check Per-Position Armed Limit Orders (up to 5 per position)
    if (Array.isArray(pos.armedOrders) && pos.armedOrders.length > 0) {
      for (let i = 0; i < pos.armedOrders.length; i++) {
        const ord = pos.armedOrders[i];
        let triggered = false;

        if (ord.type === 'sell-initials') {
          if (gainPct >= Number(ord.triggerValue)) {
            pos.armedOrders.splice(i, 1);
            return this.sellInitialsManual(pos.id);
          }
        } else if (ord.type === 'take-profit') {
          if (ord.triggerType === 'pct' && gainPct >= Number(ord.triggerValue)) triggered = true;
          if (ord.triggerType === 'mc' && pos.currentMarketCapUsd >= Number(ord.triggerValue)) triggered = true;
          if (triggered) {
            pos.armedOrders.splice(i, 1);
            // The order was sized on the bag at arm time. If the position has shrunk since
            // (manual sell, initials, another order), scale it down so "50%" stays 50%.
            const armedOn = Number(ord.tokensAtArm || 0);
            const shrink = armedOn > 0 ? Math.min(1, pos.remainingTokens / armedOn) : 1;
            const tokens = ord.tokensToSell ? ord.tokensToSell * shrink : null;
            return this.executePositionSell(pos.id, {
              exactTokens: tokens,
              sellPct: ord.sizePct,
              cause: 'limit take-profit hit',
            });
          }
        } else if (ord.type === 'stop-loss') {
          if (ord.triggerType === 'pct' && gainPct <= -Math.abs(Number(ord.triggerValue))) triggered = true;
          if (ord.triggerType === 'mc' && pos.currentMarketCapUsd <= Number(ord.triggerValue)) triggered = true;
          if (triggered) {
            pos.armedOrders.splice(i, 1);
            return this.executePositionSell(pos.id, {
              sellPct: ord.sizePct,
              cause: 'limit stop-loss hit',
            });
          }
        }
      }
    }

    if (!follow) return null;

    // 2. Check Follow-level Take Profit / Stop Loss (applies in EVERY mode)
    if (follow.tpPct !== null && follow.tpPct !== undefined && gainPct >= Number(follow.tpPct)) {
      return this.executePositionSell(pos.id, { sellPct: 100, cause: 'take-profit hit' });
    }
    if (follow.slPct !== null && follow.slPct !== undefined && gainPct <= -Math.abs(Number(follow.slPct))) {
      return this.executePositionSell(pos.id, { sellPct: 100, cause: 'stop-loss hit' });
    }

    // 3. Check 5-Rule Auto-Exit Engine (ONLY when follow.mode === 'auto-exit')
    if (follow.mode === 'auto-exit' && follow.exitRules) {
      const rules = follow.exitRules;

      if (rules.takeInitials?.enabled && !pos.initialsTaken) {
        if (gainPct >= Number(rules.takeInitials.takeAtPct)) {
          pos.initialsTaken = true;
          return this.executePositionSell(pos.id, {
            sellPct: Number(rules.takeInitials.sellSizePct),
            cause: 'initials taken off',
          });
        }
      }

      if (rules.moonbagTrail?.enabled) {
        if (peakGainPct >= Number(rules.moonbagTrail.armsAtPct)) {
          pos.trailArmed = true;
        }
        if (pos.trailArmed && dropFromPeakPct >= Number(rules.moonbagTrail.trailPct)) {
          return this.executePositionSell(pos.id, {
            sellPct: 100,
            cause: 'trailing stop hit',
          });
        }
      }

      if (rules.floor?.enabled) {
        const activeFloorDrop =
          ageSec >= Number(rules.floor.tightensAfterSec)
            ? Math.abs(Number(rules.floor.tightFloorPct))
            : Math.abs(Number(rules.floor.openingFloorPct));
        if (gainPct <= -activeFloorDrop) {
          return this.executePositionSell(pos.id, {
            sellPct: 100,
            cause: 'floor hit',
          });
        }
      }

      if (rules.waveCut?.enabled) {
        if (ageSec >= Number(rules.waveCut.afterSec) && peakGainPct < Number(rules.waveCut.needsPeakPct)) {
          return this.executePositionSell(pos.id, {
            sellPct: 100,
            cause: 'no-wave exit',
          });
        }
      }

      if (rules.hardTimeCap?.enabled && ageSec >= Number(rules.hardTimeCap.timeCapSec) && !pos.timeCapExecuted) {
        pos.timeCapExecuted = true;
        if (pos.initialsTaken) {
          return null;
        }
        const mainSellPct = rules.takeInitials?.enabled ? Number(rules.takeInitials.sellSizePct) : 100;
        pos.initialsTaken = true;
        return this.executePositionSell(pos.id, {
          sellPct: mainSellPct,
          cause: 'time cap reached',
        });
      }
    }

    return null;
  }

  armLimitOrder(positionId, { type, triggerType, triggerValue, sizePct }) {
    const pos = this.positions.find((p) => p.id === positionId && p.remainingTokens > 0);
    if (!pos) return { ok: false, error: 'Open position not found.' };

    pos.armedOrders = pos.armedOrders || [];
    if (pos.armedOrders.length >= 5) {
      return { ok: false, error: 'Maximum of 5 armed limit orders per position reached.' };
    }

    const numericSize = type === 'sell-initials' ? 0 : Math.min(100, Math.max(1, Number(sizePct || 50)));

    if (type === 'take-profit') {
      const existingTpPct = pos.armedOrders
        .filter((o) => o.type === 'take-profit')
        .reduce((sum, o) => sum + Number(o.sizePct || 0), 0);
      if (existingTpPct + numericSize > 100) {
        return {
          ok: false,
          error: `Take-profit orders cannot exceed 100% of the position (${100 - existingTpPct}% remaining free).`,
        };
      }
    }

    const order = {
      id: `ord-${randomUUID().slice(0, 6)}`,
      type,
      triggerType: type === 'sell-initials' ? 'pct' : triggerType,
      triggerValue: Number(triggerValue),
      sizePct: numericSize,
      tokensToSell: pos.remainingTokens * (numericSize / 100),
      tokensAtArm: pos.remainingTokens,
      createdAt: Date.now(),
    };

    pos.armedOrders.push(order);
    this.emit('limit_order_armed', { positionId, order });
    return { ok: true, order, position: pos };
  }

  cancelLimitOrder(positionId, orderId) {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos) return { ok: false, error: 'Position not found.' };
    pos.armedOrders = (pos.armedOrders || []).filter((o) => o.id !== orderId);
    this.emit('limit_order_cancelled', { positionId, orderId });
    return { ok: true, position: pos };
  }

  /**
   * Fetches real live token prices & market caps from DexScreener for any open positions,
   * and evaluates the Exit Engine.
   */
  /**
   * Real on-chain fills (from watched wallets) are the most trustworthy price. Record one and
   * move every open position in that token to it.
   */
  observeTradePrice(mint, priceUsd, at = Date.now()) {
    const price = Number(priceUsd);
    if (!mint || !(price > 0)) return;
    if (!this.lastTradePrice) this.lastTradePrice = new Map();
    this.lastTradePrice.set(mint, { priceUsd: price, at });
    for (const pos of this.positions) {
      if (pos.tokenAddress !== mint || pos.remainingTokens <= 0) continue;
      const ratio = pos.currentPriceUsd > 0 ? price / pos.currentPriceUsd : 1;
      if (pos.currentMarketCapUsd > 0) pos.currentMarketCapUsd = Math.round(pos.currentMarketCapUsd * ratio);
      pos.currentPriceUsd = price;
      pos.priceUpdatedAt = at;
      pos.priceSource = 'on-chain fill';
      if (price > pos.peakPriceUsd) pos.peakPriceUsd = price;
      if (pos.currentMarketCapUsd > (pos.peakMarketCapUsd || 0)) pos.peakMarketCapUsd = pos.currentMarketCapUsd;
    }
  }

  /**
   * Real on-chain fills beat market-data feeds, which lag fast pump.fun moves by 30-60 s.
   * A feed quote is ignored when a real fill says otherwise:
   *   - fill in the last 60 s: the quote must be within 25% of it
   *   - fill in the last 2 min: within 2x
   * (A lagging quote used to drag positions back to an old price, faking a crash that fired
   * trailing stops and floors.)
   */
  quoteAgreesWithChain(mint, quotePriceUsd, now = Date.now()) {
    const last = this.lastTradePrice?.get(mint);
    if (!last) return true;
    const age = now - last.at;
    if (age > 120_000) return true;
    const r = quotePriceUsd / last.priceUsd;
    if (age <= 60_000) return r <= 1.25 && r >= 0.75;
    return r <= 2 && r >= 0.5;
  }

  /**
   * Batched live quotes from DexScreener. Picks each token's deepest pool where it is the
   * base token, so the price matches what the trader and a copy would actually trade at.
   */
  async fetchLivePrices(mints) {
    const out = new Map();
    if (!mints.length || typeof fetch !== 'function') return out;
    const fetchImpl = this.priceFetch || fetch;
    for (let i = 0; i < mints.length; i += 30) {
      const chunk = mints.slice(i, i + 30);
      try {
        const res = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${chunk.map(encodeURIComponent).join(',')}`);
        if (!res.ok) {
          this.priceFeed = { ...(this.priceFeed || {}), lastError: `Price feed HTTP ${res.status}`, lastErrorAt: Date.now() };
          continue;
        }
        const data = await res.json();
        this.priceFeed = { ...(this.priceFeed || {}), lastOkAt: Date.now() };
        for (const pair of Array.isArray(data?.pairs) ? data.pairs : []) {
          const mint = pair?.baseToken?.address;
          if (!chunk.includes(mint) || !(Number(pair.priceUsd) > 0)) continue;
          const liq = Number(pair.liquidity?.usd || 0);
          const prev = out.get(mint);
          if (!prev || liq > prev.liquidityUsd) {
            out.set(mint, { priceUsd: Number(pair.priceUsd), marketCapUsd: Number(pair.marketCap || pair.fdv || 0), liquidityUsd: liq });
          }
        }
      } catch (err) {
        // network hiccup: positions keep their last live price
        this.priceFeed = { ...(this.priceFeed || {}), lastError: `Price feed unreachable (${err.message})`, lastErrorAt: Date.now() };
      }
    }
    return out;
  }

  async tickMarketPrices(customMultiplierByPosId = null) {
    const now = Date.now();
    const openPositions = this.positions.filter((p) => p.remainingTokens > 0);
    if (openPositions.length === 0) return;

    // Live prices for real token addresses: one batched DexScreener call (≤30 tokens each)
    const realMints = [...new Set(openPositions.filter((p) => p.tokenAddress && p.tokenAddress.length >= 32).map((p) => p.tokenAddress))];
    // pump.fun tokens still on their bonding curve: exact live numbers from the chain (fresher
    // than DexScreener, and the only real liquidity figure for them)
    let curves = new Map();
    let curvesFailed = false;
    if (!customMultiplierByPosId && typeof this.curveSource === 'function') {
      const pumpMints = realMints.filter((m) => /pump$/i.test(m) || openPositions.some((p) => p.tokenAddress === m && (p.venue === 'pumpfun' || p.launchpad === 'pump.fun' || p.stage === 'pre-grad')));
      if (pumpMints.length) {
        try {
          curves = await this.curveSource(pumpMints);
        } catch {
          curves = new Map();
          curvesFailed = true;
        }
      }
    }
    // a pump.fun coin whose curve was read fine but is gone has graduated to PumpSwap
    if (!customMultiplierByPosId && !curvesFailed && typeof this.curveSource === 'function') {
      for (const p of openPositions) if (p.stage === 'pre-grad' && (/pump$/i.test(p.tokenAddress || '') || p.venue === 'pumpfun') && !curves.has(p.tokenAddress)) p.stage = 'graduated';
    }
    const live = customMultiplierByPosId ? new Map() : await this.fetchLivePrices(realMints.filter((m) => !curves.has(m)));

    for (const pos of openPositions) {
      const quote = live.get(pos.tokenAddress);
      const curve = curves.get(pos.tokenAddress);
      if (curve) {
        pos.stage = 'pre-grad';
        pos.currentPriceUsd = curve.priceUsd;
        pos.currentMarketCapUsd = Math.round(curve.marketCapUsd);
        pos.liquidityUsd = Math.round(curve.liquidityUsd);
        pos.priceUpdatedAt = now;
        pos.priceSource = 'pump-curve';
      } else if (customMultiplierByPosId && customMultiplierByPosId[pos.id] !== undefined) {
        const mult = customMultiplierByPosId[pos.id];
        pos.currentPriceUsd = Number((pos.currentPriceUsd * mult).toFixed(8));
        pos.currentMarketCapUsd = Math.round(pos.currentMarketCapUsd * mult);
      } else if (curvesFailed && pos.priceSource === 'pump-curve') {
        // curve read failed this tick: keep the last exact curve price rather than a lagging feed
      } else if (quote && this.quoteAgreesWithChain(pos.tokenAddress, quote.priceUsd, now)) {
        pos.currentPriceUsd = quote.priceUsd;
        if (quote.marketCapUsd) pos.currentMarketCapUsd = Math.round(quote.marketCapUsd);
        if (quote.liquidityUsd) pos.liquidityUsd = Math.round(quote.liquidityUsd);
        pos.priceUpdatedAt = now;
        pos.priceSource = 'dexscreener';
      } else if (pos.tokenAddress && pos.tokenAddress.length >= 32) {
        // Real token but no fresh quote this tick: keep the last live price (never invent one)
      } else if (pos.isPaper || this.settings.paperTrading) {
        // Developer test tokens only (no real address): small random drift
        const drift = 1 + (Math.random() * 0.02 - 0.009);
        pos.currentPriceUsd = Number((pos.currentPriceUsd * drift).toFixed(8));
        pos.currentMarketCapUsd = Math.round(pos.currentMarketCapUsd * drift);
      }

      if (pos.currentPriceUsd > pos.peakPriceUsd) {
        pos.peakPriceUsd = pos.currentPriceUsd;
      }
      if (pos.currentMarketCapUsd > pos.peakMarketCapUsd) {
        pos.peakMarketCapUsd = pos.currentMarketCapUsd;
      }

      await this.evaluatePositionExits(pos, now);
    }
    this.emit('market_tick', { timestamp: now });
  }

  /** Clears the History list only (positions, balances and follows are untouched). */
  clearHistory() {
    const removed = this.history.length;
    const closedBefore = this.positions.length;
    this.history = [];
    // Finished (fully sold) trades are dropped too; open positions are kept
    this.positions = this.positions.filter((p) => p.remainingTokens > 0);
    const closedRemoved = closedBefore - this.positions.length;
    this.emit('history_cleared', { removed, closedRemoved });
    return { removed, closedRemoved };
  }

  resetToCleanState() {
    for (const w of this.wallets) {
      w.balances = {
        solana: { native: 0, stable: 0 },
        bsc: { native: 0, stable: 0 },
        robinhood: { native: 0, stable: 0 },
        arc: { native: 0, stable: 0 },
      };
      w.paperLedger = [{ t: Date.now(), type: 'full reset', beforeUsd: Number(w.paperBalanceUsd ?? 10000), afterUsd: 10000, changeUsd: Number((10000 - Number(w.paperBalanceUsd ?? 10000)).toFixed(2)) }];
      w.paperBalanceUsd = 10000.0;
    }
    this.follows = [];
    this.positions = [];
    this.history = [];
    this.alerts = [];
    this.realizedLog = [];
    this.copiedCycles = {};
    this.buyCooldownMap.clear();
    this.emit('state_reset', {});
    return this.getStateSnapshot();
  }

  /**
   * Realized PnL per day for one month (PnL calendar). tzOffsetMin = the browser's
   * getTimezoneOffset() (0 for UTC), so days match the user's own calendar.
   */
  pnlCalendar({ year, month, tzOffsetMin = 0, paper = true } = {}) {
    const y = Number(year);
    const m = Number(month); // 1–12
    const shift = -Number(tzOffsetMin || 0) * 60_000; // UTC → local
    const days = {};
    const wins = { count: 0, usd: 0 };
    const losses = { count: 0, usd: 0 };
    let first = null;
    for (const r of this.realizedLog || []) {
      if (Boolean(r.paper) !== Boolean(paper) || !Number.isFinite(r.pnl)) continue;
      const d = new Date(r.t + shift);
      if (first === null || r.t < first) first = r.t;
      if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m) continue;
      const day = d.getUTCDate();
      const cell = days[day] || (days[day] = { pnl: 0, trades: 0, wins: 0, losses: 0 });
      cell.pnl += r.pnl;
      cell.trades += 1;
      if (r.pnl > 0) {
        cell.wins += 1;
        wins.count += 1;
        wins.usd += r.pnl;
      } else if (r.pnl < 0) {
        cell.losses += 1;
        losses.count += 1;
        losses.usd += r.pnl;
      }
    }
    let best = null;
    let worst = null;
    for (const [day, c] of Object.entries(days)) {
      c.pnl = Number(c.pnl.toFixed(2));
      if (!best || c.pnl > best.pnl) best = { day: Number(day), pnl: c.pnl };
      if (!worst || c.pnl < worst.pnl) worst = { day: Number(day), pnl: c.pnl };
    }
    const total = Object.values(days).reduce((a, c) => a + c.pnl, 0);
    return {
      year: y,
      month: m,
      paper: Boolean(paper),
      days,
      total: Number(total.toFixed(2)),
      wins: { count: wins.count, usd: Number(wins.usd.toFixed(2)) },
      losses: { count: losses.count, usd: Number(losses.usd.toFixed(2)) },
      best: best && best.pnl > 0 ? best : null,
      worst: worst && worst.pnl < 0 ? worst : null,
      firstTradeAt: first,
    };
  }

  /**
   * Trader positions we have copied (follow + coin), so top-ups aren't copied as new positions.
   * Ends when the trader sells 100%, or after 2 h (in case their sell was never seen).
   */
  copiedCycleActive(followId, mint) {
    const c = this.copiedCycles?.[`${followId}:${mint}`];
    if (!c) return false;
    if (Date.now() - c > 2 * 3600_000) {
      delete this.copiedCycles[`${followId}:${mint}`];
      return false;
    }
    return true;
  }

  markCopiedCycle(followId, mint) {
    if (!mint) return;
    if (!this.copiedCycles) this.copiedCycles = {};
    const k = `${followId}:${mint}`;
    if (!this.copiedCycles[k]) this.copiedCycles[k] = Date.now();
  }

  endCopiedCycle(followId, mint) {
    if (this.copiedCycles) delete this.copiedCycles[`${followId}:${mint}`];
  }

  /** A real sell that did not go through: alert (once a minute per position), nothing booked. */
  realSellFailed(pos, error, execResult = null) {
    const now = Date.now();
    // tokens gone from the bot wallet (sold or moved outside the bot): after 3 checks in a row,
    // stop retrying and tell the user once
    if (execResult?.noTokens) {
      pos.realMissingChecks = (pos.realMissingChecks || 0) + 1;
      if (pos.realMissingChecks >= 3 && !pos.realTokensMissing) {
        pos.realTokensMissing = true;
        this.alerts.unshift({
          id: `alt-${randomUUID().slice(0, 8)}`,
          level: 'danger',
          title: `$${pos.symbol}: tokens are no longer in the bot wallet`,
          message: 'They were sold or moved outside Odex Mirror. Automatic exits for this position are paused.',
          timestamp: now,
        });
        this.emit('alerts_updated', {});
      }
      return { ok: false, error, realFailed: true };
    }
    pos.realMissingChecks = 0;
    if (!execResult?.backoff && (!pos.lastSellBlockedAlertAt || now - pos.lastSellBlockedAlertAt > 60_000 || execResult?.unknown)) {
      pos.lastSellBlockedAlertAt = now;
      this.alerts.unshift({
        id: `alt-${randomUUID().slice(0, 8)}`,
        level: 'danger',
        title: execResult?.unknown ? `REAL sell result unknown — check wallet ($${pos.symbol})` : `Real sell not executed ($${pos.symbol})`,
        message: `${error}. The position stays open and the exit will be retried.`,
        timestamp: now,
      });
      this.emit('alerts_updated', {});
    }
    return { ok: false, error, realFailed: true };
  }

  /**
   * Paper buys only: the price a copy is quoted at is never below the trader's own fill, nor
   * below our own paper buy of the same token in the last 30 s.
   */
  paperBuyPriceFloor(chainId, token) {
    const own = this.recentOwnBuys?.get(`${chainId}:${token.address}`);
    const ownPx = own && Date.now() - own.at < 30_000 ? Number(own.priceUsd) || 0 : 0;
    const floor = Math.max(Number(token.traderFillPriceUsd) || 0, ownPx);
    const market = Number(token.currentPriceUsd) || 0;
    return floor > market ? { ...token, currentPriceUsd: floor } : token;
  }

  /** Fees selling this position now would cost: platform fee (1%, min $0.30) + network fee. */
  estimateExitFeesUsd(p, valueUsd) {
    if (!(valueUsd > 0)) return 0;
    const gasFn = typeof this.adapter.estimateNetworkFeeUsd === 'function' ? (g) => this.adapter.estimateNetworkFeeUsd(p.chainId, this.settings.priorityFee, g) : () => 0;
    if (p.chainId === 'solana') {
      const pct = solanaTradeFeePct({ address: p.tokenAddress, stage: p.stage, launchpad: p.launchpad, marketCapUsd: p.currentMarketCapUsd, createdAt: p.tokenCreatedAt, venue: p.venue }).totalPct;
      return valueUsd * (pct / 100) + gasFn(false);
    }
    const gasless = p.chainId !== 'arc' && p.tradingAssetUsed === 'stable';
    return Math.max(0.3, valueUsd * 0.01) + gasFn(gasless);
  }

  getStateSnapshot() {
    this.getDefaultWallet(); // older saves: mark the first wallet as the default
    const openPositions = this.positions.filter((p) => p.remainingTokens > 0);
    let totalOpenValueUsd = 0;
    let totalOpenCostUsd = 0;
    let totalExitFeesUsd = 0;

    const enrichedPositions = openPositions.map((p) => {
      const valueUsd = p.remainingTokens * p.currentPriceUsd;
      // open PnL = what selling now would return (after the sell fee and gas), minus cost
      const exitFeesUsd = this.estimateExitFeesUsd(p, valueUsd);
      totalExitFeesUsd += exitFeesUsd;
      const unrealizedPnlUsd = valueUsd - exitFeesUsd - p.remainingCostUsd;
      const unrealizedPnlPct = p.remainingCostUsd > 0 ? (unrealizedPnlUsd / p.remainingCostUsd) * 100 : 0;
      totalOpenValueUsd += valueUsd;
      totalOpenCostUsd += p.remainingCostUsd;
      return {
        ...p,
        valueUsd: Number(valueUsd.toFixed(2)),
        exitFeesUsd: Number(exitFeesUsd.toFixed(2)),
        unrealizedPnlUsd: Number(unrealizedPnlUsd.toFixed(2)),
        unrealizedPnlPct: Number(unrealizedPnlPct.toFixed(2)),
        ageSec: Math.max(0, Math.floor((Date.now() - p.openedAt) / 1000)),
      };
    });

    // Closed trades: what was bought, what came back, the result
    const closedPositions = this.positions
      .filter((p) => p.remainingTokens <= 0)
      .map((p) => {
        const boughtUsd = Number(p.initialCostUsd || 0);
        // older records have no soldUsd: proceeds = cost + realized PnL (exact, same maths)
        const soldUsd = p.soldUsd != null ? Number(p.soldUsd) : boughtUsd + Number(p.realizedPnlUsd || 0);
        const pnlUsd = soldUsd - boughtUsd;
        const lastSell = this.history.find((h) => h.side === 'sell' && h.status === 'filled' && h.tokenAddress === p.tokenAddress && h.timestamp >= p.openedAt);
        return {
          id: p.id,
          followId: p.followId,
          traderHandle: p.traderHandle,
          traderWallet: p.traderWallet || null,
          chainId: p.chainId,
          isPaper: p.isPaper,
          tokenAddress: p.tokenAddress,
          symbol: p.symbol,
          name: p.name,
          imageUrl: p.imageUrl || null,
          boughtUsd: Number(boughtUsd.toFixed(2)),
          boughtTokens: Number(p.initialTokens || 0),
          soldUsd: Number(soldUsd.toFixed(2)),
          soldTokens: Number(p.soldTokens != null ? p.soldTokens : p.initialTokens || 0),
          pnlUsd: Number(pnlUsd.toFixed(2)),
          pnlPct: boughtUsd > 0 ? Number(((pnlUsd / boughtUsd) * 100).toFixed(2)) : 0,
          openedAt: p.openedAt,
          closedAt: p.closedAt || p.lastSellAt || lastSell?.timestamp || null,
          closeCause: p.closeCause || lastSell?.cause || null,
          entryMarketCapUsd: p.entryMarketCapUsd,
          ...closedSol(p, boughtUsd, soldUsd),
        };
      })
      .sort((a, b) => (b.closedAt || b.openedAt) - (a.closedAt || a.openedAt))
      .slice(0, 300);

    const totalUnrealizedPnlUsd = totalOpenValueUsd - totalExitFeesUsd - totalOpenCostUsd;
    const totalUnrealizedPnlPct =
      totalOpenCostUsd > 0 ? (totalUnrealizedPnlUsd / totalOpenCostUsd) * 100 : 0;

    return {
      chains: CHAINS,
      wallets: this.wallets,
      activeWalletId: this.getActiveWallet()?.id,
      settings: this.settings,
      follows: this.follows,
      positions: enrichedPositions,
      closedPositions,
      positionsSummary: {
        openCount: enrichedPositions.length,
        totalValueUsd: Number(totalOpenValueUsd.toFixed(2)),
        totalCostUsd: Number(totalOpenCostUsd.toFixed(2)),
        unrealizedPnlUsd: Number(totalUnrealizedPnlUsd.toFixed(2)),
        unrealizedPnlPct: Number(totalUnrealizedPnlPct.toFixed(2)),
      },
      history: this.history.slice(0, 100),
      alerts: this.alerts.slice(0, 30),
    };
  }
}
