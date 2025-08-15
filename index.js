// =================================================================
// Advanced Analytics Bot - v116 (Daily Copy-Trading Report Feature)
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
        const prehash =
            timestamp +
            method.toUpperCase() +
            path +
            (typeof body === "object" ? JSON.stringify(body) : body);
        const sign = crypto
            .createHmac("sha256", process.env.OKX_API_SECRET_KEY)
            .update(prehash)
            .digest("base64");
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
            const tickersRes = await fetch(
                `${this.baseURL}/api/v5/market/tickers?instType=SPOT`
            );
            const tickersJson = await tickersRes.json();
            if (tickersJson.code !== "0") {
                return { error: `فشل جلب أسعار السوق: ${tickersJson.msg}` };
            }
            const prices = {};
            tickersJson.data.forEach((t) => {
                if (t.instId.endsWith("-USDT")) {
                    const lastPrice = parseFloat(t.last);
                    const openPrice = parseFloat(t.open24h);
                    let change24h = 0;
                    if (openPrice > 0) change24h = (lastPrice - openPrice) / openPrice;
                    prices[t.instId] = {
                        price: lastPrice,
                        open24h: openPrice,
                        change24h,
                        volCcy24h: parseFloat(t.volCcy24h),
                    };
                }
            });
            return prices;
        } catch (error) {
            return { error: "خطأ استثنائي عند جلب أسعار السوق." };
        }
    }

    async getPortfolio(prices) {
        try {
            const path = "/api/v5/account/balance";
            const res = await fetch(`${this.baseURL}${path}`, {
                headers: this.getHeaders("GET", path),
            });
            const json = await res.json();
            if (
                json.code !== "0" ||
                !json.data ||
                !json.data[0] ||
                !json.data.details
            ) {
                return {
                    error: `فشل جلب المحفظة: ${json.msg || "بيانات غير متوقعة"}`,
                };
            }
            let assets = [],
                total = 0,
                usdtValue = 0;
            json.data.details.forEach((asset) => {
                const amount = parseFloat(asset.eq);
                if (amount > 0) {
                    const instId = `${asset.ccy}-USDT`;
                    const priceData = prices[instId] || {
                        price: asset.ccy === "USDT" ? 1 : 0,
                        change24h: 0,
                    };
                    const value = amount * priceData.price;
                    total += value;
                    if (asset.ccy === "USDT") usdtValue = value;
                    if (value >= 1)
                        assets.push({
                            asset: asset.ccy,
                            price: priceData.price,
                            value,
                            amount,
                            change24h: priceData.change24h,
                        });
                }
            });
            assets.sort((a, b) => b.value - a.value);
            return { assets, total, usdtValue };
        } catch (e) {
            return { error: "خطأ في الاتصال بمنصة OKX." };
        }
    }

    async getBalanceForComparison() {
        try {
            const path = "/api/v5/account/balance";
            const res = await fetch(`${this.baseURL}${path}`, {
                headers: this.getHeaders("GET", path),
            });
            const json = await res.json();
            if (
                json.code !== "0" ||
                !json.data ||
                !json.data[0] ||
                !json.data.details
            ) {
                return null;
            }
            const balances = {};
            json.data.details.forEach((asset) => {
                const amount = parseFloat(asset.eq);
                if (amount > 0) balances[asset.ccy] = amount;
            });
            return balances;
        } catch (e) {
            return null;
        }
    }
}
const okxAdapter = new OKXAdapter();

// =================================================================
// SECTION 1: DATABASE AND HELPER FUNCTIONS
// =================================================================
const getCollection = (collectionName) => getDB().collection(collectionName);
async function getConfig(id, defaultValue = {}) {
    try {
        const doc = await getCollection("configs").findOne({ _id: id });
        return doc ? doc.data : defaultValue;
    } catch (e) {
        return defaultValue;
    }
}
async function saveConfig(id, data) {
    try {
        await getCollection("configs").updateOne(
            { _id: id },
            { $set: { data: data } },
            { upsert: true }
        );
    } catch (e) {
        console.error(`Error in saveConfig for id: ${id}`, e);
    }
}
async function saveClosedTrade(tradeData) {
    try {
        await getCollection("tradeHistory").insertOne({
            ...tradeData,
            closedAt: new Date(),
        });
    } catch (e) {
        console.error("Error in saveClosedTrade:", e);
    }
}
async function getHistoricalPerformance(asset) {
    try {
        const history = await getCollection("tradeHistory")
            .find({ asset: asset })
            .toArray();
        if (history.length === 0) {
            return {
                realizedPnl: 0,
                tradeCount: 0,
                winningTrades: 0,
                losingTrades: 0,
                avgDuration: 0,
            };
        }
        const realizedPnl = history.reduce((sum, trade) => sum + trade.pnl, 0);
        const winningTrades = history.filter((trade) => trade.pnl > 0).length;
        const losingTrades = history.filter((trade) => trade.pnl <= 0).length;
        const totalDuration = history.reduce(
            (sum, trade) => sum + trade.durationDays,
            0
        );
        const avgDuration = history.length > 0 ? totalDuration / history.length : 0;
        return {
            realizedPnl,
            tradeCount: history.length,
            winningTrades,
            losingTrades,
            avgDuration,
        };
    } catch (e) {
        return null;
    }
}
async function saveVirtualTrade(tradeData) {
    try {
        const tradeWithId = {
            ...tradeData,
            _id: new crypto.randomBytes(16).toString("hex"),
        };
        await getCollection("virtualTrades").insertOne(tradeWithId);
        return tradeWithId;
    } catch (e) {
        console.error("Error saving virtual trade:", e);
    }
}
async function getActiveVirtualTrades() {
    try {
        return await getCollection("virtualTrades")
            .find({ status: "active" })
            .toArray();
    } catch (e) {
        return [];
    }
}
async function updateVirtualTradeStatus(tradeId, status, finalPrice) {
    try {
        await getCollection("virtualTrades").updateOne(
            { _id: tradeId },
            {
                $set: {
                    status: status,
                    closePrice: finalPrice,
                    closedAt: new Date(),
                },
            }
        );
    } catch (e) {
        console.error(`Error updating virtual trade ${tradeId}:`, e);
    }
}
const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadSettings = async () =>
    await getConfig("settings", {
        dailySummary: true,
        autoPostToChannel: false,
        debugMode: false,
        dailyReportTime: "22:00",
    });
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
const loadAlertSettings = async () =>
    await getConfig("alertSettings", { global: 5, overrides: {} });
