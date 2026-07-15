"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  PauseCircle,
  PlayCircle,
  Radar,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  WalletCards
} from "lucide-react";
import type { BotSettings } from "@/lib/bot-settings";
import {
  AI_AUTOPILOT_PROFILES,
  AI_AUTOPILOT_PROFILE_NAMES,
  applyAiAutopilotProfile,
  type AiAutopilotProfile
} from "@/lib/ai-agent/autopilot-profiles";

type AiMode = "demo" | "live";
type AiSettings = BotSettings["aiAgent"];

type ScannerCandidate = {
  id: string;
  symbol: string;
  confidencePercent: number;
  expectedEdgeBps: number;
  estimatedNetProfitToman: number;
  capitalToman: number;
  gatePassed: boolean;
};

type AiAgentSnapshot = {
  fetchedAt: number;
  runtime: {
    running: boolean;
    inFlight: boolean;
    lastTickAt: number | null;
    lastOutcome: string | null;
    lastError: string | null;
  };
  scanner?: {
    scannedAt?: number | null;
    lastScanAt?: number | null;
    scannedIrtBooks?: number;
    actionableCount?: number;
    candidates?: ScannerCandidate[];
    rejectionSummary?: Record<string, number>;
    recentRejections?: Array<{ symbol: string; reason: string; detail?: string }>;
    lastError?: string | null;
    latest?: AiAgentSnapshot["scanner"];
  };
  autopilot?: {
    profile: AiAutopilotProfile;
    profileLabel: string;
    protection: {
      active: boolean;
      scope: "global" | "pair" | "none";
      blockers: string[];
      until: number | null;
    };
  };
  model: {
    version: string;
    trainingSamples: number;
    predictionAccuracyPercent: number | null;
    readyForLive: boolean;
    blockers: string[];
  };
  demo: {
    initialCapitalToman: number;
    cashToman: number;
    equityToman: number;
    realizedPnlToman: number;
    unrealizedPnlToman: number;
    returnPercent: number;
    tradeCount: number;
    learningSampleCount: number;
    winCount: number;
    winRatePercent: number;
    maxDrawdownToman: number;
    openPositions: Array<{
      id: string;
      symbol: string;
      openedAt: number;
      inputToman: number;
      predictionProbability: number;
      learningOnly?: boolean;
    }>;
    recentTrades: Array<{
      id: string;
      symbol: string;
      closedAt: number;
      pnlToman: number;
      exitReason: string;
      learningOnly?: boolean;
    }>;
  };
  live: {
    requested: boolean;
    canExecute: boolean;
    masterArmed: boolean;
    blockers: string[];
    decisions: Array<{
      id: string;
      at: number;
      mode: AiMode;
      action: string;
      symbol?: string;
      detail?: string;
    }>;
  };
};

type ActivityItem = {
  id: string;
  at: number;
  title: string;
  detail: string;
  value?: string;
  tone: "positive" | "negative" | "neutral";
};

const blockerLabel: Record<string, string> = {
  "agent-disabled": "دستیار خاموش است",
  "demo-mode": "حالت Live انتخاب نشده است",
  "master-disarmed": "اجرای کلی معاملات واقعی خاموش است",
  "emergency-stop-active": "توقف اضطراری فعال است",
  "insufficient-training-samples": "مدل هنوز تجربه کافی ندارد",
  "prediction-accuracy-below-threshold": "کیفیت اخیر مدل کافی نیست",
  "demo-not-profitable": "نتیجه Demo هنوز مثبت نشده است",
  "no-risk-ready-engine": "کنترل ریسک آماده نیست",
  "no-risk-ready-ai-agent": "کنترل ریسک دستیار آماده نیست",
  "live-owner-not-held": "سرویس اجرای واقعی در دسترس نیست",
  "live-owner-held-by-another-runtime": "اجرای واقعی روی سرویس دیگری فعال است",
  "autopilot-loss-streak-pause": "پس از چند زیان، ورود جدید موقتاً متوقف شده است",
  "autopilot-drawdown-pause": "محافظ افت سرمایه ورود جدید را موقتاً متوقف کرده است",
  "autopilot-low-profit-pair": "این بازار به‌دلیل عملکرد ضعیف موقتاً کنار گذاشته شده است",
  "autopilot-pair-cooldown": "این بازار در دوره استراحت پس از معامله است",
  "no-qualified-live-candidate": "فعلاً فرصت مناسب اجرای واقعی وجود ندارد"
};

