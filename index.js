// =================================================================
// Advanced Analytics Bot - v134.1 (Robust Coin Info)
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();
const { connectDB, getDB } = require("./database.js");

// --- Bot Setup ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);

// --- State Variables ---
let waitingState = null;

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
async function saveConfig(id, data) { try { await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true }); } catch (e) { console.error(`Error in saveConfig for id: ${id}`, e); } }
async function saveClosedTrade(tradeData) { try { await getCollection("tradeHistory").insertOne({ ...tradeData, closedAt: new Date() }); } catch (e) { console.error("Error in saveClosedTrade:", e); } }
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
async function getInstrumentDetails(instId) {
    try {
        const tickerRes = await fetch(`${okxAdapter.baseURL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`);
        const tickerJson = await tickerRes.json();
        if (tickerJson.code !== '0' || !tickerJson.data[0]) {
            return { error: `لم يتم العثور على العملة.` };
        }
        const tickerData = tickerJson.data[0];
        return {
            price: parseFloat(tickerData.last),
            high24h: parseFloat(tickerData.high24h),
            low24h: parseFloat(tickerData.low24h),
            vol24h: parseFloat(tickerData.volCcy24h),
        };
    } catch (e) {
        // This now throws an error to be caught by Promise.allSettled
        throw new Error("خطأ في الاتصال بالمنصة لجلب بيانات السوق.");
    }
}

async function getHistoricalCandles(instId, bar = '1D', limit = 100) {
    let allCandles = [];
    let before = '';
    const maxLimitPerRequest = 100;

    try {
        while (allCandles.length < limit) {
            const currentLimit = Math.min(maxLimitPerRequest, limit - allCandles.length);
            const url = `${okxAdapter.baseURL}/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=${currentLimit}${before}`;
            
            const res = await fetch(url);
            const json = await res.json();
            
            if (json.code !== '0' || !json.data || json.data.length === 0) {
                break;
            }

            const newCandles = json.data.map(c => ({
                time: parseInt(c[0]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4])
            }));
            
            allCandles.push(...newCandles);
            
            if (newCandles.length < maxLimitPerRequest) {
                break;
            }
            
            const lastTimestamp = newCandles[newCandles.length - 1].time;
            before = `&before=${lastTimestamp}`;
        }
        return allCandles.reverse();
    } catch (e) {
        console.error(`Error fetching historical candles for ${instId}:`, e);
        return [];
    }
}

async function getAssetPriceExtremes(instId) {
    try {
        const [yearlyCandles, allTimeCandles] = await Promise.all([
            getHistoricalCandles(instId, '1D', 365),
            getHistoricalCandles(instId, '1M', 1200)
        ]);

        if (yearlyCandles.length === 0) return null;

        const getHighLow = (candles) => {
            if (!candles || candles.length === 0) return { high: 0, low: Infinity };
            return candles.reduce((acc, candle) => ({
                high: Math.max(acc.high, candle.high),
                low: Math.min(acc.low, candle.low)
            }), { high: 0, low: Infinity });
        };

        const weeklyCandles = yearlyCandles.slice(-7);
        const monthlyCandles = yearlyCandles.slice(-30);
        
        const formatLow = (low) => low === Infinity ? 0 : low;

        const weeklyExtremes = getHighLow(weeklyCandles);
        const monthlyExtremes = getHighLow(monthlyCandles);
        const yearlyExtremes = getHighLow(yearlyCandles);
        const allTimeExtremes = getHighLow(allTimeCandles);

        return {
            weekly: { high: weeklyExtremes.high, low: formatLow(weeklyExtremes.low) },
            monthly: { high: monthlyExtremes.high, low: formatLow(monthlyExtremes.low) },
            yearly: { high: yearlyExtremes.high, low: formatLow(yearlyExtremes.low) },
            allTime: { high: allTimeExtremes.high, low: formatLow(allTimeExtremes.low) }
        };
    } catch (error) {
        console.error(`Error in getAssetPriceExtremes for ${instId}:`, error);
        return null;
    }
}