const saveAlertSettings = (settings) => saveConfig("alertSettings", settings);
const loadPriceTracker = async () =>
    await getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => saveConfig("priceTracker", tracker);
function formatNumber(num, decimals = 2) {
    const number = parseFloat(num);
    if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals);
    return number.toFixed(decimals);
}
async function sendDebugMessage(message) {
    const settings = await loadSettings();
    if (settings.debugMode) {
        try {
            await bot.api.sendMessage(
                AUTHORIZED_USER_ID,
                `🐞 *Debug (OKX):* ${message}`,
                { parse_mode: "Markdown" }
            );
        } catch (e) {
            console.error("Failed to send debug message:", e);
        }
    }
}

// =================================================================
// SECTION 2: DATA PROCESSING FUNCTIONS
// =================================================================
async function getInstrumentDetails(instId) {
    try {
        const tickerRes = await fetch(
            `${okxAdapter.baseURL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`
        );
        const tickerJson = await tickerRes.json();
        if (tickerJson.code !== "0" || !tickerJson.data[0])
            return { error: `لم يتم العثور على العملة.` };
        const tickerData = tickerJson.data;
        return {
            price: parseFloat(tickerData.last),
            high24h: parseFloat(tickerData.high24h),
            low24h: parseFloat(tickerData.low24h),
            vol24h: parseFloat(tickerData.volCcy24h),
        };
    } catch (e) {
        return { error: "خطأ في الاتصال بالمنصة." };
    }
}
async function getHistoricalCandles(instId, limit = 100) {
    try {
        const res = await fetch(
            `${okxAdapter.baseURL}/api/v5/market/history-candles?instId=${instId}&bar=1D&limit=${limit}`
        );
        const json = await res.json();
        if (json.code !== "0" || !json.data || json.data.length === 0) return [];
        return json.data.map((c) => parseFloat(c[4])).reverse();
    } catch (e) {
        return [];
    }
}
function calculateSMA(closes, period) {
    if (closes.length < period) return null;
    const sum = closes.slice(-period).reduce((acc, val) => acc + val, 0);
    return sum / period;
}
function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0,
        losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        diff > 0 ? (gains += diff) : (losses -= diff);
    }
    let avgGain = gains / period,
        avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgLoss = (avgLoss * (period - 1) - diff) / period;
            avgGain = (avgGain * (period - 1)) / period;
        }
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}
async function getTechnicalAnalysis(instId) {
    const closes = await getHistoricalCandles(instId, 51);
    if (closes.length < 51) return { error: "بيانات الشموع غير كافية." };
    return {
        rsi: calculateRSI(closes),
        sma20: calculateSMA(closes, 20),
        sma50: calculateSMA(closes, 50),
    };
}
function calculatePerformanceStats(history) {
    if (history.length < 2) return null;
    const values = history.map((h) => h.total);
    const startValue = values[0];
    const endValue = values[values.length - 1];
    const pnl = endValue - startValue;
    const pnlPercent = startValue > 0 ? (pnl / startValue) * 100 : 0;
    const maxValue = Math.max(...values);
    const minValue = Math.min(...values);
    const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length;
    return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue };
}
function createChartUrl(history, periodLabel, pnl) {
    if (history.length < 2) return null;
    const chartColor = pnl >= 0 ? "rgb(75, 192, 75)" : "rgb(255, 99, 132)";
    const chartBgColor =
        pnl >= 0 ? "rgba(75, 192, 75, 0.2)" : "rgba(255, 99, 132, 0.2)";
    const labels = history.map((h) => h.label);
    const data = history.map((h) => h.total.toFixed(2));
    const chartConfig = {
        type: "line",
        data: {
            labels: labels,
            datasets: [
                {
                    label: "قيمة المحفظة ($)",
                    data: data,
                    fill: true,
                    backgroundColor: chartBgColor,
                    borderColor: chartColor,
                    tension: 0.1,
                },
            ],
        },
        options: { title: { display: true, text: `أداء المحفظة - ${periodLabel}` } },
    };
    return `https://quickchart.io/chart?c=${encodeURIComponent(
        JSON.stringify(chartConfig)
    )}&backgroundColor=white`;
}