const rejectionLabel: Record<string, string> = {
  "stale-book": "داده قدیمی",
  "empty-book": "اردربوک ناقص",
  "insufficient-levels": "عمق ناکافی",
  "spread-too-wide": "هزینه ورود زیاد",
  "impact-too-high": "اثر قیمت زیاد",
  "insufficient-visible-depth": "نقدشوندگی کم",
  "insufficient-history": "سابقه زمانی ناکافی",
  "imbalance-too-weak": "فشار بازار ضعیف",
  "top-level-concentration": "تمرکز مشکوک سفارش‌ها",
  "non-bullish-order-flow": "جریان سفارش تأیید نشد",
  "low-liquidity-retention": "نقدینگی پایدار نبود",
  "low-persistence": "سیگنال پایدار نبود",
  "persistence-too-short": "سیگنال کوتاه بود",
  "low-confidence": "کیفیت فرصت پایین بود",
  "edge-below-threshold": "سود احتمالی هزینه‌ها را پوشش نمی‌داد"
};

const format = (value: number, digits = 0) => new Intl.NumberFormat("fa-IR", {
  maximumFractionDigits: digits
}).format(Number.isFinite(value) ? value : 0);

const formatInput = (value: number) => new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
}).format(value);

export default function AiAgentCenter({
  settings,
  saving,
  saved,
  onChange,
  onOpenRisk
}: {
  settings: AiSettings;
  saving: boolean;
  saved: boolean;
  onChange: (settings: AiSettings) => void;
  onOpenRisk: () => void;
}) {
  const [snapshot, setSnapshot] = useState<AiAgentSnapshot>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/ai-agent", { cache: "no-store" });
      const payload = await response.json() as AiAgentSnapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "دریافت وضعیت دستیار ناموفق بود");
      setSnapshot(payload);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "ارتباط با دستیار قطع است");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const activeMode = !settings.enabled ? "off" : settings.mode;
  const scannerEnvelope = snapshot?.scanner;
  const scanner = scannerEnvelope?.latest ?? scannerEnvelope;
  const candidates = scanner?.candidates ?? [];
  const bestCandidate = candidates.find(candidate => candidate.gatePassed) ?? candidates[0];
  const blockers = snapshot?.live.blockers ?? snapshot?.model.blockers ?? [];
  const protection = snapshot?.autopilot?.protection;
  const profile = settings.autopilotProfile;
  const recentActivity = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = [];
    for (const position of snapshot?.demo.openPositions ?? []) {
      items.push({
        id: `position:${position.id}`,
        at: position.openedAt,
        title: position.learningOnly
          ? `نمونه آموزشی ${position.symbol} در حال بررسی است`
          : `معامله آزمایشی ${position.symbol} باز شد`,
        detail: position.learningOnly
          ? "بدون مصرف سرمایه Demo؛ فقط برای یادگیری مدل"
          : "مدل در حال پایش خروج مناسب است",
        value: position.learningOnly ? undefined : `${format(position.inputToman)} USDT`,
        tone: "neutral"
      });
    }
    for (const trade of snapshot?.demo.recentTrades ?? []) {
      items.push({
        id: `trade:${trade.id}`,
        at: trade.closedAt,
        title: trade.learningOnly
          ? `نمونه آموزشی ${trade.symbol} تکمیل شد`
          : `معامله آزمایشی ${trade.symbol} بسته شد`,
        detail: trade.learningOnly ? `نتیجه فرضی · ${exitLabel(trade.exitReason)}` : exitLabel(trade.exitReason),
        value: trade.learningOnly
          ? undefined
          : `${trade.pnlToman >= 0 ? "+" : ""}${format(trade.pnlToman)} USDT`,
        tone: trade.learningOnly ? "neutral" : trade.pnlToman >= 0 ? "positive" : "negative"
      });
    }
    for (const decision of snapshot?.live.decisions ?? []) {
      items.push({
        id: `live:${decision.id}`,
        at: decision.at,
        title: decision.symbol ? `تصمیم واقعی برای ${decision.symbol}` : "تصمیم اجرای واقعی",
        detail: decisionLabel(decision.action),
        tone: "neutral"
      });
    }
    return items.sort((left, right) => right.at - left.at).slice(0, 8);
  }, [snapshot?.demo.openPositions, snapshot?.demo.recentTrades, snapshot?.live.decisions]);

  const rejectionSummary = useMemo(() => {
    if (scanner?.rejectionSummary) {
      return Object.entries(scanner.rejectionSummary)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 6);
    }
    const counts = new Map<string, number>();
    for (const rejection of scanner?.recentRejections ?? []) {
      counts.set(rejection.reason, (counts.get(rejection.reason) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6);
  }, [scanner?.recentRejections, scanner?.rejectionSummary]);

  function setMode(mode: AiMode) {
    if (mode === "live" && !window.confirm(
      "در حالت Live، دستیار پس از عبور از همه محافظ‌های سرور می‌تواند بدون تأیید تک‌تک معاملات سفارش واقعی ارسال کند. فعال شود؟"
    )) return;
    onChange({ ...settings, enabled: true, mode });
  }

  function setProfile(nextProfile: AiAutopilotProfile) {
    onChange(applyAiAutopilotProfile({ ...settings, autopilotProfile: nextProfile }));
  }

  function updateCapital(raw: string) {
    const parsed = Number(raw.replace(/[٬,\s]/g, ""));
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    if (activeMode === "live") {
      onChange({ ...settings, maxLiveCapitalToman: parsed });
      return;
    }
    onChange({
      ...settings,
      demoCapitalToman: parsed,
      demoTradeCapitalToman: Math.min(parsed, settings.demoTradeCapitalToman)
    });
  }

  async function resetLearning() {
    if (!window.confirm("سرمایه و تاریخچه Demo و مدل آنلاین از ابتدا ساخته شوند؟ اطلاعات معاملات واقعی حذف نمی‌شود.")) return;
    try {
      setResetting(true);
      const response = await fetch("/api/ai-agent", {
        method: "DELETE",
        headers: { "x-ai-agent-action": "reset-demo-learning" }
      });
      const payload = await response.json() as AiAgentSnapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "شروع دوباره ناموفق بود");
      setSnapshot(payload);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "شروع دوباره ناموفق بود");
    } finally {
      setResetting(false);
    }
  }

  const capitalValue = activeMode === "live"
    ? settings.maxLiveCapitalToman
    : settings.demoCapitalToman;

  return <section className="ai-console">
    <header className="panel ai-console-hero">
      <div className="ai-console-brand"><BrainCircuit/><div><span className="eyebrow">AI AUTOPILOT</span><h2>دستیار هوشمند بیت‌گت</h2><p>بازار را بررسی می‌کند، در Demo یاد می‌گیرد و فقط فرصت‌های تأییدشده را به اجرای امن می‌فرستد.</p></div></div>
      <div className="ai-console-actions"><button type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? "spin" : ""}/>به‌روزرسانی</button><span className={`ai-console-state ${activeMode}`}><i/>{activeMode === "live" ? "معامله واقعی" : activeMode === "demo" ? "یادگیری Demo" : "خاموش"}</span></div>
    </header>

    {error && <div className="ai-error"><AlertTriangle/>{error}</div>}

    <section className="panel ai-command-card">
      <header><div><span className="eyebrow">QUICK CONTROL</span><h3>کنترل اصلی</h3><p>فقط حالت کار، سبک تصمیم‌گیری و سقف سرمایه را مشخص کنید.</p></div><small>{saving ? "در حال ذخیره…" : saved ? "ذخیره شد" : ""}</small></header>

      <div className="ai-mode-simple" role="group" aria-label="حالت اجرای دستیار">
        <button type="button" className={activeMode === "off" ? "active off" : ""} onClick={() => onChange({ ...settings, enabled: false })}><PauseCircle/><span><b>خاموش</b><small>ورود جدید انجام نمی‌شود</small></span></button>
        <button type="button" className={activeMode === "demo" ? "active demo" : ""} onClick={() => setMode("demo")}><PlayCircle/><span><b>Demo</b><small>یادگیری با پول مجازی</small></span></button>
        <button type="button" className={activeMode === "live" ? "active live" : ""} onClick={() => setMode("live")}><ShieldCheck/><span><b>Live</b><small>معامله واقعی خودکار</small></span></button>
      </div>

      <div className="ai-command-options">
        <div className="ai-style-picker"><div className="ai-option-title"><b>سبک تصمیم‌گیری</b><small>دستیار جزئیات را خودکار تنظیم می‌کند</small></div><div>{AI_AUTOPILOT_PROFILE_NAMES.map(name => <button type="button" key={name} className={profile === name ? "active" : ""} onClick={() => setProfile(name)} aria-pressed={profile === name}><b>{AI_AUTOPILOT_PROFILES[name].label}</b><small>{AI_AUTOPILOT_PROFILES[name].description}</small></button>)}</div></div>
        <label className="ai-capital-simple"><span><b>{activeMode === "live" ? "سقف سرمایه واقعی" : "سرمایه آزمایشی"}</b><small>{activeMode === "live" ? "دستیار بسته به کیفیت فرصت معمولاً کمتر از این سقف استفاده می‌کند" : "پرتفوی مجازی برای یادگیری و ارزیابی"}</small></span><div><input inputMode="numeric" value={formatInput(capitalValue)} onChange={event => updateCapital(event.target.value)}/><em>USDT</em></div></label>
      </div>

      <div className="ai-autonomy-note"><Sparkles/><div><b>حالت خودکار فعال است</b><span>اسکن، انتخاب بازار، اندازه معامله، خروج و توقف‌های محافظتی توسط دستیار و کنترل ریسک سرور انجام می‌شوند.</span></div></div>
    </section>

    <section className="ai-health-strip">
      <article className={protection?.active ? "protected" : "healthy"}><ShieldCheck/><div><span>محافظ سرمایه</span><b>{protection?.active ? "توقف موقت ورود" : "فعال و بدون هشدار"}</b><small>{protection?.active ? describeBlocker(protection.blockers[0]) : "افت سرمایه، زیان متوالی و Cooldown پایش می‌شوند"}</small></div></article>
      <article className={snapshot?.model.readyForLive ? "healthy" : "learning"}><BrainCircuit/><div><span>مدل تصمیم‌گیری</span><b>{modelStage(snapshot)}</b><small>{snapshot?.model.readyForLive ? "برای ارزیابی Live سابقه کافی دارد" : "از نتیجه معاملات بسته‌شده Demo یاد می‌گیرد"}</small></div></article>
      <article className={scanner?.lastError ? "protected" : "healthy"}><Radar/><div><span>پایش بازار</span><b>{scanner?.scannedAt || scanner?.lastScanAt ? "در حال بررسی بازارهای مبتنی بر USDT" : "در انتظار اولین اسکن"}</b><small>{bestCandidate ? `بهترین وضعیت فعلی: ${candidateQuality(bestCandidate)}` : "فعلاً فرصت مناسبی دیده نشده است"}</small></div></article>
    </section>

    <div className="ai-overview-grid">
      <section className="panel ai-performance-card">
        <header><div><span className="eyebrow">DEMO PERFORMANCE</span><h3>نتیجه یادگیری</h3></div><TrendingUp/></header>
        <div className="ai-performance-main"><span>ارزش فعلی Demo</span><b>{snapshot ? `${format(snapshot.demo.equityToman)} USDT` : "—"}</b><small className={(snapshot?.demo.realizedPnlToman ?? 0) >= 0 ? "positive" : "negative"}>سود بسته‌شده: {snapshot ? `${format(snapshot.demo.realizedPnlToman)} USDT` : "—"}</small></div>
        <div className="ai-performance-mini"><span><WalletCards/><b>{snapshot ? `${format(snapshot.demo.cashToman)} USDT` : "—"}</b><small>نقد مجازی</small></span><span><Activity/><b>{snapshot ? format(snapshot.demo.learningSampleCount) : "—"}</b><small>نمونه یادگیری</small></span><span><CheckCircle2/><b>{snapshot ? `${format(snapshot.demo.winRatePercent, 1)}٪` : "—"}</b><small>موفقیت معاملات Demo</small></span></div>
      </section>

      <section className={`panel ai-opportunity-card ${bestCandidate?.gatePassed ? "ready" : "waiting"}`}>
        <header><div><span className="eyebrow">MARKET NOW</span><h3>وضعیت فرصت فعلی</h3></div><Radar/></header>
        {!bestCandidate ? <div className="ai-opportunity-empty"><Radar/><b>فعلاً فرصت مناسبی وجود ندارد</b><span>دستیار همچنان همه بازارهای مبتنی بر USDT را بررسی می‌کند.</span></div> : <div className="ai-opportunity-current"><span className={bestCandidate.gatePassed ? "ready" : "waiting"}>{bestCandidate.gatePassed ? "مناسب برای بررسی نهایی" : "فعلاً زیر نظر"}</span><b>{bestCandidate.symbol}</b><strong>{candidateQuality(bestCandidate)}</strong><p>{bestCandidate.gatePassed ? "اگر حالت Live و کنترل ریسک آماده باشند، قیمت و عمق دوباره بررسی می‌شوند." : "هنوز همه شروط نقدشوندگی و کیفیت را پاس نکرده است."}</p></div>}
      </section>
    </div>

    <section className="panel ai-activity-simple">
      <header><div><span className="eyebrow">ACTIVITY</span><h3>دستیار چه کاری انجام داده؟</h3></div><button type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? "spin" : ""}/>تازه‌سازی</button></header>
      <div>{recentActivity.length ? recentActivity.map(item => <article key={item.id}><i className={item.tone}/><div><b>{item.title}</b><small>{item.detail}</small></div>{item.value && <strong className={item.tone}>{item.value}</strong>}<time>{relativeTime(item.at)}</time></article>) : <div className="ai-empty-activity"><Activity/><b>هنوز فعالیتی ثبت نشده است</b><span>با روشن‌کردن Demo، اسکن و یادگیری خودکار آغاز می‌شود.</span></div>}</div>
    </section>

    <details className="panel ai-transparency">
      <summary><span><ShieldCheck/><span><b>گزارش شفاف و نگهداری</b><small>علت توقف‌ها، دلایل رد بازار و ابزار شروع دوباره</small></span></span><ChevronDown/></summary>
      <div className="ai-transparency-body">
        <section><h4>وضعیت اجرای واقعی</h4>{blockers.length ? <div className="ai-simple-blockers">{blockers.slice(0, 6).map(blocker => <span key={blocker}>{describeBlocker(blocker)}</span>)}</div> : <p className="ok">همه شرط‌های دستیار پاس شده‌اند.</p>}<button type="button" onClick={onOpenRisk}>باز کردن مرکز کنترل ریسک</button></section>
        <section><h4>چرا بازارها رد شدند؟</h4>{rejectionSummary.length ? <div className="ai-rejection-simple">{rejectionSummary.map(([reason, count]) => <span key={reason}><b>{rejectionLabel[reason] ?? reason}</b><small>{format(count)} بار</small></span>)}</div> : <p>هنوز گزارشی ثبت نشده است.</p>}</section>
        <section><h4>شروع دوباره Demo</h4><p>فقط پرتفوی مجازی و مدل آنلاین پاک می‌شوند؛ سوابق معاملات واقعی دست‌نخورده می‌مانند.</p><button type="button" className="danger" onClick={() => void resetLearning()} disabled={resetting || activeMode === "live"}><RotateCcw/>{resetting ? "در حال شروع دوباره…" : "شروع دوباره یادگیری Demo"}</button></section>
      </div>
    </details>
  </section>;
}