function calculateSMA(closes, period) { if (closes.length < period) return null; const sum = closes.slice(-period).reduce((acc, val) => acc + val, 0); return sum / period; }
function calculateRSI(closes, period = 14) { if (closes.length < period + 1) return null; let gains = 0, losses = 0; for (let i = 1; i <= period; i++) { const diff = closes[i] - closes[i - 1]; diff > 0 ? gains += diff : losses -= diff; } let avgGain = gains / period, avgLoss = losses / period; for (let i = period + 1; i < closes.length; i++) { const diff = closes[i] - closes[i - 1]; if (diff > 0) { avgGain = (avgGain * (period - 1) + diff) / period; avgLoss = (avgLoss * (period - 1)) / period; } else { avgLoss = (avgLoss * (period - 1) - diff) / period; avgGain = (avgGain * (period - 1)) / period; } } if (avgLoss === 0) return 100; const rs = avgGain / avgLoss; return 100 - (100 / (1 + rs)); }
async function getTechnicalAnalysis(instId) { const candleData = (await getHistoricalCandles(instId, '1D', 51)); if (candleData.length < 51) return { error: "بيانات الشموع غير كافية." }; const closes = candleData.map(c => c.close); return { rsi: calculateRSI(closes), sma20: calculateSMA(closes, 20), sma50: calculateSMA(closes, 50) }; }
function calculatePerformanceStats(history) { if (history.length < 2) return null; const values = history.map(h => h.total); const startValue = values[0]; const endValue = values[values.length - 1]; const pnl = endValue - startValue; const pnlPercent = (startValue > 0) ? (pnl / startValue) * 100 : 0; const maxValue = Math.max(...values); const minValue = Math.min(...values); const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length; const dailyReturns = []; for (let i = 1; i < values.length; i++) { dailyReturns.push((values[i] - values[i - 1]) / values[i - 1]); } const bestDayChange = Math.max(...dailyReturns) * 100; const worstDayChange = Math.min(...dailyReturns) * 100; const avgReturn = dailyReturns.reduce((sum, ret) => sum + ret, 0) / dailyReturns.length; const volatility = Math.sqrt(dailyReturns.map(x => Math.pow(x - avgReturn, 2)).reduce((a, b) => a + b) / dailyReturns.length) * 100; let volText = "متوسط"; if(volatility < 1) volText = "منخفض"; if(volatility > 5) volText = "مرتفع"; return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue, bestDayChange, worstDayChange, volatility, volText }; }
function createChartUrl(data, type = 'line', title = '', labels = [], dataLabel = '') {
    if (!data || data.length === 0) return null;
    const pnl = data[data.length - 1] - data[0];
    const chartColor = pnl >= 0 ? 'rgb(75, 192, 75)' : 'rgb(255, 99, 132)';
    const chartBgColor = pnl >= 0 ? 'rgba(75, 192, 75, 0.2)' : 'rgba(255, 99, 132, 0.2)';
    const chartConfig = {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{ label: dataLabel, data: data, fill: true, backgroundColor: chartBgColor, borderColor: chartColor, tension: 0.1 }]
        },
        options: { title: { display: true, text: title } }
    };
    return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`;
}

// =================================================================
// SECTION 3: FORMATTING AND MESSAGE FUNCTIONS
// =================================================================
function formatPrivateBuy(details) { const { asset, price, amountChange, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; let msg = `*مراقبة الأصول 🔬:*\n**عملية استحواذ جديدة 🟢**\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`\n`; msg += `🔸 **نوع العملية:** تعزيز مركز / بناء مركز جديد\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`; msg += ` ▪️ **سعر التنفيذ:** \`$${formatNumber(price, 4)}\`\n`; msg += ` ▪️ **الكمية المضافة:** \`${formatNumber(Math.abs(amountChange), 6)}\`\n`; msg += ` ▪️ **التكلفة الإجمالية للصفقة:** \`$${formatNumber(tradeValue)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*التأثير على هيكل المحفظة:*\n`; msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${formatNumber(tradeSizePercent)}%\`\n`; msg += ` ▪️ **الوزن الجديد للأصل:** \`${formatNumber(newAssetWeight)}%\`\n`; msg += ` ▪️ **السيولة المتبقية (USDT):** \`$${formatNumber(newUsdtValue)}\`\n`; msg += ` ▪️ **مؤشر السيولة الحالي:** \`${formatNumber(newCashPercent)}%\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }
function formatPrivateSell(details) { const { asset, price, amountChange, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; let msg = `*مراقبة الأصول 🔬:*\n**مناورة تكتيكية 🟠**\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`\n`; msg += `🔸 **نوع العملية:** تخفيف المركز / جني أرباح جزئي\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`; msg += ` ▪️ **سعر التنفيذ:** \`$${formatNumber(price, 4)}\`\n`; msg += ` ▪️ **الكمية المخففة:** \`${formatNumber(Math.abs(amountChange), 6)}\`\n`; msg += ` ▪️ **العائد الإجمالي للصفقة:** \`$${formatNumber(tradeValue)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*التأثير على هيكل المحفظة:*\n`; msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${formatNumber(tradeSizePercent)}%\`\n`; msg += ` ▪️ **الوزن الجديد للأصل:** \`${formatNumber(newAssetWeight)}%\`\n`; msg += ` ▪️ **السيولة الجديدة (USDT):** \`$${formatNumber(newUsdtValue)}\`\n`; msg += ` ▪️ **مؤشر السيولة الحالي:** \`${formatNumber(newCashPercent)}%\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }
function formatPrivateCloseReport(details) { const { asset, avgBuyPrice, avgSellPrice, pnl, pnlPercent, durationDays, highestPrice, lowestPrice } = details; const pnlSign = pnl >= 0 ? '+' : ''; const emoji = pnl >= 0 ? '🟢' : '🔴'; let msg = `*ملف المهمة المكتملة 📂:*\n**تم إغلاق مركز ${asset} بنجاح ✅**\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*النتيجة النهائية للمهمة:*\n`; msg += ` ▪️ **الحالة:** **${pnl >= 0 ? "مربحة" : "خاسرة"}**\n`; msg += ` ▪️ **صافي الربح/الخسارة:** \`${pnlSign}$${formatNumber(pnl)}\` ${emoji}\n`; msg += ` ▪️ **نسبة العائد على الاستثمار (ROI):** \`${pnlSign}${formatNumber(pnlPercent)}%\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*الجدول الزمني والأداء:*\n`; msg += ` ▪️ **مدة الاحتفاظ بالمركز:** \`${formatNumber(durationDays, 1)} يوم\`\n`; msg += ` ▪️ **متوسط سعر الدخول:** \`$${formatNumber(avgBuyPrice, 4)}\`\n`; msg += ` ▪️ **متوسط سعر الخروج:** \`$${formatNumber(avgSellPrice, 4)}\`\n`; msg += ` ▪️ **أعلى قمة سعرية مسجلة:** \`$${formatNumber(highestPrice, 4)}\`\n`; msg += ` ▪️ **أدنى قاع سعري مسجل:** \`$${formatNumber(lowestPrice, 4)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ الإغلاق:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }
function formatPublicBuy(details) { const { asset, price, oldTotalValue, tradeValue, oldUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; const cashConsumedPercent = (oldUsdtValue > 0) ? (tradeValue / oldUsdtValue) * 100 : 0; let msg = `*💡 توصية جديدة: بناء مركز في ${asset} 🟢*\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*الأصل:* \`${asset}/USDT\`\n`; msg += `*سعر الدخول الحالي:* \`$${formatNumber(price, 4)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*استراتيجية إدارة المحفظة:*\n`; msg += ` ▪️ *حجم الدخول:* تم تخصيص \`${formatNumber(tradeSizePercent)}%\` من المحفظة لهذه الصفقة.\n`; msg += ` ▪️ *استهلاك السيولة:* استهلك هذا الدخول \`${formatNumber(cashConsumedPercent)}%\` من السيولة النقدية المتاحة.\n`; msg += ` ▪️ *السيولة المتبقية:* بعد الصفقة، أصبحت السيولة تشكل \`${formatNumber(newCashPercent)}%\` من المحفظة.\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*ملاحظات:*\nنرى في هذه المستويات فرصة واعدة. المراقبة مستمرة، وسنوافيكم بتحديثات إدارة الصفقة.\n`; msg += `#توصية #${asset}`; return msg; }
function formatPublicSell(details) { const { asset, price, amountChange, position } = details; const totalPositionAmountBeforeSale = position.totalAmountBought - (position.totalAmountSold - Math.abs(amountChange)); const soldPercent = totalPositionAmountBeforeSale > 0 ? (Math.abs(amountChange) / totalPositionAmountBeforeSale) * 100 : 0; const partialPnl = (price - position.avgBuyPrice); const partialPnlPercent = position.avgBuyPrice > 0 ? (partialPnl / position.avgBuyPrice) * 100 : 0; let msg = `*⚙️ تحديث التوصية: إدارة مركز ${asset} 🟠*\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*الأصل:* \`${asset}/USDT\`\n`; msg += `*سعر البيع الجزئي:* \`$${formatNumber(price, 4)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*استراتيجية إدارة المحفظة:*\n`; msg += ` ▪️ *الإجراء:* تم بيع \`${formatNumber(soldPercent)}%\` من مركزنا لتأمين الأرباح.\n`; msg += ` ▪️ *النتيجة:* ربح محقق على الجزء المباع بنسبة \`${formatNumber(partialPnlPercent)}%\` 🟢.\n`; msg += ` ▪️ *حالة المركز:* لا يزال المركز مفتوحًا بالكمية المتبقية.\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*ملاحظات:*\nخطوة استباقية لإدارة المخاطر وحماية رأس المال. نستمر في متابعة الأهداف الأعلى.\n`; msg += `#إدارة_مخاطر #${asset}`; return msg; }
function formatPublicClose(details) { const { asset, pnlPercent, durationDays, avgBuyPrice, avgSellPrice } = details; const pnlSign = pnlPercent >= 0 ? '+' : ''; const emoji = pnlPercent >= 0 ? '🟢' : '🔴'; let msg = `*🏆 النتيجة النهائية لتوصية ${asset} ✅*\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*الأصل:* \`${asset}/USDT\`\n`; msg += `*الحالة:* **تم إغلاق الصفقة بالكامل.**\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*ملخص أداء التوصية:*\n`; msg += ` ▪️ **متوسط سعر الدخول:** \`$${formatNumber(avgBuyPrice, 4)}\`\n`; msg += ` ▪️ **متوسط سعر الخروج:** \`$${formatNumber(avgSellPrice, 4)}\`\n`; msg += ` ▪️ **العائد النهائي على الاستثمار (ROI):** \`${pnlSign}${formatNumber(pnlPercent)}%\` ${emoji}\n`; msg += ` ▪️ **مدة التوصية:** \`${formatNumber(durationDays, 1)} يوم\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*الخلاصة:*\n`; if (pnlPercent >= 0) { msg += `صفقة موفقة أثبتت أن الصبر على التحليل يؤتي ثماره.\n`; } else { msg += `الخروج بانضباط وفقًا للخطة هو نجاح بحد ذاته. نحافظ على رأس المال للفرصة القادمة.\n`; } msg += `\nنبارك لمن اتبع التوصية. نستعد الآن للبحث عن الفرصة التالية.\n`; msg += `#نتائجتوصيات #${asset}`; return msg; }
async function formatPortfolioMsg(assets, total, capital) {
    const positions = await loadPositions();
    const usdtAsset = assets.find(a => a.asset === "USDT") || { value: 0 };
    const cashPercent = total > 0 ? (usdtAsset.value / total) * 100 : 0;
    const investedPercent = 100 - cashPercent;

    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    const pnlSign = pnl >= 0 ? '+' : '';
    const pnlEmoji = pnl >= 0 ? '🟢⬆️' : '🔴⬇️';

    let dailyPnlText = " `لا توجد بيانات كافية`";
    let totalValue24hAgo = 0;
    assets.forEach(asset => {
        if (asset.asset === 'USDT') totalValue24hAgo += asset.value;
        else if (asset.change24h !== undefined && asset.price > 0) totalValue24hAgo += asset.amount * (asset.price / (1 + asset.change24h));
        else totalValue24hAgo += asset.value;
    });

    if (totalValue24hAgo > 0) {
        const dailyPnl = total - totalValue24hAgo;
        const dailyPnlPercent = (dailyPnl / totalValue24hAgo) * 100;
        const dailySign = dailyPnl >= 0 ? '+' : '';
        const dailyEmoji = dailyPnl >= 0 ? '🟢⬆️' : '🔴⬇️';
        dailyPnlText = ` ${dailyEmoji} \`$${dailySign}${formatNumber(dailyPnl)}\` (\`${dailySign}${formatNumber(dailyPnlPercent)}%\`)`;
    }

    let caption = `🧾 *التقرير التحليلي للمحفظة*\n\n`;
    caption += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`;
    caption += `━━━━━━━━━━━━━━━━━━━\n*نظرة عامة على الأداء:*\n`;
    caption += ` ▫️ *القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`;
    if (capital > 0) {
        caption += ` ▫️ *رأس المال:* \`$${formatNumber(capital)}\`\n`;
    }
    caption += ` ▫️ *إجمالي الربح غير المحقق:* ${pnlEmoji} \`$${pnlSign}${formatNumber(pnl)}\` (\`${pnlSign}${formatNumber(pnlPercent)}%\`)\n`;
    caption += ` ▫️ *الأداء اليومي (24س):*${dailyPnlText}\n`;
    caption += ` ▫️ *السيولة:* 💵 نقدي ${formatNumber(cashPercent)}% / 📈 مستثمر ${formatNumber(investedPercent)}%\n`;
    caption += `━━━━━━━━━━━━━━━━━━━━\n*مكونات المحفظة:*\n`;

    const cryptoAssets = assets.filter(a => a.asset !== "USDT");
    cryptoAssets.forEach((a, index) => {
        const percent = total > 0 ? (a.value / total) * 100 : 0;
        const position = positions[a.asset];

        caption += `\n╭─ *${a.asset}/USDT*\n`;
        caption += `├─ *القيمة الحالية:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)\n`;
        if (position?.avgBuyPrice) {
            caption += `├─ *متوسط الشراء:* \`$${formatNumber(position.avgBuyPrice, 4)}\`\n`;
        }
        caption += `├─ *سعر السوق:* \`$${formatNumber(a.price, 4)}\`\n`;
        const dailyChangeEmoji = a.change24h >= 0 ? '🟢⬆️' : '🔴⬇️';
        caption += `├─ *الأداء اليومي:* ${dailyChangeEmoji} \`${formatNumber(a.change24h * 100)}%\`\n`;
        if (position?.avgBuyPrice > 0) {
            const totalCost = position.avgBuyPrice * a.amount;
            const assetPnl = a.value - totalCost;
            const assetPnlPercent = totalCost > 0 ? (assetPnl / totalCost) * 100 : 0;
            const assetPnlEmoji = assetPnl >= 0 ? '🟢' : '🔴';
            const assetPnlSign = assetPnl >= 0 ? '+' : '';
            caption += `╰─ *ربح/خسارة غير محقق:* ${assetPnlEmoji} \`$${assetPnlSign}${formatNumber(assetPnl)}\` (\`${assetPnlSign}${formatNumber(assetPnlPercent)}%\`)`;
        } else {
            caption += `╰─ *ربح/خسارة غير محقق:* \`غير مسجل\``;
        }

        if (index < cryptoAssets.length - 1) {
            caption += `\n━━━━━━━━━━━━━━━━━━━━`;
        }
    });

    caption += `\n\n━━━━━━━━━━━━━━━━━━━━\n*USDT (الرصيد النقدي)* 💵\n`;
    caption += `*القيمة:* \`$${formatNumber(usdtAsset.value)}\` (*الوزن:* \`${formatNumber(cashPercent)}%\`)`;
    
    return { caption };
}
async function formatAdvancedMarketAnalysis(ownedAssets = []) {
    const prices = await okxAdapter.getMarketPrices();
    if (!prices || prices.error) return `❌ فشل جلب بيانات السوق. ${prices.error || ''}`;
    
    const marketData = Object.entries(prices).map(([instId, data]) => ({ instId, ...data })).filter(d => d.volCcy24h > 10000 && d.change24h !== undefined);
    marketData.sort((a, b) => b.change24h - a.change24h);
    const topGainers = marketData.slice(0, 5);
    const topLosers = marketData.slice(-5).reverse();
    marketData.sort((a, b) => b.volCcy24h - a.volCcy24h);
    const highVolume = marketData.slice(0, 5);
    
    const ownedSymbols = ownedAssets.map(a => a.asset);
    
    let msg = `🚀 *تحليل السوق المتقدم (OKX)* | ${new Date().toLocaleDateString("ar-EG")}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n`;
    
    const avgGainerChange = topGainers.length > 0 ? topGainers.reduce((sum, g) => sum + g.change24h, 0) / topGainers.length : 0;
    const avgLoserChange = topLosers.length > 0 ? topLosers.reduce((sum, l) => sum + Math.abs(l.change24h), 0) / topLosers.length : 0;
    let sentimentText = "محايدة 😐\n(هناك فرص للنمو لكن التقلبات عالية)";
    if (avgGainerChange > avgLoserChange * 1.5) {
        sentimentText = "صعودي 🟢\n(معنويات السوق إيجابية، والرابحون يتفوقون)";
    } else if (avgLoserChange > avgGainerChange * 1.5) {
        sentimentText = "هبوطي 🔴\n(معنويات السوق سلبية، والخاسرون يسيطرون)";
    }
    msg += `📊 *معنويات السوق:* ${sentimentText}\n━━━━━━━━━━━━━━━━━━━\n\n`;

    msg += "📈 *أكبر الرابحين (24س):*\n" + topGainers.map(c => {
        const symbol = c.instId.split('-')[0];
        const ownedMark = ownedSymbols.includes(symbol) ? ' ✅' : '';
        return ` - \`${c.instId}\`: \`+${formatNumber(c.change24h * 100)}%\`${ownedMark}`;
    }).join('\n') + "\n\n";

    msg += "📉 *أكبر الخاسرين (24س):*\n" + topLosers.map(c => {
        const symbol = c.instId.split('-')[0];
        const ownedMark = ownedSymbols.includes(symbol) ? ' ✅' : '';
        return ` - \`${c.instId}\`: \`${formatNumber(c.change24h * 100)}%\`${ownedMark}`;
    }).join('\n') + "\n\n";
    
    msg += "📊 *الأعلى في حجم التداول:*\n" + highVolume.map(c => ` - \`${c.instId}\`: \`${(c.volCcy24h / 1e6).toFixed(2)}M\` USDT`).join('\n') + "\n\n";
    
    let smartRecommendation = "💡 *توصية:* راقب الأصول ذات حجم التداول المرتفع، فهي غالبًا ما تقود اتجاه السوق.";
    const ownedGainers = topGainers.filter(g => ownedSymbols.includes(g.instId.split('-')[0]));
    const ownedLosers = topLosers.filter(l => ownedSymbols.includes(l.instId.split('-')[0]));
    if (ownedGainers.length > 0) {
        smartRecommendation = `💡 *توصية ذكية:* عملة *${ownedGainers[0].instId.split('-')[0]}* التي تملكها ضمن أكبر الرابحين. قد تكون فرصة جيدة لتقييم المركز.`;
    } else if (ownedLosers.length > 0) {
        smartRecommendation = `💡 *توصية ذكية:* عملة *${ownedLosers[0].instId.split('-')[0]}* التي تملكها ضمن أكبر الخاسرين. قد يتطلب الأمر مراجعة وقف الخسارة أو استراتيجيتك.`;
    }
    msg += `${smartRecommendation}`;
    
    return msg;
}

