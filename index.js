// =================================================================
// Advanced Analytics Bot - v136.0 (Grammy Version + Closed Trade Review + AI Analysis)
// =================================================================
const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const { Configuration, OpenAIApi } = require("openai"); // NEW: Import OpenAI
require("dotenv").config();
const { connectDB, getDB } = require("./database.js");

// --- Bot Setup ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);

// --- State Variables ---
let waitingState = null;

// --- AI Setup ---
const openaiConfig = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(openaiConfig);

// =================================================================
// SECTION 0: OKX API ADAPTER
// =================================================================
class OKXAdapter {
    constructor() {
        this.name = "OKX";
        this.baseURL = "https://www.okx.com";
    }
    getHeaders(method, path, body = "") {
        const timestamp = new Date().toISOString();
        const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body);
        const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64");
        return {
            "OK-ACCESS-KEY": process.env.OKX_API_KEY,
            "OK-ACCESS-SIGN": sign,
            "OK-ACCESS-TIMESTAMP": timestamp,
            "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
            "Content-Type": "application/json",
        };
    }
    async getMarketPrices() {
        try {
            const tickersRes = await fetch(`${this.baseURL}/api/v5/market/tickers?instType=SPOT`);
            const tickersJson = await tickersRes.json();
            if (tickersJson.code !== '0') { return { error: `فشل جلب أسعار السوق: ${tickersJson.msg}` }; }
            const prices = {};
            tickersJson.data.forEach(t => {
                if (t.instId.endsWith('-USDT')) {
                    const lastPrice = parseFloat(t.last);
                    const openPrice = parseFloat(t.open24h);
                    let change24h = 0;
                    if (openPrice > 0) change24h = (lastPrice - openPrice) / openPrice;
                    prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h, volCcy24h: parseFloat(t.volCcy24h) };
                }
            });
            return prices;
        } catch (error) { return { error: "خطأ استثنائي عند جلب أسعار السوق." }; }
    }
    async getPortfolio(prices) {
        try {
            const path = "/api/v5/account/balance";
            const res = await fetch(`${this.baseURL}${path}`, { headers: this.getHeaders("GET", path) });
            const json = await res.json();
            if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) { return { error: `فشل جلب المحفظة: ${json.msg || 'بيانات غير متوقعة'}` }; }
            let assets = [], total = 0, usdtValue = 0;
            json.data[0].details.forEach(asset => {
                const amount = parseFloat(asset.eq);
                if (amount > 0) {
                    const instId = `${asset.ccy}-USDT`;
                    const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 };
                    const value = amount * priceData.price;
                    total += value;
                    if (asset.ccy === "USDT") usdtValue = value;
                    if (value >= 1) assets.push({ asset: asset.ccy, price: priceData.price, value, amount, change24h: priceData.change24h });
                }
            });
            assets.sort((a, b) => b.value - a.value);
            return { assets, total, usdtValue };
        } catch (e) { return { error: "خطأ في الاتصال بمنصة OKX." }; }
    }
    async getBalanceForComparison() {
        try {
            const path = "/api/v5/account/balance";
            const res = await fetch(`${this.baseURL}${path}`, { headers: this.getHeaders("GET", path) });
            const json = await res.json();
            if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) { return null; }
            const balances = {};
            json.data[0].details.forEach(asset => {
                const amount = parseFloat(asset.eq);
                if (amount > 0) balances[asset.ccy] = amount;
            });
            return balances;
        } catch (e) { return null; }
    }
}
const okxAdapter = new OKXAdapter();

