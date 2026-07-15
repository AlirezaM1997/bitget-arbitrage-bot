"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CircleHelp, Clock3, Coins, Gauge, RefreshCw, Settings2, ShieldAlert, Trash2, TrendingDown, TrendingUp, WalletCards } from "lucide-react";
import type { BotSettings } from "@/lib/bot-settings";

type Leg = { symbol: string; from: string; to: string; side: string; input: string; output: string; levelsUsed: number; totalLevels?: number; bestPrice?: string; worstPrice?: string; priceImpactBps?: string; spreadBps?: string; availableInput?: string; depthConsumedPercent?: string };
type Opportunity = { id: string; route: string[]; requestedInputToman: string; inputToman: string; outputToman: string; netProfitToman: string; profitBps: string; liquiditySafe: boolean; sizedByDepth: boolean; sizingMode: "optimized" | "diagnostic-minimum"; executable: boolean; rejectionReason?: string; legs: Leg[] };
type Result = { mode: "demo" | "live"; capitalToman: string; scannedAt: number; exchangeMarketCount: number; relevantMarketCount: number; marketCount: number; depthRefinedMarketCount: number; triangleCount: number; evaluatedSizeCount: number; promisingPathCount: number; fastRejectedPathCount: number; refinedPathCount: number; positiveCount: number; liquiditySafePositiveCount: number; engineMs: number; executableCount: number; opportunities: Opportunity[] };
type Balance = { spotTotalToman: string; availableToman: string; blockedToman: string; unpricedAssets?: Array<{ asset: string; amount: string }>; fetchedAt: number };
type HistoryRecord = { id: number; mode: string; route: string[]; legs: Leg[]; firstSeenAt: number; lastSeenAt: number; detections: number; inputToman: number; latestOutputToman: number; latestProfitToman: number; latestProfitBps: number; bestProfitToman: number; bestProfitBps: number; executable: boolean; settings: Partial<BotSettings>; rejectionReason: string | null };
type OpportunityHistory = { summary: { recordCount: number; detectionCount: number; uniqueRouteCount: number; bestProfitToman: number; bestProfitBps: number }; records: HistoryRecord[] };
type ExecutionOrder = { symbol: string; side: string; orderId: string; status: string; input: string; expectedOutput: string; output: string; averagePrice: string; fee: string; slippageBuffer: string; levelsUsed: number; totalLevels: number; depthConsumedPercent: string; priceImpactBps: string; spreadBps: string };
type LiveExecutionRecord = { id: number; route: string[]; status: "PREPARING" | "RUNNING" | "COMPLETED" | "FAILED"; startedAt: number; completedAt: number | null; requestedInputToman: number; plannedInputToman: number | null; plannedOutputToman: number | null; plannedProfitToman: number | null; actualOutputToman: number | null; actualProfitToman: number | null; realizedOutputToman: number | null; realizedProfitToman: number | null; residualValueToman: number | null; residualInventory: Array<{ asset: string; amount: string }>; fullySettled: boolean | null; orders: ExecutionOrder[]; error: string | null };
type LiveExecutionHistory = { summary: { attemptCount: number; completedCount: number; failedCount: number; runningCount: number; totalActualProfitToman: number }; records: LiveExecutionRecord[] };
type DashboardRiskSnapshot = {
  state: { masterArmed: boolean };
  evaluation: { strategies: { triangle: { canExecute: boolean } } };
  activeLeases: unknown[];
};
type NumericKey = "paperCapitalToman" | "maxTradeToman" | "balanceUsagePercent" | "tomanTakerFeeBps" | "usdtTakerFeeBps" | "slippageBufferBps" | "liveSafetyBufferBps" | "maxPriceImpactBps" | "maxSpreadBps" | "orderbookDepthUsagePercent" | "minProfitBps" | "minNetProfitToman" | "orderbookMaxAgeMs" | "scanIntervalMs" | "orderTimeoutMs";
type SettingField = { key: NumericKey; label: string; english: string; unit: string; description: string; increase: string; decrease: string; step?: number };

const format = (value: string | number, digits = 4) => new Intl.NumberFormat("fa-IR", { maximumFractionDigits: digits }).format(Number(value));
const formatSettingNumber = (value: number) => new Intl.NumberFormat("en-US", {
  useGrouping: true,
  maximumFractionDigits: 8
}).format(value);

const executionStatusLabel = { PREPARING: "در حال بازبینی", RUNNING: "در حال اجرا", COMPLETED: "تکمیل‌شده", FAILED: "ناموفق" } as const;
function detectedOpportunityStatus(record: HistoryRecord) {
  if (record.executable) return "شرایط اسکن را پاس کرده؛ نتیجه بازبینی نهایی یا سفارش در لاگ معاملات واقعی ثبت می‌شود";
  if (record.rejectionReason) return `اجرا نشد: ${record.rejectionReason}`;
  return "اجرا نشد؛ این رکورد قدیمی snapshot معیارهای تاریخی ندارد";
}

function normalizeNumericInput(value: string) {
  return value.replace(/[,\s]/g, "").replace(/[^\d.]/g, "");
}

const liveSettingFields: SettingField[] = [
  { key: "maxTradeToman", label: "سقف معامله واقعی", english: "Max Live Trade", unit: "USDT", description: "حداکثر سرمایه مجاز برای یک چرخه واقعی، حتی اگر موجودی حساب بیشتر باشد.", increase: "اجازه استفاده از سرمایه بیشتر و در نتیجه exposure و ریسک اجرای بالاتر را می‌دهد.", decrease: "زیان احتمالی و فشار روی اردربوک را محدود می‌کند، اما سقف سود واقعی هم کمتر می‌شود." },
  { key: "balanceUsagePercent", label: "درصد استفاده از موجودی", english: "Balance Usage", unit: "درصد", description: "درصد موجودی آزاد USDT که Live اجازه دارد برای محاسبه سقف سرمایه استفاده کند.", increase: "بخش بزرگ‌تری از کیف پول در معرض معامله قرار می‌گیرد و حاشیه نقد آزاد کمتر می‌شود.", decrease: "سرمایه رزروشده بیشتری در کیف پول باقی می‌ماند و اجرای Live محافظه‌کارانه‌تر می‌شود.", step: 0.1 },
  { key: "liveSafetyBufferBps", label: "حاشیه ایمنی اجرای واقعی", english: "Live Safety Buffer", unit: "BPS", description: "سود اضافه‌ای که فقط در Live و بالاتر از حداقل بازده لازم است تا تغییر قیمت میان سه سفارش را پوشش دهد.", increase: "ورود واقعی محافظه‌کارانه‌تر و احتمال زیان ناشی از تغییر لحظه‌ای کمتر می‌شود.", decrease: "فرصت‌های بیشتری اجرا می‌شوند، اما حاشیه دفاعی میان سه سفارش کاهش می‌یابد.", step: 0.1 },
  { key: "orderTimeoutMs", label: "مهلت تکمیل سفارش", english: "Order Timeout", unit: "ms", description: "حداکثر زمان انتظار برای نهایی شدن سفارش واقعی قبل از تلاش برای لغو آن.", increase: "فرصت بیشتری برای fill می‌دهد، اما چرخه مدت بیشتری باز می‌ماند.", decrease: "سفارش زودتر تعیین تکلیف می‌شود، ولی احتمال لغو یا partial fill بیشتر است." }
];