async function formatQuickStats(assets, total, capital) {
    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    const statusEmoji = pnl >= 0 ? '🟢' : '🔴';
    const statusText = pnl >= 0 ? 'ربح' : 'خسارة';
    
    let msg = "⚡ *إحصائيات سريعة*\n\n";
    msg += `💎 *إجمالي الأصول:* \`${assets.filter(a => a.asset !== 'USDT').length}\`\n`;
    msg += `💰 *القيمة الحالية:* \`$${formatNumber(total)}\`\n`;
    if (capital > 0) {
        msg += `📈 *نسبة الربح/الخسارة:* \`${formatNumber(pnlPercent)}%\`\n`;
        msg += `🎯 *الحالة:* ${statusEmoji} ${statusText}\n`;
    }
    
    msg += `\n━━━━━━━━━━━━━━━━━━━━\n*تحليل القمم والقيعان للأصول:*\n`;

    const cryptoAssets = assets.filter(a => a.asset !== "USDT");
    if (cryptoAssets.length === 0) {
        msg += "\n`لا توجد أصول في محفظتك لتحليلها.`";
    } else {
        const assetExtremesPromises = cryptoAssets.map(asset => 
            getAssetPriceExtremes(`${asset.asset}-USDT`)
        );
        const assetExtremesResults = await Promise.all(assetExtremesPromises);

        cryptoAssets.forEach((asset, index) => {
            const extremes = assetExtremesResults[index];
            msg += `\n🔸 *${asset.asset}:*\n`;
            if (extremes) {
                msg += ` *الأسبوعي:* قمة \`$${formatNumber(extremes.weekly.high, 4)}\` / قاع \`$${formatNumber(extremes.weekly.low, 4)}\`\n`;
                msg += ` *الشهري:* قمة \`$${formatNumber(extremes.monthly.high, 4)}\` / قاع \`$${formatNumber(extremes.monthly.low, 4)}\`\n`;
                msg += ` *السنوي:* قمة \`$${formatNumber(extremes.yearly.high, 4)}\` / قاع \`$${formatNumber(extremes.yearly.low, 4)}\`\n`;
                msg += ` *التاريخي:* قمة \`$${formatNumber(extremes.allTime.high, 4)}\` / قاع \`$${formatNumber(extremes.allTime.low, 4)}\``;
            } else {
                msg += ` \`تعذر جلب البيانات التاريخية.\``;
            }
        });
    }

    msg += `\n\n⏰ *آخر تحديث:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`;
    return msg;
}