// =================================================================
// SECTION 1: DATABASE AND HELPER FUNCTIONS
// =================================================================
const getCollection = (collectionName) => getDB().collection(collectionName);
async function getConfig(id, defaultValue = {}) { try { const doc = await getCollection("configs").findOne({ _id: id }); return doc ? doc.data : defaultValue; } catch (e) { return defaultValue; } }
async function saveConfig(id, data) { try { await getCollection("configs").updateOne({ _id: id }, { $set: { data } }, { upsert: true }); } catch (e) { console.error(`Error in saveConfig for id: ${id}`, e); } }
async function saveClosedTrade(tradeData) { try { await getCollection("tradeHistory").insertOne({ ...tradeData, closedAt: new Date(), _id: new crypto.randomBytes(16).toString("hex") }); } catch (e) { console.error("Error in saveClosedTrade:", e); } }
async function getHistoricalPerformance(asset) { try { const history = await getCollection("tradeHistory").find({ asset: asset }).toArray(); if (history.length === 0) { return { realizedPnl: 0, tradeCount: 0, winningTrades: 0, losingTrades: 0, avgDuration: 0 }; } const realizedPnl = history.reduce((sum, trade) => sum + trade.pnl, 0); const winningTrades = history.filter(trade => trade.pnl > 0).length; const losingTrades = history.filter(trade => trade.pnl <= 0).length; const totalDuration = history.reduce((sum, trade) => sum + trade.durationDays, 0); const avgDuration = history.length > 0 ? totalDuration / history.length : 0; return { realizedPnl, tradeCount: history.length, winningTrades, losingTrades, avgDuration }; } catch (e) { return null; } }
async function saveVirtualTrade(tradeData) { try { const tradeWithId = { ...tradeData, _id: new crypto.randomBytes(16).toString("hex") }; await getCollection("virtualTrades").insertOne(tradeWithId); return tradeWithId; } catch (e) { console.error("Error saving virtual trade:", e); } }
async function getActiveVirtualTrades() { try { return await getCollection("virtualTrades").find({ status: 'active' }).toArray(); } catch (e) { return []; } }
async function updateVirtualTradeStatus(tradeId, status, finalPrice) { try { await getCollection("virtualTrades").updateOne({ _id: tradeId }, { $set: { status: status, closePrice: finalPrice, closedAt: new Date() } }); } catch (e) { console.error(`Error updating virtual trade ${tradeId}:`, e); } }
const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadSettings = async () => await getConfig("settings", { dailySummary: true, autoPostToChannel: false, debugMode: false, dailyReportTime: "22:00" });
const saveSettings = (settings) => saveConfig("settings", settings);
const loadPositions = async () => await getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);
const loadHistory = async () => await getConfig("dailyHistory", []);
const saveHistory = (history) => saveConfig("dailyHistory", history);
const loadHourlyHistory = async () => await getConfig("hourlyHistory", []);
const saveHourlyHistory = (history) => saveConfig("hourlyHistory", history);
const loadBalanceState = async () => await getConfig("balanceState", {});
const saveBalanceState = (state) => saveConfig("balanceState", state);
const loadAlerts = async () => await getConfig("priceAlerts", []);
const saveAlerts = (alerts) => saveConfig("priceAlerts", alerts);
const loadAlertSettings = async () => await getConfig("alertSettings", { global: 5, overrides: {} });
const saveAlertSettings = (settings) => saveConfig("alertSettings", settings);
const loadPriceTracker = async () => await getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => saveConfig("priceTracker", tracker);
function formatNumber(num, decimals = 2) { const number = parseFloat(num); if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals); return number.toFixed(decimals); }
async function sendDebugMessage(message) { const settings = await loadSettings(); if (settings.debugMode) { try { await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug (OKX):* ${message}`, { parse_mode: "Markdown" }); } catch (e) { console.error("Failed to send debug message:", e); } } }

// =================================================================
// SECTION 2: DATA PROCESSING FUNCTIONS
// =================================================================
async function getInstrumentDetails(instId) { try { const tickerRes = await fetch(`${okxAdapter.baseURL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`); const tickerJson = await tickerRes.json(); if (tickerJson.code !== '0' || !tickerJson.data[0]) { return { error: `لم يتم العثور على العملة.` }; } const tickerData = tickerJson.data[0]; return { price: parseFloat(tickerData.last), high24h: parseFloat(tickerData.high24h), low24h: parseFloat(tickerData.low24h), vol24h: parseFloat(tickerData.volCcy24h), }; } catch (e) { throw new Error("خطأ في الاتصال بالمنصة لجلب بيانات السوق."); } }
async function getHistoricalCandles(instId, bar = '1D', limit = 100) { let allCandles = []; let before = ''; const maxLimitPerRequest = 100; try { while (allCandles.length < limit) { const currentLimit = Math.min(maxLimitPerRequest, limit - allCandles.length); const url = `${okxAdapter.baseURL}/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=${currentLimit}${before}`; const res = await fetch(url); const json = await res.json(); if (json.code !== '0' || !json.data || json.data.length === 0) { break; } const newCandles = json.data.map(c => ({ time: parseInt(c[0]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]) })); allCandles.push(...newCandles); if (newCandles.length < maxLimitPerRequest) { break; } const lastTimestamp = newCandles[newCandles.length - 1].time; before = `&before=${lastTimestamp}`; } return allCandles.reverse(); } catch (e) { console.error(`Error fetching historical candles for ${instId}:`, e); return []; } }
async function getAssetPriceExtremes(instId) { try { const [yearlyCandles, allTimeCandles] = await Promise.all([ getHistoricalCandles(instId, '1D', 365), getHistoricalCandles(instId, '1M', 240) ]); if (yearlyCandles.length === 0) return null; const getHighLow = (candles) => { if (!candles || candles.length === 0) return { high: 0, low: Infinity }; return candles.reduce((acc, candle) => ({ high: Math.max(acc.high, candle.high), low: Math.min(acc.low, candle.low) }), { high: 0, low: Infinity }); }; const weeklyCandles = yearlyCandles.slice(-7); const monthlyCandles = yearlyCandles.slice(-30); const formatLow = (low) => low === Infinity ? 0 : low; const weeklyExtremes = getHighLow(weeklyCandles); const monthlyExtremes = getHighLow(monthlyCandles); const yearlyExtremes = getHighLow(yearlyCandles); const allTimeExtremes = getHighLow(allTimeCandles); return { weekly: { high: weeklyExtremes.high, low: formatLow(weeklyExtremes.low) }, monthly: { high: monthlyExtremes.high, low: formatLow(monthlyExtremes.low) }, yearly: { high: yearlyExtremes.high, low: formatLow(yearlyExtremes.low) }, allTime: { high: allTimeExtremes.high, low: formatLow(allTimeExtremes.low) } }; } catch (error) { console.error(`Error in getAssetPriceExtremes for ${instId}:`, error); return null; } }
function calculateSMA(closes, period) { if (closes.length < period) return null; const sum = closes.slice(-period).reduce((acc, val) => acc + val, 0); return sum / period; }
function calculateRSI(closes, period = 14) { if (closes.length < period + 1) return null; let gains = 0, losses = 0; for (let i = 1; i <= period; i++) { const diff = closes[i] - closes[i - 1]; diff > 0 ? gains += diff : losses -= diff; } let avgGain = gains / period, avgLoss = losses / period; for (let i = period + 1; i < closes.length; i++) { const diff = closes[i] - closes[i - 1]; if (diff > 0) { avgGain = (avgGain * (period - 1) + diff) / period; avgLoss = (avgLoss * (period - 1)) / period; } else { avgLoss = (avgLoss * (period - 1) - diff) / period; avgGain = (avgGain * (period - 1)) / period; } } if (avgLoss === 0) return 100; const rs = avgGain / avgLoss; return 100 - (100 / (1 + rs)); }
async function getTechnicalAnalysis(instId) { const candleData = (await getHistoricalCandles(instId, '1D', 51)); if (candleData.length < 51) return { error: "بيانات الشموع غير كافية." }; const closes = candleData.map(c => c.close); return { rsi: calculateRSI(closes, 14), sma20: calculateSMA(closes, 20), sma50: calculateSMA(closes, 50) }; }
function calculatePerformanceStats(history) { if (history.length < 2) return null; const values = history.map(h => h.total); const startValue = values[0]; const endValue = values[values.length - 1]; const pnl = endValue - startValue; const pnlPercent = (startValue > 0) ? (pnl / startValue) * 100 : 0; const maxValue = Math.max(...values); const minValue = Math.min(...values); const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length; const dailyReturns = []; for (let i = 1; i < values.length; i++) { dailyReturns.push((values[i] - values[i - 1]) / values[i - 1]); } const bestDayChange = dailyReturns.length > 0 ? Math.max(...dailyReturns) * 100 : 0; const worstDayChange = dailyReturns.length > 0 ? Math.min(...dailyReturns) * 100 : 0; const avgReturn = dailyReturns.length > 0 ? dailyReturns.reduce((sum, ret) => sum + ret, 0) / dailyReturns.length : 0; const volatility = dailyReturns.length > 0 ? Math.sqrt(dailyReturns.map(x => Math.pow(x - avgReturn, 2)).reduce((a, b) => a + b) / dailyReturns.length) * 100 : 0; let volText = "متوسط"; if(volatility < 1) volText = "منخفض"; if(volatility > 5) volText = "مرتفع"; return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue, bestDayChange, worstDayChange, volatility, volText }; }
function createChartUrl(data, type = 'line', title = '', labels = [], dataLabel = '') { if (!data || data.length === 0) return null; const pnl = data[data.length - 1] - data[0]; const chartColor = pnl >= 0 ? 'rgb(75, 192, 75)' : 'rgb(255, 99, 132)'; const chartBgColor = pnl >= 0 ? 'rgba(75, 192, 75, 0.2)' : 'rgba(255, 99, 132, 0.2)'; const chartConfig = { type: 'line', data: { labels: labels, datasets: [{ label: dataLabel, data: data, fill: true, backgroundColor: chartBgColor, borderColor: chartColor, tension: 0.1 }] }, options: { title: { display: true, text: title } } }; return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`; }

// =================================================================
// NEW SECTION: AI ANALYSIS
// =================================================================
async function analyzeWithAI(prompt) {
    try {
        const completion = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: "أنت محلل مالي متخصص في العملات الرقمية، تتحدث بالعربية الفصحى، وتقدم تحليلات دقيقة، واضحة، وسهلة الفهم." },
                { role: "user", content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 300
        });
        return completion.data.choices[0].message.content.trim();
    } catch (error) {
        console.error("AI Analysis Error:", error);
        return "❌ تعذر إجراء التحليل بالذكاء الاصطناعي. قد يكون هناك مشكلة في الاتصال أو المفتاح السري.";
    }
}

async function getAIAnalysisForAsset(asset) {
    const instId = `${asset}-USDT`;
    const [details, tech, perf] = await Promise.all([
        getInstrumentDetails(instId),
        getTechnicalAnalysis(instId),
        getHistoricalPerformance(asset)
    ]);

    if (details.error) return `لا يمكن تحليل ${asset}: ${details.error}`;

    const prompt = `
    قم بتحليل عملة ${asset} بناءً على البيانات التالية:
    - السعر الحالي: $${formatNumber(details.price)}
    - أعلى 24 ساعة: $${formatNumber(details.high24h)}
    - أدنى 24 ساعة: $${formatNumber(details.low24h)}
    - حجم التداول: $${formatNumber(details.vol24h / 1e6)} مليون
    - RSI: ${formatNumber(tech.rsi)}
    - SMA20: $${formatNumber(tech.sma20, 4)}
    - SMA50: $${formatNumber(tech.sma50, 4)}
    - عدد الصفقات السابقة: ${perf.tradeCount}
    - معدل النجاح: ${formatNumber(perf.winningTrades / (perf.tradeCount || 1) * 100)}%
    
    قدم تحليلًا موجزًا، توصية (شراء/بيع/观望)، وسببك بلغة عربية واضحة.
    `;

    return await analyzeWithAI(prompt);
}

async function getAIAnalysisForPortfolio(assets, total, capital) {
    const topAssets = assets.slice(0, 5).map(a => `${a.asset} (${formatNumber(a.value)}$ - ${formatNumber(a.value/total*100)}%)`).join(', ');
    const pnlPercent = capital > 0 ? ((total - capital) / capital) * 100 : 0;
    const prompt = `
    قم بتحليل المحفظة الاستثمارية التالية:
    - القيمة الإجمالية: $${formatNumber(total)}
    - رأس المال: $${formatNumber(capital)}
    - الربح/الخسارة: ${formatNumber(pnlPercent)}%
    - أبرز الأصول: ${topAssets}
    
    قدم تقييمًا لصحة المحفظة، وتوازنها، وفرص التحسين، وخطوات مستقبلية مقترحة باللغة العربية.
    `;

    return await analyzeWithAI(prompt);
}

// =================================================================
// SECTION 3: FORMATTING AND MESSAGE FUNCTIONS
// =================================================================
function formatClosedTradeReview(trade, currentPrice) {
    const { asset, avgBuyPrice, avgSellPrice, quantity, pnl: actualPnl, pnlPercent: actualPnlPercent } = trade;
    let msg = `*🔍 مراجعة صفقة مغلقة | ${asset}*
`;
    msg += `━━━━━━━━━━━━━━━━━━━━
`;
    msg += `*ملاحظة: هذا تحليل "ماذا لو" لصفقة مغلقة، ولا يؤثر على محفظتك الحالية.*
`;
    msg += `*ملخص الأسعار الرئيسي:*
`;
    msg += `  - 💵 *سعر الشراء الأصلي:* \`$${formatNumber(avgBuyPrice, 4)}\`
`;
    msg += `  - ✅ *سعر الإغلاق الفعلي:* \`$${formatNumber(avgSellPrice, 4)}\`
`;
    msg += `  - 📈 *السعر الحالي للسوق:* \`$${formatNumber(currentPrice, 4)}\`
`;
    const actualPnlSign = actualPnl >= 0 ? '+' : '';
    const actualEmoji = actualPnl >= 0 ? '🟢' : '🔴';
    msg += `*الأداء الفعلي للصفقة (عند الإغلاق):*
`;
    msg += `  - *النتيجة:* \`${actualPnlSign}$${formatNumber(actualPnl)}\` ${actualEmoji}
`;
    msg += `  - *نسبة العائد:* \`${actualPnlSign}${formatNumber(actualPnlPercent)}%\`
`;
    const hypotheticalPnl = (currentPrice - avgBuyPrice) * quantity;
    const hypotheticalPnlPercent = (avgBuyPrice > 0) ? (hypotheticalPnl / (avgBuyPrice * quantity)) * 100 : 0;
    const hypotheticalPnlSign = hypotheticalPnl >= 0 ? '+' : '';
    const hypotheticalEmoji = hypotheticalPnl >= 0 ? '🟢' : '🔴';
    msg += `*الأداء الافتراضي (لو بقيت الصفقة مفتوحة):*
`;
    msg += `  - *النتيجة الحالية:* \`${hypotheticalPnlSign}$${formatNumber(hypotheticalPnl)}\` ${hypotheticalEmoji}
`;
    msg += `  - *نسبة العائد الحالية:* \`${hypotheticalPnlSign}${formatNumber(hypotheticalPnlPercent)}%\`
`;
    const priceChangeSinceClose = currentPrice - avgSellPrice;
    const priceChangePercent = (avgSellPrice > 0) ? (priceChangeSinceClose / avgSellPrice) * 100 : 0;
    const changeSign = priceChangeSinceClose >= 0 ? '⬆️' : '⬇️';
    msg += `*تحليل قرار الخروج:*
`;
    msg += `  - *حركة السعر منذ الإغلاق:* \`${formatNumber(priceChangePercent)}%\` ${changeSign}
`;
    if (priceChangeSinceClose > 0) {
        msg += `  - *الخلاصة:* 📈 لقد واصل السعر الصعود بعد خروجك. كانت هناك فرصة لتحقيق ربح أكبر.
`;
    } else {
        msg += `  - *الخلاصة:* ✅ لقد كان قرارك بالخروج صائبًا، حيث انخفض السعر بعد ذلك وتجنبت خسارة أو تراجع في الأرباح.
`;
    }
    return msg;
}

function formatPrivateBuy(details) { const { asset, price, amountChange, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; let msg = `*مراقبة الأصول 🔬:*
**عملية استحواذ جديدة 🟢**
━━━━━━━━━━━━━━━━━━━━
`; msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`
`; msg += `🔸 **نوع العملية:** تعزيز مركز / بناء مركز جديد
`; msg += `━━━━━━━━━━━━━━━━━━━━
*تحليل الصفقة:*
`; msg += ` ▪️ **سعر التنفيذ:** \`$${formatNumber(price, 4)}\`
`; msg += ` ▪️ **الكمية المضافة:** \`${formatNumber(Math.abs(amountChange), 6)}\`
`; msg += ` ▪️ **التكلفة الإجمالية للصفقة:** \`$${formatNumber(tradeValue)}\`
`; msg += `━━━━━━━━━━━━━━━━━━━━
*التأثير على هيكل المحفظة:*
`; msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${formatNumber(tradeSizePercent)}%\`
`; msg += ` ▪️ **الوزن الجديد للأصل:** \`${formatNumber(newAssetWeight)}%\`
`; msg += ` ▪️ **السيولة المتبقية (USDT):** \`$${formatNumber(newUsdtValue)}\`
`; msg += ` ▪️ **مؤشر السيولة الحالي:** \`${formatNumber(newCashPercent)}%\`
`; msg += `━━━━━━━━━━━━━━━━━━━━
*بتاريخ:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }

function formatPrivateSell(details) { const { asset, price, amountChange, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; let msg = `*مراقبة الأصول 🔬:*
**مناورة تكتيكية 🟠**
━━━━━━━━━━━━━━━━━━━━
`; msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`
`; msg += `🔸 **نوع العملية:** تخفيف المركز / جني أرباح جزئي
`; msg += `━━━━━━━━━━━━━━━━━━━━
*تحليل الصفقة:*
`; msg += ` ▪️ **سعر التنفيذ:** \`$${formatNumber(price, 4)}\`
`; msg += ` ▪️ **الكمية المخففة:** \`${formatNumber(Math.abs(amountChange), 6)}\`
`; msg += ` ▪️ **العائد الإجمالي للصفقة:** \`$${formatNumber(tradeValue)}\`
`; msg += `━━━━━━━━━━━━━━━━━━━━
*التأثير على هيكل المحفظة:*
`; msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${formatNumber(tradeSizePercent)}%\`
`; msg += ` ▪️ **الوزن الجديد للأصل:** \`${formatNumber(newAssetWeight)}%\`
`; msg += ` ▪️ **السيولة الجديدة (USDT):** \`$${formatNumber(newUsdtValue)}\`
`; msg += ` ▪️ **مؤشر السيولة الحالي:** \`${formatNumber(newCashPercent)}%\`
`; msg += `━━━━━━━━━━━━━━━━━━━━
*بتاريخ:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }

function formatPrivateCloseReport(details) { const { asset, avgBuyPrice, avgSellPrice, pnl, pnlPercent, durationDays, highestPrice, lowestPrice } = details; const pnlSign = pnl >= 0 ? '+' : ''; const emoji = pnl >= 0 ? '🟢' : '🔴'; let msg = `*ملف المهمة المكتملة 📂:*
**تم إغلاق مركز ${asset} بنجاح ✅**
━━━━━━━━━━━━━━━━━━━━
`; msg += `*النتيجة النهائية للمهمة:*
`; msg += ` ▪️ **الحالة:** **${pnl >= 0 ? "مربحة" : "خاسرة"}**
`; msg += ` ▪️ **صافي الربح/الخسارة:** \`${pnlSign}$${formatNumber(pnl)}\` ${emoji}
`; msg += ` ▪️ **نسبة العائد على الاستثمار (ROI):** \`${pnlSign}${formatNumber(pnlPercent)}%\`
`; msg += `━━━━━━━━━━━━━━━━━━━━
*الجدول الزمني والأداء:*
`; msg += ` ▪️ **مدة الاحتفاظ بالمركز:** \`${formatNumber(durationDays, 1)} يوم\`
`; msg += ` ▪️ **متوسط سعر الدخول:** \`$${formatNumber(avgBuyPrice, 4)}\`
`; msg += ` ▪️ **متوسط سعر الخروج:** \`$${formatNumber(avgSellPrice, 4)}\`
`; msg += ` ▪️ **أعلى قمة سعرية مسجلة:** \`$${formatNumber(highestPrice, 4)}\`
`; msg += ` ▪️ **أدنى قاع سعري مسجل:** \`$${formatNumber(lowestPrice, 4)}\`
`; msg += `━━━━━━━━━━━━━━━━━━━━
*بتاريخ الإغلاق:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }

function formatPublicBuy(details) { const { asset, price, oldTotalValue, tradeValue, oldUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; const cashConsumedPercent = (oldUsdtValue > 0) ? (tradeValue / oldUsdtValue) * 100 : 0; let msg = `*💡 توصية جديدة: بناء مركز في ${asset} 🟢*
━━━━━━━━━━━━━━━━━━━━
`; msg += `*الأصل:* \`${asset}/USDT\`
`; msg += `*سعر الدخول الحالي:* \`$${formatNumber(price, 4)}\`
`; msg += `━━━━━━━━━━━━━━━━━━━━
*استراتيجية إدارة المحفظة:*
`; msg += ` ▪️ *حجم الدخول:* تم تخصيص \`${formatNumber(tradeSizePercent)}%\` من المحفظة لهذه الصفقة.
`; msg += ` ▪️ *استهلاك السيولة:* استهلك هذا الدخول \`${formatNumber(cashConsumedPercent)}%\` من السيولة النقدية المتاحة.
`; msg += ` ▪️ *السيولة المتبقية:* بعد الصفقة، أصبحت السيولة تشكل \`${formatNumber(newCashPercent)}%\` من المحفظة.
`; msg += `━━━━━━━━━━━━━━━━━━━━
*ملاحظات:*
نرى في هذه المستويات فرصة واعدة. المراقبة مستمرة، وسنوافيكم بتحديثات إدارة الصفقة.
`; msg += `#توصية #${asset}`; return msg; }

function formatPublicSell(details) { const { asset, price, amountChange, position } = details; const totalPositionAmountBeforeSale = position.totalAmountBought - (position.totalAmountSold - Math.abs(amountChange)); const soldPercent = totalPositionAmountBeforeSale > 0 ? (Math.abs(amountChange) / totalPositionAmountBeforeSale) * 100 : 0; const partialPnl = (price - position.avgBuyPrice); const partialPnlPercent = position.avgBuyPrice > 0 ? (partialPnl / position.avgBuyPrice) * 100 : 0; let msg = `*⚙️ تحديث التوصية: إدارة مركز ${asset} 🟠*
━━━━━━━━━━━━━━━━━━━━
`; msg += `*الأصل:* \`${asset}/USDT\`
`; msg += `*سعر البيع الجزئي:* \`$${formatNumber(price, 4)}\`
`; msg += `━━━━━━━━━━━━━━━━━━━━
*استراتيجية إدارة المحفظة:*
`; msg += ` ▪️ *الإجراء:* تم بيع \`${formatNumber(soldPercent)}%\` من مركزنا لتأمين الأرباح.
`; msg += ` ▪️ *النتيجة:* ربح محقق على الجزء المباع بنسبة \`${formatNumber(partialPnlPercent)}%\` 🟢.
`; msg += ` ▪️ *حالة المركز:* لا يزال المركز مفتوحًا بالكمية المتبقية.
`; msg += `━━━━━━━━━━━━━━━━━━━━
*ملاحظات:*
خطوة استباقية لإدارة المخاطر وحماية رأس المال. نستمر في متابعة الأهداف الأعلى.
`; msg += `#إدارة_مخاطر #${asset}`; return msg; }

function formatPublicClose(details) { const { asset, pnlPercent, durationDays, avgBuyPrice, avgSellPrice } = details; const pnlSign = pnlPercent >= 0 ? '+' : ''; const emoji = pnlPercent >= 0 ? '🟢' : '🔴'; let msg = `*🏆 النتيجة النهائية لتوصية ${asset} ✅*
━━━━━━━━━━━━━━━━━━━━
`; msg += `*الأصل:* \`${asset}/USDT\`
`; msg += `*الحالة:* **تم إغلاق الصفقة بالكامل.**
`; msg += `━━━━━━━━━━━━━━━━━━━━
*ملخص أداء التوصية:*
`; msg += ` ▪️ **متوسط سعر الدخول:** \`$${formatNumber(avgBuyPrice, 4)}\`
`; msg += ` ▪️ **متوسط سعر الخروج:** \`$${formatNumber(avgSellPrice, 4)}\`
`; msg += ` ▪️ **العائد النهائي على الاستثمار (ROI):** \`${pnlSign}${formatNumber(pnlPercent)}%\` ${emoji}
`; msg += ` ▪️ **مدة التوصية:** \`${formatNumber(durationDays, 1)} يوم\`
`; msg += `━━━━━━━━━━━━━━━━━━━━
*الخلاصة:*
`; if (pnlPercent >= 0) { msg += `صفقة موفقة أثبتت أن الصبر على التحليل يؤتي ثماره.
`; } else { msg += `الخروج بانضباط وفقًا للخطة هو نجاح بحد ذاته. نحافظ على رأس المال للفرصة القادمة.
`; } msg += `
نبارك لمن اتبع التوصية. نستعد الآن للبحث عن الفرصة التالية.
`; msg += `#نتائجتوصيات #${asset}`; return msg; }

async function formatPortfolioMsg(assets, total, capital) { const positions = await loadPositions(); const usdtAsset = assets.find(a => a.asset === "USDT") || { value: 0 }; const cashPercent = total > 0 ? (usdtAsset.value / total) * 100 : 0; const investedPercent = 100 - cashPercent; const pnl = capital > 0 ? total - capital : 0; const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0; const pnlSign = pnl >= 0 ? '+' : ''; const pnlEmoji = pnl >= 0 ? '🟢⬆️' : '🔴⬇️'; let dailyPnlText = " `لا توجد بيانات كافية`"; let totalValue24hAgo = 0; assets.forEach(asset => { if (asset.asset === 'USDT') totalValue24hAgo += asset.value; else if (asset.change24h !== undefined && asset.price > 0) totalValue24hAgo += asset.amount * (asset.price / (1 + asset.change24h)); else totalValue24hAgo += asset.value; }); if (totalValue24hAgo > 0) { const dailyPnl = total - totalValue24hAgo; const dailyPnlPercent = (dailyPnl / totalValue24hAgo) * 100; const dailySign = dailyPnl >= 0 ? '+' : ''; const dailyEmoji = dailyPnl >= 0 ? '🟢⬆️' : '🔴⬇️'; dailyPnlText = ` ${dailyEmoji} \`$${dailySign}${formatNumber(dailyPnl)}\` (\`${dailySign}${formatNumber(dailyPnlPercent)}%\`)`; } let caption = `🧾 *التقرير التحليلي للمحفظة*
`; caption += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*
`; caption += `━━━━━━━━━━━━━━━━━━━
*نظرة عامة على الأداء:*
`; caption += ` ▫️ *القيمة الإجمالية:* \`$${formatNumber(total)}\`
`; if (capital > 0) { caption += ` ▫️ *رأس المال:* \`$${formatNumber(capital)}\`
`; } caption += ` ▫️ *إجمالي الربح غير المحقق:* ${pnlEmoji} \`$${pnlSign}${formatNumber(pnl)}\` (\`${pnlSign}${formatNumber(pnlPercent)}%\`)
`; caption += ` ▫️ *الأداء اليومي (24س):*${dailyPnlText}
`; caption += ` ▫️ *السيولة:* 💵 نقدي ${formatNumber(cashPercent)}% / 📈 مستثمر ${formatNumber(investedPercent)}%
`; caption += `━━━━━━━━━━━━━━━━━━━━
*مكونات المحفظة:*
`; const cryptoAssets = assets.filter(a => a.asset !== "USDT"); cryptoAssets.forEach((a, index) => { const percent = total > 0 ? (a.value / total) * 100 : 0; const position = positions[a.asset]; caption += `
╭─ *${a.asset}/USDT*
`; caption += `├─ *القيمة الحالية:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)
`; if (position?.avgBuyPrice) { caption += `├─ *متوسط الشراء:* \`$${formatNumber(position.avgBuyPrice, 4)}\`
`; } caption += `├─ *سعر السوق:* \`$${formatNumber(a.price, 4)}\`
`; const dailyChangeEmoji = a.change24h >= 0 ? '🟢⬆️' : '🔴⬇️'; caption += `├─ *الأداء اليومي:* ${dailyChangeEmoji} \`${formatNumber(a.change24h * 100)}%\`
`; if (position?.avgBuyPrice > 0) { const totalCost = position.avgBuyPrice * a.amount; const assetPnl = a.value - totalCost; const assetPnlPercent = totalCost > 0 ? (assetPnl / totalCost) * 100 : 0; const assetPnlEmoji = assetPnl >= 0 ? '🟢' : '🔴'; const assetPnlSign = assetPnl >= 0 ? '+' : ''; caption += `╰─ *ربح/خسارة غير محقق:* ${assetPnlEmoji} \`$${assetPnlSign}${formatNumber(assetPnl)}\` (\`${assetPnlSign}${formatNumber(assetPnlPercent)}%\`)`; } else { caption += `╰─ *ربح/خسارة غير محقق:* \`غير مسجل\``; } if (index < cryptoAssets.length - 1) { caption += `
━━━━━━━━━━━━━━━━━━━━`; } }); caption += `
━━━━━━━━━━━━━━━━━━━━
*USDT (الرصيد النقدي)* 💵
`; caption += `*القيمة:* \`$${formatNumber(usdtAsset.value)}\` (*الوزن:* \`${formatNumber(cashPercent)}%\`)`; return { caption }; }

async function formatAdvancedMarketAnalysis(ownedAssets = []) { const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) return `❌ فشل جلب بيانات السوق. ${prices.error || ''}`; const marketData = Object.entries(prices).map(([instId, data]) => ({ instId, ...data })).filter(d => d.volCcy24h > 10000 && d.change24h !== undefined); marketData.sort((a, b) => b.change24h - a.change24h); const topGainers = marketData.slice(0, 5); const topLosers = marketData.slice(-5).reverse(); marketData.sort((a, b) => b.volCcy24h - a.volCcy24h); const highVolume = marketData.slice(0, 5); const ownedSymbols = ownedAssets.map(a => a.asset); let msg = `🚀 *تحليل السوق المتقدم (OKX)* | ${new Date().toLocaleDateString("ar-EG")}
`; msg += `━━━━━━━━━━━━━━━━━━━
`; const avgGainerChange = topGainers.length > 0 ? topGainers.reduce((sum, g) => sum + g.change24h, 0) / topGainers.length : 0; const avgLoserChange = topLosers.length > 0 ? topLosers.reduce((sum, l) => sum + Math.abs(l.change24h), 0) / topLosers.length : 0; let sentimentText = "محايدة 😐
(هناك فرص للنمو لكن التقلبات عالية)"; if (avgGainerChange > avgLoserChange * 1.5) { sentimentText = "صعودي 🟢
(معنويات السوق إيجابية، والرابحون يتفوقون)"; } else if (avgLoserChange > avgGainerChange * 1.5) { sentimentText = "هبوطي 🔴
(معنويات السوق سلبية، والخاسرون يسيطرون)"; } msg += `📊 *معنويات السوق:* ${sentimentText}
━━━━━━━━━━━━━━━━━━━
`; msg += "📈 *أكبر الرابحين (24س):*
" + topGainers.map(c => { const symbol = c.instId.split('-')[0]; const ownedMark = ownedSymbols.includes(symbol) ? ' ✅' : ''; return ` - \`${c.instId}\`: \`+${formatNumber(c.change24h * 100)}%\`${ownedMark}`; }).join('
') + "
"; msg += "📉 *أكبر الخاسرين (24س):*
" + topLosers.map(c => { const symbol = c.instId.split('-')[0]; const ownedMark = ownedSymbols.includes(symbol) ? ' ✅' : ''; return ` - \`${c.instId}\`: \`${formatNumber(c.change24h * 100)}%\`${ownedMark}`; }).join('
') + "
"; msg += "📊 *الأعلى في حجم التداول:*
" + highVolume.map(c => ` - \`${c.instId}\`: \`${(c.volCcy24h / 1e6).toFixed(2)}M\` USDT`).join('
') + "
"; let smartRecommendation = "💡 *توصية:* راقب الأصول ذات حجم التداول المرتفع، فهي غالبًا ما تقود اتجاه السوق."; const ownedGainers = topGainers.filter(g => ownedSymbols.includes(g.instId.split('-')[0])); const ownedLosers = topLosers.filter(l => ownedSymbols.includes(l.instId.split('-')[0])); if (ownedGainers.length > 0) { smartRecommendation = `💡 *توصية ذكية:* عملة *${ownedGainers[0].instId.split('-')[0]}* التي تملكها ضمن أكبر الرابحين. قد تكون فرصة جيدة لتقييم المركز.`; } else if (ownedLosers.length > 0) { smartRecommendation = `💡 *توصية ذكية:* عملة *${ownedLosers[0].instId.split('-')[0]}* التي تملكها ضمن أكبر الخاسرين. قد يتطلب الأمر مراجعة وقف الخسارة أو استراتيجيتك.`; } msg += `${smartRecommendation}`; return msg; }

async function formatQuickStats(assets, total, capital) { const pnl = capital > 0 ? total - capital : 0; const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0; const statusEmoji = pnl >= 0 ? '🟢' : '🔴'; const statusText = pnl >= 0 ? 'ربح' : 'خسارة'; let msg = "⚡ *إحصائيات سريعة*
"; msg += `💎 *إجمالي الأصول:* \`${assets.filter(a => a.asset !== 'USDT').length}\`
`; msg += `💰 *القيمة الحالية:* \`$${formatNumber(total)}\`
`; if (capital > 0) { msg += `📈 *نسبة الربح/الخسارة:* \`${formatNumber(pnlPercent)}%\`
`; msg += `🎯 *الحالة:* ${statusEmoji} ${statusText}
`; } msg += `
━━━━━━━━━━━━━━━━━━━━
*تحليل القمم والقيعان للأصول:*
`; const cryptoAssets = assets.filter(a => a.asset !== "USDT"); if (cryptoAssets.length === 0) { msg += "
`لا توجد أصول في محفظتك لتحليلها.`"; } else { const assetExtremesPromises = cryptoAssets.map(asset => getAssetPriceExtremes(`${asset.asset}-USDT`) ); const assetExtremesResults = await Promise.all(assetExtremesPromises); cryptoAssets.forEach((asset, index) => { const extremes = assetExtremesResults[index]; msg += `
🔸 *${asset.asset}:*
`; if (extremes) { msg += ` *الأسبوعي:* قمة \`$${formatNumber(extremes.weekly.high, 4)}\` / قاع \`$${formatNumber(extremes.weekly.low, 4)}\`
`; msg += ` *الشهري:* قمة \`$${formatNumber(extremes.monthly.high, 4)}\` / قاع \`$${formatNumber(extremes.monthly.low, 4)}\`
`; msg += ` *السنوي:* قمة \`$${formatNumber(extremes.yearly.high, 4)}\` / قاع \`$${formatNumber(extremes.yearly.low, 4)}\`
`; msg += ` *التاريخي:* قمة \`$${formatNumber(extremes.allTime.high, 4)}\` / قاع \`$${formatNumber(extremes.allTime.low, 4)}\``; } else { msg += ` \`تعذر جلب البيانات التاريخية.\``; } }); } msg += `
⏰ *آخر تحديث:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }

async function formatPerformanceReport(period, periodLabel, history, btcHistory) { const stats = calculatePerformanceStats(history); if (!stats) return { error: "ℹ️ لا توجد بيانات كافية لهذه الفترة." }; let btcPerformanceText = " `لا تتوفر بيانات`"; let benchmarkComparison = ""; if (btcHistory && btcHistory.length >= 2) { const btcStart = btcHistory[0].close; const btcEnd = btcHistory[btcHistory.length - 1].close; const btcChange = (btcEnd - btcStart) / btcStart * 100; btcPerformanceText = `\`${btcChange >= 0 ? '+' : ''}${formatNumber(btcChange)}%\``; if (stats.pnlPercent > btcChange) { benchmarkComparison = `▪️ *النتيجة:* أداء أعلى من السوق ✅`; } else { benchmarkComparison = `▪️ *النتيجة:* أداء أقل من السوق ⚠️`; } } const chartLabels = history.map(h => period === '24h' ? new Date(h.time).getHours() + ':00' : new Date(h.time).toLocaleDateString('en-GB', {day: '2-digit', month: '2-digit'})); const chartDataPoints = history.map(h => h.total); const chartUrl = createChartUrl(chartDataPoints, 'line', `أداء المحفظة - ${periodLabel}`, chartLabels, 'قيمة المحفظة ($)'); const pnlSign = stats.pnl >= 0 ? '+' : ''; const emoji = stats.pnl >= 0 ? '🟢⬆️' : '🔴⬇️'; let caption = `📊 *تحليل أداء المحفظة | ${periodLabel}*
`; caption += `📈 *النتيجة:* ${emoji} \`$${pnlSign}${formatNumber(stats.pnl)}\` (\`${pnlSign}${formatNumber(stats.pnlPercent)}%\`)
`; caption += `*التغير الصافي: من \`$${formatNumber(stats.startValue)}\` إلى \`$${formatNumber(stats.endValue)}\`*
`; caption += `*📝 مقارنة معيارية (Benchmark):*
`; caption += `▪️ *أداء محفظتك:* \`${stats.pnlPercent >= 0 ? '+' : ''}${formatNumber(stats.pnlPercent)}%\`
`; caption += `▪️ *أداء عملة BTC:* ${btcPerformanceText}
`; caption += `${benchmarkComparison}
`; caption += `*📈 مؤشرات الأداء الرئيسية:*
`; caption += `▪️ *أفضل يوم:* \`+${formatNumber(stats.bestDayChange)}%\`
`; caption += `▪️ *أسوأ يوم:* \`${formatNumber(stats.worstDayChange)}%\`
`; caption += `▪️ *مستوى التقلب:* ${stats.volText}`; return { caption, chartUrl }; }