function describeBlocker(value?: string) {
  if (!value) return "در حال بررسی شرایط بازار";
  return blockerLabel[value] ?? value.replaceAll("-", " ");
}

function modelStage(snapshot?: AiAgentSnapshot) {
  if (!snapshot || snapshot.model.trainingSamples === 0) return "آماده شروع یادگیری";
  if (snapshot.model.readyForLive) return "ارزیابی‌شده";
  return "در حال یادگیری";
}

function candidateQuality(candidate: ScannerCandidate) {
  if (!candidate.gatePassed) return "نیازمند تأیید بیشتر";
  if (candidate.confidencePercent >= 75) return "کیفیت قوی";
  if (candidate.confidencePercent >= 60) return "کیفیت مناسب";
  return "کیفیت متوسط";
}

function exitLabel(reason: string) {
  if (reason === "take-profit") return "هدف سود فعال شد";
  if (reason === "stop-loss") return "حد ضرر فعال شد";
  if (reason === "max-hold") return "زمان نگهداری تمام شد";
  return reason;
}

function decisionLabel(action: string) {
  if (action === "executed") return "اجرای امن تکمیل شد";
  if (action === "rejected") return "کنترل نهایی معامله را رد کرد";
  if (action === "busy") return "اجرای دیگری در حال انجام بود";
  return action;
}

function relativeTime(at: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1_000));
  if (seconds < 60) return "همین حالا";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${format(minutes)} دقیقه پیش`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${format(hours)} ساعت پیش`;
  return new Date(at).toLocaleDateString("fa-IR");
}