async function formatPerformanceReport(period, periodLabel, history, btcHistory) {
    const stats = calculatePerformanceStats(history);
    if (!stats) return { error: "ℹ️ لا توجد بيانات كافية لهذه الفترة." };

    let btcPerformanceText = " `لا تتوفر بيانات`";
    let benchmarkComparison = "";
    if (btcHistory && btcHistory.length >= 2) {
        const btcStart = btcHistory[0].close;
        const btcEnd = btcHistory[btcHistory.length - 1].close;
        const btcChange = (btcEnd - btcStart) / btcStart * 100;
        btcPerformanceText = `\`${btcChange >= 0 ? '+' : ''}${formatNumber(btcChange)}%\``;

        if (stats.pnlPercent > btcChange) {
            benchmarkComparison = `▪️ *النتيجة:* أداء أعلى من السوق ✅`;
        } else {
            benchmarkComparison = `▪️ *النتيجة:* أداء أقل من السوق ⚠️`;
        }
    }

    const chartLabels = history.map(h => period === '24h' ? new Date(h.time).getHours() + ':00' : new Date(h.time).toLocaleDateString('en-GB', {day: '2-digit', month: '2-digit'}));
    const chartDataPoints = history.map(h => h.total);
    const chartUrl = createChartUrl(chartDataPoints, 'line', `أداء المحفظة - ${periodLabel}`, chartLabels, 'قيمة المحفظة ($)');

    const pnlSign = stats.pnl >= 0 ? '+' : '';
    const emoji = stats.pnl >= 0 ? '🟢⬆️' : '🔴⬇️';
    let caption = `📊 *تحليل أداء المحفظة | ${periodLabel}*\n\n`;
    caption += `📈 *النتيجة:* ${emoji} \`$${pnlSign}${formatNumber(stats.pnl)}\` (\`${pnlSign}${formatNumber(stats.pnlPercent)}%\`)\n`;
    caption += `*التغير الصافي: من \`$${formatNumber(stats.startValue)}\` إلى \`$${formatNumber(stats.endValue)}\`*\n\n`;
    caption += `*📝 مقارنة معيارية (Benchmark):*\n`;
    caption += `▪️ *أداء محفظتك:* \`${stats.pnlPercent >= 0 ? '+' : ''}${formatNumber(stats.pnlPercent)}%\`\n`;
    caption += `▪️ *أداء عملة BTC:* ${btcPerformanceText}\n`;
    caption += `${benchmarkComparison}\n\n`;
    caption += `*📈 مؤشرات الأداء الرئيسية:*\n`;
    caption += `▪️ *أفضل يوم:* \`+${formatNumber(stats.bestDayChange)}%\`\n`;
    caption += `▪️ *أسوأ يوم:* \`${formatNumber(stats.worstDayChange)}%\`\n`;
    caption += `▪️ *مستوى التقلب:* ${stats.volText}`;
    
    return { caption, chartUrl };
}

// =================================================================
// SECTION 4: BACKGROUND JOBS & DYNAMIC MANAGEMENT
// =================================================================
async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount, oldTotalValue) { if (!asset || price === undefined || price === null || isNaN(price)) return { analysisResult: null }; const positions = await loadPositions(); let position = positions[asset]; let analysisResult = { type: 'none', data: {} }; if (amountChange > 0) { const tradeValue = amountChange * price; const entryCapitalPercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; if (!position) { positions[asset] = { totalAmountBought: amountChange, totalCost: tradeValue, avgBuyPrice: price, openDate: new Date().toISOString(), totalAmountSold: 0, realizedValue: 0, highestPrice: price, lowestPrice: price, entryCapitalPercent: entryCapitalPercent, }; } else { position.totalAmountBought += amountChange; position.totalCost += tradeValue; position.avgBuyPrice = position.totalCost / position.totalAmountBought; } analysisResult.type = 'buy'; } else if (amountChange < 0 && position) { const soldAmount = Math.abs(amountChange); position.realizedValue = (position.realizedValue || 0) + (soldAmount * price); position.totalAmountSold = (position.totalAmountSold || 0) + soldAmount; if (newTotalAmount * price < 1) { const totalCost = parseFloat(position.totalCost); const realizedValue = parseFloat(position.realizedValue); const finalPnl = realizedValue - totalCost; const finalPnlPercent = totalCost > 0 ? (finalPnl / totalCost) * 100 : 0; const closeDate = new Date(); const openDate = new Date(position.openDate); const durationDays = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24); const avgSellPrice = position.totalAmountSold > 0 ? position.realizedValue / position.totalAmountSold : 0; const closeReportData = { asset, pnl: finalPnl, pnlPercent: finalPnlPercent, durationDays, avgBuyPrice: position.avgBuyPrice, avgSellPrice, highestPrice: position.highestPrice, lowestPrice: position.lowestPrice, entryCapitalPercent: position.entryCapitalPercent, exitQuantityPercent: 100 }; await saveClosedTrade(closeReportData); analysisResult = { type: 'close', data: closeReportData }; delete positions[asset]; } else { analysisResult.type = 'sell'; } } await savePositions(positions); analysisResult.data.position = positions[asset] || position; return { analysisResult }; }
async function monitorBalanceChanges() { try { await sendDebugMessage("Checking balance changes..."); const previousState = await loadBalanceState(); const previousBalances = previousState.balances || {}; const oldTotalValue = previousState.totalValue || 0; const oldUsdtValue = previousBalances['USDT'] || 0; const currentBalance = await okxAdapter.getBalanceForComparison(); if (!currentBalance) { await sendDebugMessage("Could not fetch current balance."); return; } const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) { await sendDebugMessage("Could not fetch market prices."); return; } const { assets: newAssets, total: newTotalValue, usdtValue: newUsdtValue, error } = await okxAdapter.getPortfolio(prices); if (error || newTotalValue === undefined) { await sendDebugMessage(`Portfolio fetch error: ${error}`); return; } if (Object.keys(previousBalances).length === 0) { await sendDebugMessage("Initializing first balance state."); await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue }); return; } const allAssets = new Set([...Object.keys(previousBalances), ...Object.keys(currentBalance)]); let stateNeedsUpdate = false; for (const asset of allAssets) { if (asset === 'USDT') continue; const prevAmount = previousBalances[asset] || 0; const currAmount = currentBalance[asset] || 0; const difference = currAmount - prevAmount; const priceData = prices[`${asset}-USDT`]; if (!priceData || !priceData.price || isNaN(priceData.price) || Math.abs(difference * priceData.price) < 1) continue; await sendDebugMessage(`Detected change for ${asset}: ${difference}`); stateNeedsUpdate = true; const { analysisResult } = await updatePositionAndAnalyze(asset, difference, priceData.price, currAmount, oldTotalValue); if (analysisResult.type === 'none') continue; const tradeValue = Math.abs(difference) * priceData.price; const newAssetData = newAssets.find(a => a.asset === asset); const newAssetValue = newAssetData ? newAssetData.value : 0; const newAssetWeight = newTotalValue > 0 ? (newAssetValue / newTotalValue) * 100 : 0; const newCashPercent = newTotalValue > 0 ? (newUsdtValue / newTotalValue) * 100 : 0; const baseDetails = { asset, price: priceData.price, amountChange: difference, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent, oldUsdtValue, position: analysisResult.data.position }; const settings = await loadSettings(); let privateMessage, publicMessage; if (analysisResult.type === 'buy') { privateMessage = formatPrivateBuy(baseDetails); publicMessage = formatPublicBuy(baseDetails); await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" }); if (settings.autoPostToChannel) { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" }); } } else if (analysisResult.type === 'sell') { privateMessage = formatPrivateSell(baseDetails); publicMessage = formatPublicSell(baseDetails); await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" }); if (settings.autoPostToChannel) { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" }); } } else if (analysisResult.type === 'close') { privateMessage = formatPrivateCloseReport(analysisResult.data); publicMessage = formatPublicClose(analysisResult.data); if (settings.autoPostToChannel) { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" }); await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" }); } else { const confirmationKeyboard = new InlineKeyboard().text("✅ نعم، انشر التقرير", "publish_report").text("❌ لا، تجاهل", "ignore_report"); const hiddenMarker = `\n<report>${JSON.stringify(publicMessage)}</report>`; const confirmationMessage = `*تم إغلاق المركز بنجاح. هل تود نشر الملخص في القناة؟*\n\n${privateMessage}${hiddenMarker}`; await bot.api.sendMessage(AUTHORIZED_USER_ID, confirmationMessage, { parse_mode: "Markdown", reply_markup: confirmationKeyboard }); } } } if (stateNeedsUpdate) { await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue }); await sendDebugMessage("State updated after balance change."); } else { await sendDebugMessage("No significant balance changes detected."); } } catch (e) { console.error("CRITICAL ERROR in monitorBalanceChanges:", e); await sendDebugMessage(`CRITICAL ERROR in monitorBalanceChanges: ${e.message}`); } }
async function trackPositionHighLow() { try { const positions = await loadPositions(); if (Object.keys(positions).length === 0) return; const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) return; let positionsUpdated = false; for (const symbol in positions) { const position = positions[symbol]; const currentPrice = prices[`${symbol}-USDT`]?.price; if (currentPrice) { if (!position.highestPrice || currentPrice > position.highestPrice) { position.highestPrice = currentPrice; positionsUpdated = true; } if (!position.lowestPrice || currentPrice < position.lowestPrice) { position.lowestPrice = currentPrice; positionsUpdated = true; } } } if (positionsUpdated) { await savePositions(positions); await sendDebugMessage("Updated position high/low prices."); } } catch(e) { console.error("CRITICAL ERROR in trackPositionHighLow:", e); } }
async function checkPriceAlerts() { try { const alerts = await loadAlerts(); if (alerts.length === 0) return; const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) return; const remainingAlerts = []; let triggered = false; for (const alert of alerts) { const currentPrice = prices[alert.instId]?.price; if (currentPrice === undefined) { remainingAlerts.push(alert); continue; } if ((alert.condition === '>' && currentPrice > alert.price) || (alert.condition === '<' && currentPrice < alert.price)) { await bot.api.sendMessage(AUTHORIZED_USER_ID, `🚨 *تنبيه سعر!* \`${alert.instId}\`\nالشرط: ${alert.condition} ${alert.price}\nالسعر الحالي: \`${currentPrice}\``, { parse_mode: "Markdown" }); triggered = true; } else { remainingAlerts.push(alert); } } if (triggered) await saveAlerts(remainingAlerts); } catch (error) { console.error("Error in checkPriceAlerts:", error); } }
async function checkPriceMovements() { try { await sendDebugMessage("Checking price movements..."); const alertSettings = await loadAlertSettings(); const priceTracker = await loadPriceTracker(); const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) return; const { assets, total: currentTotalValue, error } = await okxAdapter.getPortfolio(prices); if (error || currentTotalValue === undefined) return; if (priceTracker.totalPortfolioValue === 0) { priceTracker.totalPortfolioValue = currentTotalValue; assets.forEach(a => { if (a.price) priceTracker.assets[a.asset] = a.price; }); await savePriceTracker(priceTracker); return; } let trackerUpdated = false; for (const asset of assets) { if (asset.asset === 'USDT' || !asset.price) continue; const lastPrice = priceTracker.assets[asset.asset]; if (lastPrice) { const changePercent = ((asset.price - lastPrice) / lastPrice) * 100; const threshold = alertSettings.overrides[asset.asset] || alertSettings.global; if (Math.abs(changePercent) >= threshold) { const movementText = changePercent > 0 ? 'صعود' : 'هبوط'; const message = `📈 *تنبيه حركة سعر لأصل!* \`${asset.asset}\`\n*الحركة:* ${movementText} بنسبة \`${formatNumber(changePercent)}%\`\n*السعر الحالي:* \`$${formatNumber(asset.price, 4)}\``; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); priceTracker.assets[asset.asset] = asset.price; trackerUpdated = true; } } else { priceTracker.assets[asset.asset] = asset.price; trackerUpdated = true; } } if (trackerUpdated) await savePriceTracker(priceTracker); } catch (e) { console.error("CRITICAL ERROR in checkPriceMovements:", e); } }
async function runDailyJobs() { try { const settings = await loadSettings(); if (!settings.dailySummary) return; const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) return; const { total } = await okxAdapter.getPortfolio(prices); if (total === undefined) return; const history = await loadHistory(); const date = new Date().toISOString().slice(0, 10); const today = history.find(h => h.date === date); if (today) { today.total = total; } else { history.push({ date, total, time: Date.now() }); } if (history.length > 35) history.shift(); await saveHistory(history); console.log(`[Daily Summary Recorded]: ${date} - $${formatNumber(total)}`); } catch (e) { console.error("CRITICAL ERROR in runDailyJobs:", e); } }
async function runHourlyJobs() { try { const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) return; const { total } = await okxAdapter.getPortfolio(prices); if (total === undefined) return; const history = await loadHourlyHistory(); const hourLabel = new Date().toISOString().slice(0, 13); const existingIndex = history.findIndex(h => h.label === hourLabel); if (existingIndex > -1) { history[existingIndex].total = total; } else { history.push({ label: hourLabel, total, time: Date.now() }); } if (history.length > 72) history.splice(0, history.length - 72); await saveHourlyHistory(history); } catch (e) { console.error("Error in hourly jobs:", e); } }
async function monitorVirtualTrades() { const activeTrades = await getActiveVirtualTrades(); if (activeTrades.length === 0) return; const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) return; for (const trade of activeTrades) { const currentPrice = prices[trade.instId]?.price; if (!currentPrice) continue; let finalStatus = null; let pnl = 0; let finalPrice = 0; if (currentPrice >= trade.targetPrice) { finalPrice = trade.targetPrice; pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice); finalStatus = 'completed'; const profitPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0; const msg = `🎯 *الهدف تحقق (توصية افتراضية)!* ✅\n\n` + `*العملة:* \`${trade.instId}\`\n` + `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` + `*سعر الهدف:* \`$${formatNumber(trade.targetPrice, 4)}\`\n\n` + `💰 *الربح المحقق:* \`+$${formatNumber(pnl)}\` (\`+${formatNumber(profitPercent)}%\`)`; await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" }); } else if (currentPrice <= trade.stopLossPrice) { finalPrice = trade.stopLossPrice; pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice); finalStatus = 'stopped'; const lossPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0; const msg = `🛑 *تم تفعيل وقف الخسارة (توصية افتراضية)!* 🔻\n\n` + `*العملة:* \`${trade.instId}\`\n` + `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` + `*سعر الوقف:* \`$${formatNumber(trade.stopLossPrice, 4)}\`\n\n` + `💸 *الخسارة:* \`$${formatNumber(pnl)}\` (\`${formatNumber(lossPercent)}%\`)`; await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" }); } if (finalStatus) { await updateVirtualTradeStatus(trade._id, finalStatus, finalPrice); } } }

