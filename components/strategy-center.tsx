"use client";

import { Activity, Gauge, Radio, ShieldAlert, SlidersHorizontal, Waves } from "lucide-react";
import type { StrategyLabSettings } from "@/lib/strategy-settings";

export type SerializedStrategySignal = {
  id: string;
  kind: "orderbook-gap" | "orderbook-imbalance";
  title: string;
  symbols: string[];
  action: string;
  status: "actionable" | "watch" | "blocked";
  paperOnly: true;
  expectedEdgeBps: string;
  estimatedNetProfitToman: string;
  confidence: string;
  reasons: string[];
  metrics: Record<string, string | number | boolean>;
  scannedAt: number;
};

export type StrategyLabResult = {
  scannedAt: number;
  signals: SerializedStrategySignal[];
  actionableCount: number;
  watchCount: number;
  enabledCount: number;
  diagnostics: Record<string, string | number | boolean>;
};

type Props = {
  settings: StrategyLabSettings;
  result?: StrategyLabResult;
  onChange: (settings: StrategyLabSettings) => void;
  saving?: boolean;
  saved?: boolean;
  only?: StrategyWorkspaceKey;
};

export type StrategyWorkspaceKey = "gapTrading" | "imbalance";

const fa = (value: string | number, digits = 0) => new Intl.NumberFormat("fa-IR", { maximumFractionDigits: digits }).format(Number(value));
const en = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value);
const labels = {
  "orderbook-gap": "Orderbook Gap",
  "orderbook-imbalance": "Orderbook Imbalance"
} as const;