// =================================================================
// SECTION 3: FORMATTING AND MESSAGE FUNCTIONS
// =================================================================
function formatPrivateBuy(details) {
    const {
        asset,
        price,
        amountChange,
        tradeValue,
        oldTotalValue,
        newAssetWeight,
        newUsdtValue,
        newCashPercent,
    } = details;
    const tradeSizePercent =
        oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0;
    let msg = `*مراقبة الأصول 🔬:*\n**عملية استحواذ جديدة 🟢**\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`\n`;
    msg += `🔸 **نوع العملية:** تعزيز مركز / بناء مركز جديد\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`;
    msg += ` ▪️ **سعر التنفيذ:** \`$${formatNumber(price, 4)}\`\n`;
    msg += ` ▪️ **الكمية المضافة:** \`${formatNumber(Math.abs(amountChange), 6)}\`\n`;
    msg += ` ▪️ **التكلفة الإجمالية للصفقة:** \`$${formatNumber(tradeValue)}\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*التأثير على هيكل المحفظة:*\n`;
    msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${formatNumber(
        tradeSizePercent
    )}%\`\n`;
    msg += ` ▪️ **الوزن الجديد للأصل:** \`${formatNumber(newAssetWeight)}%\`\n`;
    msg += ` ▪️ **السيولة المتبقية (USDT):** \`$${formatNumber(newUsdtValue)}\`\n`;
    msg += ` ▪️ **مؤشر السيولة الحالي:** \`${formatNumber(newCashPercent)}%\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${new Date().toLocaleString("ar-EG", {
        timeZone: "Africa/Cairo",
    })}`;
    return msg;
}
function formatPrivateSell(details) {
    const {
        asset,
        price,
        amountChange,
        tradeValue,
        oldTotalValue,
        newAssetWeight,
        newUsdtValue,
        newCashPercent,
    } = details;
    const tradeSizePercent =
        oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0;
    let msg = `*مراقبة الأصول 🔬:*\n**مناورة تكتيكية 🟠**\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`\n`;
    msg += `🔸 **نوع العملية:** تخفيف المركز / جني أرباح جزئي\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`;
    msg += ` ▪️ **سعر التنفيذ:** \`$${formatNumber(price, 4)}\`\n`;
    msg += ` ▪️ **الكمية المخففة:** \`${formatNumber(Math.abs(amountChange), 6)}\`\n`;
    msg += ` ▪️ **العائد الإجمالي للصفقة:** \`$${formatNumber(tradeValue)}\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*التأثير على هيكل المحفظة:*\n`;
    msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${formatNumber(
        tradeSizePercent
    )}%\`\n`;
    msg += ` ▪️ **الوزن الجديد للأصل:** \`${formatNumber(newAssetWeight)}%\`\n`;
    msg += ` ▪️ **السيولة الجديدة (USDT):** \`$${formatNumber(newUsdtValue)}\`\n`;
    msg += ` ▪️ **مؤشر السيولة الحالي:** \`${formatNumber(newCashPercent)}%\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${new Date().toLocaleString("ar-EG", {
        timeZone: "Africa/Cairo",
    })}`;
    return msg;
}
function formatPrivateCloseReport(details) {
    const {
        asset,
        avgBuyPrice,
        avgSellPrice,
        pnl,
        pnlPercent,
        durationDays,
        highestPrice,
        lowestPrice,
    } = details;
    const pnlSign = pnl >= 0 ? "+" : "";
    const emoji = pnl >= 0 ? "🟢" : "🔴";
    let msg = `*ملف المهمة المكتملة 📂:*\n**تم إغلاق مركز ${asset} بنجاح ✅**\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*النتيجة النهائية للمهمة:*\n`;
    msg += ` ▪️ **الحالة:** **${pnl >= 0 ? "مربحة" : "خاسرة"}**\n`;
    msg += ` ▪️ **صافي الربح/الخسارة:** \`${pnlSign}$${formatNumber(pnl)}\` ${emoji}\n`;
    msg += ` ▪️ **نسبة العائد على الاستثمار (ROI):** \`${pnlSign}${formatNumber(
        pnlPercent
    )}%\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*الجدول الزمني والأداء:*\n`;
    msg += ` ▪️ **مدة الاحتفاظ بالمركز:** \`${formatNumber(
        durationDays,
        1
    )} يوم\`\n`;
    msg += ` ▪️ **متوسط سعر الدخول:** \`$${formatNumber(avgBuyPrice, 4)}\`\n`;
    msg += ` ▪️ **متوسط سعر الخروج:** \`$${formatNumber(avgSellPrice, 4)}\`\n`;
    msg += ` ▪️ **أعلى قمة سعرية مسجلة:** \`$${formatNumber(highestPrice, 4)}\`\n`;
    msg += ` ▪️ **أدنى قاع سعري مسجل:** \`$${formatNumber(lowestPrice, 4)}\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ الإغلاق:* ${new Date().toLocaleString("ar-EG", {
        timeZone: "Africa/Cairo",
    })}`;
    return msg;
}
function formatPublicBuy(details) {
    const { asset, price, oldTotalValue, tradeValue, oldUsdtValue, newCashPercent } =
        details;
    const tradeSizePercent =
        oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0;
    const cashConsumedPercent =
        oldUsdtValue > 0 ? (tradeValue / oldUsdtValue) * 100 : 0;
    let msg = `*💡 توصية جديدة: بناء مركز في ${asset} 🟢*\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*الأصل:* \`${asset}/USDT\`\n`;
    msg += `*سعر الدخول الحالي:* \`$${formatNumber(price, 4)}\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*استراتيجية إدارة المحفظة:*\n`;
    msg += ` ▪️ *حجم الدخول:* تم تخصيص \`${formatNumber(
        tradeSizePercent
    )}%\` من المحفظة لهذه الصفقة.\n`;
    msg += ` ▪️ *استهلاك السيولة:* استهلك هذا الدخول \`${formatNumber(
        cashConsumedPercent
    )}%\` من السيولة النقدية المتاحة.\n`;
    msg += ` ▪️ *السيولة المتبقية:* بعد الصفقة، أصبحت السيولة تشكل \`${formatNumber(
        newCashPercent
    )}%\` من المحفظة.\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*ملاحظات:*\nنرى في هذه المستويات فرصة واعدة. المراقبة مستمرة، وسنوافيكم بتحديثات إدارة الصفقة.\n`;
    msg += `#توصية #${asset}`;
    return msg;
}
function formatPublicSell(details) {
    const { asset, price, amountChange, position } = details;
    const totalPositionAmountBeforeSale =
        position.totalAmountBought - (position.totalAmountSold - Math.abs(amountChange));
    const soldPercent =
        totalPositionAmountBeforeSale > 0
            ? (Math.abs(amountChange) / totalPositionAmountBeforeSale) * 100
            : 0;
    const partialPnl = price - position.avgBuyPrice;
    const partialPnlPercent =
        position.avgBuyPrice > 0 ? (partialPnl / position.avgBuyPrice) * 100 : 0;
    let msg = `*⚙️ تحديث التوصية: إدارة مركز ${asset} 🟠*\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*الأصل:* \`${asset}/USDT\`\n`;
    msg += `*سعر البيع الجزئي:* \`$${formatNumber(price, 4)}\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*استراتيجية إدارة المحفظة:*\n`;
    msg += ` ▪️ *الإجراء:* تم بيع \`${formatNumber(
        soldPercent
    )}%\` من مركزنا لتأمين الأرباح.\n`;
    msg += ` ▪️ *النتيجة:* ربح محقق على الجزء المباع بنسبة \`${formatNumber(
        partialPnlPercent
    )}%\` 🟢.\n`;
    msg += ` ▪️ *حالة المركز:* لا يزال المركز مفتوحًا بالكمية المتبقية.\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*ملاحظات:*\nخطوة استباقية لإدارة المخاطر وحماية رأس المال. نستمر في متابعة الأهداف الأعلى.\n`;
    msg += `#إدارة_مخاطر #${asset}`;
    return msg;
}
function formatPublicClose(details) {
    const { asset, pnlPercent, durationDays, avgBuyPrice, avgSellPrice } = details;
    const pnlSign = pnlPercent >= 0 ? "+" : "";
    const emoji = pnlPercent >= 0 ? "🟢" : "🔴";
    let msg = `*🏆 النتيجة النهائية لتوصية ${asset} ✅*\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*الأصل:* \`${asset}/USDT\`\n`;
    msg += `*الحالة:* **تم إغلاق الصفقة بالكامل.**\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*ملخص أداء التوصية:*\n`;
    msg += ` ▪️ **متوسط سعر الدخول:** \`$${formatNumber(avgBuyPrice, 4)}\`\n`;
    msg += ` ▪️ **متوسط سعر الخروج:** \`$${formatNumber(avgSellPrice, 4)}\`\n`;
    msg += ` ▪️ **العائد النهائي على الاستثمار (ROI):** \`${pnlSign}${formatNumber(
        pnlPercent
    )}%\` ${emoji}\n`;
    msg += ` ▪️ **مدة التوصية:** \`${formatNumber(durationDays, 1)} يوم\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*الخلاصة:*\n`;
    if (pnlPercent >= 0) {
        msg += `صفقة موفقة أثبتت أن الصبر على التحليل يؤتي ثماره.\n`;
    } else {
        msg += `الخروج بانضباط وفقًا للخطة هو نجاح بحد ذاته. نحافظ على رأس المال للفرصة القادمة.\n`;
    }
    msg += `\nنبارك لمن اتبع التوصية. نستعد الآن للبحث عن الفرصة التالية.\n`;
    msg += `#نتائجتوصيات #${asset}`;
    return msg;
}