// =================================================================
// SECTION 4: BACKGROUND JOBS & DYNAMIC MANAGEMENT
// =================================================================
async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount, oldTotalValue) {
    if (!asset || price === undefined || price === null || isNaN(price)) return { analysisResult: null };
    const positions = await loadPositions();
    let position = positions[asset];
    let analysisResult = { type: 'none', data: {} };
    if (amountChange > 0) {
        const tradeValue = amountChange * price;
        const entryCapitalPercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0;
        if (!position) {
            positions[asset] = {
                totalAmountBought: amountChange,
                totalCost: tradeValue,
                avgBuyPrice: price,
                openDate: new Date().toISOString(),
                totalAmountSold: 0,
                realizedValue: 0,
                highestPrice: price,
                lowestPrice: price,
                entryCapitalPercent: entryCapitalPercent,
            };
            position = positions[asset];
        } else {
            position.totalAmountBought += amountChange;
            position.totalCost += tradeValue;
            position.avgBuyPrice = position.totalCost / position.totalAmountBought;
            if (price > position.highestPrice) position.highestPrice = price;
            if (price < position.lowestPrice) position.lowestPrice = price;
        }
        analysisResult.type = 'buy';
    } else if (amountChange < 0 && position) {
        const soldAmount = Math.abs(amountChange);
        position.realizedValue = (position.realizedValue || 0) + (soldAmount * price);
        position.totalAmountSold = (position.totalAmountSold || 0) + soldAmount;
        if (newTotalAmount * price < 1) {
            const closedQuantity = position.totalAmountBought;
            const investedCapital = position.avgBuyPrice * closedQuantity;
            const realizedValue = position.realizedValue;
            const finalPnl = realizedValue - investedCapital;
            const finalPnlPercent = investedCapital > 0 ? (finalPnl / investedCapital) * 100 : 0;
            const closeDate = new Date();
            const openDate = new Date(position.openDate);
            const durationDays = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24);
            const avgSellPrice = position.totalAmountSold > 0 ? position.realizedValue / position.totalAmountSold : 0;
            const closeReportData = {
                asset,
                pnl: finalPnl,
                pnlPercent: finalPnlPercent,
                durationDays,
                avgBuyPrice: position.avgBuyPrice,
                avgSellPrice,
                highestPrice: position.highestPrice,
                lowestPrice: position.lowestPrice,
                entryCapitalPercent: position.entryCapitalPercent,
                exitQuantityPercent: 100,
                quantity: closedQuantity
            };
            await saveClosedTrade(closeReportData);
            analysisResult = { type: 'close', data: closeReportData };
            delete positions[asset];
        } else {
            analysisResult.type = 'sell';
        }
    }
    await savePositions(positions);
    analysisResult.data.position = positions[asset] || position;
    return { analysisResult };
}