function metricNumber(signal: SerializedStrategySignal, ...keys: string[]) {
  for (const key of keys) {
    const value = Number(signal.metrics[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function signalMetric(signal: SerializedStrategySignal) {
  if (signal.kind === "orderbook-imbalance") {
    const flow = metricNumber(signal, "directionalOrderFlow", "normalizedOrderFlow");
    const retention = metricNumber(signal, "dominantLiquidityRetentionPercent");
    const samples = metricNumber(signal, "orderFlowSampleCount");
    return {
      label: "Depth Ratio / MLOFI",
      value: `${fa(signal.metrics.ratio as number, 2)}×${flow === null ? "" : ` · ${fa(flow, 4)}`}`,
      note: `جریان ${samples === null ? "—" : fa(samples)} تغییر مستقل · ماندگاری نقدینگی ${retention === null ? "—" : `${fa(retention, 1)}٪`} · سود تضمین‌شده نیست`,
      directional: false
    };
  }
  if (signal.kind === "orderbook-gap") {
    const gap = metricNumber(signal, "gapBps");
    const robustZ = metricNumber(signal, "robustGapZScore", "gapZScore", "robustZScore", "robustZ");
    const persistence = metricNumber(signal, "persistenceMs");
    const preGapConsumption = metricNumber(signal, "plannedPreGapConsumptionPercent", "preGapConsumptionPercent");
    const flow = metricNumber(signal, "normalizedOrderFlow");
    const retention = metricNumber(signal, "bidLiquidityRetentionPercent");
    const projectedNet = metricNumber(signal, "projectedNetBps", "projectedNetEdgeBps", "netEdgeBps") ?? Number(signal.expectedEdgeBps);
    return {
      label: "Gap / Robust Z",
      value: `${gap === null ? "—" : fa(gap, 2)} BPS${robustZ === null ? "" : ` · Z ${fa(robustZ, 2)}`}`,
      note: `ماندگاری ${persistence === null ? "—" : `${fa(persistence)} ms`} · MLOFI ${flow === null ? "—" : fa(flow, 4)} · حفظ Bid ${retention === null ? "—" : `${fa(retention, 1)}٪`} · مصرف پیش از Gap ${preGapConsumption === null ? "—" : `${fa(preGapConsumption, 1)}٪`} · خالص مدل ${fa(projectedNet, 2)} BPS`,
      directional: true
    };
  }
  return {
    label: "Net Edge",
    value: `${fa(signal.expectedEdgeBps, 2)} BPS`,
    note: `سود تخمینی ${fa(signal.estimatedNetProfitToman)} USDT`,
    directional: true
  };
}

function signalStateLabel(signal: SerializedStrategySignal) {
  if (signal.kind === "orderbook-gap" && signal.status === "watch" && signal.metrics.analyticalSetupPassed === true) return "Setup سایه معتبر";
  if (signal.status === "actionable") return "آماده بررسی Paper";
  if (signal.status === "blocked") return "ردشده";
  return "زیر نظر";
}

export default function StrategyCenter({ settings, result, onChange, saving, saved, only }: Props) {
  const update = <K extends keyof StrategyLabSettings>(key: K, value: StrategyLabSettings[K]) => onChange({ ...settings, [key]: value });
  const updateSection = <K extends Exclude<keyof StrategyLabSettings, "enabled">>(section: K, patch: Partial<StrategyLabSettings[K]>) => {
    update(section, { ...settings[section], ...patch } as StrategyLabSettings[K]);
  };
  const grouped = (kind: SerializedStrategySignal["kind"]) => result?.signals.filter(signal => signal.kind === kind) ?? [];
  const best = (kind: SerializedStrategySignal["kind"]) => grouped(kind).sort((a, b) => Number(b.expectedEdgeBps) - Number(a.expectedEdgeBps))[0];
  const gapSetups = grouped("orderbook-gap").filter(signal => signal.status === "watch" && signal.metrics.analyticalSetupPassed === true);
  const bestGapSetup = [...gapSetups].sort((a, b) => Number(b.expectedEdgeBps) - Number(a.expectedEdgeBps))[0];
  const onlyKind = only && ({ gapTrading: "orderbook-gap", imbalance: "orderbook-imbalance" } as const)[only];
  const visibleSignals = result?.signals.filter(signal => !onlyKind || signal.kind === onlyKind) ?? [];

  return <section className={`strategy-center ${only ? `only-${only}` : ""}`} aria-labelledby="strategy-center-title">
    <div className="strategy-hero panel">
      <div><span className="eyebrow">{only ? "STRATEGY SETTINGS" : "MULTI-STRATEGY RESEARCH DESK"}</span><h2 id="strategy-center-title"><SlidersHorizontal/> {only ? "تنظیمات و سیگنال‌ها" : "مرکز استراتژی‌ها"}</h2><small className="strategy-save">{saving ? "در حال ذخیره تنظیمات…" : saved ? "تمام تغییرات ذخیره شد" : ""}</small></div>
      {!only && <div className="strategy-master"><span className={settings.enabled ? "status-dot online" : "status-dot"}/><div><b>{settings.enabled ? "اسکن Paper همه موتورها روشن" : "اسکن Paper همه موتورها متوقف"}</b><small>{result ? `${fa(result.enabledCount)} موتور · ${fa(result.actionableCount)} سیگنال آماده بررسی` : "در انتظار اولین اسکن"}</small></div><button type="button" className={`mini-toggle ${settings.enabled ? "on" : ""}`} onClick={() => update("enabled", !settings.enabled)} aria-pressed={settings.enabled}>{settings.enabled ? "توقف همه اسکن‌های Paper" : "شروع همه اسکن‌های Paper"}</button></div>}
    </div>

    <div className="strategy-grid">
      <StrategyCard anchor="strategy-orderbook-gap" icon={Gauge} tone="amber" title="شکاف نقدشوندگی اردربوک" english="Orderbook Gap / Liquidity Vacuum" family="Market Microstructure" enabled={settings.gapTrading.enabled} onToggle={() => updateSection("gapTrading", { enabled: !settings.gapTrading.enabled })} count={gapSetups.length} best={bestGapSetup} primaryLabel="بزرگ‌ترین Gap معتبر" primaryValue={bestGapSetup ? `${fa(bestGapSetup.metrics.gapBps as number, 2)} BPS` : "—"} risks={["False Gap", "Ephemeral Liquidity", "Feed Latency"]}>
        <div className="gap-venue-grid">
          <div className="gap-venue available"><span>SPOT ORDERBOOK</span><b>اجرای واقعی با کالیبراسیون</b><p>ورود فقط پس از تأیید چند Snapshot، نتیجه‌های آینده همان الگو، عمق رفت‌وبرگشت و بازاعتبارسنجی دو مرحله‌ای انجام می‌شود.</p></div>
          <div className="gap-venue unavailable"><span>OTC / EASY</span><b>داده قابل اتکا در دسترس نیست</b><p>OTC اردربوک عمومی و API رسمی پشتیبانی‌شده برای Quote/Execution ندارد؛ بنابراین Gap واقعی آن قابل سنجش یا اجرای امن نیست.</p></div>
        </div>
        <SettingsBand tone="live" title="تشخیص، کالیبراسیون و اجرای Spot" description="Gap به‌تنهایی فرصت سود نیست. ورود Live علاوه بر ساختار شکاف، به نتیجه‌های آینده مستقل، فشار Bid، Microprice، عمق رفت‌وبرگشت و خروج حفاظتی نیاز دارد."/>

        <StrategySettingGroup title="ساختار شکاف" english="GAP STRUCTURE" description="تعریف می‌کند کدام فاصله بین سطوح قیمت واقعاً غیرعادی محسوب شود.">
          <NumberField label="تعداد سطوح نزدیک" english="Active Levels" unit="سطح" value={settings.gapTrading.levels} help="بیشتر: شکاف‌های دورتر هم دیده می‌شوند، اما ارتباطشان با حرکت فوری قیمت ضعیف‌تر است." onChange={levels => updateSection("gapTrading", { levels })}/>
          <NumberField label="سطوح خط مبنا" english="Baseline Levels" unit="سطح" value={settings.gapTrading.baselineLevels} help="برای Median/MAD شکاف‌های همان اردربوک است. خیلی کم، Z-Score را ناپایدار می‌کند؛ خیلی زیاد، رژیم نزدیک قیمت را کمرنگ می‌کند." onChange={baselineLevels => updateSection("gapTrading", { baselineLevels })}/>
          <NumberField label="حداقل اندازه شکاف" english="Minimum Gap" unit="BPS" value={settings.gapTrading.minGapBps} help="افزایش آن سیگنال‌های کوچک و پرهزینه را حذف می‌کند؛ کاهش آن تعداد سیگنال و احتمال نویز را بالا می‌برد." onChange={minGapBps => updateSection("gapTrading", { minGapBps })}/>
          <NumberField label="حداقل امتیاز مقاوم" english="Robust Z-Score" unit="Z" value={settings.gapTrading.minGapZScore} help="شکاف را نسبت به Median/MAD همان کتاب می‌سنجد. مقدار بالاتر فقط ناهنجاری‌های آماری قوی‌تر را نگه می‌دارد." onChange={minGapZScore => updateSection("gapTrading", { minGapZScore })}/>
          <NumberField label="نسبت به شکاف معمول" english="Gap / Median Ratio" unit="×" value={settings.gapTrading.minGapRatio} help="مثلاً ۴ یعنی Gap باید دست‌کم چهار برابر فاصله معمول سطوح باشد؛ افزایش آن سیگنال کمتر و انتخابی‌تر می‌دهد." onChange={minGapRatio => updateSection("gapTrading", { minGapRatio })}/>
          <NumberField label="وزن سطوح دورتر" english="Level Weight Decay" unit="٪" value={settings.gapTrading.levelWeightDecayPercent} help="وزن هر Level دورتر نسبت به قبلی است. مقدار کمتر روی نقدینگی نزدیک قیمت تمرکز بیشتری دارد." onChange={levelWeightDecayPercent => updateSection("gapTrading", { levelWeightDecayPercent })}/>
        </StrategySettingGroup>

        <StrategySettingGroup title="تأیید زمانی و جهت حرکت" english="PERSISTENCE & DIRECTION" description="یک Snapshot منفرد کافی نیست؛ Gap باید بماند و جریان سفارش احتمال حرکت رو به بالا را تأیید کند.">
          <NumberField label="حداقل تأیید متوالی" english="Confirmations" unit="نمونه" value={settings.gapTrading.minConfirmations} help="بیشتر: مقاومت بهتر در برابر سفارش لحظه‌ای و Spoof؛ در عوض ورود دیرتر و سیگنال کمتر." onChange={minConfirmations => updateSection("gapTrading", { minConfirmations })}/>
          <NumberField label="پنجره نمونه‌ها" english="Sample Window" unit="ms" value={settings.gapTrading.sampleWindowMs} help="فقط Snapshotهای این بازه در تأیید Gap استفاده می‌شوند. پنجره بلندتر پایدارتر ولی کندتر است." onChange={sampleWindowMs => updateSection("gapTrading", { sampleWindowMs })}/>
          <NumberField label="حداقل ماندگاری" english="Minimum Persistence" unit="ms" value={settings.gapTrading.minPersistenceMs} help="Gap زودگذر پیش از این زمان رد می‌شود. مقدار خیلی کم برای اسکن REST قابل اتکا نیست." onChange={minPersistenceMs => updateSection("gapTrading", { minPersistenceMs })}/>
          <NumberField label="حداکثر عمر سیگنال" english="Maximum Persistence" unit="ms" value={settings.gapTrading.maxPersistenceMs} help="Gap قدیمی ممکن است دیگر اطلاعات تازه‌ای نداشته باشد؛ کوتاه‌تر کردن این زمان سیگنال‌های stale را زودتر حذف می‌کند." onChange={maxPersistenceMs => updateSection("gapTrading", { maxPersistenceMs })}/>
          <NumberField label="حداکثر تغییر اندازه Gap" english="Maximum Gap Drift" unit="٪" value={settings.gapTrading.maxGapDriftPercent} help="اگر اندازه Gap بین نمونه‌ها بیش از این درصد تغییر کند، ساختار ناپایدار تلقی می‌شود. مقدار کمتر سخت‌گیرانه‌تر است." onChange={maxGapDriftPercent => updateSection("gapTrading", { maxGapDriftPercent })}/>
          <NumberField label="جابجایی مرز شکاف" english="Boundary Drift" unit="BPS" value={settings.gapTrading.maxBoundaryDriftBps} help="قیمت دو Level سازنده Gap نباید بیش از این مقدار جابه‌جا شود. سقف پایین‌تر، Gapهای ناپایدار را زودتر رد می‌کند." onChange={maxBoundaryDriftBps => updateSection("gapTrading", { maxBoundaryDriftBps })}/>
          <NumberField label="حداقل تغییرات جریان" english="Flow Samples" unit="تغییر" value={settings.gapTrading.minFlowSamples} help="تعداد تغییر مستقل بین Snapshotها برای محاسبه MLOFI تقریبی. صفر این محافظ را خاموش می‌کند؛ مقدار بالاتر قابل‌اتکاتر ولی کندتر است." onChange={minFlowSamples => updateSection("gapTrading", { minFlowSamples })}/>
          <NumberField label="حداقل جریان سفارش" english="Snapshot MLOFI" unit="N-OFI" value={settings.gapTrading.minOrderFlowImbalance} help="افزوده‌شدن Bid و حذف Ask را در چند Level و بین Snapshotها می‌سنجد. بیشتر، فقط جریان صعودی قوی‌تر را می‌پذیرد؛ این معیار با فید REST تقریب MLOFI است، نه رویداد کامل صرافی." onChange={minOrderFlowImbalance => updateSection("gapTrading", { minOrderFlowImbalance })}/>
          <NumberField label="حداقل حمایت سمت خرید" english="Bid Support Ratio" unit="×" value={settings.gapTrading.minBidSupportRatio} help="نسبت عمق وزنی Bid به Ask است. بالاتر، تأیید صعود قوی‌تر ولی فرصت کمتر ایجاد می‌کند." onChange={minBidSupportRatio => updateSection("gapTrading", { minBidSupportRatio })}/>
          <NumberField label="سوگیری Microprice" english="Microprice Bias" unit="BPS" value={settings.gapTrading.minMicropriceBiasBps} help="Microprice باید بالاتر از Mid باشد. افزایش آن ورودهای هم‌جهت‌تر و دیرتر می‌دهد." onChange={minMicropriceBiasBps => updateSection("gapTrading", { minMicropriceBiasBps })}/>
        </StrategySettingGroup>

        <StrategySettingGroup title="کیفیت نقدشوندگی و ضد دست‌کاری" english="LIQUIDITY QUALITY" description="شکاف مصنوعی، عمق متمرکز و مصرف بیش‌ازحد سطح قبل از Gap را حذف می‌کند.">
          <NumberField label="حداقل ماندگاری نقدینگی Bid" english="Bid Liquidity Retention" unit="٪" value={settings.gapTrading.minBidLiquidityRetentionPercent} help="چه سهمی از سفارش‌های Bid قبلی روی همان قیمت باقی مانده است. مقدار بالاتر Wallهای زودگذر را بهتر حذف می‌کند، اما تغییر طبیعی اردربوک را هم سخت‌گیرانه‌تر می‌بیند." onChange={minBidLiquidityRetentionPercent => updateSection("gapTrading", { minBidLiquidityRetentionPercent })}/>
          <NumberField label="سقف تمرکز سطح اول" english="Top-Level Share" unit="٪" value={settings.gapTrading.maxTopLevelSharePercent} help="اگر بخش بزرگی از عمق فقط در یک Level باشد، ریسک Wall یا نقدینگی زودگذر بیشتر است. این معیار قصد Spoofing را اثبات نمی‌کند؛ مقدار کمتر سخت‌گیرانه‌تر است." onChange={maxTopLevelSharePercent => updateSection("gapTrading", { maxTopLevelSharePercent })}/>
          <NumberField label="حداکثر مصرف قبل از Gap" english="Pre-Gap Consumption" unit="٪" value={settings.gapTrading.maxPreGapConsumptionPercent} help="تخمین می‌زند ورود چه سهمی از نقدینگی پیش از شکاف را می‌خورد. مقدار کمتر اثر قیمت و خطر ایجاد حرکت توسط خود ربات را محدود می‌کند." onChange={maxPreGapConsumptionPercent => updateSection("gapTrading", { maxPreGapConsumptionPercent })}/>
          <NumberField label="حداقل عمق قابل مشاهده" english="Visible Depth" unit="USDT" value={settings.gapTrading.minVisibleDepthToman} help="افزایش آن بازارهای کم‌عمق را حذف می‌کند، ولی تعداد دارایی‌های قابل بررسی کاهش می‌یابد." onChange={minVisibleDepthToman => updateSection("gapTrading", { minVisibleDepthToman })}/>
          <NumberField label="حداکثر اسپرد ورود" english="Maximum Spread" unit="BPS" value={settings.gapTrading.maxSpreadBps} help="Gap داخل کتاب با Spread خریدوفروش فرق دارد؛ این سقف مانع ورود به بازاری می‌شود که هزینه عبور از Spread زیاد است." onChange={maxSpreadBps => updateSection("gapTrading", { maxSpreadBps })}/>
        </StrategySettingGroup>

        <StrategySettingGroup title="اقتصاد سیگنال و کالیبراسیون" english="EDGE & CALIBRATION" description="بازده مدل با نتیجه‌های آینده Snapshotهای قبلی مقایسه می‌شود؛ بدون نمونه و نرخ موفقیت کافی ورود واقعی انجام نمی‌شود.">
          <NumberField label="سهم قابل انتظار از Gap" english="Target Capture" unit="٪" value={settings.gapTrading.targetCapturePercent} help="فرض می‌کند چه درصدی از فاصله Gap واقعاً قابل برداشت است. مقدار بالاتر برآورد سود را خوش‌بینانه‌تر و پرریسک‌تر می‌کند." onChange={targetCapturePercent => updateSection("gapTrading", { targetCapturePercent })}/>
          <NumberField label="حداقل بازده خالص پیش‌بینی‌شده" english="Projected Net Edge" unit="BPS" value={settings.gapTrading.minProjectedNetBps} help="بعد از Spread، کارمزد، اثر قیمت و حاشیه خطا سنجیده می‌شود. افزایش آن سیگنال کمتر ولی حاشیه مدل بیشتر می‌دهد." onChange={minProjectedNetBps => updateSection("gapTrading", { minProjectedNetBps })}/>
          <NumberField label="حاشیه خطای مدل" english="Safety Buffer" unit="BPS" value={settings.gapTrading.safetyBufferBps} help="از بازده پیش‌بینی‌شده کم می‌شود تا خطای مدل و تأخیر پوشش داده شود. عدد بالاتر محافظه‌کارانه‌تر است." onChange={safetyBufferBps => updateSection("gapTrading", { safetyBufferBps })}/>
          <NumberField label="حداکثر اثر قیمت" english="Maximum Price Impact" unit="BPS" value={settings.gapTrading.maxPriceImpactBps} help="سقف اثر اجرای سرمایه آزمایشی بر قیمت است. کاهش آن اندازه‌های مخرب را حذف می‌کند." onChange={maxPriceImpactBps => updateSection("gapTrading", { maxPriceImpactBps })}/>
          <NumberField label="سهم قابل اتکا از عمق" english="Usable Depth" unit="٪" value={settings.gapTrading.depthUsagePercent} help="درصد بالاتر به حجم نمایشی بیشتری اعتماد می‌کند و خطر ناپدیدشدن نقدینگی را بالا می‌برد." onChange={depthUsagePercent => updateSection("gapTrading", { depthUsagePercent })}/>
          <NumberField label="سرمایه معامله" english="Live Capital" unit="USDT" value={settings.gapTrading.capitalToman} help="سرمایه واقعی هر پوزیشن؛ افزایش آن مصرف عمق، اثر قیمت و زیان بالقوه را بالا می‌برد." onChange={capitalToman => updateSection("gapTrading", { capitalToman })}/>
          <NumberField label="افق سنجش نتیجه" english="Prediction Horizon" unit="ms" value={settings.gapTrading.predictionHorizonMs} help="حرکت Mid پس از این فاصله، نتیجه تاریخی هر Gap محسوب می‌شود." onChange={predictionHorizonMs => updateSection("gapTrading", { predictionHorizonMs })}/>
          <NumberField label="حداقل نمونه نتیجه" english="Outcome Samples" unit="نمونه" value={settings.gapTrading.minOutcomeSamples} help="تا این تعداد نتیجه مستقل جمع نشود موتور سفارش واقعی نمی‌فرستد." onChange={minOutcomeSamples => updateSection("gapTrading", { minOutcomeSamples })}/>
          <NumberField label="حداقل نرخ موفقیت" english="Minimum Hit Rate" unit="٪" value={settings.gapTrading.minOutcomeHitRatePercent} help="درصد Gapهای قبلی که در افق تعیین‌شده حرکت مثبت ساخته‌اند؛ بالاتر سخت‌گیرانه‌تر است." onChange={minOutcomeHitRatePercent => updateSection("gapTrading", { minOutcomeHitRatePercent })}/>
          <NumberField label="حداقل بازده کالیبره" english="Predicted Net Edge" unit="BPS" value={settings.gapTrading.minPredictedNetBps} help="صدک محافظه‌کارانه نتیجه‌ها پس از کسر هزینه رفت‌وبرگشت و بافر پیش‌بینی." onChange={minPredictedNetBps => updateSection("gapTrading", { minPredictedNetBps })}/>
          <NumberField label="بافر پیش‌بینی" english="Forecast Safety" unit="BPS" value={settings.gapTrading.forecastSafetyBps} help="برای پوشش تأخیر و خطای مدل از نتیجه تاریخی کم می‌شود." onChange={forecastSafetyBps => updateSection("gapTrading", { forecastSafetyBps })}/>
        </StrategySettingGroup>

        <StrategySettingGroup title="خروج و بازیابی واقعی" english="LIVE EXIT & RECOVERY" description="پوزیشن با USDT باز می‌شود و با Take Profit، Stop، پایان Gap یا Time Stop دوباره به USDT بسته می‌شود.">
          <NumberField label="حد سود" english="Take Profit" unit="BPS" value={settings.gapTrading.takeProfitBps} help="هدف سود پوزیشن؛ مقدار بالاتر زمان نگهداری و احتمال برگشت سود را بیشتر می‌کند." onChange={takeProfitBps => updateSection("gapTrading", { takeProfitBps })}/>
          <NumberField label="حد ضرر" english="Stop Loss" unit="BPS" value={settings.gapTrading.stopLossBps} help="پیش از خرید، هزینه رفت‌وبرگشت باید با حاشیه کافی پایین‌تر از این حد باشد." onChange={stopLossBps => updateSection("gapTrading", { stopLossBps })}/>
          <NumberField label="حداکثر زیان" english="Max Loss" unit="USDT" value={settings.gapTrading.maxLossToman} help="سقف زیان مبتنی بر USDT مستقل از حد ضرر درصدی." onChange={maxLossToman => updateSection("gapTrading", { maxLossToman })}/>
          <NumberField label="حداکثر باقیمانده" english="Max Residual" unit="USDT" value={settings.gapTrading.maxResidualToman} help="اگر Dust برآوردی بعد از گردکردن بیش از این باشد، خرید از ابتدا رد می‌شود." onChange={maxResidualToman => updateSection("gapTrading", { maxResidualToman })}/>
          <NumberField label="حداکثر زمان نگهداری" english="Max Hold" unit="ms" value={settings.gapTrading.maxHoldMs} help="پس از این زمان خروج اجباری به USDT شروع می‌شود." onChange={maxHoldMs => updateSection("gapTrading", { maxHoldMs })}/>
          <NumberField label="فاصله پایش" english="Poll Interval" unit="ms" value={settings.gapTrading.pollIntervalMs} help="کمتر: خروج سریع‌تر و بار API بیشتر." onChange={pollIntervalMs => updateSection("gapTrading", { pollIntervalMs })}/>
          <NumberField label="وقفه ورود مجدد" english="Cooldown" unit="ms" value={settings.gapTrading.cooldownMs} help="از معامله مکرر همان Gap در فاصله کوتاه جلوگیری می‌کند." onChange={cooldownMs => updateSection("gapTrading", { cooldownMs })}/>
          <NumberField label="رزرو سفارش" english="Order Reserve" unit="BPS" value={settings.gapTrading.orderReserveBps} help="بخشی از سرمایه را برای حرکت قیمت بین محاسبه و ثبت سفارش رزرو می‌کند." onChange={orderReserveBps => updateSection("gapTrading", { orderReserveBps })}/>
          <NumberField label="اسپرد Recovery" english="Recovery Max Spread" unit="BPS" value={settings.gapTrading.recoveryMaxSpreadBps} help="سقف اضطراری اسپرد برای بستن پوزیشن باز." onChange={recoveryMaxSpreadBps => updateSection("gapTrading", { recoveryMaxSpreadBps })}/>
          <NumberField label="اثر قیمت Recovery" english="Recovery Max Impact" unit="BPS" value={settings.gapTrading.recoveryMaxPriceImpactBps} help="سقف اثر قیمت در خروج اضطراری." onChange={recoveryMaxPriceImpactBps => updateSection("gapTrading", { recoveryMaxPriceImpactBps })}/>
          <NumberField label="لغزش Recovery" english="Recovery Slippage" unit="BPS" value={settings.gapTrading.recoverySlippageBps} help="بالاتر خروج اضطراری را محتمل‌تر ولی پرهزینه‌تر می‌کند." onChange={recoverySlippageBps => updateSection("gapTrading", { recoverySlippageBps })}/>
        </StrategySettingGroup>
      </StrategyCard>

      <StrategyCard anchor="strategy-imbalance" icon={Waves} tone="amber" title="عدم‌تعادل اردربوک" english="Orderbook Imbalance" family="Event-Driven" enabled={settings.imbalance.enabled} onToggle={() => updateSection("imbalance", { enabled: !settings.imbalance.enabled })} count={grouped("orderbook-imbalance").length} best={best("orderbook-imbalance")} primaryLabel="Weighted Ratio" primaryValue={best("orderbook-imbalance") ? `${fa(best("orderbook-imbalance")!.metrics.ratio as number, 2)}×` : "—"} risks={["Spoofing", "Absorption", "Latency"]}>
        <SettingsBand tone="paper" title="سیگنال چندنمونه‌ای و ضد Spoofing" description="عمق چند Level با وزن بیشتر برای قیمت‌های نزدیک سنجیده می‌شود؛ ورود فقط پس از تداوم فشار، Change Point، Microprice و کنترل اثر قیمت مجاز است."/>
        <NumberField label="تعداد سطوح" english="Depth Levels" unit="سطح" value={settings.imbalance.levels} help="سطوح بیشتر تصویر عمیق‌تر ولی کندتر و مستعد سفارش‌های دور از قیمت می‌دهد؛ سطوح کمتر حساس‌تر و پرنویزتر است." onChange={levels => updateSection("imbalance", { levels })}/>
        <NumberField label="وزن Level بعدی" english="Level Weight Decay" unit="٪" value={settings.imbalance.levelWeightDecayPercent} help="مثلاً ۷۰٪ یعنی هر سطح دورتر فقط ۷۰٪ سطح قبلی وزن دارد. کمتر: تمرکز بیشتر روی Top of Book؛ بیشتر: اتکای بیشتر به عمق دور." onChange={levelWeightDecayPercent => updateSection("imbalance", { levelWeightDecayPercent })}/>
        <NumberField label="حداقل نسبت ورود" english="Entry Imbalance" unit="×" value={settings.imbalance.minRatio} help="بیشتر: سیگنال قوی‌تر و کمتر؛ کمتر: سیگنال بیشتر و نویز بالاتر." onChange={minRatio => updateSection("imbalance", { minRatio })}/>
        <NumberField label="نسبت خروج" english="Exit Imbalance" unit="×" value={settings.imbalance.exitRatio} help="نزدیک‌تر به ۱ یعنی خروج پس از خنثی‌شدن فشار اردربوک." onChange={exitRatio => updateSection("imbalance", { exitRatio })}/>
        <NumberField label="پنجره نمونه‌ها" english="Signal Window" unit="ms" value={settings.imbalance.sampleWindowMs} help="فقط Snapshotهای این بازه برای تداوم و Change Point استفاده می‌شوند. بزرگ‌تر: سیگنال کندتر و پایدارتر؛ کوچک‌تر: واکنش سریع‌تر و نویز بیشتر." onChange={sampleWindowMs => updateSection("imbalance", { sampleWindowMs })}/>
        <NumberField label="حداقل تأیید" english="Min Confirmations" unit="نمونه" value={settings.imbalance.minConfirmations} help="تعداد Snapshot هم‌جهت لازم. افزایش آن Wallهای لحظه‌ای را بهتر حذف می‌کند، اما ورود را دیرتر می‌کند." onChange={minConfirmations => updateSection("imbalance", { minConfirmations })}/>
        <NumberField label="افق پیش‌بینی" english="Prediction Horizon" unit="ms" value={settings.imbalance.predictionHorizonMs} help="حرکت قیمت پس از این فاصله برای سنجش نتیجه هر سیگنال استفاده می‌شود. کوتاه‌تر پرنویزتر و بلندتر کندتر است." onChange={predictionHorizonMs => updateSection("imbalance", { predictionHorizonMs })}/>
        <NumberField label="حداقل نمونه نتیجه" english="Outcome Samples" unit="نمونه" value={settings.imbalance.minOutcomeSamples} help="تا این تعداد نتیجه مستقل از Snapshotهای واقعاً جدید جمع نشود، موتور فقط پایش می‌کند و سفارش نمی‌فرستد. عدد بالاتر اطمینان آماری بیشتر و سیگنال کمتر می‌دهد." onChange={minOutcomeSamples => updateSection("imbalance", { minOutcomeSamples })}/>
        <NumberField label="حداقل نرخ موفقیت" english="Minimum Hit Rate" unit="٪" value={settings.imbalance.minOutcomeHitRatePercent} help="درصد نمونه‌های تاریخی که پس از سیگنال در جهت پیش‌بینی حرکت کرده‌اند. بالاتر سخت‌گیرانه‌تر است." onChange={minOutcomeHitRatePercent => updateSection("imbalance", { minOutcomeHitRatePercent })}/>
        <NumberField label="حداقل بازده خالص پیش‌بینی" english="Predicted Net Edge" unit="BPS" value={settings.imbalance.minPredictedNetBps} help="صدک محافظه‌کارانه بازده پس از کسر هزینه رفت‌وبرگشت و بافر مدل؛ افزایش آن سود کاذب را کمتر می‌کند." onChange={minPredictedNetBps => updateSection("imbalance", { minPredictedNetBps })}/>
        <NumberField label="بافر خطای پیش‌بینی" english="Forecast Safety" unit="BPS" value={settings.imbalance.forecastSafetyBps} help="از پیش‌بینی تاریخی کم می‌شود تا Latency و خطای مدل پوشش داده شود. بیشتر، محافظه‌کارانه‌تر است." onChange={forecastSafetyBps => updateSection("imbalance", { forecastSafetyBps })}/>
        <NumberField label="حداقل ماندگاری فشار" english="Min Persistence" unit="ms" value={settings.imbalance.minPersistenceMs} help="سیگنال باید حداقل این مدت باقی بماند. مقدار خیلی کم نسبت به سفارش‌های لحظه‌ای و Spoofing حساس است." onChange={minPersistenceMs => updateSection("imbalance", { minPersistenceMs })}/>
        <NumberField label="حداکثر عمر فشار" english="Max Persistence" unit="ms" value={settings.imbalance.maxPersistenceMs} help="پس از این زمان سیگنال قدیمی و احتمالاً جذب‌شده یا قیمت‌گذاری‌شده تلقی می‌شود. باید از حداقل ماندگاری بزرگ‌تر باشد." onChange={maxPersistenceMs => updateSection("imbalance", { maxPersistenceMs })}/>
        <NumberField label="حداقل جهش فشار" english="Change Point Delta" unit="NOBI" value={settings.imbalance.minPressureDelta} help="افزایش لازم در عدم‌تعادل نرمال‌شده/CUSUM نسبت به خط پایه. بیشتر: فقط تغییرات ناگهانی‌تر؛ کمتر: سیگنال‌های آرام‌تر و بیشتر." onChange={minPressureDelta => updateSection("imbalance", { minPressureDelta })}/>
        <NumberField label="حداقل تغییرات جریان" english="Flow Samples" unit="تغییر" value={settings.imbalance.minFlowSamples} help="حداقل تعداد انتقال مستقل Snapshot برای تأیید جریان سفارش. صفر این محافظ را خاموش می‌کند؛ عدد بالاتر ورود را دیرتر ولی مقاوم‌تر می‌کند." onChange={minFlowSamples => updateSection("imbalance", { minFlowSamples })}/>
        <NumberField label="حداقل جریان هم‌جهت" english="Snapshot MLOFI" unit="N-OFI" value={settings.imbalance.minOrderFlowImbalance} help="فقط زیادبودن حجم فعلی کافی نیست؛ تغییرات Bid/Ask در چند Level باید هم‌جهت باشد. مقدار بالاتر سیگنال کمتر و جریان قوی‌تر می‌دهد." onChange={minOrderFlowImbalance => updateSection("imbalance", { minOrderFlowImbalance })}/>
        <NumberField label="حداقل ماندگاری سمت غالب" english="Liquidity Retention" unit="٪" value={settings.imbalance.minDominantLiquidityRetentionPercent} help="درصد نقدینگی سمت غالب که بین Snapshotها روی همان قیمت باقی می‌ماند. افزایش آن Wallهای لحظه‌ای را بیشتر رد می‌کند؛ مقدار خیلی بالا تغییر طبیعی بازار را هم حذف می‌کند." onChange={minDominantLiquidityRetentionPercent => updateSection("imbalance", { minDominantLiquidityRetentionPercent })}/>
        <NumberField label="سقف تمرکز Level اول" english="Top-Level Concentration" unit="٪" value={settings.imbalance.maxTopLevelSharePercent} help="اگر سهم دیوار Level اول از این مقدار بیشتر باشد، سیگنال برای کاهش ریسک Spoofing رد می‌شود. مقدار کمتر سخت‌گیرانه‌تر است." onChange={maxTopLevelSharePercent => updateSection("imbalance", { maxTopLevelSharePercent })}/>
        <NumberField label="حداقل تأیید Microprice" english="Microprice Bias" unit="BPS" value={settings.imbalance.minMicropriceBiasBps} help="Microprice باید حداقل به این اندازه جهت صعود را تأیید کند. بیشتر: ورود کمتر ولی هم‌جهتی قوی‌تر با Top of Book." onChange={minMicropriceBiasBps => updateSection("imbalance", { minMicropriceBiasBps })}/>
        <NumberField label="حرکت مخالف مجاز" english="Max Adverse Mid Move" unit="BPS" value={settings.imbalance.maxAdverseMoveBps} help="اگر قیمت میانی با وجود فشار Bid بیش از این مقدار افت کند، احتمال Absorption وجود دارد و ورود رد می‌شود. کمتر: فیلتر حساس‌تر؛ بیشتر: تحمل حرکت خلاف جهت." onChange={maxAdverseMoveBps => updateSection("imbalance", { maxAdverseMoveBps })}/>
        <NumberField label="حداقل عمق" english="Visible Depth" unit="USDT" value={settings.imbalance.minVisibleDepthToman} help="بالاتر، بازارهای کم‌عمق را حذف می‌کند." onChange={minVisibleDepthToman => updateSection("imbalance", { minVisibleDepthToman })}/>
        <SettingsBand tone="live" title="ورود، خروج و Recovery واقعی Mainnet" description="این مقادیر در پوزیشن واقعی، Take Profit، Stop، Time Stop و Recovery روی حساب اصلی اعمال می‌شوند."/>
        <NumberField label="سرمایه معامله" english="Live Capital" unit="USDT" value={settings.imbalance.capitalToman} help="بیشتر: اثر قیمت و زیان بالقوه بیشتر؛ سقف‌های سراسری نیز اعمال می‌شوند." onChange={capitalToman => updateSection("imbalance", { capitalToman })}/>
        <NumberField label="حداکثر اسپرد" english="Max Spread" unit="BPS" value={settings.imbalance.maxSpreadBps} help="سقف پایین‌تر ورود در بازار پرهزینه را رد می‌کند." onChange={maxSpreadBps => updateSection("imbalance", { maxSpreadBps })}/>
        <NumberField label="حداکثر اثر قیمت" english="Max Price Impact" unit="BPS" value={settings.imbalance.maxPriceImpactBps} help="کمتر: حجم اجرای محافظه‌کارانه‌تر." onChange={maxPriceImpactBps => updateSection("imbalance", { maxPriceImpactBps })}/>
        <NumberField label="سهم مجاز از عمق" english="Usable Depth" unit="٪" value={settings.imbalance.depthUsagePercent} help="درصد بالاتر اتکا به عمق نمایشی و ریسک لغزش را زیاد می‌کند." onChange={depthUsagePercent => updateSection("imbalance", { depthUsagePercent })}/>
        <NumberField label="حد سود" english="Take Profit" unit="BPS" value={settings.imbalance.takeProfitBps} help="هدف بالاتر زمان نگهداری و احتمال برگشت سود را بیشتر می‌کند." onChange={takeProfitBps => updateSection("imbalance", { takeProfitBps })}/>
        <NumberField label="حد ضرر" english="Stop Loss" unit="BPS" value={settings.imbalance.stopLossBps} help="قبل از خرید، هزینه رفت‌وبرگشت شامل اسپرد، دو کارمزد، لغزش و گردکردن محاسبه می‌شود؛ اگر این هزینه با حاشیه اجرا به Stop Loss برسد، سفارش اصلاً ارسال نمی‌شود. عدد بزرگ‌تر تحمل حرکت مخالف و زیان بالقوه را بیشتر می‌کند." onChange={stopLossBps => updateSection("imbalance", { stopLossBps })}/>
        <NumberField label="حداکثر زیان معامله" english="Max Loss" unit="USDT" value={settings.imbalance.maxLossToman} help="سقف زیان مبتنی بر USDT مستقل از Stop BPS؛ مقدار کمتر محافظه‌کارانه‌تر است." onChange={maxLossToman => updateSection("imbalance", { maxLossToman })}/>
        <NumberField label="حداکثر باقیمانده دارایی" english="Max Residual Value" unit="USDT" value={settings.imbalance.maxResidualToman} help="بازارهایی مثل BNB که گام مقدارشان می‌تواند Dust باارزش بسازد، پیش از ارسال سفارش رد می‌شوند." onChange={maxResidualToman => updateSection("imbalance", { maxResidualToman })}/>
        <NumberField label="حداکثر زمان نگهداری" english="Max Hold" unit="ms" value={settings.imbalance.maxHoldMs} help="Time Stop؛ پس از این زمان خروج اجباری آغاز می‌شود." onChange={maxHoldMs => updateSection("imbalance", { maxHoldMs })}/>
        <NumberField label="فاصله پایش" english="Poll Interval" unit="ms" value={settings.imbalance.pollIntervalMs} help="کمتر: خروج سریع‌تر و بار API بیشتر." onChange={pollIntervalMs => updateSection("imbalance", { pollIntervalMs })}/>
        <NumberField label="وقفه ورود مجدد" english="Execution Cooldown" unit="ms" value={settings.imbalance.cooldownMs} help="بیشتر: سیگنال‌های تکراری و دست‌کاری اردربوک کمتر معامله می‌شوند؛ کمتر: ورود بیشتر با ریسک سیگنال کاذب بالاتر." onChange={cooldownMs => updateSection("imbalance", { cooldownMs })}/>
        <NumberField label="رزرو سفارش" english="Order Reserve" unit="BPS" value={settings.imbalance.orderReserveBps} help="افزایش آن احتمال Fill و هزینه قیمت اجرا را بالا می‌برد." onChange={orderReserveBps => updateSection("imbalance", { orderReserveBps })}/>
        <NumberField label="اسپرد مجاز Recovery" english="Recovery Max Spread" unit="BPS" value={settings.imbalance.recoveryMaxSpreadBps} help="فقط برای خروج اضطراری؛ عدد بزرگ‌تر خروج را پرهزینه‌تر می‌کند." onChange={recoveryMaxSpreadBps => updateSection("imbalance", { recoveryMaxSpreadBps })}/>
        <NumberField label="اثر قیمت Recovery" english="Recovery Max Impact" unit="BPS" value={settings.imbalance.recoveryMaxPriceImpactBps} help="حداکثر اثر قیمت مجاز برای بستن اضطراری." onChange={recoveryMaxPriceImpactBps => updateSection("imbalance", { recoveryMaxPriceImpactBps })}/>
        <NumberField label="لغزش Recovery" english="Recovery Slippage" unit="BPS" value={settings.imbalance.recoverySlippageBps} help="بالاتر احتمال خروج فوری را زیاد و کیفیت قیمت را کمتر می‌کند." onChange={recoverySlippageBps => updateSection("imbalance", { recoverySlippageBps })}/>
      </StrategyCard>

      <article className="strategy-card unavailable">
        <header><div className="strategy-icon"><Radio/></div><div><span>Potential Arbitrage</span><h3>اسپات ↔ خرید آسان<small>Spot ↔ Easy</small></h3></div><em className="availability unsupported">API پشتیبانی نمی‌شود</em></header>
        <p>در OpenAPI فعلی بیت‌گت endpoint رسمی Quote/Execution برای خرید آسان وجود ندارد؛ این موتور عمداً غیرفعال است.</p>
        <div className="risk-tags"><span>Quote Expiry</span><span>Partial Fill</span><span>Unsupported API</span></div>
        <div className="strategy-unavailable"><ShieldAlert/><span>از endpoint قدیمی یا حدسی برای پول واقعی استفاده نمی‌شود.</span></div>
        <details className="strategy-controls"><summary><SlidersHorizontal/> تنظیمات تحقیقاتی Spot ↔ Easy</summary><div>
          <SettingsBand tone="paper" title="فقط نگهداری تنظیمات تحقیق" description="تا زمانی که Bitget API رسمی Quote/Execution ارائه نکند، این مقادیر نه اسکن قابل اتکا و نه سفارش واقعی ایجاد می‌کنند."/>
          <NumberField label="حداقل برتری قیمت" english="Minimum Edge" unit="BPS" value={settings.spotEasy.minEdgeBps} help="بیشترکردن مقدار، فقط اختلاف‌های بزرگ‌تر را برای تحقیق قابل توجه می‌داند." onChange={minEdgeBps => updateSection("spotEasy", { minEdgeBps })}/>
          <NumberField label="بافر انقضای Quote" english="Quote Expiry Buffer" unit="ms" value={settings.spotEasy.quoteExpiryBufferMs} help="حاشیه زمانی برای ردکردن Quote نزدیک انقضا؛ فعلاً به endpoint واقعی متصل نیست." onChange={quoteExpiryBufferMs => updateSection("spotEasy", { quoteExpiryBufferMs })}/>
        </div></details>
      </article>
    </div>

    <section className="signal-board panel">
      <div className="section-title"><div><span className="eyebrow">UNIFIED SIGNAL TAPE</span><h2><Activity/> سیگنال‌های چنداستراتژی</h2><small className="section-note">«آماده بررسی Paper» فقط نتیجه محاسبات است؛ اجازه اجرای واقعی جداگانه در Risk Center مشخص می‌شود.</small></div><span>{result ? `آخرین اسکن ${new Date(result.scannedAt).toLocaleTimeString("fa-IR")}` : "در انتظار داده"}</span></div>
      {!visibleSignals.length ? <div className="empty">هنوز سیگنالی با داده و شروط فعلی پیدا نشده است.</div> : <div className="signal-list">{visibleSignals.slice(0, 40).map(signal => <article className={`signal-row ${signal.status}`} key={signal.id}>
        <div><span className={`signal-kind ${signal.kind}`}>{labels[signal.kind]}</span><b>{signal.title}</b><small><bdi dir="ltr">{signal.symbols.join(" · ")}</bdi></small></div>
        <div><span>اقدام پیشنهادی Paper</span><b><bdi dir="ltr">{signal.action}</bdi></b><small>{signal.reasons[0]}</small></div>
        {(() => { const metric = signalMetric(signal); return <div><span>{metric.label}</span><b className={metric.directional ? Number(signal.expectedEdgeBps) > 0 ? "positive" : "negative" : ""}>{metric.value}</b><small>{metric.note}</small></div>; })()}
        <div><span>Confidence</span><b>{fa(signal.confidence, 1)}٪</b><div className="confidence-bar"><i style={{ width: `${Math.min(100, Number(signal.confidence))}%` }}/></div></div>
        <div><span className={`signal-state ${signal.status}`}>{signalStateLabel(signal)}</span></div>
        <details><summary>دلیل‌ها و Metrics</summary><div className="signal-details"><ul>{signal.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><dl>{Object.entries(signal.metrics).map(([key, value]) => <div key={key}><dt>{key}</dt><dd><bdi dir="ltr">{typeof value === "number" ? fa(value, 4) : String(value)}</bdi></dd></div>)}</dl></div></details>
      </article>)}</div>}
    </section>
  </section>;
}

function StrategyCard({ anchor, icon: Icon, tone, title, english, family, enabled, onToggle, count, best, primaryLabel = "بهترین Edge", primaryValue, risks, children }: { anchor: string; icon: typeof Activity; tone: string; title: string; english: string; family: string; enabled: boolean; onToggle: () => void; count: number; best?: SerializedStrategySignal; primaryLabel?: string; primaryValue?: string; risks: string[]; children: React.ReactNode }) {
  return <article id={anchor} className={`strategy-card ${tone} ${enabled ? "enabled" : "disabled"}`}>
    <header><div className="strategy-icon"><Icon/></div><div><span>{family}</span><h3>{title}<small>{english}</small></h3></div><button type="button" className={`mini-toggle ${enabled ? "on" : ""}`} onClick={onToggle} aria-pressed={enabled}>{enabled ? "اسکن Paper روشن" : "اسکن Paper خاموش"}</button></header>
    <div className="strategy-metrics"><div><span>سیگنال</span><b>{fa(count)}</b></div><div><span>{primaryLabel}</span><b>{primaryValue ?? (best ? `${fa(best.expectedEdgeBps, 2)} BPS` : "—")}</b></div><div><span>Confidence</span><b>{best ? `${fa(best.confidence, 1)}٪` : "—"}</b></div></div>
    <div className="risk-tags">{risks.map(risk => <span key={risk}>{risk}</span>)}</div>
    <details className="strategy-controls"><summary><SlidersHorizontal/> مدیریت و تنظیمات</summary><div>{children}</div></details>
  </article>;
}

function SettingsBand({ tone, title, description }: { tone: "paper" | "live"; title: string; description: string }) {
  return <div className={`strategy-settings-band ${tone}`}><b>{tone === "paper" ? "PAPER / SIGNAL" : "LIVE / EXECUTION"} · {title}</b><small>{description}</small></div>;
}

function StrategySettingGroup({ title, english, description, children }: { title: string; english: string; description: string; children: React.ReactNode }) {
  return <section className="strategy-setting-group"><header><div><b>{title}</b><span>{english}</span></div><small>{description}</small></header><div>{children}</div></section>;
}

function NumberField({ label, english, unit, value, help, onChange }: { label: string; english: string; unit: string; value: number; help?: string; onChange: (value: number) => void }) {
  return <label className="strategy-field"><span>{label}<small>{english}</small>{help && <i className="strategy-field-help">{help}</i>}</span><div><input type="text" inputMode="decimal" value={en(value)} onChange={event => { const parsed = Number(event.target.value.replace(/,/g, "")); if (Number.isFinite(parsed)) onChange(parsed); }}/><em>{unit}</em></div></label>;
}