// النسخة المعدلة بالكامل بهذه الرسالة
async function formatPortfolioMsg(assets, total, capital) {
    const positions = await loadPositions();

    // الأداء اليومي 24س
    let dailyPnlText = " ▫️ *الأداء اليومي (24س):* `لا توجد بيانات كافية`\n";
    let totalValue24hAgo = 0;
    assets.forEach((asset) => {
        if (asset.asset === "USDT") totalValue24hAgo += asset.value;
        else if (asset.change24h !== undefined && asset.price > 0)
            totalValue24hAgo += asset.amount * (asset.price / (1 + asset.change24h));
        else totalValue24hAgo += asset.value;
    });
    if (totalValue24hAgo > 0) {
        const dailyPnl = total - totalValue24hAgo;
        const dailyPnlPercent = (dailyPnl / totalValue24hAgo) * 100;
        const sign = dailyPnl >= 0 ? "+" : "";
        dailyPnlText = ` ▫️ *الأداء اليومي (24س):* ${
            dailyPnl >= 0 ? "🟢⬆️" : "🔴⬇️"
        } \`${sign}${formatNumber(dailyPnl)}\` (\`${sign}${formatNumber(
            dailyPnlPercent
        )}%\`)\n`;
    }

    // الربح/الخسارة الكلي غير المحقق
    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    const pnlSign = pnl >= 0 ? "+" : "";

    // السيولة
    const usdtValue = (assets.find((a) => a.asset === "USDT") || { value: 0 }).value;
    const cashPercent = total > 0 ? (usdtValue / total) * 100 : 0;
    const liquidityText = ` ▫️ *السيولة:* 💵 نقدي ${formatNumber(
        cashPercent,
        1
    )}% / 📈 مستثمر ${formatNumber(100 - cashPercent, 1)}%`;

    // رأس التقرير
    let msg = `🧾 *التقرير التحليلي للمحفظة*\n\n`;
    msg += `*بتاريخ: ${new Date().toLocaleString("ar-EG", {
        timeZone: "Africa/Cairo",
    })}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n*نظرة عامة على الأداء:*\n`;
    msg += ` ▫️ *القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`;
    msg += ` ▫️ *رأس المال:* \`$${formatNumber(capital)}\`\n`;
    msg += ` ▫️ *إجمالي الربح غير المحقق:* ${
        pnl >= 0 ? "🟢⬆️" : "🔴⬇️"
    } \`${pnlSign}${formatNumber(pnl)}\` (\`${pnlSign}${formatNumber(
        pnlPercent
    )}%\`)\n`;
    msg += dailyPnlText + liquidityText + `\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*مكونات المحفظة:*\n`;

    // تفاصيل الأصول
    assets.forEach((a, index) => {
        const percent = total > 0 ? (a.value / total) * 100 : 0;
        msg += "\n";

        if (a.asset === "USDT") {
            // USDT كرصيد نقدي
            msg += `*USDT* (الرصيد النقدي) 💵\n`;
            msg += `*القيمة:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(
                percent
            )}%\`)`;
        } else {
            // ترتيب العرض: سعر السوق -> متوسط الشراء -> الأداء اليومي -> ربح/خسارة غير محققة -> القيمة الحالية+الوزن
            const change24hPercent = (a.change24h || 0) * 100;
            const changeEmoji = change24hPercent >= 0 ? "🟢⬆️" : "🔴⬇️";
            const changeSign = change24hPercent >= 0 ? "+" : "";

            const position = positions[a.asset];

            msg += `╭─ *${a.asset}/USDT*\n`;

            // 1) سعر السوق
            msg += `├─ *سعر السوق:* \`$${formatNumber(a.price, 4)}\`\n`;

            // 2) متوسط الشراء
            if (position?.avgBuyPrice > 0) {
                msg += `├─ *متوسط الشراء:* \`$${formatNumber(
                    position.avgBuyPrice,
                    4
                )}\`\n`;
            } else {
                msg += `├─ *متوسط الشراء:* \`غير مسجل\`\n`;
            }

            // 3) الأداء اليومي
            msg += `├─ *الأداء اليومي:* ${changeEmoji} \`${changeSign}${formatNumber(
                change24hPercent
            )}%\`\n`;

            // 4) ربح/خسارة غير محققة
            if (position?.avgBuyPrice > 0) {
                const totalCost = position.avgBuyPrice * a.amount;
                const assetPnl = a.value - totalCost;
                const assetPnlPercent = totalCost > 0 ? (assetPnl / totalCost) * 100 : 0;
                const pnlEmoji = assetPnl >= 0 ? "🟢" : "🔴";
                const pnlSignAsset = assetPnl >= 0 ? "+" : "";
                msg += `├─ *ربح/خسارة غير محققة:* ${pnlEmoji} \`${pnlSignAsset}${formatNumber(
                    assetPnl
                )}\` (\`${pnlSignAsset}${formatNumber(assetPnlPercent)}%\`)\n`;
            } else {
                msg += `├─ *ربح/خسارة غير محققة:* \`غير متاح\`\n`;
            }

            // السطر الختامي: القيمة الحالية + الوزن
            msg += `╰─ *القيمة الحالية:* \`$${formatNumber(
                a.value
            )}\` (*الوزن:* \`${formatNumber(percent)}%\`)`;
        }

        if (index < assets.length - 1) msg += `\n━━━━━━━━━━━━━━━━━━━━`;
    });

    return msg;
}