const settingGroups: Array<{ id: string; title: string; english: string; description: string; icon: typeof Coins; fields: SettingField[] }> = [
  {
    id: "fees", title: "کارمزد و سودآوری", english: "Fees & Profitability", description: "هزینه‌های تخمینی و حداقل سود لازم برای قابل اجرا شدن مسیر.", icon: Gauge,
    fields: [
      { key: "tomanTakerFeeBps", label: "کارمزد ضلع‌های USDT", english: "USDT-quoted Taker Fee", unit: "BPS", description: "کارمزد fallback برای ضلع‌هایی که quote آن‌ها USDT است؛ نرخ رسمی هر نماد در صورت دسترسی مقدم است.", increase: "محاسبه محافظه‌کارانه‌تر و تعداد فرصت‌ها کمتر می‌شود.", decrease: "فرصت بیشتری دیده می‌شود، اما مقدار کمتر از کارمزد واقعی سود را غیرواقعی نشان می‌دهد.", step: 0.1 },
      { key: "usdtTakerFeeBps", label: "کارمزد ضلع‌های متقاطع", english: "Cross-pair Taker Fee", unit: "BPS", description: "کارمزد fallback برای جفت‌های متقاطع با quoteهایی مانند BTC، ETH یا BGB؛ نرخ رسمی هر نماد در صورت دسترسی مقدم است.", increase: "سود خالص تخمینی کاهش و فیلتر فرصت‌ها سخت‌تر می‌شود.", decrease: "سود تخمینی بیشتر می‌شود؛ فقط در صورت تطابق با سطح واقعی حساب کمش کنید.", step: 0.1 },
      { key: "slippageBufferBps", label: "بافر لغزش", english: "Slippage Buffer", unit: "BPS", description: "حاشیه ایمنی اضافه بر قیمت میانگین عمق برای تغییر بازار بین اسکن و پرشدن سفارش.", increase: "فرصت‌های کمتری پذیرفته می‌شوند ولی تحمل تغییرات لحظه‌ای بیشتر می‌شود.", decrease: "ربات تهاجمی‌تر می‌شود، اما احتمال محقق نشدن سود محاسبه‌شده بالاتر می‌رود.", step: 0.1 },
      { key: "minProfitBps", label: "حداقل بازده خالص", english: "Minimum Net Return", unit: "BPS", description: "حداقل درصد سود خالص کل چرخه پس از عمق، کارمزد و لغزش.", increase: "فقط مسیرهای با حاشیه سود درصدی بیشتر اجرا می‌شوند و تعداد معاملات کم می‌شود.", decrease: "فرصت‌های کوچک‌تر هم اجرا می‌شوند، اما حاشیه خطا و تغییر بازار کمتر است.", step: 0.1 },
      { key: "minNetProfitToman", label: "حداقل سود خالص", english: "Minimum Net Profit", unit: "USDT", description: "حداقل سود عددی مبتنی بر USDT لازم برای قابل اجرا بودن چرخه.", increase: "معاملات کم‌سود حذف می‌شوند، حتی اگر درصد بازده خوبی داشته باشند.", decrease: "چرخه‌های با سود عددی کوچک‌تر پذیرفته می‌شوند و اثر هزینه‌های پیش‌بینی‌نشده مهم‌تر می‌شود." }
    ]
  },
  {
    id: "liquidity", title: "نقدشوندگی و کیفیت بازار", english: "Liquidity & Market Quality", description: "کنترل کیفیت اردربوک و میزان اتکای ربات به حجم قابل مشاهده.", icon: ShieldAlert,
    fields: [
      { key: "maxPriceImpactBps", label: "حداکثر اثر قیمت", english: "Max Price Impact", unit: "BPS", description: "بیشترین اختلاف مجاز بین بهترین قیمت و قیمت میانگین اجرای هر ضلع.", increase: "بازارهای کم‌عمق‌تر پذیرفته می‌شوند، اما قیمت میانگین اجرای بدتری خواهید داشت.", decrease: "فیلتر عمق سخت‌تر و اجرای سفارشها با کیفیت‌تر، ولی فرصت‌ها کمتر می‌شوند.", step: 0.1 },
      { key: "maxSpreadBps", label: "حداکثر اسپرد بازار", english: "Max Bid-Ask Spread", unit: "BPS", description: "حداکثر فاصله مجاز بین بهترین bid و ask هر بازار.", increase: "بازارهای کم‌نقدشونده و پرهزینه‌تری وارد محاسبات می‌شوند.", decrease: "فقط بازارهای فشرده‌تر پذیرفته می‌شوند و احتمال اجرای مناسب بیشتر است.", step: 0.1 },
      { key: "orderbookDepthUsagePercent", label: "سهم مجاز از عمق بازار", english: "Usable Orderbook Depth", unit: "درصد", description: "درصدی از حجم قابل مشاهده هر سطح که ربات قابل اتکا فرض می‌کند؛ باقی‌مانده reserve است.", increase: "سرمایه بیشتری قابل اجرا دیده می‌شود، اما ریسک حذف سفارش‌های اردربوک قبل از fill بالا می‌رود.", decrease: "حاشیه نقدشوندگی امن‌تر می‌شود، ولی اندازه بهینه و تعداد فرصت‌ها کاهش می‌یابد.", step: 0.1 },
      { key: "orderbookMaxAgeMs", label: "حداکثر عمر اردربوک", english: "Max Orderbook Age", unit: "ms", description: "قدیمی‌ترین داده بازار که هنوز برای قیمت‌گذاری معتبر شناخته می‌شود.", increase: "داده‌های قدیمی‌تر پذیرفته می‌شوند و ریسک تصمیم با قیمت منقضی بالا می‌رود.", decrease: "تازگی داده سخت‌گیرانه‌تر می‌شود، اما بازارهای کم‌فعال بیشتر رد خواهند شد." }
    ]
  },
  {
    id: "timing", title: "زمان‌بندی و اجرای سفارش", english: "Timing & Execution", description: "سرعت اسکن بازار و مدت انتظار برای تعیین تکلیف سفارش واقعی.", icon: Clock3,
    fields: [
      { key: "scanIntervalMs", label: "فاصله اسکن خودکار", english: "Scan Interval", unit: "ms", description: "فاصله شروع اسکن‌های بازار؛ حداقل مجاز برنامه ۱۰۰۰ میلی‌ثانیه است.", increase: "بار API و CPU کمتر می‌شود، اما فرصت‌های کوتاه‌مدت دیرتر شناسایی می‌شوند.", decrease: "واکنش سریع‌تر می‌شود، ولی فشار روی API بیشتر است و کمتر از یک ثانیه مجاز نیست." }
    ]
  }
];