async function monitorBalanceChanges() {
    try {
        await sendDebugMessage("Checking balance changes...");
        const previousState = await loadBalanceState();
        const previousBalances = previousState.balances || {};
        const currentBalance = await okxAdapter.getBalanceForComparison();
        if (!currentBalance) {
            await sendDebugMessage("Could not fetch current balance to compare.");
            return;
        }
        const prices = await okxAdapter.getMarketPrices();
        if (!prices || prices.error) {
            await sendDebugMessage("Could not fetch market prices to compare.");
            return;
        }
        const { assets: newAssets, total: newTotalValue, usdtValue: newUsdtValue, error } = await okxAdapter.getPortfolio(prices);
        if (error || newTotalValue === undefined) {
            await sendDebugMessage(`Portfolio fetch error: ${error}`);
            return;
        }
        if (Object.keys(previousBalances).length === 0) {
            await sendDebugMessage("Initializing first balance state. No notifications will be sent.");
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue });
            return;
        }
        const oldTotalValue = previousState.totalValue || 0;
        let stateNeedsUpdate = false;
        const allAssets = new Set([...Object.keys(previousBalances), ...Object.keys(currentBalance)]);
        for (const asset of allAssets) {
            if (asset === 'USDT') continue;
            const prevAmount = previousBalances[asset] || 0;
            const currAmount = currentBalance[asset] || 0;
            const difference = currAmount - prevAmount;
            const priceData = prices[`${asset}-USDT`];
            if (!priceData || !priceData.price || isNaN(priceData.price) || Math.abs(difference * priceData.price) < 1) {
                continue;
            }
            stateNeedsUpdate = true;
            await sendDebugMessage(`Detected change for ${asset}: ${difference}`);
            const { analysisResult } = await updatePositionAndAnalyze(asset, difference, priceData.price, currAmount, oldTotalValue);
            if (analysisResult.type === 'none') continue;
            const tradeValue = Math.abs(difference) * priceData.price;
            const newAssetData = newAssets.find(a => a.asset === asset);
            const newAssetValue = newAssetData ? newAssetData.value : 0;
            const newAssetWeight = newTotalValue > 0 ? (newAssetValue / newTotalValue) * 100 : 0;
            const newCashPercent = newTotalValue > 0 ? (newUsdtValue / newTotalValue) * 100 : 0;
            const oldUsdtValue = previousBalances['USDT'] || 0;
            const baseDetails = { asset, price: priceData.price, amountChange: difference, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent, oldUsdtValue, position: analysisResult.data.position };
            const settings = await loadSettings();
            let privateMessage, publicMessage;
            if (analysisResult.type === 'buy') {
                privateMessage = formatPrivateBuy(baseDetails);
                publicMessage = formatPublicBuy(baseDetails);
                await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" });
                if (settings.autoPostToChannel) {
                    await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" });
                }
            } else if (analysisResult.type === 'sell') {
                privateMessage = formatPrivateSell(baseDetails);
                publicMessage = formatPublicSell(baseDetails);
                await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" });
                if (settings.autoPostToChannel) {
                    await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" });
                }
            } else if (analysisResult.type === 'close') {
                privateMessage = formatPrivateCloseReport(analysisResult.data);
                publicMessage = formatPublicClose(analysisResult.data);
                if (settings.autoPostToChannel) {
                    await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" });
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" });
                } else {
                    const confirmationKeyboard = new InlineKeyboard()
                        .text("✅ نعم، انشر التقرير", "publish_report")
                        .text("❌ لا، تجاهل", "ignore_report");
                    const hiddenMarker = `
<report>${JSON.stringify(publicMessage)}</report>`;
                    const confirmationMessage = `*تم إغلاق المركز بنجاح. هل تود نشر الملخص في القناة؟*
${privateMessage}${hiddenMarker}`;
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, confirmationMessage, { parse_mode: "Markdown", reply_markup: confirmationKeyboard });
                }
            }
        }
        if (stateNeedsUpdate) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue });
            await sendDebugMessage("State updated successfully after processing changes.");
        } else {
            await sendDebugMessage("No significant balance changes detected.");
        }
    } catch (e) {
        console.error("CRITICAL ERROR in monitorBalanceChanges:", e);
        await sendDebugMessage(`CRITICAL ERROR in monitorBalanceChanges: ${e.message}`);
    }
}

