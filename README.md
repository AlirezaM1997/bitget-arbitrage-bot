# ربات آربیتراژ مثلثی Bitget

یک ترمینال RTL برای کشف و اجرای آربیتراژ مثلثی در بازار Spot بیت‌گت با مبنای `USDT`. معماری هسته، اسکن دو‌مرحله‌ای، کنترل ریسک، Recovery، لاگ پایدار و داشبورد از پروژه‌ی مرجع `nobitex-arbitrage` پیروی می‌کند، اما قرارداد بازار و اجرای سفارش برای Bitget بازطراحی شده است.

> [!CAUTION]
> آربیتراژ سه سفارش اتمیک نیست و این نرم‌افزار سود را تضمین نمی‌کند. تغییر قیمت، کارمزد واقعی حساب، Partial Fill، لغزش، کمبود عمق، قطع WebSocket یا نامشخص ماندن وضعیت سفارش می‌تواند باعث زیان و نیاز به مداخله دستی شود.

## وضعیت این نسخه

- فقط موتور **Triangular Arbitrage** قابلیت اجرای واقعی دارد.
- موتورهای Gap، Imbalance و AI پروژه‌ی مرجع عمداً از Runtime و UI خارج و در Risk Capability روی `unavailable` قفل شده‌اند.
- Anchor فعلی `USDT` است و چرخه‌ها به‌شکل `USDT → Asset A → Asset B → USDT` کشف می‌شوند.
- حالت **Demo** با سرمایه USDT انتخابی از داده واقعی بازار استفاده می‌کند، سود و خروجی را محاسبه می‌کند و هیچ سفارشی نمی‌فرستد.
- حالت **Real** فقط پس از فعال‌شدن Triangle و `Master Live` در کنترل ریسک اجازه اجرای سفارش دارد.
- اجرای سفارش فقط در `next start`، پس از روشن‌کردن Triangle و `Master Live`، گرفتن Live Owner و Execution Lease مجاز است.
- فایل‌های state و دیتابیس پروژه مرجع منتقل نشده‌اند؛ state اولیه همیشه `masterArmed=false` است.

## امکانات اصلی

- کشف خودکار تمام مثلث‌های متصل به USDT از metadata رسمی symbolها
- اردربوک چندسطحی `books15` با snapshotهای immutable، freshness و cross-book skew guard
- محدودکردن WebSocket به symbolهای واقعاً عضو یک مثلث و تقسیم subscriptionها بین چند اتصال
- محاسبه با `Decimal`، کارمزد، spread، price impact، slippage و درصد مجاز مصرف عمق
- بهینه‌سازی اندازه معامله به‌جای فرض‌کردن اینکه بیشترین سرمایه بهترین انتخاب است
- precision، quantity step، price step، minimum quantity و `minTradeUSDT` در سطح هر symbol
- بازاعتبارسنجی کامل مسیر قبل از ضلع اول و پیش از هر ضلع بعدی
- سفارش محافظت‌شده `limit IOC` با قیمت سقف/کف استخراج‌شده از عمق شبیه‌سازی‌شده
- ثبت durable رویداد `SUBMITTING` و `clientOid` پیش از درخواست شبکه
- reconciliation با `clientOid` پس از timeout مبهم برای جلوگیری از سفارش تکراری
- استفاده از Fill قطعی و fee asset واقعی برای تعیین ورودی ضلع بعدی
- Recovery عمومی دارایی باقی‌مانده به USDT و ثبت جداگانه Dust
- SQLite با WAL، لاگ اجرای واقعی و ledger زنجیره‌شده با SHA-256
- Master Live، Emergency Stop، سقف زیان روزانه، سقف زیان پیاپی و اجرای هم‌زمان
- Startup Audit برای متوقف‌کردن اجرای خودکار در حضور شواهد یک چرخه نیمه‌تمام

## معماری

```text
Bitget REST metadata + books15 WebSocket
                  ↓
          Triangle Scanner / Engine
                  ↓
       Demo Dashboard + Opportunity DB
                  ↓
   Production Scheduler (server-side only)
                  ↓
Risk Gate → Live Owner → Execution Lease
                  ↓
      3 × protected IOC order + polling
                  ↓
 Fill accounting → Recovery → PnL / Ledger
```

مرورگر فقط نمایش، تنظیمات و فرمان‌های کنترل ریسک را انجام می‌دهد. بستن تب، Scheduler سمت سرور را متوقف نمی‌کند؛ برای توقف ورودهای جدید باید `Master Live` را خاموش کنید یا Emergency Stop بزنید.

## نصب و اجرای Demo

نیازمندی پیشنهادی: Bun 1.3+ یا Node.js 22+.

```powershell
bun install
Copy-Item .env.example .env.local
bun run dev
```

داشبورد روی `http://127.0.0.1:3000` در دسترس است. حالت Demo برای داده عمومی به credential نیاز ندارد. مبلغ `Demo Capital` را با USDT تعیین کنید تا ورودی قابل اجرا، خروجی تخمینی، سود خالص و درصد بازده هر چرخه محاسبه شود.

## تنظیم `.env.local`

Bitget علاوه بر Key و Secret، حتماً Passphrase همان API Key را می‌خواهد:

```dotenv
BITGET_API_BASE="https://api.bitget.com"
BITGET_WS_PUBLIC="wss://ws.bitget.com/v2/ws/public"

BITGET_API_KEY=""
BITGET_API_SECRET=""
BITGET_API_PASSPHRASE=""
```

نکات:

- برای کلید فقط مجوزهای Spot `Read` و `Trade` را فعال کنید؛ مجوز Withdraw لازم نیست.
- IP Allowlist را در پنل Bitget فعال کنید.
- نوع حساب را در داشبورد روی `UTA` (پیشنهادی Bitget) یا `Classic Spot V2` بگذارید؛ انتخاب باید دقیقاً با نوع همان API Key یکی باشد.
- حالت Demo داخل داشبورد یک شبیه‌سازی محلی و مستقل از API خصوصی است و بدون کلید کار می‌کند.
- برای ثبت سفارش روی حساب آزمایشی خود Bitget، در داشبورد `Bitget Demo API` را انتخاب و Demo API Key وارد کنید؛ در این حالت هدر `paptrading: 1` ارسال می‌شود.
- نوع حساب و محیط سفارش هنگام روشن بودن Master Live یا وجود معامله/بازیابی در حال اجرا قفل هستند.
- فایل env را commit یا در لاگ/اسکرین‌شات منتشر نکنید.

## اجرای Real روی Bitget Demo یا Mainnet

اجرای سفارش در Development عمداً مسدود است. پس از تکمیل env:

```powershell
bun run build
bun run start
```

سپس در داشبورد:

1. محیط و کامل‌بودن credentialها را در «کنترل ریسک» بررسی کنید.
2. سرمایه، fee fallback، slippage، حداقل سود و محدودیت‌های عمق را بازبینی کنید.
3. Triangle را روشن نگه دارید و `Master Live` را آگاهانه فعال کنید.
4. ابتدا با Demo و سپس با سرمایه بسیار کم Mainnet آزمون کنید.

خاموش‌کردن Master جلوی معامله جدید را می‌گیرد. Recovery یک exposure اثبات‌شده می‌تواند برای کاهش ریسک ادامه پیدا کند. وضعیت `MANUAL_REVIEW` یا `LIVE_ORDER_STATE_UNKNOWN` نیازمند تطبیق دستی Order IDها و موجودی در پنل Bitget است.

## تنظیمات داشبورد

- `Demo Capital`: مقدار USDT برای شبیه‌سازی هر چرخه و محاسبه سود
- `Max Live Trade`: سقف سخت سرمایه هر چرخه واقعی
- `Balance Usage`: درصد موجودی آزاد USDT قابل استفاده
- `USDT-quoted / Cross-pair Fee`: fallback محافظه‌کارانه؛ نرخ رسمی symbol در صورت دسترسی مقدم است
- `Slippage Buffer` و `Live Safety Buffer`: حاشیه تغییر بازار میان اسکن و Fill
- `Max Price Impact`، `Max Spread` و `Depth Usage`: محدودیت کیفیت نقدشوندگی
- `Minimum Net Return` و `Minimum Net Profit`: شرط درصدی و عددی سود
- `Orderbook Max Age`: بیشترین عمر snapshot مجاز
- `Scan Interval`: فاصله tickهای اسکن سمت سرور
- `Order Timeout`: مهلت تعیین تکلیف IOC و reconciliation

## داده‌های پایدار

| مسیر | محتوا |
|---|---|
| `data/bot-settings.json` | تنظیمات داشبورد؛ state اولیه محافظه‌کارانه |
| `data/risk-state.json` | Master، Emergency Stop، محدودیت‌ها و PnL روزانه |
| `data/arbitrage.sqlite` | تاریخچه فرصت‌ها و اجرای Triangle |
| `data/execution-ledger.sqlite` | رویدادهای hash-chained سفارش‌های واقعی |

فایل‌های runtime و SQLite در `.gitignore` هستند. هیچ state یا Order ID از پروژه مرجع در این پروژه وجود ندارد.

## تست و بررسی

تست‌ها از clientهای تزریقی استفاده می‌کنند و نباید سفارش واقعی بفرستند:

```powershell
bun test
bun run typecheck
bun run build
```

## محدودیت‌های مهم

- سه ضلع یک تراکنش واحد نیستند؛ ضلع دوم فقط بعد از Fill قطعی ضلع اول شروع می‌شود.
- REST acknowledgement به معنی Fill نیست؛ وضعیت سفارش تا terminal شدن poll و reconcile می‌شود.
- IOC می‌تواند ناقص پر شود؛ مقدار ضلع بعدی از `cumExec` واقعی ساخته می‌شود.
- fee ممکن است از base، quote یا BGB کم شود؛ محاسبه باید fee coin را لحاظ کند.
- WebSocket ممکن است قطع شود؛ snapshot stale یا دارای sequence gap وارد اجرای واقعی نمی‌شود.
- این برنامه برای یک میزبان محلی طراحی شده و احراز هویت مناسب انتشار عمومی ندارد. آن را روی `0.0.0.0`، LAN یا اینترنت عمومی منتشر نکنید.

## مستندات رسمی

- [Bitget API Introduction](https://www.bitget.com/api-doc/common/intro)
- [REST Signature](https://www.bitget.com/api-doc/common/signature)
- [Spot Symbols](https://www.bitget.com/api-doc/spot/market/Get-Symbols)
- [Spot Depth WebSocket](https://www.bitget.com/api-doc/spot/websocket/public/Depth-Channel)
- [Spot Place Order](https://www.bitget.com/api-doc/spot/trade/Place-Order)
- [Spot Order Info](https://www.bitget.com/api-doc/spot/trade/Get-Order-Info)
- [Demo Trading](https://www.bitget.com/api-doc/common/demotrading/restapi)
- [UTA API](https://www.bitget.com/api-doc/uta/intro)