async function formatAdvancedMarketAnalysis() {
    const prices = await okxAdapter.getMarketPrices();
    if (!prices || prices.error) return `❌ فشل جلب بيانات السوق. ${prices.error || ""}`;
    const marketData = Object.entries(prices)
        .map(([instId, data]) => ({ instId, ...data }))
        .filter((d) => d.volCcy24h > 10000 && d.change24h !== undefined);
    marketData.sort((a, b) => b.change24h - a.change24h);
    const topGainers = marketData.slice(0, 5);
    const topLosers = marketData.slice(-5).reverse();
    marketData.sort((a, b) => b.volCcy24h - a.volCcy24h);
    const highVolume = marketData.slice(0, 5);
    let msg = `🚀 *تحليل السوق المتقدم (OKX)* | ${new Date().toLocaleDateString(
        "ar-EG"
    )}\n━━━━━━━━━━━━━━━━━━━\n\n`;
    msg +=
        "📈 *أكبر الرابحين (24س):*\n" +
        topGainers
            .map((c) => ` - \`${c.instId}\`: \`+${formatNumber(c.change24h * 100)}%\``)
            .join("\n") +
        "\n\n";
    msg +=
        "📉 *أكبر الخاسرين (24س):*\n" +
        topLosers
            .map((c) => ` - \`${c.instId}\`: \`${formatNumber(c.change24h * 100)}%\``)
            .join("\n") +
        "\n\n";
    msg +=
        "📊 *الأعلى في حجم التداول:*\n" +
        highVolume
            .map(
                (c) => ` - \`${c.instId}\`: \`${(c.volCcy24h / 1e6).toFixed(2)}M\` USDT`
            )
            .join("\n") +
        "\n\n";
    msg +=
        "💡 *توصية:* راقب الأصول ذات حجم التداول المرتفع، فهي غالبًا ما تقود اتجاه السوق.";
    return msg;
}
async function formatQuickStats(assets, total, capital) {
    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    const statusEmoji = pnl >= 0 ? "🟢" : "🔴";
    const statusText = pnl >= 0 ? "ربح" : "خسارة";
    let msg = "⚡ *إحصائيات سريعة*\n\n";
    msg += `💎 *إجمالي الأصول:* \`${assets.filter((a) => a.asset !== "USDT").length}\`\n`;
    msg += `💰 *القيمة الحالية:* \`$${formatNumber(total)}\`\n`;
    msg += `📈 *نسبة الربح/الخسارة:* \`${formatNumber(pnlPercent)}%\`\n`;
    msg += `🎯 *الحالة:* ${statusEmoji} ${statusText}\n\n`;
    msg += `⏰ *آخر تحديث:* ${new Date().toLocaleTimeString("ar-EG")}`;
    return msg;
}