// =================================================================
// SECTION 4.5: DAILY & CUMULATIVE REPORTING
// =================================================================
async function formatDailyCopyReport() {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const closedTrades = await getCollection("tradeHistory").find({ closedAt: { $gte: twentyFourHoursAgo } }).toArray();
    if (closedTrades.length === 0) {
        return "📊 لم يتم إغلاق أي صفقات في الـ 24 ساعة الماضية.";
    }
    const today = new Date();
    const dateString = `${today.getDate().toString().padStart(2, '0')}/${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getFullYear()}`;
    let report = `📊 تقرير النسخ اليومي – خلال الـ24 ساعة الماضية\n🗓 التاريخ: ${dateString}\n\n`;
    let totalPnlWeightedSum = 0;
    let totalWeight = 0;
    for (const trade of closedTrades) {
        if (trade.pnlPercent === undefined || trade.entryCapitalPercent === undefined) continue;
        const resultEmoji = trade.pnlPercent >= 0 ? '🔼' : '🔽';
        report += `🔸اسم العملة: ${trade.asset}\n`;
        report += `🔸 نسبة الدخول من رأس المال: ${formatNumber(trade.entryCapitalPercent)}%\n`;
        report += `🔸 متوسط سعر الشراء: ${formatNumber(trade.avgBuyPrice, 4)}\n`;
        report += `🔸 سعر الخروج: ${formatNumber(trade.avgSellPrice, 4)}\n`;
        report += `🔸 نسبة الخروج من الكمية: ${formatNumber(trade.exitQuantityPercent)}%\n`;
        report += `🔸 النتيجة: ${trade.pnlPercent >= 0 ? '+' : ''}${formatNumber(trade.pnlPercent)}% ${resultEmoji}\n\n`;
        if (trade.entryCapitalPercent > 0) {
            totalPnlWeightedSum += trade.pnlPercent * trade.entryCapitalPercent;
            totalWeight += trade.entryCapitalPercent;
        }
    }
    const totalPnl = totalWeight > 0 ? totalPnlWeightedSum / totalWeight : 0;
    const totalPnlEmoji = totalPnl >= 0 ? '📈' : '📉';
    report += `إجمالي الربح الحالي خدمة النسخ: ${totalPnl >= 0 ? '+' : ''}${formatNumber(totalPnl, 2)}% ${totalPnlEmoji}\n\n`;
    report += `✍️ يمكنك الدخول في اي وقت تراه مناسب، الخدمة مفتوحة للجميع\n\n`;
    report += `📢 قناة التحديثات الرسمية:\n@RahhalVIP\n\n`;
    report += `🌐 رابط النسخ المباشر:\n🏦 https://www.binance.info/copy-trading/lead-details/456346669905472870`;
    return report;
}
async function runDailyReportJob() { try { await sendDebugMessage("Running daily copy-trading report job..."); const report = await formatDailyCopyReport(); if (report.startsWith("📊 لم يتم إغلاق أي صفقات")) { await bot.api.sendMessage(AUTHORIZED_USER_ID, report); } else { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, report); await bot.api.sendMessage(AUTHORIZED_USER_ID, "✅ تم إرسال تقرير النسخ اليومي إلى القناة بنجاح."); } } catch(e) { console.error("Error in runDailyReportJob:", e); await bot.api.sendMessage(AUTHORIZED_USER_ID, `❌ حدث خطأ أثناء إنشاء تقرير النسخ اليومي: ${e.message}`); } }
async function generateAndSendCumulativeReport(ctx, asset) { try { const trades = await getCollection("tradeHistory").find({ asset: asset }).toArray(); if (trades.length === 0) { await ctx.reply(`ℹ️ لا يوجد سجل صفقات مغلقة لعملة *${asset}*.`, { parse_mode: "Markdown" }); return; } const totalPnl = trades.reduce((sum, trade) => sum + (trade.pnl || 0), 0); const totalRoi = trades.reduce((sum, trade) => sum + (trade.pnlPercent || 0), 0); const avgRoi = totalRoi / trades.length; const winningTrades = trades.filter(t => (t.pnl || 0) > 0).length; const winRate = (winningTrades / trades.length) * 100; const bestTrade = trades.reduce((max, trade) => (trade.pnlPercent || 0) > (max.pnlPercent || 0) ? trade : max, trades[0]); const worstTrade = trades.reduce((min, trade) => (trade.pnlPercent || 0) < (min.pnlPercent || 0) ? trade : min, trades[0]); const impactSign = totalPnl >= 0 ? '+' : ''; const impactEmoji = totalPnl >= 0 ? '🟢' : '🔴'; const winRateEmoji = winRate >= 50 ? '✅' : '⚠️'; let report = `*تحليل الأثر التراكمي | ${asset}* 🔬\n\n`; report += `*الخلاصة الاستراتيجية:*\n`; report += `تداولاتك في *${asset}* أضافت ما قيمته \`${impactSign}$${formatNumber(totalPnl)}\` ${impactEmoji} إلى محفظتك بشكل تراكمي.\n\n`; report += `*ملخص الأداء التاريخي:*\n`; report += ` ▪️ *إجمالي الصفقات:* \`${trades.length}\`\n`; report += ` ▪️ *معدل النجاح (Win Rate):* \`${formatNumber(winRate)}%\` ${winRateEmoji}\n`; report += ` ▪️ *متوسط العائد (ROI):* \`${formatNumber(avgRoi)}%\`\n\n`; report += `*أبرز الصفقات:*\n`; report += ` 🏆 *أفضل صفقة:* ربح بنسبة \`${formatNumber(bestTrade.pnlPercent)}%\`\n`; report += ` 💔 *أسوأ صفقة:* ${worstTrade.pnlPercent < 0 ? 'خسارة' : 'ربح'} بنسبة \`${formatNumber(worstTrade.pnlPercent)}%\`\n\n`; report += `*توصية استراتيجية خاصة:*\n`; if (avgRoi > 5 && winRate > 60) { report += `أداء *${asset}* يتفوق على المتوسط بشكل واضح. قد تفكر في زيادة حجم صفقاتك المستقبلية فيها.`; } else if (totalPnl < 0) { report += `أداء *${asset}* سلبي. قد ترغب في مراجعة استراتيجيتك لهذه العملة أو تقليل المخاطرة فيها.`; } else { report += `أداء *${asset}* يعتبر ضمن النطاق المقبول. استمر في المراقبة والتحليل.`; } await ctx.reply(report, { parse_mode: "Markdown" }); } catch(e) { console.error(`Error generating cumulative report for ${asset}:`, e); await ctx.reply("❌ حدث خطأ أثناء إنشاء التقرير."); } }