async function trackPositionHighLow() { try { const positions = await loadPositions(); if (Object.keys(positions).length === 0) return; const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) return; let positionsUpdated = false; for (const symbol in positions) { const position = positions[symbol]; const currentPrice = prices[`${symbol}-USDT`]?.price; if (currentPrice) { if (!position.highestPrice || currentPrice > position.highestPrice) { position.highestPrice = currentPrice; positionsUpdated = true; } if (!position.lowestPrice || currentPrice < position.lowestPrice) { position.lowestPrice = currentPrice; positionsUpdated = true; } } } if (positionsUpdated) { await savePositions(positions); await sendDebugMessage("Updated position high/low prices."); } } catch(e) { console.error("CRITICAL ERROR in trackPositionHighLow:", e); } }

async function checkPriceAlerts() { try { const alerts = await loadAlerts(); if (alerts.length === 0) return; const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) return; const remainingAlerts = []; let triggered = false; for (const alert of alerts) { const currentPrice = prices[alert.instId]?.price; if (currentPrice === undefined) { remainingAlerts.push(alert); continue; } if ((alert.condition === '>' && currentPrice > alert.price) || (alert.condition === '<' && currentPrice < alert.price)) { await bot.api.sendMessage(AUTHORIZED_USER_ID, `🚨 *تنبيه سعر!* \`${alert.instId}\`
الشرط: ${alert.condition} ${alert.price}
السعر الحالي: \`${currentPrice}\``, { parse_mode: "Markdown" }); triggered = true; } else { remainingAlerts.push(alert); } } if (triggered) await saveAlerts(remainingAlerts); } catch (error) { console.error("Error in checkPriceAlerts:", error); } }