// =================================================================
// SECTION 4: BACKGROUND JOBS & DYNAMIC MANAGEMENT
// =================================================================
async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount, oldTotalValue) {
    if (!asset || price === undefined || price === null || isNaN(price))
        return { analysisResult: null };
    const positions = await loadPositions();
    let position = positions[asset];
    let analysisResult = { type: "none", data: {} };

    if (amountChange > 0) {
        // Buy
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
                trades: [],
            };
        } else {
            position.totalAmountBought += amountChange;
            position.totalCost += tradeValue;
            position.avgBuyPrice = position.totalCost / position.totalAmountBought;
        }
        analysisResult.type = "buy";
    } else if (amountChange < 0 && position) {
        // Sell
        const soldAmount = Math.abs(amountChange);
        position.realizedValue += soldAmount * price;
        position.totalAmountSold += soldAmount;

        const exitQuantityPercent =
            position.totalAmountBought > 0
                ? (soldAmount / position.totalAmountBought) * 100
                : 0;

        if (newTotalAmount * price < 1) {
            // Position closed
            const finalPnl = position.realizedValue - position.totalCost;
            const finalPnlPercent = position.totalCost > 0 ? (finalPnl / position.totalCost) * 100 : 0;
            const closeDate = new Date();
            const openDate = new Date(position.openDate);
            const durationDays =
                (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24);
            const avgSellPrice =
                position.totalAmountSold > 0
                    ? position.realizedValue / position.totalAmountSold
                    : 0;

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
            };

            await saveClosedTrade(closeReportData);
            analysisResult = { type: "close", data: closeReportData };
            delete positions[asset];
        } else {
            // Partial sell (log)
            const tempPnlPercent =
                position.avgBuyPrice > 0
                    ? ((price - position.avgBuyPrice) / position.avgBuyPrice) * 100
                    : 0;
            const partialCloseData = {
                asset,
                pnlPercent: tempPnlPercent,
                avgBuyPrice: position.avgBuyPrice,
                avgSellPrice: price,
                entryCapitalPercent: position.entryCapitalPercent,
                exitQuantityPercent: exitQuantityPercent,
            };
            await saveClosedTrade(partialCloseData);
            analysisResult.type = "sell";
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
        const oldTotalValue = previousState.totalValue || 0;
        const oldUsdtValue = previousBalances["USDT"] || 0;

        const currentBalance = await okxAdapter.getBalanceForComparison();
        if (!currentBalance) {
            await sendDebugMessage("Could not fetch current balance.");
            return;
        }
        const prices = await okxAdapter.getMarketPrices();
        if (!prices || prices.error) {
            await sendDebugMessage("Could not fetch market prices.");
            return;
        }
        const {
            assets: newAssets,
            total: newTotalValue,
            usdtValue: newUsdtValue,
            error,
        } = await okxAdapter.getPortfolio(prices);
        if (error || newTotalValue === undefined) {
            await sendDebugMessage(`Portfolio fetch error: ${error}`);
            return;
        }
        if (Object.keys(previousBalances).length === 0) {
            await sendDebugMessage("Initializing first balance state.");
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue });
            return;
        }

        const allAssets = new Set([
            ...Object.keys(previousBalances),
            ...Object.keys(currentBalance),
        ]);
        let stateNeedsUpdate = false;

        for (const asset of allAssets) {
            if (asset === "USDT") continue;
            const prevAmount = previousBalances[asset] || 0;
            const currAmount = currentBalance[asset] || 0;
            const difference = currAmount - prevAmount;
            const priceData = prices[`${asset}-USDT`];

            if (
                !priceData ||
                !priceData.price ||
                isNaN(priceData.price) ||
                Math.abs(difference * priceData.price) < 1
            )
                continue;

            await sendDebugMessage(`Detected change for ${asset}: ${difference}`);
            stateNeedsUpdate = true;

            const { analysisResult } = await updatePositionAndAnalyze(
                asset,
                difference,
                priceData.price,
                currAmount,
                oldTotalValue
            );
            if (analysisResult.type === "none") continue;

            const tradeValue = Math.abs(difference) * priceData.price;
            const newAssetData = newAssets.find((a) => a.asset === asset);
            const newAssetValue = newAssetData ? newAssetData.value : 0;
            const newAssetWeight =
                newTotalValue > 0 ? (newAssetValue / newTotalValue) * 100 : 0;
            const newCashPercent =
                newTotalValue > 0 ? (newUsdtValue / newTotalValue) * 100 : 0;

            const baseDetails = {
                asset,
                price: priceData.price,
                amountChange: difference,
                tradeValue,
                oldTotalValue,
                newAssetWeight,
                newUsdtValue,
                newCashPercent,
                oldUsdtValue,
                position: analysisResult.data.position,
            };

            const settings = await loadSettings();
            let privateMessage, publicMessage;

            if (analysisResult.type === "buy") {
                privateMessage = formatPrivateBuy(baseDetails);
                publicMessage = formatPublicBuy(baseDetails);
                await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, {
                    parse_mode: "Markdown",
                });
                if (settings.autoPostToChannel) {
                    await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, {
                        parse_mode: "Markdown",
                    });
                }
            } else if (analysisResult.type === "sell") {
                privateMessage = formatPrivateSell(baseDetails);
                publicMessage = formatPublicSell(baseDetails);
                await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, {
                    parse_mode: "Markdown",
                });
                if (settings.autoPostToChannel) {
                    await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, {
                        parse_mode: "Markdown",
                    });
                }
            } else if (analysisResult.type === "close") {
                privateMessage = formatPrivateCloseReport(analysisResult.data);
                publicMessage = formatPublicClose(analysisResult.data);
                if (settings.autoPostToChannel) {
                    await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, {
                        parse_mode: "Markdown",
                    });
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, {
                        parse_mode: "Markdown",
                    });
                } else {
                    const confirmationKeyboard = new InlineKeyboard()
                        .text("✅ نعم، انشر التقرير", "publish_report")
                        .text("❌ لا، تجاهل", "ignore_report");
                    const hiddenMarker = `\n<report>${JSON.stringify(publicMessage)}</report>`;
                    const confirmationMessage = `*تم إغلاق المركز بنجاح. هل تود نشر الملخص في القناة؟*\n\n${privateMessage}${hiddenMarker}`;
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, confirmationMessage, {
                        parse_mode: "Markdown",
                        reply_markup: confirmationKeyboard,
                    });
                }
            }
        }

        if (stateNeedsUpdate) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue });
            await sendDebugMessage("State updated after balance change.");
        } else {
            await sendDebugMessage("No significant balance changes detected.");
        }
    } catch (e) {
        console.error("CRITICAL ERROR in monitorBalanceChanges:", e);
        await sendDebugMessage(`CRITICAL ERROR in monitorBalanceChanges: ${e.message}`);
    }
}

async function trackPositionHighLow() {
    try {
        const positions = await loadPositions();
        if (Object.keys(positions).length === 0) return;

        const prices = await okxAdapter.getMarketPrices();
        if (!prices || prices.error) return;

        let positionsUpdated = false;
        for (const symbol in positions) {
            const position = positions[symbol];
            const currentPrice = prices[`${symbol}-USDT`]?.price;
            if (currentPrice) {
                if (!position.highestPrice || currentPrice > position.highestPrice) {
                    position.highestPrice = currentPrice;
                    positionsUpdated = true;
                }
                if (!position.lowestPrice || currentPrice < position.lowestPrice) {
                    position.lowestPrice = currentPrice;
                    positionsUpdated = true;
                }
            }
        }
        if (positionsUpdated) {
            await savePositions(positions);
            await sendDebugMessage("Updated position high/low prices.");
        }
    } catch (e) {
        console.error("CRITICAL ERROR in trackPositionHighLow:", e);
    }
}