export default function Dashboard() {
  const [settings, setSettings] = useState<BotSettings>();
  const [data, setData] = useState<Result>();
  const [balance, setBalance] = useState<Balance>();
  const [history, setHistory] = useState<OpportunityHistory>();
  const [liveExecutions, setLiveExecutions] = useState<LiveExecutionHistory>();
  const [riskSnapshot, setRiskSnapshot] = useState<DashboardRiskSnapshot>();
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [executionMessage, setExecutionMessage] = useState("");
  const [error, setError] = useState("");
  const [balanceError, setBalanceError] = useState("");
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [openSettingHint, setOpenSettingHint] = useState<NumericKey | null>(null);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [clearingExecutionHistory, setClearingExecutionHistory] = useState(false);
  const [purgingDatabase, setPurgingDatabase] = useState(false);
  const settingsRef = useRef<BotSettings | undefined>(undefined);
  const scanInFlight = useRef(false);
  const modeRef = useRef<"demo" | "live">("demo");

  useEffect(() => {
    void fetch("/api/settings", { cache: "no-store" })
      .then(async response => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "خطا در دریافت تنظیمات");
        setSettings(json); settingsRef.current = json;
      })
      .catch(reason => setError(reason instanceof Error ? reason.message : "خطا در دریافت تنظیمات"));
  }, []);

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  useEffect(() => {
    if (!settings) return;
    setSaving(true); setSaved(false);
    const timer = window.setTimeout(() => {
      void fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-settings-action": "bitget-dashboard" },
        body: JSON.stringify(settings)
      })
        .then(async response => {
          const json = await response.json();
          if (!response.ok) throw new Error(json.error ?? "خطا در ذخیره تنظیمات");
          setSaved(true);
        })
        .catch(reason => setError(reason instanceof Error ? reason.message : "خطا در ذخیره تنظیمات"))
        .finally(() => setSaving(false));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [settings]);

  const fetchRisk = useCallback(async () => {
    try {
      const response = await fetch("/api/risk", { cache: "no-store" });
      const json = await response.json() as DashboardRiskSnapshot & { error?: string };
      if (!response.ok) throw new Error(json.error ?? "خطا در دریافت وضعیت Risk");
      setRiskSnapshot(json);
      const triangleLive = json.state.masterArmed && json.evaluation.strategies.triangle.canExecute;
      if (triangleLive && modeRef.current !== "live") {
        modeRef.current = "live";
        setMode("live");
        setExecutionMessage("اجرای خودکار سمت سرور فعال است؛ آربیتراژ مثلثی بدون وابستگی به باز بودن مرورگر پایش می‌شود.");
      } else if (!triangleLive && modeRef.current === "live") {
        modeRef.current = "demo";
        setMode("demo");
        setExecutionMessage("حالت واقعی متوقف شد؛ داشبورد به شبیه‌سازی دمو برگشت.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "ارتباط داشبورد با کنترل ریسک قطع شد؛ وضعیت Runtime سرور نامشخص است.");
    }
  }, []);

  useEffect(() => {
    void fetchRisk();
    const timer = window.setInterval(() => void fetchRisk(), 5_000);
    return () => window.clearInterval(timer);
  }, [fetchRisk]);

  const fetchBalance = useCallback(async () => {
    try {
      setBalanceLoading(true);
      setBalanceError("");
      const response = await fetch("/api/balance", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در دریافت موجودی");
      setBalance(json);
    } catch (reason) {
      setBalanceError(reason instanceof Error ? reason.message : "خطا در دریافت موجودی");
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode !== "live") {
      setBalance(undefined);
      setBalanceError("");
      return;
    }
    void fetchBalance();
    const timer = window.setInterval(() => void fetchBalance(), 15_000);
    return () => window.clearInterval(timer);
  }, [fetchBalance, mode]);

  const fetchHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/opportunities?limit=50", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در دریافت تاریخچه فرصت‌ها");
      setHistory(json);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "خطا در دریافت تاریخچه فرصت‌ها");
    }
  }, []);

  const fetchLiveExecutions = useCallback(async () => {
    try {
      const response = await fetch("/api/executions?limit=50", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در دریافت لاگ معاملات واقعی");
      setLiveExecutions(json);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "خطا در دریافت لاگ معاملات واقعی");
    }
  }, []);

  const clearDetectedHistory = useCallback(async () => {
    if (!window.confirm("تمام جزئیات و شمارنده‌های فرصت‌های شناسایی‌شده پاک شوند؟ لاگ معاملات واقعی حذف نخواهد شد.")) return;
    setClearingHistory(true);
    setError("");
    try {
      const response = await fetch("/api/opportunities", {
        method: "DELETE",
        headers: { "x-history-action": "clear-opportunity-history" }
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در پاک‌سازی تاریخچه فرصت‌ها");
      setHistory(json.history);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "خطا در پاک‌سازی تاریخچه فرصت‌ها");
    } finally {
      setClearingHistory(false);
    }
  }, []);

  const clearExecutionHistory = useCallback(async () => {
    if (!window.confirm("تاریخچه اجراهای نهایی و تلاش‌های متوقف‌شده پیش از ارسال سفارش پاک شود؟ رکوردهای دارای سفارش باز، Recovery یا ابهام در وضعیت صرافی برای ایمنی باقی می‌مانند.")) return;
    setClearingExecutionHistory(true);
    setError("");
    try {
      const response = await fetch("/api/executions", {
        method: "DELETE",
        headers: { "x-history-action": "clear-execution-history" }
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در پاک‌سازی تاریخچه اجراها");
      setLiveExecutions(json.liveExecutions);
      const deletedCount = Number(json.deletedCount?.total ?? 0);
      const remainingCount = Number(json.remainingCount ?? 0);
      setExecutionMessage(deletedCount > 0
        ? `${format(deletedCount)} رکورد از تاریخچه اجراها پاک شد${remainingCount > 0 ? `؛ ${format(remainingCount)} رکورد دارای سفارش یا وضعیت باز برای ایمنی حفظ شد.` : "."}`
        : remainingCount > 0
          ? `رکورد قابل‌حذفی وجود نداشت؛ ${format(remainingCount)} رکورد دارای سفارش یا وضعیت باز برای ایمنی حفظ شد.`
          : "تاریخچه اجراها از قبل خالی بود.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "خطا در پاک‌سازی تاریخچه اجراها");
    } finally {
      setClearingExecutionHistory(false);
    }
  }, []);

  const purgeAllDatabaseData = useCallback(async () => {
    if (riskSnapshot?.state.masterArmed) {
      setError("برای حذف کامل دیتابیس ابتدا اجرای کلی معاملات واقعی را خاموش کنید.");
      return;
    }
    if (!window.confirm("تمام فرصت‌ها، اجراها، سفارش‌ها، تغییر وضعیت‌ها و Audit Ledger برای همیشه حذف شوند؟ این عملیات قابل بازگشت نیست.")) return;
    const phrase = window.prompt("برای تأیید نهایی عبارت DELETE ALL DATA را دقیقاً وارد کنید:");
    if (phrase !== "DELETE ALL DATA") {
      if (phrase !== null) setError("عبارت تأیید صحیح نبود؛ هیچ دیتایی حذف نشد.");
      return;
    }

    setPurgingDatabase(true);
    setError("");
    try {
      const response = await fetch("/api/admin/database", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-admin-action": "purge-all-database-data"
        },
        body: JSON.stringify({ confirmation: "DELETE_ALL_DATABASE_DATA" })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در حذف کامل دیتابیس");
      await Promise.all([fetchHistory(), fetchLiveExecutions()]);
      setExecutionMessage(`${format(Number(json.deleted?.total ?? 0))} رکورد دیتابیس برای همیشه حذف شد. تنظیمات، Risk State و اطلاعات اتصال حفظ شدند.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "خطا در حذف کامل دیتابیس");
    } finally {
      setPurgingDatabase(false);
    }
  }, [fetchHistory, fetchLiveExecutions, riskSnapshot?.state.masterArmed]);

  useEffect(() => {
    void fetchHistory();
    void fetchLiveExecutions();
    const timer = window.setInterval(() => { void fetchHistory(); void fetchLiveExecutions(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [fetchHistory, fetchLiveExecutions]);

  const runScan = useCallback(async () => {
    if (scanInFlight.current || !settingsRef.current) return;
    scanInFlight.current = true; setLoading(true); setError("");
    try {
      const response = await fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json", "x-bot-mode": modeRef.current }, body: JSON.stringify(settingsRef.current) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در اسکن");
      setData(json);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "خطای ناشناخته";
      setError(message);
    }
    finally { scanInFlight.current = false; setLoading(false); }
  }, []);

  useEffect(() => {
    if (!settings) return;
    void runScan();
    const timer = window.setInterval(() => void runScan(), Math.max(1_000, settings.scanIntervalMs));
    return () => window.clearInterval(timer);
  }, [runScan, settings?.scanIntervalMs, Boolean(settings)]);

  function updateNumber(key: NumericKey, value: string) {
    const normalized = normalizeNumericInput(value);
    const parsed = Number(normalized);
    if (normalized !== "" && !Number.isFinite(parsed)) return;
    setSaved(false);
    setSettings(current => current ? { ...current, [key]: normalized === "" ? 0 : parsed } : current);
  }

  function updateBitgetAccountMode(bitgetAccountMode: BotSettings["bitgetAccountMode"]) {
    setSaved(false);
    setSettings(current => current ? { ...current, bitgetAccountMode } : current);
  }

  function updateBitgetDemoTrading(bitgetDemoTrading: boolean) {
    setSaved(false);
    setSettings(current => current ? { ...current, bitgetDemoTrading } : current);
  }

  async function selectDashboardMode(nextMode: "demo" | "live") {
    setError("");
    let nextRiskSnapshot = riskSnapshot;
    let realActive = Boolean(
      riskSnapshot?.state.masterArmed
      && riskSnapshot.evaluation.strategies.triangle.canExecute
    );

    if (nextMode === "live" && !realActive) {
      try {
        const response = await fetch("/api/risk", {
          method: "POST",
          headers: { "content-type": "application/json", "x-risk-action": "bitget-dashboard" },
          body: JSON.stringify({ action: "arm" })
        });
        const json = await response.json() as DashboardRiskSnapshot & { error?: string };
        if (!response.ok) throw new Error(json.error ?? "فعال‌سازی حالت واقعی ناموفق بود");
        nextRiskSnapshot = json;
        setRiskSnapshot(json);
        realActive = Boolean(json.state.masterArmed && json.evaluation.strategies.triangle.canExecute);
        if (!realActive) throw new Error("حالت واقعی توسط بررسی‌های ایمنی سرور تأیید نشد.");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "فعال‌سازی حالت واقعی ناموفق بود");
        return;
      }
    }

    if (nextMode === "demo" && nextRiskSnapshot?.state.masterArmed) {
      if (!window.confirm("با رفتن به حالت دمو، ورود معامله واقعی جدید متوقف شود؟")) return;
      try {
        const response = await fetch("/api/risk", {
          method: "POST",
          headers: { "content-type": "application/json", "x-risk-action": "bitget-dashboard" },
          body: JSON.stringify({ action: "disarm" })
        });
        const json = await response.json() as DashboardRiskSnapshot & { error?: string };
        if (!response.ok) throw new Error(json.error ?? "خاموش‌کردن حالت واقعی ناموفق بود");
        setRiskSnapshot(json);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "خاموش‌کردن حالت واقعی ناموفق بود");
        return;
      }
    }

    modeRef.current = nextMode;
    setMode(nextMode);
    setExecutionMessage(nextMode === "demo"
      ? "حالت دمو فعال است؛ فقط سود و خروجی روی اردربوک واقعی محاسبه می‌شود و هیچ سفارشی ارسال نمی‌شود."
      : "حالت واقعی فعال است؛ اجرای خودکار سمت سرور فرصت‌های معتبر را بررسی می‌کند.");
    void runScan();
  }

  const realModeActive = Boolean(
    riskSnapshot?.state.masterArmed
    && riskSnapshot.evaluation.strategies.triangle.canExecute
  );
  const demoCalculationCurrent = Boolean(
    data?.mode === "demo"
    && settings
    && Math.abs(Number(data.capitalToman) - settings.paperCapitalToman) < 1e-9
  );
  const demoOpportunity = demoCalculationCurrent
    ? data?.opportunities.find(opportunity => opportunity.executable)
    : undefined;
  const bitgetConnectionLocked = !settings
    || !riskSnapshot
    || riskSnapshot.state.masterArmed
    || riskSnapshot.activeLeases.length > 0;
  const bitgetConnectionLockReason = !riskSnapshot
    ? "در حال دریافت وضعیت ایمنی اجرا…"
    : riskSnapshot.state.masterArmed
      ? "برای تغییر این گزینه‌ها ابتدا Master Live را خاموش کنید."
      : riskSnapshot.activeLeases.length > 0
        ? "تغییر تنظیمات تا پایان معامله یا بازیابی در حال اجرا قفل است."
        : "این تنظیمات فقط اتصال خصوصی و سفارش‌های حالت واقعی را تغییر می‌دهند.";

  const renderSettingField = (field: SettingField) => {
    if (!settings) return null;
    const hintOpen = openSettingHint === field.key;
    return <div className={`setting-field ${hintOpen ? "hint-open" : ""}`} key={field.key}>
      <div className="setting-meta"><label htmlFor={`setting-${field.key}`}><b>{field.label}</b><small>{field.english}</small></label><button type="button" className="setting-help" onClick={() => setOpenSettingHint(current => current === field.key ? null : field.key)} aria-expanded={hintOpen} aria-controls={`hint-${field.key}`} title={`راهنمای ${field.english}`}><CircleHelp/></button></div>
      <div className="setting-input"><input id={`setting-${field.key}`} type="text" inputMode={field.step && field.step < 1 ? "decimal" : "numeric"} value={formatSettingNumber(settings[field.key])} onChange={event => updateNumber(field.key, event.target.value)}/><em>{field.unit}</em></div>
      {hintOpen && <div className="setting-hint" id={`hint-${field.key}`}><p>{field.description}</p><div><span className="hint-up"><TrendingUp/><b>اگر بیشتر شود</b><small>{field.increase}</small></span><span className="hint-down"><TrendingDown/><b>اگر کمتر شود</b><small>{field.decrease}</small></span></div></div>}
    </div>;
  };

  return <main className="triangle-only-dashboard">
    <header className="hero">
      <div className="brand"><div className="logo">△</div><div><span className="eyebrow">BITGET TRIANGULAR ARBITRAGE</span><h1>داشبورد آربیتراژ مثلثی</h1><p>اسکن کامل بازار Spot با شروع و پایان USDT</p></div></div>
    </header>

    <section className="mode-workspaces" aria-label="حالت‌های دمو و واقعی">
      <article className={`mode-workspace demo-workspace ${mode === "demo" ? "active" : ""}`}>
        <header className="mode-workspace-head">
          <span className="mode-workspace-icon"><Coins/></span>
          <div><span className="eyebrow">DEMO SIMULATION</span><h2>حالت دمو</h2><p>اسکن تمام بازارها و تمام چرخه‌های USDT با سرمایه مجازی؛ بدون اتصال به کیف پول و بدون سفارش.</p></div>
          <span className={`mode-state-badge ${mode === "demo" ? "active" : ""}`}>{mode === "demo" ? "حالت فعال" : "غیرفعال"}</span>
        </header>
        <div className="demo-mode-console">
          <div className="demo-capital-control">
            <label htmlFor="demo-capital"><span>سرمایه ورود دمو</span><small>مقدار تتر مبنای ارزیابی تمام چرخه‌ها</small></label>
            <div><input id="demo-capital" type="text" inputMode="decimal" value={settings ? formatSettingNumber(settings.paperCapitalToman) : ""} onChange={event => updateNumber("paperCapitalToman", event.target.value)} aria-label="سرمایه دمو به تتر"/><em>USDT</em></div>
            <button type="button" onClick={() => void selectDashboardMode("demo")} disabled={loading || !settings || settings.paperCapitalToman <= 0}><RefreshCw className={loading && mode === "demo" ? "spin" : ""}/>{loading && mode === "demo" ? "در حال محاسبه…" : "محاسبه سود دمو"}</button>
          </div>
          <div className="demo-profit-preview">
            <div><span>سرمایه قابل اجرا</span><b>{demoOpportunity ? `${format(demoOpportunity.inputToman)} USDT` : "—"}</b></div>
            <div><span>خروجی تخمینی</span><b>{demoOpportunity ? `${format(demoOpportunity.outputToman)} USDT` : "—"}</b></div>
            <div className={demoOpportunity && Number(demoOpportunity.netProfitToman) >= 0 ? "positive" : ""}><span>سود خالص تخمینی</span><b>{demoOpportunity ? `${format(demoOpportunity.netProfitToman)} USDT` : "—"}</b><small>{demoOpportunity ? `${format(Number(demoOpportunity.profitBps) / 100, 3)}٪` : demoCalculationCurrent ? "فعلاً فرصت قابل اجرای سودده پیدا نشد" : "برای مبلغ جدید محاسبه را اجرا کنید"}</small></div>
          </div>
          <p className="demo-safety-note"><ShieldAlert/>قیمت‌ها واقعی‌اند، اما این سکشن هیچ دسترسی خصوصی و هیچ امکان ارسال سفارش ندارد.</p>
        </div>
        <button type="button" className="mode-activate-button demo" onClick={() => void selectDashboardMode("demo")} disabled={mode === "demo"}>{mode === "demo" ? "دمو فعال است" : "فعال‌کردن حالت دمو"}</button>
      </article>

      <article className={`mode-workspace live-workspace ${mode === "live" ? "active" : ""}`}>
        <header className="mode-workspace-head">
          <span className="mode-workspace-icon"><WalletCards/></span>
          <div><span className="eyebrow">LIVE EXECUTION</span><h2>حالت واقعی</h2><p>اجرای خودکار چرخه‌های معتبر با موجودی Spot USDT و تنظیمات اختصاصی حساب Bitget.</p></div>
          <span className={`mode-state-badge ${mode === "live" && realModeActive ? "active" : ""}`}>{mode === "live" && realModeActive ? "اجرای واقعی فعال" : "متوقف"}</span>
        </header>
        <section className="mode-settings-block">
          <div className="mode-settings-title"><span>تنظیمات مخصوص واقعی</span><small>این مقادیر فقط روی سفارش‌های واقعی اثر دارند.</small></div>
          <div className="mode-setting-grid">{settings ? liveSettingFields.map(renderSettingField) : <div className="settings-loading">در حال بارگذاری تنظیمات…</div>}</div>
        </section>
        <div className="bitget-connection-settings">
          <div className="bitget-connection-copy"><span className="eyebrow">BITGET PRIVATE CONNECTION</span><b>اتصال حساب واقعی</b><small>نوع حساب و محیط API فقط متعلق به این سکشن است.</small></div>
          <div className="bitget-connection-control">
            <span>نوع حساب API</span>
            <div role="group" aria-label="نوع حساب API بیت‌گت">
              <button type="button" className={settings?.bitgetAccountMode === "uta" ? "active" : ""} aria-pressed={settings?.bitgetAccountMode === "uta"} disabled={bitgetConnectionLocked} onClick={() => updateBitgetAccountMode("uta")}><b>UTA</b><small>پیشنهادی</small></button>
              <button type="button" className={settings?.bitgetAccountMode === "classic" ? "active" : ""} aria-pressed={settings?.bitgetAccountMode === "classic"} disabled={bitgetConnectionLocked} onClick={() => updateBitgetAccountMode("classic")}><b>Classic</b><small>Spot V2</small></button>
            </div>
          </div>
          <div className="bitget-connection-control">
            <span>محیط سفارش Bitget</span>
            <div role="group" aria-label="محیط سفارش بیت‌گت">
              <button type="button" className={settings && !settings.bitgetDemoTrading ? "active" : ""} aria-pressed={Boolean(settings && !settings.bitgetDemoTrading)} disabled={bitgetConnectionLocked} onClick={() => updateBitgetDemoTrading(false)}><b>Mainnet</b><small>حساب اصلی</small></button>
              <button type="button" className={settings?.bitgetDemoTrading ? "active demo-api" : ""} aria-pressed={Boolean(settings?.bitgetDemoTrading)} disabled={bitgetConnectionLocked} onClick={() => updateBitgetDemoTrading(true)}><b>Bitget Demo API</b><small>paptrading</small></button>
            </div>
          </div>
          <p className={bitgetConnectionLocked ? "locked" : ""}><ShieldAlert/>{bitgetConnectionLockReason}</p>
        </div>
        <div className="live-mode-console">
          <div><span>وضعیت اجرا</span><b>{realModeActive ? "فعال" : "متوقف"}</b><small>با کلید همین سکشن روشن یا خاموش می‌شود.</small></div>
          <div><span>USDT آزاد حساب</span><b>{balance ? `${format(balance.availableToman, 2)} USDT` : balanceError ? "خطا در موجودی" : mode === "live" ? "در حال دریافت…" : "پس از فعال‌سازی"}</b><small>سقف هر چرخه: {settings ? format(settings.maxTradeToman) : "—"} USDT</small></div>
          <button type="button" onClick={() => void runScan()} disabled={loading || mode !== "live"}><RefreshCw className={loading && mode === "live" ? "spin" : ""}/>{loading && mode === "live" ? "در حال اسکن…" : "اسکن فوری واقعی"}</button>
        </div>
        <button type="button" className="mode-activate-button live" onClick={() => void selectDashboardMode("live")} disabled={mode === "live" && realModeActive}>{mode === "live" && realModeActive ? "حالت واقعی فعال است" : "فعال‌کردن حالت واقعی"}</button>
      </article>
    </section>

    <div className={`notice ${riskSnapshot?.state.masterArmed ? "live-notice" : ""}`}><AlertTriangle size={22}/><div><b>{riskSnapshot?.state.masterArmed ? "اجرای واقعی آربیتراژ مثلثی روشن است." : "حالت دمو فعال است؛ اجرای واقعی خاموش است."}</b><span>{riskSnapshot?.state.masterArmed ? "فقط چرخه‌های USDT که همه کنترل‌های عمق، سود و ریسک را پاس کنند اجازه سفارش دارند." : "قیمت‌ها از اردربوک واقعی کل بازار مرتبط می‌آیند، اما هیچ سفارشی ارسال نمی‌شود."}</span></div></div>
    {executionMessage && <div className={`execution-message ${mode === "live" ? "active" : "paused"}`}>{executionMessage}</div>}
    {error && <div className="error">{error}</div>}

    <section className="settings-panel panel" id="settings">
      <div className="settings-head"><div><span className="eyebrow">SHARED SETTINGS</span><h2><Settings2/> تنظیمات عمومی اسکن</h2><p>این مقادیر در هر دو حالت دمو و واقعی روی تمام بازارها و چرخه‌های آربیتراژ مثلثی اعمال می‌شوند.</p></div><span className="save-state">{saving ? "در حال ذخیره…" : saved ? "تنظیمات ذخیره شد" : ""}</span></div>
      {!settings ? <div className="settings-loading">در حال بارگذاری تنظیمات…</div> : <>
        <div className="settings-groups">{settingGroups.map(group => {
          const GroupIcon = group.icon;
          return <section className="setting-group" key={group.id}>
            <header className="setting-group-head"><GroupIcon/><div><h3>{group.title}<span>{group.english}</span></h3><p>{group.description}</p></div></header>
            <div className="setting-group-grid">{group.fields.map(renderSettingField)}</div>
          </section>;
        })}</div>
      </>}
    </section>

    {data && <>
      <section className="stats"><article className={`balance-card ${mode === "live" && balanceError ? "balance-error" : ""}`}>{mode === "demo" ? <><span><Coins/> سرمایه دمو</span><b>{settings ? `${format(settings.paperCapitalToman)} USDT` : "در حال دریافت…"}</b><small>شبیه‌سازی محلی · بدون دسترسی به کیف پول</small></> : <><span><WalletCards/> ارزش کل کیف اسپات <button type="button" className="balance-refresh" onClick={() => void fetchBalance()} disabled={balanceLoading} title="به‌روزرسانی موجودی" aria-label="به‌روزرسانی موجودی"><RefreshCw className={balanceLoading ? "spin" : ""}/></button></span><b>{balanceError ? "خطا در دریافت موجودی" : balance ? `${format(balance.spotTotalToman)} USDT` : "در حال دریافت…"}</b>{balance && !balanceError && <small title={balance.unpricedAssets?.length ? `بدون نرخ USDT: ${balance.unpricedAssets.map(item => item.asset).join(", ")}` : undefined}>USDT نقد آزاد: {format(balance.availableToman, 2)}{balance.unpricedAssets?.length ? ` · ${format(balance.unpricedAssets.length)} دارایی بدون قیمت` : ""}</small>}{balanceError && <small title={balanceError}>{balanceError}</small>}</>}</article><article className="market-coverage-card"><span>اسکن تمام بازارهای Spot</span><b>{format(data.exchangeMarketCount)} بازار</b><small>{format(data.marketCount)} از {format(data.relevantMarketCount)} بازار سازندهٔ مثلث کامل · {format(data.triangleCount)} چرخه جهت‌دار USDT · {format(data.depthRefinedMarketCount)} بازار با بازبینی عمق</small></article><article><span>فرصت‌های همین اسکن</span><b>{format(data.executableCount)}</b><small>{format(data.positiveCount)} سود مثبت · {format(data.liquiditySafePositiveCount)} نقدشونده · {format(data.evaluatedSizeCount)} سناریوی سرمایه</small></article><article><span>آخرین اسکن کامل</span><b>{new Date(data.scannedAt).toLocaleTimeString("fa-IR")}</b><small>Engine {format(data.engineMs)}ms · {format(data.refinedPathCount)} مسیر بهینه‌سازی‌شده</small></article></section>
      <section className="results"><div className="section-title"><div><span className="eyebrow">ALL TRIANGULAR CYCLES</span><h2>تمام چرخه‌های بررسی‌شده</h2></div><span>{format(data.opportunities.length)} نتیجه از {format(data.triangleCount)} چرخه جهت‌دار · {data.mode === "live" ? `اسکن واقعی با سقف ${format(data.capitalToman)} USDT` : `دمو با سرمایه ${format(data.capitalToman)} USDT`} · عمق، اسپرد، اثر قیمت، کارمزد و لغزش لحاظ شده</span></div>
        {!data.opportunities.length && <div className="empty">برای این مبلغ هیچ مسیر سه‌مرحله‌ای با عمق و داده تازه پیدا نشد.</div>}
        {data.opportunities.map((opportunity, index) => <article className={`opportunity ${opportunity.executable ? "good" : ""}`} key={opportunity.id}>
          <div className="rank">{format(index + 1)}</div><div className="route">{opportunity.route.map((asset, i) => <span key={`${asset}-${i}`}><b>{asset === "USDT" ? "USDT" : asset}</b>{i < opportunity.route.length - 1 && <ArrowLeft/>}</span>)}</div>
          <div className="money"><span>خروجی</span><b>{format(opportunity.outputToman)} USDT</b></div><div className={`profit ${Number(opportunity.netProfitToman) >= 0 ? "positive" : "negative"}`}><span>سود خالص</span><b>{format(opportunity.netProfitToman)} USDT</b><small>{format(Number(opportunity.profitBps) / 100, 3)}٪</small></div>
          <div className="status"><span>{opportunity.executable ? "قابل اجرا با عمق فعلی" : opportunity.rejectionReason}</span>{opportunity.sizingMode === "diagnostic-minimum" ? <span className="sizing diagnostic">تست سریع حداقل سفارش: {format(opportunity.inputToman)} USDT · این عدد سرمایه پیشنهادی معامله نیست</span> : <span className="sizing">سرمایه بهینه: {format(opportunity.inputToman)} USDT از سقف {format(opportunity.requestedInputToman)} USDT{opportunity.sizedByDepth ? " · برای نقدشوندگی بهینه شد" : ""}</span>}</div><details><summary>جزئیات عمق سه سفارش</summary><div className="legs">{opportunity.legs.map((leg, i) => <div key={leg.symbol}><span>{i + 1}. {leg.from} ← {leg.to}</span><b>{leg.side} {leg.symbol}</b><small>{format(leg.levelsUsed)} از {format(leg.totalLevels ?? leg.levelsUsed)} سطح · مصرف عمق {format(leg.depthConsumedPercent ?? 0, 2)}٪</small><small>اثر قیمت {format(Number(leg.priceImpactBps ?? 0) / 100, 3)}٪ · اسپرد {format(Number(leg.spreadBps ?? 0) / 100, 3)}٪</small><small>ورودی {format(leg.input, 8)} {leg.from} ← خروجی {format(leg.output, 8)} {leg.to}</small></div>)}</div></details>
        </article>)}
      </section>
      <section className="execution-panel panel">
        <div className="section-title"><div><span className="eyebrow">REAL TRADE LOG</span><h2>لاگ معاملات واقعی</h2><small className="section-note">PnL اقتصادی شامل ارزش ماندهٔ Dust است؛ فقط ردیف «کاملاً تسویه‌شده» سود نقدی قطعی دارد.</small></div><div className="section-actions"><span>{format(liveExecutions?.summary.completedCount ?? 0)} تکمیل‌شده از {format(liveExecutions?.summary.attemptCount ?? 0)} تلاش · PnL {format(liveExecutions?.summary.totalActualProfitToman ?? 0)} USDT</span><button type="button" className="history-clear" onClick={() => void clearExecutionHistory()} disabled={clearingExecutionHistory}><Trash2/>{clearingExecutionHistory ? "در حال پاک‌سازی…" : "پاک کردن لاگ نهایی"}</button></div></div>
        {!liveExecutions?.records.length ? <div className="empty">هنوز هیچ اجرای واقعی آغاز نشده است.</div> : <div className="execution-list">{liveExecutions.records.map(record => <article className={`execution-row ${record.status.toLowerCase()}`} key={record.id}>
          <div><span className={`execution-status ${record.status.toLowerCase()}`}>{executionStatusLabel[record.status]}</span><b>معامله واقعی #{format(record.id)}</b><div className="history-route">{record.route.map((asset, index) => <span key={`${asset}-${index}`}>{asset === "USDT" ? "USDT" : asset}{index < record.route.length - 1 ? " ← " : ""}</span>)}</div><small>{new Date(record.startedAt).toLocaleString("fa-IR")}</small></div>
          <div><span>سرمایه بهینه</span><b>{record.plannedInputToman === null ? "—" : `${format(record.plannedInputToman)} USDT`}</b><small>سقف واقعی: {format(record.requestedInputToman)} USDT</small></div>
          <div><span>سود برنامه‌ریزی‌شده</span><b>{record.plannedProfitToman === null ? "—" : `${format(record.plannedProfitToman)} USDT`}</b><small>{record.orders.length} سفارش ثبت‌شده در لاگ</small></div>
          <div><span>PnL اقتصادی</span><b className={record.actualProfitToman !== null && record.actualProfitToman >= 0 ? "positive" : "negative"}>{record.actualProfitToman === null ? "—" : `${format(record.actualProfitToman)} USDT`}</b><small>{record.fullySettled === true ? `کاملاً تسویه‌شده · سود نقدی ${format(record.realizedProfitToman ?? record.actualProfitToman ?? 0)} USDT` : record.fullySettled === false ? `تسویه‌نشده · نقدی ${format(record.realizedProfitToman ?? 0)} · مانده ${format(record.residualValueToman ?? 0)} USDT` : record.completedAt ? "رکورد قدیمی؛ وضعیت مانده مشخص نیست" : "در انتظار نتیجه نهایی"}</small></div>
          {record.error && <div className="execution-error">{record.error}</div>}
          <details><summary>سفارش‌های واقعی و شناسه‌های بیت‌گت</summary>{!record.orders.length ? <div className="no-orders">هنوز سفارشی ارسال یا تکمیل نشده است.</div> : <div className="execution-orders">{record.orders.map((order, index) => <div key={`${order.orderId}-${index}`}><span>{index + 1}. {order.side} {order.symbol}</span><b>Order ID: {order.orderId}</b><small>وضعیت: {order.status} · خروجی واقعی: {format(order.output, 8)}</small><small>اثر قیمت {format(Number(order.priceImpactBps) / 100, 3)}٪ · اسپرد {format(Number(order.spreadBps) / 100, 3)}٪ · {format(order.levelsUsed)} سطح</small></div>)}</div>}</details>
        </article>)}</div>}
      </section>
      <section className="history-panel panel">
        <div className="section-title"><div><span className="eyebrow">OPPORTUNITY DETECTIONS</span><h2>تاریخچه فرصت‌های شناسایی‌شده</h2><small className="section-note">برچسب Live فقط یعنی فرصت هنگام اسکن Live دیده شده؛ انجام معامله فقط در «لاگ معاملات واقعی» ثبت می‌شود.</small></div><div className="section-actions"><span>{format(history?.summary.uniqueRouteCount ?? 0)} مسیر یکتا · {format(history?.summary.recordCount ?? 0)} رکورد دقیقه‌ای</span><button type="button" className="history-clear" onClick={() => void clearDetectedHistory()} disabled={clearingHistory}><Trash2/>{clearingHistory ? "در حال پاک‌سازی…" : "پاک کردن تاریخچه"}</button></div></div>
        {!history?.records.length ? <div className="empty">هنوز مسیر دارای سود خالص مثبت در دیتابیس ثبت نشده است.</div> : <div className="history-list">{history.records.map(record => <article className="history-row" key={record.id}>
          <div><span className={`history-mode ${record.mode}`}>{record.mode === "live" ? "اسکن واقعی" : "اسکن دمو"}</span><div className="history-route">{record.route.map((asset, index) => <span key={`${asset}-${index}`}>{asset === "USDT" ? "USDT" : asset}{index < record.route.length - 1 ? " ← " : ""}</span>)}</div><small>{new Date(record.lastSeenAt).toLocaleString("fa-IR")}</small></div>
          <div><span>آخرین سود</span><b className="positive">{format(record.latestProfitToman)} USDT</b><small>{format(record.latestProfitBps / 100, 3)}٪</small></div>
          <div><span>بهترین سود</span><b>{format(record.bestProfitToman)} USDT</b><small>{format(record.bestProfitBps / 100, 3)}٪</small></div>
          <div><span>دفعات مشاهده</span><b>{format(record.detections)}</b><small className={record.executable ? "positive" : "history-rejection"}>{detectedOpportunityStatus(record)}</small></div>
          <details><summary>جزئیات مسیر</summary><div className="legs">{record.legs.map((leg, index) => <div key={`${leg.symbol}-${index}`}><span>{index + 1}. {leg.from} ← {leg.to}</span><b>{leg.side} {leg.symbol}</b><small>{format(leg.levelsUsed)} از {format(leg.totalLevels ?? leg.levelsUsed)} سطح اردربوک{leg.depthConsumedPercent !== undefined ? ` · مصرف ${format(leg.depthConsumedPercent, 2)}٪` : ""}</small>{leg.priceImpactBps !== undefined && <small>اثر قیمت {format(Number(leg.priceImpactBps) / 100, 3)}٪ · اسپرد {format(Number(leg.spreadBps ?? 0) / 100, 3)}٪</small>}</div>)}</div></details>
        </article>)}</div>}
      </section>
    </>}

    <section className="database-danger-zone panel">
      <div className="database-danger-icon"><ShieldAlert/></div>
      <div className="database-danger-content"><span className="eyebrow">DATABASE MANAGEMENT</span><h2>حذف کامل داده‌های آربیتراژ</h2><p>فرصت‌ها، معاملات، Order IDها و Audit Ledger حذف می‌شوند. تنظیمات ربات، Risk State و اطلاعات اتصال دست‌نخورده می‌مانند.</p><small>فقط با اجرای واقعی خاموش و بدون معامله، Recovery یا Lease فعال قابل انجام است.</small></div>
      <button type="button" className="database-purge-button" onClick={() => void purgeAllDatabaseData()} disabled={purgingDatabase || riskSnapshot?.state.masterArmed} title={riskSnapshot?.state.masterArmed ? "ابتدا اجرای واقعی را خاموش کنید" : "حذف دائمی رکوردهای آربیتراژ"}><Trash2/>{purgingDatabase ? "در حال حذف…" : "حذف کامل داده‌ها"}</button>
    </section>
  </main>;
}