async function checkPriceMovements() { try { await sendDebugMessage("Checking price movements..."); const alertSettings = await loadAlertSettings(); const priceTracker = await loadPriceTracker(); const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) return; const { assets, total: currentTotalValue, error } = await okxAdapter.getPortfolio(prices); if (error || currentTotalValue === undefined) return; if (priceTracker.totalPortfolioValue === 0) { priceTracker.totalPortfolioValue = currentTotalValue; assets.forEach(a => { if (a.price) priceTracker.assets[a.asset] = a.price; }); await savePriceTracker(priceTracker); return; } let trackerUpdated = false; for (const asset of assets) { if (asset.asset === 'USDT' || !asset.price) continue; const lastPrice = priceTracker.assets[asset.asset]; if (lastPrice) { const changePercent = ((asset.price - lastPrice) / lastPrice) * 100; const threshold = alertSettings.overrides[asset.asset] || alertSettings.global; if (Math.abs(changePercent) >= threshold) { const movementText = changePercent > 0 ? 'صعود' : 'هبوط'; const message = `📈 *تنبيه حركة سعر لأصل!* \`${asset.asset}\`
*الحركة:* ${movementText} بنسبة \`${formatNumber(changePercent)}%\`
*السعر الحالي:* \`$${formatNumber(asset.price, 4)}\``; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); priceTracker.assets[asset.asset] = asset.price; trackerUpdated = true; } } else { priceTracker.assets[asset.asset] = asset.price; trackerUpdated = true; } } if (trackerUpdated) await savePriceTracker(priceTracker); } catch (e) { console.error("CRITICAL ERROR in checkPriceMovements:", e); } }

async function runDailyJobs() { try { const settings = await loadSettings(); if (!settings.dailySummary) return; const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) return; const { total } = await okxAdapter.getPortfolio(prices); if (total === undefined) return; const history = await loadHistory(); const date = new Date().toISOString().slice(0, 10); const today = history.find(h => h.date === date); if (today) { today.total = total; } else { history.push({ date, total, time: Date.now() }); } if (history.length > 35) history.shift(); await saveHistory(history); console.log(`[Daily Summary Recorded]: ${date} - $${formatNumber(total)}`); } catch (e) { console.error("CRITICAL ERROR in runDailyJobs:", e); } }

async function runHourlyJobs() { try { const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) return; const { total } = await okxAdapter.getPortfolio(prices); if (total === undefined) return; const history = await loadHourlyHistory(); const hourLabel = new Date().toISOString().slice(0, 13); const existingIndex = history.findIndex(h => h.label === hourLabel); if (existingIndex > -1) { history[existingIndex].total = total; } else { history.push({ label: hourLabel, total, time: Date.now() }); } if (history.length > 72) history.splice(0, history.length - 72); await saveHourlyHistory(history); } catch (e) { console.error("Error in hourly jobs:", e); } }

async function monitorVirtualTrades() { const activeTrades = await getActiveVirtualTrades(); if (activeTrades.length === 0) return; const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) return; for (const trade of activeTrades) { const currentPrice = prices[trade.instId]?.price; if (!currentPrice) continue; let finalStatus = null; let pnl = 0; let finalPrice = 0; if (currentPrice >= trade.targetPrice) { finalPrice = trade.targetPrice; pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice); finalStatus = 'completed'; const profitPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0; const msg = `🎯 *الهدف تحقق (توصية افتراضية)!* ✅
` + `*العملة:* \`${trade.instId}\`
` + `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`
` + `*سعر الهدف:* \`$${formatNumber(trade.targetPrice, 4)}\`
` + `💰 *الربح المحقق:* \`+$${formatNumber(pnl)}\` (\`+${formatNumber(profitPercent)}%\`)`; await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" }); } else if (currentPrice <= trade.stopLossPrice) { finalPrice = trade.stopLossPrice; pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice); finalStatus = 'stopped'; const lossPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0; const msg = `🛑 *تم تفعيل وقف الخسارة (توصية افتراضية)!* 🔻
` + `*العملة:* \`${trade.instId}\`
` + `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`
` + `*سعر الوقف:* \`$${formatNumber(trade.stopLossPrice, 4)}\`
` + `💸 *الخسارة:* \`$${formatNumber(pnl)}\` (\`${formatNumber(lossPercent)}%\`)`; await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" }); } if (finalStatus) { await updateVirtualTradeStatus(trade._id, finalStatus, finalPrice); } } }

// =================================================================
// SECTION 4.5: DAILY & CUMULATIVE REPORTING
// =================================================================
async function formatDailyCopyReport() { const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000); const closedTrades = await getCollection("tradeHistory").find({ closedAt: { $gte: twentyFourHoursAgo } }).toArray(); if (closedTrades.length === 0) { return "📊 لم يتم إغلاق أي صفقات في الـ 24 ساعة الماضية."; } const today = new Date(); const dateString = `${today.getDate().toString().padStart(2, '0')}/${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getFullYear()}`; let report = `📊 تقرير النسخ اليومي – خلال الـ24 ساعة الماضية
🗓 التاريخ: ${dateString}
`; let totalPnlWeightedSum = 0; let totalWeight = 0; for (const trade of closedTrades) { if (trade.pnlPercent === undefined || trade.entryCapitalPercent === undefined) continue; const resultEmoji = trade.pnlPercent >= 0 ? '🔼' : '🔽'; report += `🔸اسم العملة: ${trade.asset}
`; report += `🔸 نسبة الدخول من رأس المال: ${formatNumber(trade.entryCapitalPercent)}%
`; report += `🔸 متوسط سعر الشراء: ${formatNumber(trade.avgBuyPrice, 4)}
`; report += `🔸 سعر الخروج: ${formatNumber(trade.avgSellPrice, 4)}
`; report += `🔸 نسبة الخروج من الكمية: ${formatNumber(trade.exitQuantityPercent)}%
`; report += `🔸 النتيجة: ${trade.pnlPercent >= 0 ? '+' : ''}${formatNumber(trade.pnlPercent)}% ${resultEmoji}
`; if (trade.entryCapitalPercent > 0) { totalPnlWeightedSum += trade.pnlPercent * trade.entryCapitalPercent; totalWeight += trade.entryCapitalPercent; } } const totalPnl = totalWeight > 0 ? totalPnlWeightedSum / totalWeight : 0; const totalPnlEmoji = totalPnl >= 0 ? '📈' : '📉'; report += `إجمالي الربح الحالي خدمة النسخ: ${totalPnl >= 0 ? '+' : ''}${formatNumber(totalPnl, 2)}% ${totalPnlEmoji}
`; report += `✍️ يمكنك الدخول في اي وقت تراه مناسب، الخدمة مفتوحة للجميع
`; report += `📢 قناة التحديثات الرسمية:
@abusalamachart
`; report += `🌐 رابط النسخ المباشر:
🏦 https://t.me/abusalamachart`; return report; }

async function runDailyReportJob() { try { await sendDebugMessage("Running daily copy-trading report job..."); const report = await formatDailyCopyReport(); if (report.startsWith("📊 لم يتم إغلاق أي صفقات")) { await bot.api.sendMessage(AUTHORIZED_USER_ID, report); } else { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, report); await bot.api.sendMessage(AUTHORIZED_USER_ID, "✅ تم إرسال تقرير النسخ اليومي إلى القناة بنجاح."); } } catch(e) { console.error("Error in runDailyReportJob:", e); await bot.api.sendMessage(AUTHORIZED_USER_ID, `❌ حدث خطأ أثناء إنشاء تقرير النسخ اليومي: ${e.message}`); } }

async function generateAndSendCumulativeReport(ctx, asset) { try { const trades = await getCollection("tradeHistory").find({ asset: asset }).toArray(); if (trades.length === 0) { await ctx.reply(`ℹ️ لا يوجد سجل صفقات مغلقة لعملة *${asset}*.`, { parse_mode: "Markdown" }); return; } const totalPnl = trades.reduce((sum, trade) => sum + (trade.pnl || 0), 0); const totalRoi = trades.reduce((sum, trade) => sum + (trade.pnlPercent || 0), 0); const avgRoi = trades.length > 0 ? totalRoi / trades.length : 0; const winningTrades = trades.filter(t => (t.pnl || 0) > 0).length; const winRate = trades.length > 0 ? (winningTrades / trades.length) * 100 : 0; const bestTrade = trades.reduce((max, trade) => (trade.pnlPercent || 0) > (max.pnlPercent || 0) ? trade : max, trades[0]); const worstTrade = trades.reduce((min, trade) => (min.pnlPercent !== undefined && (trade.pnlPercent || 0) < min.pnlPercent) ? trade : min, { pnlPercent: 0}); const impactSign = totalPnl >= 0 ? '+' : ''; const impactEmoji = totalPnl >= 0 ? '🟢' : '🔴'; const winRateEmoji = winRate >= 50 ? '✅' : '⚠️'; let report = `*تحليل الأثر التراكمي | ${asset}* 🔬
`; report += `*الخلاصة الاستراتيجية:*
`; report += `تداولاتك في *${asset}* أضافت ما قيمته \`${impactSign}$${formatNumber(totalPnl)}\` ${impactEmoji} إلى محفظتك بشكل تراكمي.
`; report += `*ملخص الأداء التاريخي:*
`; report += ` ▪️ *إجمالي الصفقات:* \`${trades.length}\`
`; report += ` ▪️ *معدل النجاح (Win Rate):* \`${formatNumber(winRate)}%\` ${winRateEmoji}
`; report += ` ▪️ *متوسط العائد (ROI):* \`${formatNumber(avgRoi)}%\`
`; report += `*أبرز الصفقات:*
`; report += ` 🏆 *أفضل صفقة:* ربح بنسبة \`${formatNumber(bestTrade.pnlPercent)}%\`
`; report += ` 💔 *أسوأ صفقة:* ${worstTrade.pnlPercent < 0 ? 'خسارة' : 'ربح'} بنسبة \`${formatNumber(worstTrade.pnlPercent)}%\`
`; report += `*توصية استراتيجية خاصة:*
`; if (avgRoi > 5 && winRate > 60) { report += `أداء *${asset}* يتفوق على المتوسط بشكل واضح. قد تفكر في زيادة حجم صفقاتك المستقبلية فيها.`; } else if (totalPnl < 0) { report += `أداء *${asset}* سلبي. قد ترغب في مراجعة استراتيجيتك لهذه العملة أو تقليل المخاطرة فيها.`; } else { report += `أداء *${asset}* يعتبر ضمن النطاق المقبول. استمر في المراقبة والتحليل.`; } await ctx.reply(report, { parse_mode: "Markdown" }); } catch(e) { console.error(`Error generating cumulative report for ${asset}:`, e); await ctx.reply("❌ حدث خطأ أثناء إنشاء التقرير."); } }