async function checkPriceAlerts() {
    try {
        const alerts = await loadAlerts();
        if (alerts.length === 0) return;
        const prices = await okxAdapter.getMarketPrices();
        if (!prices || prices.error) return;

        const remainingAlerts = [];
        let triggered = false;
        for (const alert of alerts) {
            const currentPrice = prices[alert.instId]?.price;
            if (currentPrice === undefined) {
                remainingAlerts.push(alert);
                continue;
            }
            if (
                (alert.condition === ">" && currentPrice > alert.price) ||
                (alert.condition === "<" && currentPrice < alert.price)
            ) {
                await bot.api.sendMessage(
                    AUTHORIZED_USER_ID,
                    `🚨 *تنبيه سعر!* \`${alert.instId}\`\nالشرط: ${alert.condition} ${alert.price}\nالسعر الحالي: \`${currentPrice}\``,
                    { parse_mode: "Markdown" }
                );
                triggered = true;
            } else {
                remainingAlerts.push(alert);
            }
        }
        if (triggered) await saveAlerts(remainingAlerts);
    } catch (error) {
        console.error("Error in checkPriceAlerts:", error);
    }
}

async function checkPriceMovements() {
    try {
        await sendDebugMessage("Checking price movements...");
        const alertSettings = await loadAlertSettings();
        const priceTracker = await loadPriceTracker();
        const prices = await okxAdapter.getMarketPrices();
        if (!prices || prices.error) return;

        const { assets, total: currentTotalValue, error } = await okxAdapter.getPortfolio(prices);
        if (error || currentTotalValue === undefined) return;

        if (priceTracker.totalPortfolioValue === 0) {
            priceTracker.totalPortfolioValue = currentTotalValue;
            assets.forEach((a) => {
                if (a.price) priceTracker.assets[a.asset] = a.price;
            });
            await savePriceTracker(priceTracker);
            return;
        }

        let trackerUpdated = false;
        for (const asset of assets) {
            if (asset.asset === "USDT" || !asset.price) continue;
            const lastPrice = priceTracker.assets[asset.asset];
            if (lastPrice) {
                const changePercent = ((asset.price - lastPrice) / lastPrice) * 100;
                const threshold =
                    alertSettings.overrides[asset.asset] || alertSettings.global;
                if (Math.abs(changePercent) >= threshold) {
                    const movementText = changePercent > 0 ? "صعود" : "هبوط";
                    const message = `📈 *تنبيه حركة سعر لأصل!* \`${asset.asset}\`\n*الحركة:* ${movementText} بنسبة \`${formatNumber(
                        changePercent
                    )}%\`\n*السعر الحالي:* \`$${formatNumber(asset.price, 4)}\``;
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, message, {
                        parse_mode: "Markdown",
                    });
                    priceTracker.assets[asset.asset] = asset.price;
                    trackerUpdated = true;
                }
            } else {
                priceTracker.assets[asset.asset] = asset.price;
                trackerUpdated = true;
            }
        }
        if (trackerUpdated) await savePriceTracker(priceTracker);
    } catch (e) {
        console.error("CRITICAL ERROR in checkPriceMovements:", e);
    }
}

async function runDailyJobs() {
    try {
        const settings = await loadSettings();
        if (!settings.dailySummary) return;

        const prices = await okxAdapter.getMarketPrices();
        if (!prices || prices.error) return;

        const { total } = await okxAdapter.getPortfolio(prices);
        if (total === undefined) return;

        const history = await loadHistory();
        const date = new Date().toISOString().slice(0, 10);
        const todayIndex = history.findIndex((h) => h.date === date);
        if (todayIndex > -1) history[todayIndex].total = total;
        else history.push({ date, total });

        if (history.length > 35) history.shift();
        await saveHistory(history);

        console.log(`[Daily Summary Recorded]: ${date} - $${formatNumber(total)}`);
    } catch (e) {
        console.error("CRITICAL ERROR in runDailyJobs:", e);
    }
}

async function runHourlyJobs() {
    try {
        const prices = await okxAdapter.getMarketPrices();
        if (!prices || prices.error) return;
        const { total } = await okxAdapter.getPortfolio(prices);
        if (total === undefined) return;

        const history = await loadHourlyHistory();
        const hourLabel = new Date().toISOString().slice(0, 13);
        const existingIndex = history.findIndex((h) => h.label === hourLabel);
        if (existingIndex > -1) history[existingIndex].total = total;
        else history.push({ label: hourLabel, total });

        if (history.length > 72) history.splice(0, history.length - 72);
        await saveHourlyHistory(history);
    } catch (e) {
        console.error("Error in hourly jobs:", e);
    }
}