// =================================================================
// SECTION 5: BOT SETUP, KEYBOARDS, AND HANDLERS
// =================================================================
const mainKeyboard = new Keyboard() .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row() .text("🚀 تحليل السوق").text("💡 توصية افتراضية").row() .text("⚡ إحصائيات سريعة").text("📈 تحليل تراكمي").row() .text("🔔 ضبط تنبيه").text("ℹ️ معلومات عملة").row() .text("🧮 حاسبة الربح والخسارة").text("⚙️ الإعدادات").row() .resized();
const virtualTradeKeyboard = new InlineKeyboard().text("➕ إضافة توصية جديدة", "add_virtual_trade").row().text("📈 متابعة التوصيات الحية", "track_virtual_trades");
async function sendSettingsMenu(ctx) { const settings = await loadSettings(); const settingsKeyboard = new InlineKeyboard().text("💰 تعيين رأس المال", "set_capital").text("💼 عرض المراكز المفتوحة", "view_positions").row().text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts").text("🗑️ حذف تنبيه سعر", "delete_alert").row().text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").text(`🚀 النشر للقناة: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost").row().text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug").text("📊 إرسال تقرير النسخ", "send_daily_report").row().text("🔥 حذف جميع البيانات 🔥", "delete_all_data"); const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*"; try { if (ctx.callbackQuery) { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); } else { await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); } } catch(e) { console.error("Error sending settings menu:", e); } }
async function sendMovementAlertsMenu(ctx) { const alertSettings = await loadAlertSettings(); const text = `🚨 *إدارة تنبيهات حركة الأسعار*\n\n- *النسبة العامة الحالية:* \`${alertSettings.global}%\`.\n- يمكنك تعيين نسبة مختلفة لعملة معينة.`; const keyboard = new InlineKeyboard().text("📊 تعديل النسبة العامة", "set_global_alert").text("💎 تعديل نسبة عملة", "set_coin_alert").row().text("🔙 العودة للإعدادات", "back_to_settings"); await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard }); }

bot.use(async (ctx, next) => { if (ctx.from?.id === AUTHORIZED_USER_ID) { await next(); } else { console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`); } });

bot.command("start", (ctx) => { const welcomeMessage = `🤖 *أهلاً بك في بوت التحليل المتكامل لمنصة OKX.*\n\n` + `*اضغط على الأزرار أدناه للبدء!*`; ctx.reply(welcomeMessage, { parse_mode: "Markdown", reply_markup: mainKeyboard }); });
bot.command("settings", async (ctx) => { await sendSettingsMenu(ctx); });

// =============================================================
// ===== تم تعديل هذه الدالة بالكامل لإصلاح الحاسبة =====
// =============================================================
bot.command("pnl", async (ctx) => {
    // نحصل على نص الرسالة الكامل ونزيل منه الأمر للوصول إلى الأرقام فقط
    const text = ctx.message.text || '';
    const argsString = text.substring(text.indexOf(' ') + 1);
    const args = argsString.trim().split(/\s+/);

    // تحقق من أن المستخدم أدخل 3 أرقام بالضبط
    if (args.length !== 3) {
        return await ctx.reply(
            `❌ *صيغة غير صحيحة.*\n*مثال:* \`/pnl <سعر الشراء> <سعر البيع> <الكمية>\`\n\n*مثلاً: /pnl 100 120 50*`,
            { parse_mode: "Markdown" }
        );
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

    const msg = `🧮 *نتيجة حساب الربح والخسارة*\n\n` +
        ` ▪️ *إجمالي تكلفة الشراء:* \`$${formatNumber(investment)}\`\n` +
        ` ▪️ *إجمالي قيمة البيع:* \`$${formatNumber(saleValue)}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `*صافي الربح/الخسارة:* \`${sign}${formatNumber(pnl)}\` (\`${sign}${formatNumber(pnlPercent)}%\`)\n` +
        `**الحالة النهائية: ${status}**`;

    await ctx.reply(msg, { parse_mode: "Markdown" });
});


bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;

    try {
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
            
            const btcHistoryCandles = await getHistoricalCandles('BTC-USDT', bar, limit);
            const btcHistory = btcHistoryCandles.map(c => ({close: c.close}));

            const report = await formatPerformanceReport(period, periodLabel, portfolioHistory, btcHistory);

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

        switch(data) {
            case "add_virtual_trade": waitingState = 'add_virtual_trade'; await ctx.editMessageText("✍️ *لإضافة توصية افتراضية، أرسل التفاصيل في 5 أسطر منفصلة:*\n\n`BTC-USDT`\n`65000` (سعر الدخول)\n`70000` (سعر الهدف)\n`62000` (وقف الخسارة)\n`1000` (المبلغ الافتراضي)\n\n**ملاحظة:** *لا تكتب كلمات مثل 'دخول' أو 'هدف'، فقط الأرقام والرمز.*", { parse_mode: "Markdown" }); break;
            case "track_virtual_trades": await ctx.editMessageText("⏳ جاري جلب التوصيات النشطة..."); const activeTrades = await getActiveVirtualTrades(); if (activeTrades.length === 0) { await ctx.editMessageText("✅ لا توجد توصيات افتراضية نشطة حاليًا.", { reply_markup: virtualTradeKeyboard }); return; } const prices = await okxAdapter.getMarketPrices(); if (!prices || prices.error) { await ctx.editMessageText(`❌ فشل جلب الأسعار، لا يمكن متابعة التوصيات.`, { reply_markup: virtualTradeKeyboard }); return; } let reportMsg = "📈 *متابعة حية للتوصيات النشطة:*\n" + "━━━━━━━━━━━━━━━━━━━━\n"; for (const trade of activeTrades) { const currentPrice = prices[trade.instId]?.price; if (!currentPrice) { reportMsg += `*${trade.instId}:* \`لا يمكن جلب السعر الحالي.\`\n`; } else { const pnl = (currentPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice); const pnlPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0; const sign = pnl >= 0 ? '+' : ''; const emoji = pnl >= 0 ? '🟢' : '🔴'; reportMsg += `*${trade.instId}* ${emoji}\n` + ` ▫️ *الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` + ` ▫️ *الحالي:* \`$${formatNumber(currentPrice, 4)}\`\n` + ` ▫️ *ربح/خسارة:* \`${sign}${formatNumber(pnl)}\` (\`${sign}${formatNumber(pnlPercent)}%\`)\n` + ` ▫️ *الهدف:* \`$${formatNumber(trade.targetPrice, 4)}\`\n` + ` ▫️ *الوقف:* \`$${formatNumber(trade.stopLossPrice, 4)}\`\n`; } reportMsg += "━━━━━━━━━━━━━━━━━━━━\n"; } await ctx.editMessageText(reportMsg, { parse_mode: "Markdown", reply_markup: virtualTradeKeyboard }); break;
            case "set_capital": waitingState = 'set_capital'; await ctx.editMessageText("💰 يرجى إرسال المبلغ الجديد لرأس المال (رقم فقط)."); break;
            case "back_to_settings": await sendSettingsMenu(ctx); break;
            case "manage_movement_alerts": await sendMovementAlertsMenu(ctx); break;
            case "set_global_alert": waitingState = 'set_global_alert_state'; await ctx.editMessageText("✍️ يرجى إرسال النسبة العامة الجديدة (مثال: `5`)."); break;
            case "set_coin_alert": waitingState = 'set_coin_alert_state'; await ctx.editMessageText("✍️ يرجى إرسال رمز العملة والنسبة.\n*مثال:*\n`BTC 2.5`"); break;
            case "view_positions": const positions = await loadPositions(); if (Object.keys(positions).length === 0) { await ctx.editMessageText("ℹ️ لا توجد مراكز مفتوحة.", { reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") }); break; } let posMsg = "📄 *قائمة المراكز المفتوحة:*\n"; for (const symbol in positions) { const pos = positions[symbol]; posMsg += `\n- *${symbol}:* متوسط الشراء \`$${formatNumber(pos.avgBuyPrice, 4)}\``; } await ctx.editMessageText(posMsg, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") }); break;
            case "delete_alert": const alerts = await loadAlerts(); if (alerts.length === 0) { await ctx.editMessageText("ℹ️ لا توجد تنبيهات مسجلة.", { reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") }); break; } let alertMsg = "🗑️ *اختر التنبيه لحذفه:*\n\n"; alerts.forEach((alert, i) => { alertMsg += `*${i + 1}.* \`${alert.instId} ${alert.condition} ${alert.price}\`\n`; }); alertMsg += "\n*أرسل رقم التنبيه الذي تود حذفه.*"; waitingState = 'delete_alert_number'; await ctx.editMessageText(alertMsg, { parse_mode: "Markdown" }); break;
            case "toggle_summary": case "toggle_autopost": case "toggle_debug": const settings = await loadSettings(); if (data === 'toggle_summary') settings.dailySummary = !settings.dailySummary; else if (data === 'toggle_autopost') settings.autoPostToChannel = !settings.autoPostToChannel; else if (data === 'toggle_debug') settings.debugMode = !settings.debugMode; await saveSettings(settings); await sendSettingsMenu(ctx); break;
            case "send_daily_report": await ctx.editMessageText("⏳ جاري إنشاء وإرسال تقرير النسخ اليومي..."); await runDailyReportJob(); await sendSettingsMenu(ctx); break;
            case "delete_all_data": waitingState = 'confirm_delete_all'; await ctx.editMessageText("⚠️ *تحذير: هذا الإجراء لا يمكن التراجع عنه!* لحذف كل شيء، أرسل: `تأكيد الحذف`", { parse_mode: "Markdown" }); break;
        }
    } catch (error) { console.error("Error in callback_query handler:", error); try { await ctx.reply("❌ حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى."); } catch (e) { console.error("Failed to send error message to user:", e); } }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    if (waitingState) {
        const state = waitingState;
        waitingState = null;
        switch (state) {
            case 'cumulative_analysis_asset':
                await generateAndSendCumulativeReport(ctx, text.toUpperCase());
                return;
            case 'add_virtual_trade':
                try {
                    const lines = text.split('\n').map(line => line.trim());
                    if (lines.length < 5) throw new Error("التنسيق غير صحيح، يجب أن يتكون من 5 أسطر.");
                    const instId = lines[0].toUpperCase();
                    const entryPrice = parseFloat(lines[1]);
                    const targetPrice = parseFloat(lines[2]);
                    const stopLossPrice = parseFloat(lines[3]);
                    const virtualAmount = parseFloat(lines[4]);
                    if (!instId.endsWith('-USDT')) throw new Error("رمز العملة يجب أن ينتهي بـ -USDT.");
                    if ([entryPrice, targetPrice, stopLossPrice, virtualAmount].some(isNaN)) { throw new Error("تأكد من أن جميع القيم المدخلة هي أرقام صالحة."); }
                    if (entryPrice <= 0 || targetPrice <= 0 || stopLossPrice <= 0 || virtualAmount <= 0) { throw new Error("جميع القيم الرقمية يجب أن تكون أكبر من صفر."); }
                    if (targetPrice <= entryPrice) throw new Error("سعر الهدف يجب أن يكون أعلى من سعر الدخول.");
                    if (stopLossPrice >= entryPrice) throw new Error("سعر وقف الخسارة يجب أن يكون أقل من سعر الدخول.");
                    const tradeData = { instId, entryPrice, targetPrice, stopLossPrice, virtualAmount, status: 'active', createdAt: new Date() };
                    await saveVirtualTrade(tradeData);
                    await ctx.reply(`✅ *تمت إضافة التوصية الافتراضية بنجاح.*\n\nسيتم إعلامك عند تحقيق الهدف أو تفعيل وقف الخسارة.`, { parse_mode: "Markdown" });
                } catch (e) {
                    await ctx.reply(`❌ *خطأ في إضافة التوصية:*\n${e.message}\n\nالرجاء المحاولة مرة أخرى بالتنسيق الصحيح.`);
                }
                return;
            case 'set_capital':
                const amount = parseFloat(text);
                if (!isNaN(amount) && amount >= 0) {
                    await saveCapital(amount);
                    await ctx.reply(`✅ *تم تحديث رأس المال إلى:* \`$${formatNumber(amount)}\``, { parse_mode: "Markdown" });
                } else {
                    await ctx.reply("❌ مبلغ غير صالح.");
                }
                return;
            case 'set_global_alert_state':
                const percent = parseFloat(text);
                if (!isNaN(percent) && percent > 0) {
                    const alertSettingsGlobal = await loadAlertSettings();
                    alertSettingsGlobal.global = percent;
                    await saveAlertSettings(alertSettingsGlobal);
                    await ctx.reply(`✅ تم تحديث النسبة العامة لتنبيهات الحركة إلى \`${percent}%\`.`);
                } else {
                    await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا موجبًا.");
                }
                return;
            case 'set_coin_alert_state':
                const parts_coin_alert = text.split(/\s+/);
                if (parts_coin_alert.length !== 2) {
                    await ctx.reply("❌ *صيغة غير صحيحة*. يرجى إرسال رمز العملة ثم النسبة.");
                    return;
                }
                const [symbol_coin_alert, percentStr_coin_alert] = parts_coin_alert;
                const coinPercent = parseFloat(percentStr_coin_alert);
                if (isNaN(coinPercent) || coinPercent < 0) {
                    await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا.");
                    return;
                }
                const alertSettingsCoin = await loadAlertSettings();
                if (coinPercent === 0) {
                    delete alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()];
                    await ctx.reply(`✅ تم حذف الإعداد المخصص لـ *${symbol_coin_alert.toUpperCase()}* وستتبع الآن النسبة العامة.`);
                } else {
                    alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()] = coinPercent;
                    await ctx.reply(`✅ تم تحديث النسبة المخصصة لـ *${symbol_coin_alert.toUpperCase()}* إلى \`${coinPercent}%\`.`);
                }
                await saveAlertSettings(alertSettingsCoin);
                return;
            case 'confirm_delete_all':
                if (text === 'تأكيد الحذف') {
                    await getCollection("configs").deleteMany({});
                    await getCollection("virtualTrades").deleteMany({});
                    await getCollection("tradeHistory").deleteMany({});
                    await ctx.reply("✅ تم حذف جميع بياناتك.");
                } else {
                    await ctx.reply("❌ تم إلغاء الحذف.");
                }
                return;
            case 'coin_info':
                const instId = text.toUpperCase();
                const coinSymbol = instId.split('-')[0];
                const loadingMsg = await ctx.reply(`⏳ جاري تجهيز التقرير لـ ${instId}...`);

                try {
                    const results = await Promise.allSettled([
                        getInstrumentDetails(instId),
                        okxAdapter.getMarketPrices(),
                        getHistoricalPerformance(coinSymbol),
                        getTechnicalAnalysis(instId)
                    ]);

                    const detailsResult = results[0];
                    const pricesResult = results[1];
                    const historicalPerfResult = results[2];
                    const techAnalysisResult = results[3];
                    
                    if (detailsResult.status === 'rejected' || (detailsResult.status === 'fulfilled' && detailsResult.value.error)) {
                        const errorMsg = detailsResult.reason?.message || detailsResult.value?.error || "فشل جلب البيانات الأساسية للعملة.";
                        throw new Error(errorMsg);
                    }
            
                    const details = detailsResult.value;
                    let msg = `ℹ️ *الملف التحليلي الكامل | ${instId}*\n\n*القسم الأول: بيانات السوق*\n`;
                    msg += ` ▫️ *السعر الحالي:* \`$${formatNumber(details.price, 4)}\`\n`;
                    msg += ` ▫️ *أعلى (24س):* \`$${formatNumber(details.high24h, 4)}\`\n`;
                    msg += ` ▫️ *أدنى (24س):* \`$${formatNumber(details.low24h, 4)}\`\n\n`;
            
                    msg += `*القسم الثاني: تحليل مركزك الحالي*\n`;
                    if (pricesResult.status === 'fulfilled' && !pricesResult.value.error) {
                        const prices = pricesResult.value;
                        const { assets: userAssets } = await okxAdapter.getPortfolio(prices);
                        const ownedAsset = userAssets.find(a => a.asset === coinSymbol);
                        const positions = await loadPositions();
                        const assetPosition = positions[coinSymbol];
                        if (ownedAsset && assetPosition?.avgBuyPrice) {
                            const pnl = (details.price - assetPosition.avgBuyPrice) * ownedAsset.amount;
                            const pnlPercent = (assetPosition.avgBuyPrice > 0) ? (pnl / (assetPosition.avgBuyPrice * ownedAsset.amount)) * 100 : 0;
                            const durationDays = (new Date().getTime() - new Date(assetPosition.openDate).getTime()) / (1000 * 60 * 60 * 24);
                            msg += ` ▪️ *متوسط الشراء:* \`$${formatNumber(assetPosition.avgBuyPrice, 4)}\`\n`;
                            msg += ` ▪️ *الربح/الخسارة غير المحقق:* ${pnl >= 0 ? '🟢' : '🔴'} \`${pnl >= 0 ? '+' : ''}${formatNumber(pnl)}\` (\`${pnl >= 0 ? '+' : ''}${formatNumber(pnlPercent)}%\`)\n`;
                            msg += ` ▪️ *مدة فتح المركز:* \`${formatNumber(durationDays, 1)} يوم\`\n\n`;
                        } else {
                            msg += ` ▪️ لا يوجد مركز مفتوح حالياً لهذه العملة.\n\n`;
                        }
                    } else {
                        msg += ` ▪️ تعذر تحليل المركز (فشل جلب بيانات المحفظة).\n\n`;
                    }
            
                    msg += `*القسم الثالث: تاريخ أدائك مع العملة*\n`;
                    if (historicalPerfResult.status === 'fulfilled' && historicalPerfResult.value) {
                        const historicalPerf = historicalPerfResult.value;
                        if (historicalPerf.tradeCount > 0) {
                            msg += ` ▪️ *إجمالي الربح/الخسارة المحقق:* \`${historicalPerf.realizedPnl >= 0 ? '+' : ''}${formatNumber(historicalPerf.realizedPnl)}\`\n`;
                            msg += ` ▪️ *سجل الصفقات:* \`${historicalPerf.tradeCount}\` (${historicalPerf.winningTrades} رابحة / ${historicalPerf.losingTrades} خاسرة)\n\n`;
                        } else {
                            msg += ` ▪️ لا يوجد تاريخ صفقات مغلقة لهذه العملة.\n\n`;
                        }
                    } else {
                        msg += ` ▪️ تعذر جلب سجل الأداء التاريخي.\n\n`;
                    }
                    
                    msg += `*القسم الرابع: مؤشرات فنية بسيطة*\n`;
                    if (techAnalysisResult.status === 'fulfilled' && !techAnalysisResult.value.error) {
                        const techAnalysis = techAnalysisResult.value;
                        let rsiText = "محايد";
                        if (techAnalysis.rsi > 70) rsiText = "تشبع شرائي 🔴";
                        if (techAnalysis.rsi < 30) rsiText = "تشبع بيعي 🟢";
                        msg += ` ▪️ *RSI (14D):* \`${formatNumber(techAnalysis.rsi)}\` (${rsiText})\n`;
                        if(techAnalysis.sma20) msg += ` ▪️ *السعر* *${details.price > techAnalysis.sma20 ? 'فوق' : 'تحت'}* *SMA20* (\`$${formatNumber(techAnalysis.sma20, 4)}\`)\n`;
                        if(techAnalysis.sma50) msg += ` ▪️ *السعر* *${details.price > techAnalysis.sma50 ? 'فوق' : 'تحت'}* *SMA50* (\`$${formatNumber(techAnalysis.sma50, 4)}\`)`;
                    } else {
                         msg += ` ▪️ تعذر جلب المؤشرات الفنية.\n`;
                    }
            
                    await ctx.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, msg, { parse_mode: "Markdown" });
                } catch(e) {
                    console.error("Error fetching coin info:", e);
                    await ctx.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, `❌ حدث خطأ أثناء جلب البيانات: ${e.message}`);
                }
                return;
            case 'set_alert':
                const parts_alert = text.trim().split(/\s+/);
                if (parts_alert.length !== 3) {
                    await ctx.reply("❌ صيغة غير صحيحة. مثال: `BTC > 50000`");
                    return;
                }
                const [symbol, cond, priceStr] = parts_alert;
                if (cond !== '>' && cond !== '<') {
                    await ctx.reply("❌ الشرط غير صالح. استخدم `>` أو `<`.");
                    return;
                }
                const price = parseFloat(priceStr);
                if (isNaN(price) || price <= 0) {
                    await ctx.reply("❌ السعر غير صالح.");
                    return;
                }
                const allAlerts = await loadAlerts();
                allAlerts.push({ instId: symbol.toUpperCase() + '-USDT', condition: cond, price: price });
                await saveAlerts(allAlerts);
                await ctx.reply(`✅ تم ضبط التنبيه: ${symbol.toUpperCase()} ${cond} ${price}`, { parse_mode: "Markdown" });
                return;
            case 'delete_alert_number':
                let currentAlerts = await loadAlerts();
                const index = parseInt(text) - 1;
                if (isNaN(index) || index < 0 || index >= currentAlerts.length) {
                    await ctx.reply("❌ رقم غير صالح.");
                    return;
                }
                currentAlerts.splice(index, 1);
                await saveAlerts(currentAlerts);
                await ctx.reply(`✅ تم حذف التنبيه.`);
                return;
        }
    }

    switch (text) {
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
        case "🚀 تحليل السوق":
            const loadingMsgMarket = await ctx.reply("⏳ جاري تحليل السوق...");
            try {
                const prices = await okxAdapter.getMarketPrices();
                if (!prices || prices.error) throw new Error(prices.error || `فشل جلب أسعار السوق.`);
                const { assets, error } = await okxAdapter.getPortfolio(prices);
                if (error) throw new Error(error);
                const marketMsg = await formatAdvancedMarketAnalysis(assets);
                await ctx.api.editMessageText(loadingMsgMarket.chat.id, loadingMsgMarket.message_id, marketMsg, { parse_mode: "Markdown" });
            } catch (e) {
                console.error("Error in 'تحليل السوق':", e);
                await ctx.api.editMessageText(loadingMsgMarket.chat.id, loadingMsgMarket.message_id, `❌ حدث خطأ أثناء تحليل السوق: ${e.message}`);
            }
            break;
        case "💡 توصية افتراضية":
            await ctx.reply("اختر الإجراء المطلوب للتوصيات الافتراضية:", { reply_markup: virtualTradeKeyboard });
            break;
        case "⚡ إحصائيات سريعة":
            const loadingMsgQuick = await ctx.reply("⏳ جاري حساب الإحصائيات...");
            try {
                const prices = await okxAdapter.getMarketPrices();
                if (!prices || prices.error) throw new Error(prices.error || `فشل جلب أسعار السوق.`);
                const capital = await loadCapital();
                const { assets, total, error } = await okxAdapter.getPortfolio(prices);
                if (error) throw new Error(error);
                const quickStatsMsg = await formatQuickStats(assets, total, capital);
                await ctx.api.editMessageText(loadingMsgQuick.chat.id, loadingMsgQuick.message_id, quickStatsMsg, { parse_mode: "Markdown" });
            } catch (e) {
                console.error("Error in 'إحصائيات سريعة':", e);
                await ctx.api.editMessageText(loadingMsgQuick.chat.id, loadingMsgQuick.message_id, `❌ حدث خطأ: ${e.message}`);
            }
            break;
        case "📈 أداء المحفظة":
            const performanceKeyboard = new InlineKeyboard().text("آخر 24 ساعة", "chart_24h").text("آخر 7 أيام", "chart_7d").row().text("آخر 30 يومًا", "chart_30d");
            await ctx.reply("اختر الفترة الزمنية لعرض تقرير الأداء:", { reply_markup: performanceKeyboard });
            break;
        case "📈 تحليل تراكمي":
            waitingState = 'cumulative_analysis_asset';
            await ctx.reply("✍️ يرجى إرسال رمز العملة التي تود تحليلها (مثال: `BTC`).");
            break;
        case "ℹ️ معلومات عملة":
            waitingState = 'coin_info';
            await ctx.reply("✍️ يرجى إرسال رمز العملة (مثال: `BTC-USDT`).");
            break;
        case "⚙️ الإعدادات":
            await sendSettingsMenu(ctx);
            break;
        case "🔔 ضبط تنبيه":
            waitingState = 'set_alert';
            await ctx.reply("✍️ *لضبط تنبيه سعر، استخدم الصيغة:*\n`BTC > 50000`", { parse_mode: "Markdown" });
            break;
        case "🧮 حاسبة الربح والخسارة":
            await ctx.reply("✍️ لحساب الربح/الخسارة، استخدم أمر `/pnl` بالصيغة التالية:\n`/pnl <سعر الشراء> <سعر البيع> <الكمية>`", {parse_mode: "Markdown"});
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
            await bot.start();
        }
        console.log("Bot is now fully operational for OKX.");

        // Start all background jobs
        console.log("Starting OKX background jobs...");
        setInterval(monitorBalanceChanges, 60 * 1000);
        setInterval(trackPositionHighLow, 60 * 1000);
        setInterval(checkPriceAlerts, 30 * 1000);
        setInterval(checkPriceMovements, 60 * 1000);
        setInterval(monitorVirtualTrades, 30 * 1000);
        setInterval(runHourlyJobs, 60 * 60 * 1000);
        setInterval(runDailyJobs, 24 * 60 * 60 * 1000);
        setInterval(runDailyReportJob, 24 * 60 * 60 * 1000);
        
        // Run initial jobs once on startup
        await runHourlyJobs();
        await runDailyJobs();
        await monitorBalanceChanges();
        await bot.api.sendMessage(AUTHORIZED_USER_ID, "✅ تم تفعيل المراقبة المتقدمة لمنصة OKX.").catch(console.error);

    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
        process.exit(1);
    }
}

startBot();