// =================================================================
// SECTION 5: BOT SETUP, KEYBOARDS, AND HANDLERS
// =================================================================
const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("🚀 تحليل السوق").text("💡 توصية افتراضية").row()
    .text("⚡ إحصائيات سريعة").text("📈 تحليل تراكمي").row()
    .text("🔍 مراجعة الصفقات").text("🧠 تحليل بالذكاء الاصطناعي").row() // NEW BUTTON
    .text("🧮 حاسبة الربح والخسارة").text("⚙️ الإعدادات").row()
    .resized();

const virtualTradeKeyboard = new InlineKeyboard().text("➕ إضافة توصية جديدة", "add_virtual_trade").row().text("📈 متابعة التوصيات الحية", "track_virtual_trades");

async function sendSettingsMenu(ctx) { 
    const settings = await loadSettings(); 
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital")
        .text("💼 عرض المراكز المفتوحة", "view_positions")
        .row()
        .text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts")
        .text("🗑️ حذف تنبيه سعر", "delete_alert")
        .row()
        .text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary")
        .text(`🚀 النشر للقناة: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost")
        .row()
        .text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug")
        .text("📊 إرسال تقرير النسخ", "send_daily_report")
        .row()
        .text("🔥 حذف جميع البيانات 🔥", "delete_all_data");
    const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*";
    try { 
        if (ctx.callbackQuery) { 
            await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); 
        } else { 
            await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); 
        } 
    } catch(e) { console.error("Error sending settings menu:", e); } 
}

async function sendMovementAlertsMenu(ctx) { 
    const alertSettings = await loadAlertSettings(); 
    const text = `🚨 *إدارة تنبيهات حركة الأسعار*
- *النسبة العامة الحالية:* \`${alertSettings.global}%\`.
- يمكنك تعيين نسبة مختلفة لعملة معينة.`; 
    const keyboard = new InlineKeyboard()
        .text("📊 تعديل النسبة العامة", "set_global_alert")
        .text("💎 تعديل نسبة عملة", "set_coin_alert")
        .row()
        .text("🔙 العودة للإعدادات", "back_to_settings"); 
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard }); 
}

bot.use(async (ctx, next) => { 
    if (ctx.from?.id === AUTHORIZED_USER_ID) { 
        await next(); 
    } else { 
        console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`); 
    } 
});

bot.command("start", (ctx) => { 
    const welcomeMessage = `🤖 *أهلاً بك في بوت التحليل المتكامل لمنصة OKX.*
` + `*اضغط على الأزرار أدناه للبدء!*`; 
    ctx.reply(welcomeMessage, { parse_mode: "Markdown", reply_markup: mainKeyboard }); 
});

bot.command("settings", async (ctx) => { await sendSettingsMenu(ctx); });

bot.command("pnl", async (ctx) => { 
    const text = ctx.message.text || ''; 
    const argsString = text.substring(text.indexOf(' ') + 1); 
    const args = argsString.trim().split(/\s+/); 
    if (args.length !== 3) { 
        return await ctx.reply( `❌ *صيغة غير صحيحة.*
*مثال:* \`/pnl <سعر الشراء> <سعر البيع> <الكمية>\`
*مثلاً: /pnl 100 120 50*`, { parse_mode: "Markdown" } ); 
    } 
    const [buyPrice, sellPrice, quantity] = args.map(parseFloat); 
    if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) { 
        return await ctx.reply("❌ *خطأ:* تأكد من أن جميع القيم هي أرقام موجبة وصحيحة."); 
    } 
    const investment = buyPrice * quantity; 
    const saleValue = sellPrice * quantity; 
    const pnl = saleValue - investment; 
    const pnlPercent = (investment > 0) ? (pnl / investment) * 100 : 0; 
    const status = pnl >= 0 ? "ربح ✅" : "خسارة 🔻"; 
    const sign = pnl >= 0 ? '+' : ''; 
    const msg = `🧮 *نتيجة حساب الربح والخسارة*
` + ` ▪️ *إجمالي تكلفة الشراء:* \`$${formatNumber(investment)}\`
` + ` ▪️ *إجمالي قيمة البيع:* \`$${formatNumber(saleValue)}\`
` + `━━━━━━━━━━━━━━━━━━━━
` + `*صافي الربح/الخسارة:* \`${sign}${formatNumber(pnl)}\` (\`${sign}${formatNumber(pnlPercent)}%\`)
` + `**الحالة النهائية: ${status}**`; 
    await ctx.reply(msg, { parse_mode: "Markdown" }); 
});

// NEW: Handler for AI Analysis
bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    if (waitingState) {
        // Handle AI state
        if (waitingState === "ai_ask_coin") {
            waitingState = null;
            const coin = ctx.message.text.trim().toUpperCase();
            const loading = await ctx.reply(`🧠 جاري تحليل عملة ${coin} باستخدام الذكاء الاصطناعي...`);
            const aiResponse = await getAIAnalysisForAsset(coin);
            await ctx.api.editMessageText(loading.chat.id, loading.message_id, `*🧠 تحليل الذكاء الاصطناعي | ${coin}*\n\n${aiResponse}`, { parse_mode: "Markdown" });
            return;
        }
        // Handle other waiting states...
        return;
    }

    switch (text) {
        case "🧠 تحليل بالذكاء الاصطناعي":
            const aiKeyboard = new InlineKeyboard()
                .text("💼 تحليل المحفظة", "ai_analyze_portfolio")
                .text("🪙 تحليل عملة", "ai_analyze_coin");
            await ctx.reply("اختر نوع التحليل الذي تريده:", { reply_markup: aiKeyboard });
            break;

        // Existing cases...
        case "📊 عرض المحفظة":
            const loadingMsgPortfolio = await ctx.reply("⏳ جاري إعداد التقرير...");
            try {
                const prices = await okxAdapter.getMarketPrices();
                if (!prices || prices.error) throw new Error(prices.error || `فشل جلب أسعار السوق.`);
                const capital = await loadCapital();
                const { assets, total, error } = await okxAdapter.getPortfolio(prices);
                if (error) throw new Error(error);
                const { caption } = await formatPortfolioMsg(assets, total, capital);
                await ctx.api.editMessageText(loadingMsgPortfolio.chat.id, loadingMsgPortfolio.message_id, caption, { parse_mode: "Markdown" });
            } catch (e) {
                console.error("Error in 'عرض المحفظة':", e);
                await ctx.api.editMessageText(loadingMsgPortfolio.chat.id, loadingMsgPortfolio.message_id, `❌ حدث خطأ: ${e.message}`);
            }
            break;

        // ... other cases (unchanged)
        default:
            // Default handler
    }
});

bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;

    if (data === "ai_analyze_portfolio") {
        const msg = await ctx.reply("🧠 جاري طلب تحليل المحفظة من الذكاء الاصطناعي...");
        const prices = await okxAdapter.getMarketPrices();
        if (!prices || prices.error) return await ctx.editMessageText("❌ فشل جلب بيانات السوق.");
        const capital = await loadCapital();
        const { assets, total } = await okxAdapter.getPortfolio(prices);
        const aiResponse = await getAIAnalysisForPortfolio(assets, total, capital);
        await ctx.editMessageText(`*🧠 تحليل الذكاء الاصطناعي - المحفظة*\n\n${aiResponse}`, { parse_mode: "Markdown" });
        return;
    }

    if (data === "ai_analyze_coin") {
        waitingState = "ai_ask_coin";
        await ctx.editMessageText("✍️ أرسل رمز العملة التي ترغب في تحليلها (مثل BTC).");
        return;
    }

    // Existing callback handlers...
    if (data.startsWith("review_trade_")) {
        const tradeId = data.split('_')[2];
        await ctx.editMessageText(`⏳ جاري تحليل صفقة \`${tradeId.substring(0, 8)}...\``);
        const trade = await getCollection("tradeHistory").findOne({ _id: tradeId });
        if (!trade || !trade.quantity) {
            await ctx.editMessageText("❌ لم يتم العثور على الصفقة أو أنها لا تحتوي على بيانات الكمية اللازمة للتحليل. (الصفقات القديمة قد لا تدعم هذه الميزة).");
            return;
        }
        const prices = await okxAdapter.getMarketPrices();
        const currentPrice = prices[`${trade.asset}-USDT`]?.price;
        if (!currentPrice) {
            await ctx.editMessageText(`❌ تعذر جلب السعر الحالي لعملة ${trade.asset}.`);
            return;
        }
        const reviewMessage = formatClosedTradeReview(trade, currentPrice);
        await ctx.editMessageText(reviewMessage, { parse_mode: "Markdown" });
        return;
    }

    if (data.startsWith("chart_")) {
        const period = data.split('_')[1];
        await ctx.editMessageText("⏳ جاري إنشاء تقرير الأداء المتقدم...");
        let history, periodLabel, bar, limit;
        if (period === '24h') {
            history = await loadHourlyHistory();
            periodLabel = "آخر 24 ساعة";
            bar = '1H';
            limit = 24;
        } else if (period === '7d') {
            history = await loadHistory();
            periodLabel = "آخر 7 أيام";
            bar = '1D';
            limit = 7;
        } else if (period === '30d') {
            history = await loadHistory();
            periodLabel = "آخر 30 يومًا";
            bar = '1D';
            limit = 30;
        } else { return; }
        const portfolioHistory = (period === '24h' ? history.slice(-24) : history.slice(-limit));
        if (!portfolioHistory || portfolioHistory.length < 2) { await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة."); return; }
        const mappedHistory = portfolioHistory.map(h => ({ ...h, time: h.time || Date.parse(h.date || h.label)}));
        const btcHistoryCandles = await getHistoricalCandles('BTC-USDT', bar, limit);
        const report = await formatPerformanceReport(period, periodLabel, mappedHistory, btcHistoryCandles);
        if (report.error) {
            await ctx.editMessageText(report.error);
        } else {
            await ctx.replyWithPhoto(report.chartUrl, { caption: report.caption, parse_mode: "Markdown" });
            await ctx.deleteMessage();
        }
        return;
    }

    if (data === "publish_report" || data === "ignore_report") {
        const originalMessage = ctx.callbackQuery.message;
        if (!originalMessage) return;
        const originalText = originalMessage.text;
        const reportMarkerStart = originalText.indexOf("<report>");
        const reportMarkerEnd = originalText.indexOf("</report>");
        if (reportMarkerStart !== -1) {
            const privatePart = originalText.substring(0, reportMarkerStart);
            if (data === "publish_report") {
                if (reportMarkerEnd !== -1) {
                    const reportContentString = originalText.substring(reportMarkerStart + 8, reportMarkerEnd);
                    const reportContent = JSON.parse(reportContentString);
                    await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, reportContent, { parse_mode: "Markdown" });
                    const newText = privatePart.replace('*تم إغلاق المركز بنجاح. هل تود نشر الملخص في القناة؟*', '✅ *تم نشر التقرير بنجاح في القناة.*');
                    await ctx.editMessageText(newText, { reply_markup: undefined, parse_mode: 'Markdown' });
                }
            } else {
                const newText = privatePart.replace('*تم إغلاق المركز بنجاح. هل تود نشر الملخص في القناة؟*', '❌ *تم تجاهل نشر التقرير.*');
                await ctx.editMessageText(newText, { reply_markup: undefined, parse_mode: 'Markdown' });
            }
        }
        return;
    }

    // ... other switch cases
    switch(data) {
        case "add_virtual_trade": 
            waitingState = 'add_virtual_trade'; 
            await ctx.editMessageText("✍️ *لإضافة توصية افتراضية، أرسل التفاصيل في 5 أسطر منفصلة:*\n`BTC-USDT`\n`65000` (سعر الدخول)\n`70000` (سعر الهدف)\n`62000` (وقف الخسارة)\n`1000` (المبلغ الافتراضي)\n**ملاحظة:** *لا تكتب كلمات مثل 'دخول' أو 'هدف'، فقط الأرقام والرمز.*", { parse_mode: "Markdown" }); 
            break;
        case "track_virtual_trades": 
            await ctx.editMessageText("⏳ جاري جلب التوصيات النشطة..."); 
            const activeTrades = await getActiveVirtualTrades(); 
            if (activeTrades.length === 0) { 
                await ctx.editMessageText("✅ لا توجد توصيات افتراضية نشطة حاليًا.", { reply_markup: virtualTradeKeyboard }); 
                return; 
            } 
            const prices = await okxAdapter.getMarketPrices(); 
            if (!prices || prices.error) { 
                await ctx.editMessageText(`❌ فشل جلب الأسعار، لا يمكن متابعة التوصيات.`, { reply_markup: virtualTradeKeyboard }); 
                return; 
            } 
            let reportMsg = "📈 *متابعة حية للتوصيات النشطة:*\n━━━━━━━━━━━━━━━━━━━━\n"; 
            for (const trade of activeTrades) { 
                const currentPrice = prices[trade.instId]?.price; 
                if (!currentPrice) { 
                    reportMsg += `*${trade.instId}:* \`لا يمكن جلب السعر الحالي.\`\n`; 
                } else { 
                    const pnl = (currentPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice); 
                    const pnlPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0; 
                    const sign = pnl >= 0 ? '+' : ''; 
                    const emoji = pnl >= 0 ? '🟢' : '🔴'; 
                    reportMsg += `*${trade.instId}* ${emoji}\n` + 
                        ` ▫️ *الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` + 
                        ` ▫️ *الحالي:* \`$${formatNumber(currentPrice, 4)}\`\n` + 
                        ` ▫️ *ربح/خسارة:* \`${sign}${formatNumber(pnl)}\` (\`${sign}${formatNumber(pnlPercent)}%\`)\n` + 
                        ` ▫️ *الهدف:* \`$${formatNumber(trade.targetPrice, 4)}\`\n` + 
                        ` ▫️ *الوقف:* \`$${formatNumber(trade.stopLossPrice, 4)}\`\n━━━━━━━━━━━━━━━━━━━━\n`; 
                } 
            } 
            await ctx.editMessageText(reportMsg, { parse_mode: "Markdown", reply_markup: virtualTradeKeyboard }); 
            break;
        case "set_capital": 
            waitingState = 'set_capital'; 
            await ctx.editMessageText("💰 يرجى إرسال المبلغ الجديد لرأس المال (رقم فقط)."); 
            break;
        case "back_to_settings": 
            await sendSettingsMenu(ctx); 
            break;
        case "manage_movement_alerts": 
            await sendMovementAlertsMenu(ctx); 
            break;
        case "set_global_alert": 
            waitingState = 'set_global_alert_state'; 
            await ctx.editMessageText("✍️ يرجى إرسال النسبة العامة الجديدة (مثال: `5`)."); 
            break;
        case "set_coin_alert": 
            waitingState = 'set_coin_alert_state'; 
            await ctx.editMessageText("✍️ يرجى إرسال رمز العملة والنسبة.\n*مثال:*\n`BTC 2.5`"); 
            break;
        case "view_positions": 
            const positions = await loadPositions(); 
            if (Object.keys(positions).length === 0) { 
                await ctx.editMessageText("ℹ️ لا توجد مراكز مفتوحة.", { reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") }); 
                break; 
            } 
            let posMsg = "📄 *قائمة المراكز المفتوحة:*\n"; 
            for (const symbol in positions) { 
                const pos = positions[symbol]; 
                posMsg += `- *${symbol}:* متوسط الشراء \`$${formatNumber(pos.avgBuyPrice, 4)}\`\n`; 
            } 
            await ctx.editMessageText(posMsg, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") }); 
            break;
        case "delete_alert": 
            const alerts = await loadAlerts(); 
            if (alerts.length === 0) { 
                await ctx.editMessageText("ℹ️ لا توجد تنبيهات مسجلة.", { reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") }); 
                break; 
            } 
            let alertMsg = "🗑️ *اختر التنبيه لحذفه:*\n"; 
            alerts.forEach((alert, i) => { 
                alertMsg += `*${i + 1}.* \`${alert.instId} ${alert.condition} ${alert.price}\`\n`; 
            }); 
            alertMsg += "\n*أرسل رقم التنبيه الذي تود حذفه.*"; 
            waitingState = 'delete_alert_number'; 
            await ctx.editMessageText(alertMsg, { parse_mode: "Markdown" }); 
            break;
        case "toggle_summary": 
        case "toggle_autopost": 
        case "toggle_debug": 
            const settings = await loadSettings(); 
            if (data === 'toggle_summary') settings.dailySummary = !settings.dailySummary; 
            else if (data === 'toggle_autopost') settings.autoPostToChannel = !settings.autoPostToChannel; 
            else if (data === 'toggle_debug') settings.debugMode = !settings.debugMode; 
            await saveSettings(settings); 
            await sendSettingsMenu(ctx); 
            break;
        case "send_daily_report": 
            await ctx.editMessageText("⏳ جاري إنشاء وإرسال تقرير النسخ اليومي..."); 
            await runDailyReportJob(); 
            await sendSettingsMenu(ctx); 
            break;
        case "delete_all_data": 
            waitingState = 'confirm_delete_all'; 
            await ctx.editMessageText("⚠️ *تحذير: هذا الإجراء لا يمكن التراجع عنه!* لحذف كل شيء، أرسل: `تأكيد الحذف`", { parse_mode: "Markdown" }); 
            break;
    }
});

// =================================================================
// SECTION 6: SERVER AND BOT INITIALIZATION
// =================================================================
app.get("/healthcheck", (req, res) => res.status(200).send("OK"));

async function startBot() {
    try {
        await connectDB();
        console.log("MongoDB connected.");
        if (process.env.NODE_ENV === "production") {
            app.use(express.json());
            app.use(webhookCallback(bot, "express"));
            app.listen(PORT, () => { console.log(`Bot server is running on port ${PORT}`); });
        } else {
            console.log("Bot starting with polling...");
            await bot.start({
                drop_pending_updates: true,
            });
        }
        console.log("Bot is now fully operational for OKX.");
        setInterval(monitorBalanceChanges, 60 * 1000);
        setInterval(trackPositionHighLow, 60 * 1000);
        setInterval(checkPriceAlerts, 30 * 1000);
        setInterval(checkPriceMovements, 60 * 1000);
        setInterval(monitorVirtualTrades, 30 * 1000);
        setInterval(runHourlyJobs, 60 * 60 * 1000);
        setInterval(runDailyJobs, 24 * 60 * 60 * 1000);
        setInterval(runDailyReportJob, 24 * 60 * 60 * 1000);
        await runHourlyJobs();
        await runDailyJobs();
        await monitorBalanceChanges();
        await bot.api.sendMessage(AUTHORIZED_USER_ID, "✅ *تم إعادة تشغيل البوت بنجاح*\nتم تفعيل المراقبة المتقدمة لمنصة OKX.", {parse_mode: "Markdown"}).catch(console.error);
    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
        process.exit(1);
    }
}

startBot();