async function monitorVirtualTrades() {
    const activeTrades = await getActiveVirtualTrades();
    if (activeTrades.length === 0) return;

    const prices = await okxAdapter.getMarketPrices();
    if (!prices || prices.error) return;

    for (const trade of activeTrades) {
        const currentPrice = prices[trade.instId]?.price;
        if (!currentPrice) continue;

        let finalStatus = null;
        let pnl = 0;
        let finalPrice = 0;

        if (currentPrice >= trade.targetPrice) {
            finalPrice = trade.targetPrice;
            pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
            finalStatus = "completed";
            const profitPercent =
                trade.virtualAmount > 0 ? (pnl / trade.virtualAmount) * 100 : 0;
            const msg =
                `🎯 *الهدف تحقق (توصية افتراضية)!* ✅\n\n` +
                `*العملة:* \`${trade.instId}\`\n` +
                `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` +
                `*سعر الهدف:* \`$${formatNumber(trade.targetPrice, 4)}\`\n\n` +
                `💰 *الربح المحقق:* \`+$${formatNumber(pnl)}\` (\`+${formatNumber(
                    profitPercent
                )}%\`)`;
            await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
        } else if (currentPrice <= trade.stopLossPrice) {
            finalPrice = trade.stopLossPrice;
            pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
            finalStatus = "stopped";
            const lossPercent =
                trade.virtualAmount > 0 ? (pnl / trade.virtualAmount) * 100 : 0;
            const msg =
                `🛑 *تم تفعيل وقف الخسارة (توصية افتراضية)!* 🔻\n\n` +
                `*العملة:* \`${trade.instId}\`\n` +
                `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` +
                `*سعر الوقف:* \`$${formatNumber(trade.stopLossPrice, 4)}\`\n\n` +
                `💸 *الخسارة:* \`$${formatNumber(pnl)}\` (\`${formatNumber(lossPercent)}%\`)`;
            await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
        }

        if (finalStatus) {
            await updateVirtualTradeStatus(trade._id, finalStatus, finalPrice);
        }
    }
}

// =================================================================
// SECTION 4.5: NEW DAILY COPY-TRADING REPORT
// (اترك دالتك الحالية كما هي إن كانت تعمل لديك، أو أضف نسختك المفضلة)
// =================================================================
async function formatDailyCopyReport() {
    try {
        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const closedTrades = await getCollection("tradeHistory").find({
            closedAt: { $gte: twentyFourHoursAgo, $lte: now },
        }).toArray();

        const reportDate = new Date().toLocaleDateString("ar-EG", { timeZone: "Africa/Cairo" });

        if (!closedTrades || closedTrades.length === 0) {
            return [
                "📊 تقرير النسخ اليومي – خلال الـ24 ساعة الماضية",
                `🗓 التاريخ: ${reportDate}`,
                "",
                "لا توجد صفقات خلال آخر 24 ساعة.",
                "",
                "✍️ يمكنك الدخول في اي وقت تراه مناسب، الخدمة مفتوحة للجميع",
                "",
                "📢 قناة التحديثات الرسمية:",
                "@RahhalVIP",
                "",
                "🌐 رابط النسخ المباشر:",
                "🏦"
            ].join("\n");
        }

        const lines = [];
        let weightedSum = 0, weightTotal = 0, simpleSum = 0, simpleCount = 0;

        for (const t of closedTrades) {
            const asset = t.asset || "-";
            const entryCap = Number(t.entryCapitalPercent) || 0;
            const avgBuy = Number(t.avgBuyPrice) || 0;
            const exit = Number(t.avgSellPrice) || 0;
            const exitQty = Number(t.exitQuantityPercent);
            const roi = Number(t.pnlPercent);

            lines.push(
                `🔸اسم العملة: ${asset}`,
                `🔸 نسبة الدخول من رأس المال: ${entryCap.toFixed(2)}%`,
                `🔸 متوسط سعر الشراء: ${avgBuy > 0 ? avgBuy.toFixed(4) : "0.0000"}`,
                `🔸 سعر الخروج: ${exit > 0 ? exit.toFixed(4) : "0.0000"}`,
                `🔸 نسبة الخروج من الكمية: ${(isFinite(exitQty) ? exitQty : 100).toFixed(2)}%`,
                `🔸 النتيجة: ${roi >= 0 ? "+" : ""}${(isFinite(roi) ? roi : 0).toFixed(2)}% ${roi >= 0 ? "🔼" : "🔽"}`,
                ""
            );

            if (isFinite(entryCap) && entryCap > 0 && isFinite(roi)) {
                weightedSum += entryCap * roi;
                weightTotal += entryCap;
            }
            if (isFinite(roi)) {
                simpleSum += roi;
                simpleCount += 1;
            }
        }

        let totalRoi = 0;
        if (weightTotal > 0) totalRoi = weightedSum / weightTotal;
        else if (simpleCount > 0) totalRoi = simpleSum / simpleCount;

        const header = [
            "📊 تقرير النسخ اليومي – خلال الـ24 ساعة الماضية",
            `🗓 التاريخ: ${reportDate}`,
            ""
        ].join("\n");

        const footer = [
            `إجمالي الربح الحالي خدمة النسخ: ${totalRoi >= 0 ? "+" : ""}${totalRoi.toFixed(2)}% ${totalRoi >= 0 ? "📈" : "📉"}`,
            "",
            "✍️ يمكنك الدخول في اي وقت تراه مناسب، الخدمة مفتوحة للجميع",
            "",
            "📢 قناة التحديثات الرسمية:",
            "@RahhalVIP",
            "",
            "🌐 رابط النسخ المباشر:",
            "🏦"
        ].join("\n");

        return [header, ...lines, footer].join("\n").trim();
    } catch (e) {
        console.error("Error in formatDailyCopyReport:", e);
        const reportDate = new Date().toLocaleDateString("ar-EG", { timeZone: "Africa/Cairo" });
        return [
            "📊 تقرير النسخ اليومي – خلال الـ24 ساعة الماضية",
            `🗓 التاريخ: ${reportDate}`,
            "",
            "حدث خطأ مؤقت أثناء إنشاء التقرير.",
            "",
            "✍️ يمكنك الدخول في اي وقت تراه مناسب، الخدمة مفتوحة للجميع",
            "",
            "📢 قناة التحديثات الرسمية:",
            "@RahhalVIP",
            "",
            "🌐 رابط النسخ المباشر:",
            "🏦"
        ].join("\n");
    }
}

// يمكنك الإبقاء على بقية ربط البوت والسيرفر لديك كما هو.
// مثال تشغيل أساسي (إن كنت تستخدم Webhook أو Long Polling عدله حسب إعداداتك):
app.get("/", (req, res) => res.send("Bot is running."));
app.listen(PORT, async () => {
    try {
        await connectDB();
        console.log(`Server listening on :${PORT}`);
    } catch (e) {
        console.error("DB connection failed:", e);
    }
});
