// =================================================================
// Advanced Analytics Bot - v143.4 (Fully Sanitized & Stable)
// =================================================================
// --- IMPORTS ---
const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const WebSocket = require('ws');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();
const { connectDB, getDB } = require("./database.js");

// =================================================================
// SECTION 0: CONFIGURATION & SETUP
// =================================================================

// --- Bot Configuration ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OKX_CONFIG = {
    apiKey: process.env.OKX_API_KEY,
    apiSecret: process.env.OKX_API_SECRET_KEY,
    passphrase: process.env.OKX_API_PASSPHRASE,
};
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;

// --- Bot & App Initialization ---
const app = express();
const bot = new Bot(BOT_TOKEN);

// --- State & Cache Variables ---
let waitingState = null;
let marketCache = { data: null, ts: 0 };
let isProcessingBalance = false;

// --- AI Setup ---
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

// =================================================================
// SECTION 1: OKX API ADAPTER & CACHING
// =================================================================

async function getCachedMarketPrices(ttlMs = 15000) {
    const now = Date.now();
    if (marketCache.data && now - marketCache.ts < ttlMs) {
        return marketCache.data;
    }
    const data = await okxAdapter.getMarketPrices();
    if (!data.error) {
        marketCache = { data, ts: now };
    }
    return data;
}

class OKXAdapter {
    constructor(config) {
        this.name = "OKX";
        this.baseURL = "https://www.okx.com";
        this.config = config;
    }

    getHeaders(method, path, body = "") {
        const timestamp = new Date().toISOString();
        const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body);
        const sign = crypto.createHmac("sha256", this.config.apiSecret).update(prehash).digest("base64");
        return {
            "OK-ACCESS-KEY": this.config.apiKey,
            "OK-ACCESS-SIGN": sign,
            "OK-ACCESS-TIMESTAMP": timestamp,
            "OK-ACCESS-PASSPHRASE": this.config.passphrase,
            "Content-Type": "application/json",
        };
    }

    async getMarketPrices() {
        try {
            const res = await fetch(`${this.baseURL}/api/v5/market/tickers?instType=SPOT`);
            const json = await res.json();
            if (json.code !== '0') {
                return { error: `فشل جلب أسعار السوق: ${json.msg}` };
            }
            const prices = {};
            json.data.forEach(t => {
                if (t.instId.endsWith('-USDT')) {
                    const lastPrice = parseFloat(t.last);
                    const openPrice = parseFloat(t.open24h);
                    let change24h = 0;
                    if (openPrice > 0) {
                        change24h = (lastPrice - openPrice) / openPrice;
                    }
                    prices[t.instId] = {
                        price: lastPrice,
                        open24h: openPrice,
                        change24h,
                        volCcy24h: parseFloat(t.volCcy24h)
                    };
                }
            });
            return prices;
        } catch (error) {
            console.error("OKXAdapter getMarketPrices Error:", error);
            return { error: "خطأ في الاتصال بالشبكة عند جلب أسعار السوق." };
        }
    }

    async getPortfolio(prices) {
        try {
            const path = "/api/v5/account/balance";
            const res = await fetch(`${this.baseURL}${path}`, { headers: this.getHeaders("GET", path) });
            const json = await res.json();
            if (json.code !== '0' || !json.data?.[0]?.details) {
                return { error: `فشل جلب المحفظة: ${json.msg || 'بيانات غير متوقعة'}` };
            }
            let assets = [];
            let total = 0;
            let usdtValue = 0;
            json.data[0].details.forEach(asset => {
                const amount = parseFloat(asset.eq);
                if (amount > 0) {
                    const instId = `${asset.ccy}-USDT`;
                    const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0, open24h: (asset.ccy === "USDT" ? 1 : 0) };
                    const value = amount * priceData.price;
                    total += value;
                    if (asset.ccy === "USDT") usdtValue = value;
                    if (value >= 1) {
                        assets.push({ asset: asset.ccy, price: priceData.price, value, amount, change24h: priceData.change24h, open24h: priceData.open24h });
                    }
                }
            });
            assets.sort((a, b) => b.value - a.value);
            return { assets, total, usdtValue };
        } catch (e) {
            console.error("OKXAdapter getPortfolio Error:", e);
            return { error: "خطأ في الاتصال بمنصة OKX." };
        }
    }

    async getBalanceForComparison() {
        try {
            const path = "/api/v5/account/balance";
            const res = await fetch(`${this.baseURL}${path}`, { headers: this.getHeaders("GET", path) });
            const json = await res.json();
            if (json.code !== '0' || !json.data?.[0]?.details) {
                return null;
            }
            const balances = {};
            json.data[0].details.forEach(asset => {
                const amount = parseFloat(asset.eq);
                if (amount > 0) balances[asset.ccy] = amount;
            });
            return balances;
        } catch (e) {
            console.error("OKXAdapter getBalanceForComparison Error:", e);
            return null;
        }
    }
}
const okxAdapter = new OKXAdapter(OKX_CONFIG);

// =================================================================
// SECTION 2: DATABASE & HELPER FUNCTIONS
// =================================================================
const getCollection = (collectionName) => getDB().collection(collectionName);
const getConfig = async (id, defaultValue = {}) => { try { const doc = await getCollection("configs").findOne({ _id: id }); return doc ? doc.data : defaultValue; } catch (e) { return defaultValue; } };
const saveConfig = async (id, data) => { try { await getCollection("configs").updateOne({ _id: id }, { $set: { data } }, { upsert: true }); } catch (e) { console.error(`Error in saveConfig for id: ${id}`, e); } };
const saveClosedTrade = async (tradeData) => { try { await getCollection("tradeHistory").insertOne({ ...tradeData, closedAt: new Date(), _id: crypto.randomBytes(16).toString("hex") }); } catch (e) { console.error("Error in saveClosedTrade:", e); } };
const getHistoricalPerformance = async (asset) => { try { const history = await getCollection("tradeHistory").find({ asset: asset }).toArray(); if (history.length === 0) return { realizedPnl: 0, tradeCount: 0, winningTrades: 0, losingTrades: 0, avgDuration: 0 }; const realizedPnl = history.reduce((sum, trade) => sum + (trade.pnl || 0), 0); const winningTrades = history.filter(trade => (trade.pnl || 0) > 0).length; const losingTrades = history.filter(trade => (trade.pnl || 0) <= 0).length; const totalDuration = history.reduce((sum, trade) => sum + (trade.durationDays || 0), 0); const avgDuration = history.length > 0 ? totalDuration / history.length : 0; return { realizedPnl, tradeCount: history.length, winningTrades, losingTrades, avgDuration }; } catch (e) { return { realizedPnl: 0, tradeCount: 0, winningTrades: 0, losingTrades: 0, avgDuration: 0 }; } };
const saveVirtualTrade = async (tradeData) => { try { const tradeWithId = { ...tradeData, _id: crypto.randomBytes(16).toString("hex") }; await getCollection("virtualTrades").insertOne(tradeWithId); return tradeWithId; } catch (e) { console.error("Error saving virtual trade:", e); } };
const getActiveVirtualTrades = async () => { try { return await getCollection("virtualTrades").find({ status: 'active' }).toArray(); } catch (e) { return []; } };
const updateVirtualTradeStatus = async (tradeId, status, finalPrice) => { try { await getCollection("virtualTrades").updateOne({ _id: tradeId }, { $set: { status: status, closePrice: finalPrice, closedAt: new Date() } }); } catch (e) { console.error(`Error updating virtual trade ${tradeId}:`, e); } };

// --- Simplified Config Helpers ---
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
const saveAlerts = (alerts) => saveConfig("alerts", alerts);
const loadAlertSettings = async () => await getConfig("alertSettings", { global: 5, overrides: {} });
const saveAlertSettings = (settings) => saveConfig("alertSettings", settings);
const loadPriceTracker = async () => await getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => saveConfig("priceTracker", tracker);

// --- Utility Functions ---
const formatNumber = (num, decimals = 2) => { const number = parseFloat(num); return isNaN(number) || !isFinite(number) ? (0).toFixed(decimals) : number.toFixed(decimals); };
function formatSmart(num) {
    const n = Number(num);
    if (!isFinite(n)) return "0.00";
    if (Math.abs(n) >= 1) return n.toFixed(2);
    if (Math.abs(n) >= 0.01) return n.toFixed(4);
    if (Math.abs(n) === 0) return "0.00";
    return n.toPrecision(4);
}

/**
 * ✅ **CRITICAL FIX FUNCTION**
 * This function escapes special characters in a string to make it safe for Telegram's MarkdownV2 parser.
 * It prevents the 'can't parse entities' error.
 * @param {string | number} text The text to sanitize.
 * @returns {string} The sanitized text.
 */
const sanitizeMarkdownV2 = (text) => {
    if (typeof text !== 'string' && typeof text !== 'number') return '';
    const charsToEscape = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
    let sanitizedText = String(text);
    for (const char of charsToEscape) {
        sanitizedText = sanitizedText.replace(new RegExp('\\' + char, 'g'), '\\' + char);
    }
    return sanitizedText;
};

const sendDebugMessage = async (message) => {
    const settings = await loadSettings();
    if (settings.debugMode) {
        try {
            // We sanitize the debug message itself to avoid errors in sending debug info
            const sanitizedMessage = sanitizeMarkdownV2(message);
            await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug \\(OKX\\):* ${sanitizedMessage}`, { parse_mode: "MarkdownV2" });
        } catch (e) {
            console.error("Failed to send debug message:", e);
        }
    }
};


// =================================================================
// SECTION 3: FORMATTING AND MESSAGE FUNCTIONS
// =================================================================
function formatClosedTradeReview(trade, currentPrice) { const { asset, avgBuyPrice, avgSellPrice, quantity, pnl: actualPnl, pnlPercent: actualPnlPercent } = trade; let msg = `*🔍 مراجعة صفقة مغلقة | ${sanitizeMarkdownV2(asset)}*\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n`; msg += `*ملاحظة: هذا تحليل "ماذا لو" لصفقة مغلقة، ولا يؤثر على محفظتك الحالية\\.*\n\n`; msg += `*ملخص الأسعار الرئيسي:*\n`; msg += `  \\- 💵 *سعر الشراء الأصلي:* \`$${sanitizeMarkdownV2(formatSmart(avgBuyPrice))}\`\n`; msg += `  \\- ✅ *سعر الإغلاق الفعلي:* \`$${sanitizeMarkdownV2(formatSmart(avgSellPrice))}\`\n`; msg += `  \\- 📈 *السعر الحالي للسوق:* \`$${sanitizeMarkdownV2(formatSmart(currentPrice))}\`\n\n`; const actualPnlSign = actualPnl >= 0 ? '+' : ''; const actualEmoji = actualPnl >= 0 ? '🟢' : '🔴'; msg += `*الأداء الفعلي للصفقة \\(عند الإغلاق\\):*\n`; msg += `  \\- *النتيجة:* \`${sanitizeMarkdownV2(actualPnlSign)}${sanitizeMarkdownV2(formatNumber(actualPnl))}\` ${actualEmoji}\n`; msg += `  \\- *نسبة العائد:* \`${sanitizeMarkdownV2(actualPnlSign)}${sanitizeMarkdownV2(formatNumber(actualPnlPercent))}%\`\n\n`; const hypotheticalPnl = (currentPrice - avgBuyPrice) * quantity; const hypotheticalPnlPercent = (avgBuyPrice > 0) ? (hypotheticalPnl / (avgBuyPrice * quantity)) * 100 : 0; const hypotheticalPnlSign = hypotheticalPnl >= 0 ? '+' : ''; const hypotheticalEmoji = hypotheticalPnl >= 0 ? '🟢' : '🔴'; msg += `*الأداء الافتراضي \\(لو بقيت الصفقة مفتوحة\\):*\n`; msg += `  \\- *النتيجة الحالية:* \`${sanitizeMarkdownV2(hypotheticalPnlSign)}${sanitizeMarkdownV2(formatNumber(hypotheticalPnl))}\` ${hypotheticalEmoji}\n`; msg += `  \\- *نسبة العائد الحالية:* \`${sanitizeMarkdownV2(hypotheticalPnlSign)}${sanitizeMarkdownV2(formatNumber(hypotheticalPnlPercent))}%\`\n\n`; const priceChangeSinceClose = currentPrice - avgSellPrice; const priceChangePercent = (avgSellPrice > 0) ? (priceChangeSinceClose / avgSellPrice) * 100 : 0; const changeSign = priceChangeSinceClose >= 0 ? '⬆️' : '⬇️'; msg += `*تحليل قرار الخروج:*\n`; msg += `  \\- *حركة السعر منذ الإغلاق:* \`${sanitizeMarkdownV2(formatNumber(priceChangePercent))}%\` ${changeSign}\n`; if (priceChangeSinceClose > 0) { msg += `  \\- *الخلاصة:* 📈 لقد واصل السعر الصعود بعد خروجك\\. كانت هناك فرصة لتحقيق ربح أكبر\\.\n`; } else { msg += `  \\- *الخلاصة:* ✅ لقد كان قرارك بالخروج صائبًا، حيث انخفض السعر بعد ذلك وتجنبت خسارة أو تراجع في الأرباح\\.\n`; } return msg; }
function formatPrivateBuy(details) { const { asset, price, amountChange, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; let msg = `*مراقبة الأصول 🔬:*\n**عملية استحواذ جديدة 🟢**\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `🔸 **الأصل المستهدف:** \`${sanitizeMarkdownV2(asset)}/USDT\`\n`; msg += `🔸 **نوع العملية:** تعزيز مركز / بناء مركز جديد\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`; msg += ` ▪️ **سعر التنفيذ:** \`$${sanitizeMarkdownV2(formatSmart(price))}\`\n`; msg += ` ▪️ **الكمية المضافة:** \`${sanitizeMarkdownV2(formatNumber(Math.abs(amountChange), 6))}\`\n`; msg += ` ▪️ **التكلفة الإجمالية للصفقة:** \`$${sanitizeMarkdownV2(formatNumber(tradeValue))}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*التأثير على هيكل المحفظة:*\n`; msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${sanitizeMarkdownV2(formatNumber(tradeSizePercent))}%\`\n`; msg += ` ▪️ **الوزن الجديد للأصل:** \`${sanitizeMarkdownV2(formatNumber(newAssetWeight))}%\`\n`; msg += ` ▪️ **السيولة المتبقية \\(USDT\\):** \`$${sanitizeMarkdownV2(formatNumber(newUsdtValue))}\`\n`; msg += ` ▪️ **مؤشر السيولة الحالي:** \`${sanitizeMarkdownV2(formatNumber(newCashPercent))}%\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${sanitizeMarkdownV2(new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }))}`; return msg; }
function formatPrivateSell(details) { const { asset, price, amountChange, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; let msg = `*مراقبة الأصول 🔬:*\n**مناورة تكتيكية 🟠**\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `🔸 **الأصل المستهدف:** \`${sanitizeMarkdownV2(asset)}/USDT\`\n`; msg += `🔸 **نوع العملية:** تخفيف المركز / جني أرباح جزئي\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`; msg += ` ▪️ **سعر التنفيذ:** \`$${sanitizeMarkdownV2(formatSmart(price))}\`\n`; msg += ` ▪️ **الكمية المخففة:** \`${sanitizeMarkdownV2(formatNumber(Math.abs(amountChange), 6))}\`\n`; msg += ` ▪️ **العائد الإجمالي للصفقة:** \`$${sanitizeMarkdownV2(formatNumber(tradeValue))}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*التأثير على هيكل المحفظة:*\n`; msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${sanitizeMarkdownV2(formatNumber(tradeSizePercent))}%\`\n`; msg += ` ▪️ **الوزن الجديد للأصل:** \`${sanitizeMarkdownV2(formatNumber(newAssetWeight))}%\`\n`; msg += ` ▪️ **السيولة الجديدة \\(USDT\\):** \`$${sanitizeMarkdownV2(formatNumber(newUsdtValue))}\`\n`; msg += ` ▪️ **مؤشر السيولة الحالي:** \`${sanitizeMarkdownV2(formatNumber(newCashPercent))}%\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${sanitizeMarkdownV2(new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }))}`; return msg; }
function formatPrivateCloseReport(details) {
    const { asset, avgBuyPrice, avgSellPrice, pnl, pnlPercent, durationDays, highestPrice, lowestPrice } = details;
    const pnlSign = pnl >= 0 ? '+' : '';
    const emoji = pnl >= 0 ? '🟢' : '🔴';
    
    let exitEfficiencyText = "";
    if (highestPrice && avgSellPrice && highestPrice > avgBuyPrice) {
        const potentialGain = highestPrice - avgBuyPrice;
        const actualGain = avgSellPrice - avgBuyPrice;
        if (potentialGain > 0) {
            const efficiency = (actualGain / potentialGain) * 100;
            exitEfficiencyText = ` ▪️ *كفاءة الخروج:* 📈 \`${sanitizeMarkdownV2(formatNumber(efficiency))}%\`\n`;
        }
    }

    let msg = `*ملف المهمة المكتملة 📂:*\n**تم إغلاق مركز ${sanitizeMarkdownV2(asset)} بنجاح ✅**\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*النتيجة النهائية للمهمة:*\n`;
    msg += ` ▪️ **الحالة:** **${pnl >= 0 ? "مربحة" : "خاسرة"}**\n`;
    msg += ` ▪️ **صافي الربح/الخسارة:** \`${sanitizeMarkdownV2(pnlSign)}${sanitizeMarkdownV2(formatNumber(pnl))}\` ${emoji}\n`;
    msg += ` ▪️ **نسبة العائد على الاستثمار \\(ROI\\):** \`${sanitizeMarkdownV2(pnlSign)}${sanitizeMarkdownV2(formatNumber(pnlPercent))}%\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*الجدول الزمني والأداء:*\n`;
    msg += ` ▪️ **مدة الاحتفاظ بالمركز:** \`${sanitizeMarkdownV2(formatNumber(durationDays, 1))} يوم\`\n`;
    msg += ` ▪️ **متوسط سعر الدخول:** \`$${sanitizeMarkdownV2(formatSmart(avgBuyPrice))}\`\n`;
    msg += ` ▪️ **متوسط سعر الخروج:** \`$${sanitizeMarkdownV2(formatSmart(avgSellPrice))}\`\n`;
    msg += ` ▪️ **أعلى قمة سعرية مسجلة:** \`$${sanitizeMarkdownV2(formatSmart(highestPrice))}\`\n`;
    msg += ` ▪️ **أدنى قاع سعري مسجل:** \`$${sanitizeMarkdownV2(formatSmart(lowestPrice))}\`\n`;
    msg += exitEfficiencyText;
    msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ الإغلاق:* ${sanitizeMarkdownV2(new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }))}`;
    return msg;
}
function formatPublicBuy(details) { const { asset, price, oldTotalValue, tradeValue, oldUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; const cashConsumedPercent = (oldUsdtValue > 0) ? (tradeValue / oldUsdtValue) * 100 : 0; let msg = `*💡 توصية جديدة: بناء مركز في ${sanitizeMarkdownV2(asset)} 🟢*\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*الأصل:* \`${sanitizeMarkdownV2(asset)}/USDT\`\n`; msg += `*سعر الدخول الحالي:* \`$${sanitizeMarkdownV2(formatSmart(price))}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*استراتيجية إدارة المحفظة:*\n`; msg += ` ▪️ *حجم الدخول:* تم تخصيص \`${sanitizeMarkdownV2(formatNumber(tradeSizePercent))}%\` من المحفظة لهذه الصفقة\\.\n`; msg += ` ▪️ *استهلاك السيولة:* استهلك هذا الدخول \`${sanitizeMarkdownV2(formatNumber(cashConsumedPercent))}%\` من السيولة النقدية المتاحة\\.\n`; msg += ` ▪️ *السيولة المتبقية:* بعد الصفقة، أصبحت السيولة تشكل \`${sanitizeMarkdownV2(formatNumber(newCashPercent))}%\` من المحفظة\\.\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*ملاحظات:*\nنرى في هذه المستويات فرصة واعدة\\. المراقبة مستمرة، وسنوافيكم بتحديثات إدارة الصفقة\\.\n`; msg += `#توصية #${sanitizeMarkdownV2(asset)}`; return msg; }
function formatPublicSell(details) { const { asset, price, amountChange, position } = details; const totalPositionAmountBeforeSale = position.totalAmountBought - (position.totalAmountSold - Math.abs(amountChange)); const soldPercent = totalPositionAmountBeforeSale > 0 ? (Math.abs(amountChange) / totalPositionAmountBeforeSale) * 100 : 0; const partialPnl = (price - position.avgBuyPrice); const partialPnlPercent = position.avgBuyPrice > 0 ? (partialPnl / position.avgBuyPrice) * 100 : 0; let msg = `*⚙️ تحديث التوصية: إدارة مركز ${sanitizeMarkdownV2(asset)} 🟠*\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*الأصل:* \`${sanitizeMarkdownV2(asset)}/USDT\`\n`; msg += `*سعر البيع الجزئي:* \`$${sanitizeMarkdownV2(formatSmart(price))}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*استراتيجية إدارة المحفظة:*\n`; msg += ` ▪️ *الإجراء:* تم بيع \`${sanitizeMarkdownV2(formatNumber(soldPercent))}%\` من مركزنا لتأمين الأرباح\\.\n`; msg += ` ▪️ *النتيجة:* ربح محقق على الجزء المباع بنسبة \`${sanitizeMarkdownV2(formatNumber(partialPnlPercent))}%\` 🟢\\.\n`; msg += ` ▪️ *حالة المركز:* لا يزال المركز مفتوحًا بالكمية المتبقية\\.\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*ملاحظات:*\nخطوة استباقية لإدارة المخاطر وحماية رأس المال\\. نستمر في متابعة الأهداف الأعلى\\.\n`; msg += `#إدارة_مخاطر #${sanitizeMarkdownV2(asset)}`; return msg; }
function formatPublicClose(details) { const { asset, pnlPercent, durationDays, avgBuyPrice, avgSellPrice } = details; const pnlSign = pnlPercent >= 0 ? '+' : ''; const emoji = pnlPercent >= 0 ? '🟢' : '🔴'; let msg = `*🏆 النتيجة النهائية لتوصية ${sanitizeMarkdownV2(asset)} ✅*\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*الأصل:* \`${sanitizeMarkdownV2(asset)}/USDT\`\n`; msg += `*الحالة:* **تم إغلاق الصفقة بالكامل\\.**\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*ملخص أداء التوصية:*\n`; msg += ` ▪️ **متوسط سعر الدخول:** \`$${sanitizeMarkdownV2(formatSmart(avgBuyPrice))}\`\n`; msg += ` ▪️ **متوسط سعر الخروج:** \`$${sanitizeMarkdownV2(formatSmart(avgSellPrice))}\`\n`; msg += ` ▪️ **العائد النهائي على الاستثمار \\(ROI\\):** \`${sanitizeMarkdownV2(pnlSign)}${sanitizeMarkdownV2(formatNumber(pnlPercent))}%\` ${emoji}\n`; msg += ` ▪️ **مدة التوصية:** \`${sanitizeMarkdownV2(formatNumber(durationDays, 1))} يوم\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*الخلاصة:*\n`; if (pnlPercent >= 0) { msg += `صفقة موفقة أثبتت أن الصبر على التحليل يؤتي ثماره\\.\n`; } else { msg += `الخروج بانضباط وفقًا للخطة هو نجاح بحد ذاته\\. نحافظ على رأس المال للفرصة القادمة\\.\n`; } msg += `\nنبارك لمن اتبع التوصية\\. نستعد الآن للبحث عن الفرصة التالية\\.\n`; msg += `#نتائجتوصيات #${sanitizeMarkdownV2(asset)}`; return msg; }
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
        if (asset.asset === 'USDT') {
            totalValue24hAgo += asset.value;
        } else {
            const prevPrice = asset.open24h > 0 ? asset.open24h : (asset.price / (1 + asset.change24h));
            totalValue24hAgo += asset.amount * prevPrice;
        }
    });

    if (totalValue24hAgo > 0) {
        const dailyPnl = total - totalValue24hAgo;
        const dailyPnlPercent = (dailyPnl / totalValue24hAgo) * 100;
        const dailySign = dailyPnl >= 0 ? '+' : '';
        const dailyEmoji = dailyPnl >= 0 ? '🟢⬆️' : '🔴⬇️';
        dailyPnlText = ` ${dailyEmoji} \`$${sanitizeMarkdownV2(dailySign)}${sanitizeMarkdownV2(formatNumber(dailyPnl))}\` \\(\`${sanitizeMarkdownV2(dailySign)}${sanitizeMarkdownV2(formatNumber(dailyPnlPercent))}%\`\\)`;
    }

    let caption = `🧾 *التقرير التحليلي للمحفظة*\n\n`;
    caption += `*بتاريخ: ${sanitizeMarkdownV2(new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }))}*\n`;
    
    const cryptoAssets = assets.filter(a => a.asset !== "USDT" && a.change24h !== undefined);
    if (cryptoAssets.length > 0) {
        cryptoAssets.sort((a, b) => b.change24h - a.change24h);
        const bestPerformer = cryptoAssets[0];
        const worstPerformer = cryptoAssets[cryptoAssets.length - 1];
        caption += `━━━━━━━━━━━━━━━━━━━\n*🎯 أبرز تحركات اليوم:*\n`;
        caption += `▫️ *الأفضل أداءً:* 🟢 ${sanitizeMarkdownV2(bestPerformer.asset)} \\(\`+${sanitizeMarkdownV2(formatNumber(bestPerformer.change24h * 100))}%\`\\)\n`;
        if (cryptoAssets.length > 1) {
            caption += `▫️ *الأقل أداءً:* 🔴 ${sanitizeMarkdownV2(worstPerformer.asset)} \\(\`${sanitizeMarkdownV2(formatNumber(worstPerformer.change24h * 100))}%\`\\)\n`;
        }
    }
    
    caption += `━━━━━━━━━━━━━━━━━━━\n*نظرة عامة على الأداء:*\n`;
    caption += ` ▫️ *القيمة الإجمالية:* \`$${sanitizeMarkdownV2(formatNumber(total))}\`\n`;
    if (capital > 0) { caption += ` ▫️ *رأس المال:* \`$${sanitizeMarkdownV2(formatNumber(capital))}\`\n`; }
    caption += ` ▫️ *إجمالي الربح غير المحقق:* ${pnlEmoji} \`$${sanitizeMarkdownV2(pnlSign)}${sanitizeMarkdownV2(formatNumber(pnl))}\` \\(\`${sanitizeMarkdownV2(pnlSign)}${sanitizeMarkdownV2(formatNumber(pnlPercent))}%\`\\)\n`;
    caption += ` ▫️ *الأداء اليومي \\(24س\\):*${dailyPnlText}\n`;
    caption += ` ▫️ *السيولة:* 💵 نقدي ${sanitizeMarkdownV2(formatNumber(cashPercent))}% / 📈 مستثمر ${sanitizeMarkdownV2(formatNumber(investedPercent))}%\n`;
    caption += `━━━━━━━━━━━━━━━━━━━━\n*مكونات المحفظة:*\n`;
    
    const displayAssets = assets.filter(a => a.asset !== "USDT");
    displayAssets.forEach((a, index) => {
        const percent = total > 0 ? (a.value / total) * 100 : 0;
        const position = positions[a.asset];
        caption += `\n╭─ *${sanitizeMarkdownV2(a.asset)}/USDT*\n`;
        caption += `├─ *القيمة الحالية:* \`$${sanitizeMarkdownV2(formatNumber(a.value))}\` \\(*الوزن:* \`${sanitizeMarkdownV2(formatNumber(percent))}%\`\\)\n`;
        if (position?.avgBuyPrice) { caption += `├─ *متوسط الشراء:* \`$${sanitizeMarkdownV2(formatSmart(position.avgBuyPrice))}\`\n`; }
        caption += `├─ *سعر السوق:* \`$${sanitizeMarkdownV2(formatSmart(a.price))}\`\n`;
        const dailyChangeEmoji = a.change24h >= 0 ? '🟢⬆️' : '🔴⬇️';
        caption += `├─ *الأداء اليومي:* ${dailyChangeEmoji} \`${sanitizeMarkdownV2(formatNumber(a.change24h * 100))}%\`\n`;
        if (position?.avgBuyPrice > 0) {
            const totalCost = position.avgBuyPrice * a.amount;
            const assetPnl = a.value - totalCost;
            const assetPnlPercent = totalCost > 0 ? (assetPnl / totalCost) * 100 : 0;
            const assetPnlEmoji = assetPnl >= 0 ? '🟢' : '🔴';
            const assetPnlSign = assetPnl >= 0 ? '+' : '';
            caption += `╰─ *ربح/خسارة غير محقق:* ${assetPnlEmoji} \`$${sanitizeMarkdownV2(assetPnlSign)}${sanitizeMarkdownV2(formatNumber(assetPnl))}\` \\(\`${sanitizeMarkdownV2(assetPnlSign)}${sanitizeMarkdownV2(formatNumber(assetPnlPercent))}%\`\\)`;
        } else {
            caption += `╰─ *ربح/خسارة غير محقق:* \`غير مسجل\``;
        }
        if (index < displayAssets.length - 1) {
            caption += `\n━━━━━━━━━━━━━━━━━━━━`;
        }
    });
    caption += `\n\n━━━━━━━━━━━━━━━━━━━━\n*USDT \\(الرصيد النقدي\\)* 💵\n`;
    caption += `*القيمة:* \`$${sanitizeMarkdownV2(formatNumber(usdtAsset.value))}\` \\(*الوزن:* \`${sanitizeMarkdownV2(formatNumber(cashPercent))}%\`\\)`;
    return { caption };
}
async function formatAdvancedMarketAnalysis(ownedAssets = []) {
    const prices = await getCachedMarketPrices();
    if (!prices || prices.error) return `❌ فشل جلب بيانات السوق\\. ${prices.error || ''}`;
    
    const marketData = Object.entries(prices).map(([instId, data]) => ({ instId, ...data })).filter(d => d.volCcy24h > 10000 && d.change24h !== undefined);
    
    const totalCount = marketData.length;
    const gainersCount = marketData.filter(d => d.change24h > 0).length;
    const losersCount = totalCount - gainersCount;
    const gainersPercent = totalCount > 0 ? (gainersCount / totalCount) * 100 : 0;
    const losersPercent = totalCount > 0 ? (losersCount / totalCount) * 100 : 0;
    let breadthConclusion = "السوق متوازن حاليًا\\.";
    if (gainersPercent > 65) {
        breadthConclusion = "السوق يظهر قوة شرائية واسعة النطاق\\.";
    } else if (losersPercent > 65) {
        breadthConclusion = "السوق يظهر ضغطًا بيعيًا واسع النطاق\\.";
    }

    marketData.sort((a, b) => b.change24h - a.change24h);
    const topGainers = marketData.slice(0, 5);
    const topLosers = marketData.slice(-5).reverse();
    marketData.sort((a, b) => b.volCcy24h - a.volCcy24h);
    const highVolume = marketData.slice(0, 5);
    const ownedSymbols = ownedAssets.map(a => a.asset);
    
    let msg = `🚀 *تحليل السوق المتقدم \\(OKX\\)* | ${sanitizeMarkdownV2(new Date().toLocaleDateString("ar-EG"))}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n📊 *اتساع السوق \\(آخر 24س\\):*\n`;
    msg += `▫️ *العملات الصاعدة:* 🟢 \`${sanitizeMarkdownV2(formatNumber(gainersPercent))}%\`\n`;
    msg += `▫️ *العملات الهابطة:* 🔴 \`${sanitizeMarkdownV2(formatNumber(losersPercent))}%\`\n`;
    msg += `▫️ *الخلاصة:* ${sanitizeMarkdownV2(breadthConclusion)}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n\n`;
    
    msg += "📈 *أكبر الرابحين \\(24س\\):*\n" + topGainers.map(c => { const symbol = c.instId.split('-')[0]; const ownedMark = ownedSymbols.includes(symbol) ? ' ✅' : ''; return ` \\- \`${sanitizeMarkdownV2(c.instId)}\`: \`+${sanitizeMarkdownV2(formatNumber(c.change24h * 100))}%\`${ownedMark}`; }).join('\n') + "\n\n";
    msg += "📉 *أكبر الخاسرين \\(24س\\):*\n" + topLosers.map(c => { const symbol = c.instId.split('-')[0]; const ownedMark = ownedSymbols.includes(symbol) ? ' ✅' : ''; return ` \\- \`${sanitizeMarkdownV2(c.instId)}\`: \`${sanitizeMarkdownV2(formatNumber(c.change24h * 100))}%\`${ownedMark}`; }).join('\n') + "\n\n";
    msg += "📊 *الأعلى في حجم التداول:*\n" + highVolume.map(c => ` \\- \`${sanitizeMarkdownV2(c.instId)}\`: \`${sanitizeMarkdownV2((c.volCcy24h / 1e6).toFixed(2))}M\` USDT`).join('\n') + "\n\n";
    
    let smartRecommendation = "💡 *توصية:* راقب الأصول ذات حجم التداول المرتفع، فهي غالبًا ما تقود اتجاه السوق\\.";
    const ownedGainers = topGainers.filter(g => ownedSymbols.includes(g.instId.split('-')[0]));
    const ownedLosers = topLosers.filter(l => ownedSymbols.includes(l.instId.split('-')[0]));
    if (ownedGainers.length > 0) {
        smartRecommendation = `💡 *توصية ذكية:* عملة *${sanitizeMarkdownV2(ownedGainers[0].instId.split('-')[0])}* التي تملكها ضمن أكبر الرابحين\\. قد تكون فرصة جيدة لتقييم المركز\\.`;
    } else if (ownedLosers.length > 0) {
        smartRecommendation = `💡 *توصية ذكية:* عملة *${sanitizeMarkdownV2(ownedLosers[0].instId.split('-')[0])}* التي تملكها ضمن أكبر الخاسرين\\. قد يتطلب الأمر مراجعة وقف الخسارة أو استراتيجيتك\\.`;
    }
    msg += `${smartRecommendation}`;
    return msg;
}
async function formatQuickStats(assets, total, capital) { const pnl = capital > 0 ? total - capital : 0; const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0; const statusEmoji = pnl >= 0 ? '🟢' : '🔴'; const statusText = pnl >= 0 ? 'ربح' : 'خسارة'; let msg = "⚡ *إحصائيات سريعة*\n\n"; msg += `💎 *إجمالي الأصول:* \`${assets.filter(a => a.asset !== 'USDT').length}\`\n`; msg += `💰 *القيمة الحالية:* \`$${sanitizeMarkdownV2(formatNumber(total))}\`\n`; if (capital > 0) { msg += `📈 *نسبة الربح/الخسارة:* \`${sanitizeMarkdownV2(formatNumber(pnlPercent))}%\`\n`; msg += `🎯 *الحالة:* ${statusEmoji} ${statusText}\n`; } msg += `\n━━━━━━━━━━━━━━━━━━━━\n*تحليل القمم والقيعان للأصول:*\n`; const cryptoAssets = assets.filter(a => a.asset !== "USDT"); if (cryptoAssets.length === 0) { msg += "\n`لا توجد أصول في محفظتك لتحليلها\\.`"; } else { const assetExtremesPromises = cryptoAssets.map(asset => getAssetPriceExtremes(`${asset.asset}-USDT`) ); const assetExtremesResults = await Promise.all(assetExtremesPromises); cryptoAssets.forEach((asset, index) => { const extremes = assetExtremesResults[index]; msg += `\n🔸 *${sanitizeMarkdownV2(asset.asset)}:*\n`; if (extremes) { msg += ` *الأسبوعي:* قمة \`$${sanitizeMarkdownV2(formatSmart(extremes.weekly.high))}\` / قاع \`$${sanitizeMarkdownV2(formatSmart(extremes.weekly.low))}\`\n`; msg += ` *الشهري:* قمة \`$${sanitizeMarkdownV2(formatSmart(extremes.monthly.high))}\` / قاع \`$${sanitizeMarkdownV2(formatSmart(extremes.monthly.low))}\`\n`; msg += ` *السنوي:* قمة \`$${sanitizeMarkdownV2(formatSmart(extremes.yearly.high))}\` / قاع \`$${sanitizeMarkdownV2(formatSmart(extremes.yearly.low))}\`\n`; msg += ` *التاريخي:* قمة \`$${sanitizeMarkdownV2(formatSmart(extremes.allTime.high))}\` / قاع \`$${sanitizeMarkdownV2(formatSmart(extremes.allTime.low))}\``; } else { msg += ` \`تعذر جلب البيانات التاريخية\\.\``; } }); } msg += `\n\n⏰ *آخر تحديث:* ${sanitizeMarkdownV2(new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }))}`; return msg; }
async function formatPerformanceReport(period, periodLabel, history, btcHistory) { const stats = calculatePerformanceStats(history); if (!stats) return { error: "ℹ️ لا توجد بيانات كافية لهذه الفترة\\." }; let btcPerformanceText = " `لا تتوفر بيانات`"; let benchmarkComparison = ""; if (btcHistory && btcHistory.length >= 2) { const btcStart = btcHistory[0].close; const btcEnd = btcHistory[btcHistory.length - 1].close; const btcChange = (btcEnd - btcStart) / btcStart * 100; btcPerformanceText = `\`${sanitizeMarkdownV2(btcChange >= 0 ? '+' : '')}${sanitizeMarkdownV2(formatNumber(btcChange))}%\``; if (stats.pnlPercent > btcChange) { benchmarkComparison = `▪️ *النتيجة:* أداء أعلى من السوق ✅`; } else { benchmarkComparison = `▪️ *النتيجة:* أداء أقل من السوق ⚠️`; } } const chartLabels = history.map(h => period === '24h' ? new Date(h.time).getHours() + ':00' : new Date(h.time).toLocaleDateString('en-GB', {day: '2-digit', month: '2-digit'})); const chartDataPoints = history.map(h => h.total); const chartUrl = createChartUrl(chartDataPoints, 'line', `أداء المحفظة - ${periodLabel}`, chartLabels, 'قيمة المحفظة ($)'); const pnlSign = stats.pnl >= 0 ? '+' : ''; const emoji = stats.pnl >= 0 ? '🟢⬆️' : '🔴⬇️'; let caption = `📊 *تحليل أداء المحفظة | ${sanitizeMarkdownV2(periodLabel)}*\n\n`; caption += `📈 *النتيجة:* ${emoji} \`$${sanitizeMarkdownV2(pnlSign)}${sanitizeMarkdownV2(formatNumber(stats.pnl))}\` \\(\`${sanitizeMarkdownV2(pnlSign)}${sanitizeMarkdownV2(formatNumber(stats.pnlPercent))}%\`\\)\n`; caption += `*التغير الصافي: من \`$${sanitizeMarkdownV2(formatNumber(stats.startValue))}\` إلى \`$${sanitizeMarkdownV2(formatNumber(stats.endValue))}\`*\n\n`; caption += `*📝 مقارنة معيارية \\(Benchmark\\):*\n`; caption += `▪️ *أداء محفظتك:* \`${sanitizeMarkdownV2(stats.pnlPercent >= 0 ? '+' : '')}${sanitizeMarkdownV2(formatNumber(stats.pnlPercent))}%\`\n`; caption += `▪️ *أداء عملة BTC:* ${btcPerformanceText}\n`; caption += `${benchmarkComparison}\n\n`; caption += `*📈 مؤشرات الأداء الرئيسية:*\n`; caption += `▪️ *أفضل يوم:* \`+${sanitizeMarkdownV2(formatNumber(stats.bestDayChange))}%\`\n`; caption += `▪️ *أسوأ يوم:* \`${sanitizeMarkdownV2(formatNumber(stats.worstDayChange))}%\`\n`; caption += `▪️ *مستوى التقلب:* ${sanitizeMarkdownV2(stats.volText)}`; return { caption, chartUrl }; }

// =================================================================
// SECTION 4: DATA PROCESSING & AI ANALYSIS
// =================================================================

// --- Market Data Processing ---
async function getInstrumentDetails(instId) { try { const tickerRes = await fetch(`${okxAdapter.baseURL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`); const tickerJson = await tickerRes.json(); if (tickerJson.code !== '0' || !tickerJson.data || !tickerJson.data[0]) { return { error: `لم يتم العثور على العملة.` }; } const tickerData = tickerJson.data[0]; return { price: parseFloat(tickerData.last), high24h: parseFloat(tickerData.high24h), low24h: parseFloat(tickerData.low24h), vol24h: parseFloat(tickerData.volCcy24h), }; } catch (e) { throw new Error("خطأ في الاتصال بالمنصة لجلب بيانات السوق."); } }
async function getHistoricalCandles(instId, bar = '1D', limit = 100) { let allCandles = []; let before = ''; const maxLimitPerRequest = 100; try { while (allCandles.length < limit) { await new Promise(resolve => setTimeout(resolve, 250)); const currentLimit = Math.min(maxLimitPerRequest, limit - allCandles.length); const url = `${okxAdapter.baseURL}/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=${currentLimit}${before}`; const res = await fetch(url); const json = await res.json(); if (json.code !== '0' || !json.data || json.data.length === 0) { break; } const newCandles = json.data.map(c => ({ time: parseInt(c[0]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]) })); allCandles.push(...newCandles); if (newCandles.length < maxLimitPerRequest) { break; } const lastTimestamp = newCandles[newCandles.length - 1].time; before = `&before=${lastTimestamp}`; } return allCandles.reverse(); } catch (e) { console.error(`Error fetching historical candles for ${instId}:`, e); return []; } }
async function getAssetPriceExtremes(instId) { try { const [yearlyCandles, allTimeCandles] = await Promise.all([ getHistoricalCandles(instId, '1D', 365), getHistoricalCandles(instId, '1M', 240) ]); if (yearlyCandles.length === 0) return null; const getHighLow = (candles) => { if (!candles || candles.length === 0) return { high: 0, low: Infinity }; return candles.reduce((acc, candle) => ({ high: Math.max(acc.high, candle.high), low: Math.min(acc.low, candle.low) }), { high: 0, low: Infinity }); }; const weeklyCandles = yearlyCandles.slice(-7); const monthlyCandles = yearlyCandles.slice(-30); const formatLow = (low) => low === Infinity ? 0 : low; const weeklyExtremes = getHighLow(weeklyCandles); const monthlyExtremes = getHighLow(monthlyCandles); const yearlyExtremes = getHighLow(yearlyCandles); const allTimeExtremes = getHighLow(allTimeCandles); return { weekly: { high: weeklyExtremes.high, low: formatLow(weeklyExtremes.low) }, monthly: { high: monthlyExtremes.high, low: formatLow(monthlyExtremes.low) }, yearly: { high: yearlyExtremes.high, low: formatLow(yearlyExtremes.low) }, allTime: { high: allTimeExtremes.high, low: formatLow(allTimeExtremes.low) } }; } catch (error) { console.error(`Error in getAssetPriceExtremes for ${instId}:`, error); return null; } }
function calculateSMA(closes, period) { if (closes.length < period) return null; const sum = closes.slice(-period).reduce((acc, val) => acc + val, 0); return sum / period; }
function calculateRSI(closes, period = 14) { if (closes.length < period + 1) return null; let gains = 0, losses = 0; for (let i = 1; i <= period; i++) { const diff = closes[i] - closes[i - 1]; diff > 0 ? gains += diff : losses -= diff; } let avgGain = gains / period, avgLoss = losses / period; for (let i = period + 1; i < closes.length; i++) { const diff = closes[i] - closes[i - 1]; if (diff > 0) { avgGain = (avgGain * (period - 1) + diff) / period; avgLoss = (avgLoss * (period - 1)) / period; } else { avgLoss = (avgLoss * (period - 1) - diff) / period; avgGain = (avgGain * (period - 1)) / period; } } if (avgLoss === 0) return 100; const rs = avgGain / avgLoss; return 100 - (100 / (1 + rs)); }
async function getTechnicalAnalysis(instId) { const candleData = (await getHistoricalCandles(instId, '1D', 51)); if (candleData.length < 51) return { error: "بيانات الشموع غير كافية." }; const closes = candleData.map(c => c.close); return { rsi: calculateRSI(closes, 14), sma20: calculateSMA(closes, 20), sma50: calculateSMA(closes, 50) }; }
function calculatePerformanceStats(history) { if (history.length < 2) return null; const values = history.map(h => h.total); const startValue = values[0]; const endValue = values[values.length - 1]; const pnl = endValue - startValue; const pnlPercent = (startValue > 0) ? (pnl / startValue) * 100 : 0; const maxValue = Math.max(...values); const minValue = Math.min(...values); const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length; const dailyReturns = []; for (let i = 1; i < values.length; i++) { dailyReturns.push((values[i] - values[i - 1]) / values[i - 1]); } const bestDayChange = dailyReturns.length > 0 ? Math.max(...dailyReturns) * 100 : 0; const worstDayChange = dailyReturns.length > 0 ? Math.min(...dailyReturns) * 100 : 0; const avgReturn = dailyReturns.length > 0 ? dailyReturns.reduce((sum, ret) => sum + ret, 0) / dailyReturns.length : 0; const volatility = dailyReturns.length > 0 ? Math.sqrt(dailyReturns.map(x => Math.pow(x - avgReturn, 2)).reduce((a, b) => a + b) / dailyReturns.length) * 100 : 0; let volText = "متوسط"; if(volatility < 1) volText = "منخفض"; if(volatility > 5) volText = "مرتفع"; return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue, bestDayChange, worstDayChange, volatility, volText }; }
function createChartUrl(data, type = 'line', title = '', labels = [], dataLabel = '') { if (!data || data.length === 0) return null; const pnl = data[data.length - 1] - data[0]; const chartColor = pnl >= 0 ? 'rgb(75, 192, 75)' : 'rgb(255, 99, 132)'; const chartBgColor = pnl >= 0 ? 'rgba(75, 192, 75, 0.2)' : 'rgba(255, 99, 132, 0.2)'; const chartConfig = { type: 'line', data: { labels: labels, datasets: [{ label: dataLabel, data: data, fill: true, backgroundColor: chartBgColor, borderColor: chartColor, tension: 0.1 }] }, options: { title: { display: true, text: title } } }; return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`; }

// --- AI Analysis Services ---
async function analyzeWithAI(prompt) {
    try {
        const fullPrompt = `أنت محلل مالي خبير ومستشار استثماري متخصص في العملات الرقمية، تتحدث بالعربية الفصحى، وتقدم تحليلات دقيقة وموجزة. في نهاية كل تحليل، يجب عليك إضافة السطر التالي بالضبط كما هو: "هذا التحليل لأغراض معلوماتية فقط وليس توصية مالية."\n\n---\n\nالطلب: ${prompt}`;
        const result = await geminiModel.generateContent(fullPrompt);
        const response = await result.response;
        if (response.promptFeedback?.blockReason) {
            console.error("AI Analysis Blocked:", response.promptFeedback.blockReason);
            return `❌ تم حظر التحليل من قبل Google لأسباب تتعلق بالسلامة: ${response.promptFeedback.blockReason}`;
        }
        return response.text().trim();
    } catch (error) {
        console.error("AI Analysis Error (Gemini):", error);
        return "❌ تعذر إجراء التحليل بالذكاء الاصطناعي. قد يكون هناك مشكلة في الاتصال أو المفتاح السري.";
    }
}
async function getCoinFundamentals(coinSymbol) {
    try {
        const listRes = await fetch('https://api.coingecko.com/api/v3/coins/list');
        const coinList = await listRes.json();
        const coin = coinList.find(c => c.symbol.toLowerCase() === coinSymbol.toLowerCase());
        if (!coin) {
            return { error: "لم يتم العثور على العملة في قاعدة البيانات." };
        }
        const coinId = coin.id;

        const dataRes = await fetch(`https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`);
        const data = await dataRes.json();
        
        if (data.error) {
            return { error: data.error };
        }

        return {
            rank: data.market_cap_rank || 'N/A',
            category: data.categories?.[0] || 'Unknown',
            description: data.description?.ar || data.description?.en?.split('. ')[0] || 'لا يوجد وصف متاح.'
        };
    } catch (error) {
        console.error(`CoinGecko API Error for ${coinSymbol}:`, error);
        return { error: "فشل الاتصال بخدمة بيانات المشاريع." };
    }
}
function truncate(s, max = 12000) { 
    return s.length > max ? s.slice(0, max) + "..." : s; 
}

async function getAIAnalysisForAsset(asset) {
    const instId = `${asset}-USDT`;
    const [details, tech, perf, fundamentals] = await Promise.all([
        getInstrumentDetails(instId),
        getTechnicalAnalysis(instId),
        getHistoricalPerformance(asset),
        getCoinFundamentals(asset)
    ]);

    if (details.error) return `لا يمكن تحليل ${asset}: ${details.error}`;
    if (tech.error) return `لا يمكن تحليل ${asset}: ${tech.error}`;
    if (!perf) return `لا يمكن تحليل ${asset}: فشل جلب الأداء التاريخي.`;

    let fundamentalSection = "";
    if (fundamentals && !fundamentals.error) {
        fundamentalSection = `
    **1. بيانات المشروع الأساسية (من مصادر خارجية):**
    - **الترتيب السوقي:** ${fundamentals.rank || 'غير معروف'}
    - **الفئة:** ${fundamentals.category || 'غير معروف'}
    - **وصف المشروع:** ${fundamentals.description || 'لا يوجد'}
        `;
    } else {
        fundamentalSection = `
    **1. بيانات المشروع الأساسية:**
    - لم يتم العثور على بيانات أساسية محدثة للمشروع. إذا كانت لديك معرفة مسبقة بهذا المشروع، يرجى استخدامها في تحليلك.
        `;
    }

    let riskProfile = "متوسط";
    if (tech.rsi > 70) riskProfile = "مرتفع (تشبع شرائي)";
    if (tech.rsi < 30) riskProfile = "منخفض (تشبع بيعي)";

    const basePrompt = `
    أنت محلل خبير. قم بتحليل عملة ${asset} بشكل شامل يدمج بين التحليل الأساسي والفني وتاريخي الشخصي معها.
    ${fundamentalSection}
    **2. البيانات الفنية الحالية:**
    - **السعر الحالي:** $${formatSmart(details.price)}
    - **أعلى 24 ساعة:** $${formatSmart(details.high24h)}
    - **أدنى 24 ساعة:** $${formatSmart(details.low24h)}
    - **RSI (14 يوم):** ${tech.rsi ? formatNumber(tech.rsi) : 'N/A'}
    - **ملف المخاطرة الفني:** ${riskProfile}
    - **علاقة السعر بالمتوسطات:** السعر حاليًا ${details.price > tech.sma20 ? 'فوق' : 'تحت'} SMA20 و ${details.price > tech.sma50 ? 'فوق' : 'تحت'} SMA50.

    **3. بياناتي التاريخية مع العملة:**
    - **عدد صفقاتي السابقة:** ${perf.tradeCount}
    - **معدل نجاحي:** ${perf.tradeCount > 0 ? formatNumber((perf.winningTrades / perf.tradeCount) * 100) : '0'}%

    **المطلوب:**
    قدم تحليلًا متكاملاً في فقرة واحدة. ابدأ بوصف المشروع ومكانته (باستخدام البيانات المتاحة أو معرفتك الخاصة)، ثم اربطه بالوضع الفني الحالي، وأخيرًا، قدم توصية واضحة (شراء/بيع/مراقبة) مع الأخذ في الاعتبار تاريخي الشخصي مع العملة.
    `;

    return await analyzeWithAI(truncate(basePrompt));
}

async function getAIAnalysisForPortfolio(assets, total, capital) {
    const topAssets = assets.slice(0, 5).map(a => `${a.asset} (يمثل ${formatNumber((a.value/total)*100)}%)`).join('، ');
    const pnlPercent = capital > 0 ? ((total - capital) / capital) * 100 : 0;
    const prompt = `
    قم بتحليل المحفظة الاستثمارية التالية:
    - القيمة الإجمالية: $${formatNumber(total)}
    - رأس المال الأصلي: $${formatNumber(capital)}
    - إجمالي الربح/الخسارة غير المحقق: ${formatNumber(pnlPercent)}%
    - أبرز 5 أصول في المحفظة: ${topAssets}
    
    قدم تقييمًا لصحة المحفظة، درجة تنوعها، وأهم المخاطر أو الفرص التي تراها. ثم قدم توصية واحدة واضحة لتحسين أدائها.
    `;

    return await analyzeWithAI(prompt);
}

async function getLatestCryptoNews(searchQuery) {
    try {
        const apiKey = process.env.NEWS_API_KEY;
        if (!apiKey) throw new Error("NEWS_API_KEY is not configured.");
        
        const fromDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const url = `https://newsapi.org/v2/everything?q=(${searchQuery})&sortBy=relevancy&from=${fromDate}&pageSize=10&apiKey=${apiKey}`;
        
        const res = await fetch(url);
        const data = await res.json();

        if (data.status !== 'ok') {
            if (data.code === 'apiKeyInvalid' || data.code === 'apiKeyMissing') {
                 throw new Error("مفتاح NewsAPI غير صالح أو مفقود. يرجى التحقق من إعداداتك.");
            }
            throw new Error(`NewsAPI error: ${data.message}`);
        }
        
        return data.articles.map(article => ({
            title: article.title,
            source: article.source.name,
            content: article.content || article.description,
            url: article.url
        }));

    } catch (error) {
        console.error("Error fetching crypto news:", error);
        return { error: error.message };
    }
}

async function getAIGeneralNewsSummary() {
    const newsArticles = await getLatestCryptoNews("crypto OR cryptocurrency OR bitcoin OR ethereum OR blockchain");
    if (newsArticles.error) return `❌ فشل في جلب الأخبار: ${newsArticles.error}`;
    if (newsArticles.length === 0) return "ℹ️ لم يتم العثور على أخبار حديثة عن الكريبتو حاليًا.";

    const articlesForPrompt = newsArticles.map(a => `Source: ${a.source}\nTitle: ${a.title}\nContent: ${a.content}`).join('\n\n---\n\n');
    
    const prompt = `You are an expert news editor. The following is a list of recent news articles, likely in English. Your task is to:
1. Identify the 3-4 most important news items related to the cryptocurrency market.
2. Summarize them concisely in PROFESSIONAL ARABIC.
3. Based on these summaries, write a short paragraph in ARABIC about the general market sentiment (e.g., bullish, bearish, uncertain).

News Articles:\n${articlesForPrompt}`;

    return await analyzeWithAI(prompt);
}

async function getAIPortfolioNewsSummary() {
    const prices = await getCachedMarketPrices();
    if (prices.error) throw new Error("فشل جلب أسعار السوق لتحليل أخبار المحفظة.");
    const { assets, error } = await okxAdapter.getPortfolio(prices);
    if (error) throw new Error("فشل جلب المحفظة لتحليل الأخبار.");

    const cryptoAssets = assets.filter(a => a.asset !== "USDT");
    if (cryptoAssets.length === 0) {
        return "ℹ️ لا تحتوي محفظتك على عملات رقمية لجلب أخبار متعلقة بها.";
    }

    const assetSymbols = cryptoAssets.map(a => `"${a.asset} crypto"`).join(' OR '); 
    
    const newsArticles = await getLatestCryptoNews(assetSymbols);
    if (newsArticles.error) return `❌ فشل في جلب الأخبار: ${newsArticles.error}`;
    if (newsArticles.length === 0) return `ℹ️ لم يتم العثور على أخبار حديثة متعلقة بأصول محفظتك (${assetSymbols.replace(/"/g, '').replace(/ crypto/g, '')}).`;
    
    const articlesForPrompt = newsArticles.map(a => `Source: ${a.source}\nTitle: ${a.title}\nContent: ${a.content}`).join('\n\n---\n\n');
    
    const prompt = `You are a personal financial advisor. My portfolio contains the following assets: ${assetSymbols}. Below is a list of recent news articles, likely in English. Your task is to:
1. Summarize the most important news from the list that could affect my investments.
2. Explain the potential impact of each news item simply.
3. All your output MUST be in PROFESSIONAL ARABIC.

News Articles:\n${articlesForPrompt}`;

    return await analyzeWithAI(prompt);
}


// =================================================================
// SECTION 5: BACKGROUND JOBS & DYNAMIC MANAGEMENT
// =================================================================

async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount, oldTotalValue) {
    if (!asset || price === undefined || price === null || isNaN(price)) {
        return { analysisResult: null };
    }

    const positions = await loadPositions();
    let position = positions[asset];
    let analysisResult = { type: 'none', data: {} };

    if (amountChange > 0) { // Buy logic
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
    } else if (amountChange < 0 && position) { // Sell logic
        const soldAmount = Math.abs(amountChange);
        position.realizedValue = (position.realizedValue || 0) + (soldAmount * price);
        position.totalAmountSold = (position.totalAmountSold || 0) + soldAmount;

        if (newTotalAmount * price < 1) { // Position close logic
            const avgSellPrice = position.totalAmountSold > 0 ? position.realizedValue / position.totalAmountSold : 0;
            const quantity = position.totalAmountBought;
            const investedCapital = position.totalCost;
            const finalPnl = (avgSellPrice - position.avgBuyPrice) * quantity;
            const finalPnlPercent = (investedCapital > 0) ? (finalPnl / investedCapital) * 100 : 0;
            const closeDate = new Date();
            const openDate = new Date(position.openDate);
            const durationDays = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24);

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
                quantity: quantity
            };

            await saveClosedTrade(closeReportData);
            analysisResult = { type: 'close', data: closeReportData };
            delete positions[asset];
        } else { // Partial sell logic
            analysisResult.type = 'sell';
        }
    }
    
    await savePositions(positions);
    analysisResult.data.position = positions[asset] || position;
    return { analysisResult };
}

async function monitorBalanceChanges() {
    if (isProcessingBalance) {
        await sendDebugMessage("Balance check skipped: a process is already running.");
        return;
    }
    isProcessingBalance = true;

    try {
        await sendDebugMessage("Checking balance changes...");
        const previousState = await loadBalanceState();
        const previousBalances = previousState.balances || {};
        const currentBalance = await okxAdapter.getBalanceForComparison();
        if (!currentBalance) {
            await sendDebugMessage("Could not fetch current balance to compare.");
            isProcessingBalance = false; return;
        }
        const prices = await getCachedMarketPrices();
        if (!prices || prices.error) {
            await sendDebugMessage("Could not fetch market prices to compare.");
            isProcessingBalance = false; return;
        }
        const { assets: newAssets, total: newTotalValue, usdtValue: newUsdtValue, error } = await okxAdapter.getPortfolio(prices);
        if (error || newTotalValue === undefined) {
            await sendDebugMessage(`Portfolio fetch error: ${error}`);
            isProcessingBalance = false; return;
        }
        if (Object.keys(previousBalances).length === 0) {
            await sendDebugMessage("Initializing first balance state. No notifications will be sent.");
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue });
            isProcessingBalance = false; return;
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
            
            const sendMessageSafely = async (chatId, message, options = {}) => {
                try {
                    await bot.api.sendMessage(chatId, message, { parse_mode: "MarkdownV2", ...options });
                } catch (e) {
                    console.error(`Failed to send message to chat ${chatId}:`, e.message);
                    await sendDebugMessage(`Call to 'sendMessage' failed! (${e.message})`);
                }
            };

            if (analysisResult.type === 'buy') {
                privateMessage = formatPrivateBuy(baseDetails);
                publicMessage = formatPublicBuy(baseDetails);
                await sendMessageSafely(AUTHORIZED_USER_ID, privateMessage);
                if (settings.autoPostToChannel) {
                    await sendMessageSafely(TARGET_CHANNEL_ID, publicMessage);
                }
            } else if (analysisResult.type === 'sell') {
                privateMessage = formatPrivateSell(baseDetails);
                publicMessage = formatPublicSell(baseDetails);
                await sendMessageSafely(AUTHORIZED_USER_ID, privateMessage);
                if (settings.autoPostToChannel) {
                    await sendMessageSafely(TARGET_CHANNEL_ID, publicMessage);
                }
            } else if (analysisResult.type === 'close') {
                privateMessage = formatPrivateCloseReport(analysisResult.data);
                publicMessage = formatPublicClose(analysisResult.data);
                if (settings.autoPostToChannel) {
                    await sendMessageSafely(TARGET_CHANNEL_ID, publicMessage);
                    await sendMessageSafely(AUTHORIZED_USER_ID, privateMessage);
                } else {
                    const confirmationKeyboard = new InlineKeyboard()
                        .text("✅ نعم، انشر التقرير", "publish_report")
                        .text("❌ لا، تجاهل", "ignore_report");
                    const hiddenMarker = `\n<report>${JSON.stringify(publicMessage)}</report>`;
                    const confirmationMessage = `*تم إغلاق المركز بنجاح\\. هل تود نشر الملخص في القناة؟*\n\n${privateMessage}${hiddenMarker}`;
                    await sendMessageSafely(AUTHORIZED_USER_ID, confirmationMessage, { reply_markup: confirmationKeyboard });
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
    } finally {
        isProcessingBalance = false;
    }
}

async function trackPositionHighLow() { try { const positions = await loadPositions(); if (Object.keys(positions).length === 0) return; const prices = await getCachedMarketPrices(); if (!prices || prices.error) return; let positionsUpdated = false; for (const symbol in positions) { const position = positions[symbol]; const currentPrice = prices[`${symbol}-USDT`]?.price; if (currentPrice) { if (!position.highestPrice || currentPrice > position.highestPrice) { position.highestPrice = currentPrice; positionsUpdated = true; } if (!position.lowestPrice || currentPrice < position.lowestPrice) { position.lowestPrice = currentPrice; positionsUpdated = true; } } } if (positionsUpdated) { await savePositions(positions); await sendDebugMessage("Updated position high/low prices."); } } catch(e) { console.error("CRITICAL ERROR in trackPositionHighLow:", e); } }
async function checkPriceAlerts() { try { const alerts = await loadAlerts(); if (alerts.length === 0) return; const prices = await getCachedMarketPrices(); if (!prices || prices.error) return; const remainingAlerts = []; let triggered = false; for (const alert of alerts) { const currentPrice = prices[alert.instId]?.price; if (currentPrice === undefined) { remainingAlerts.push(alert); continue; } if ((alert.condition === '>' && currentPrice > alert.price) || (alert.condition === '<' && currentPrice < alert.price)) { await bot.api.sendMessage(AUTHORIZED_USER_ID, `🚨 *تنبيه سعر\\!* \`${sanitizeMarkdownV2(alert.instId)}\`\nالشرط: ${sanitizeMarkdownV2(alert.condition)} ${sanitizeMarkdownV2(alert.price)}\nالسعر الحالي: \`${sanitizeMarkdownV2(currentPrice)}\``, { parse_mode: "MarkdownV2" }); triggered = true; } else { remainingAlerts.push(alert); } } if (triggered) await saveAlerts(remainingAlerts); } catch (error) { console.error("Error in checkPriceAlerts:", error); } }
async function checkPriceMovements() {
    try {
        await sendDebugMessage("Checking price movements...");
        const alertSettings = await loadAlertSettings();
        const priceTracker = await loadPriceTracker();
        const prices = await getCachedMarketPrices();
        if (!prices || prices.error) return;

        const { assets, total: currentTotalValue, error } = await okxAdapter.getPortfolio(prices);
        if (error || currentTotalValue === undefined) return;

        if (priceTracker.totalPortfolioValue === 0) {
            priceTracker.totalPortfolioValue = currentTotalValue;
            assets.forEach(a => {
                if (a.price) priceTracker.assets[a.asset] = a.price;
            });
            await savePriceTracker(priceTracker);
            return;
        }

        let trackerUpdated = false;

        for (const asset of assets) {
            if (asset.asset === 'USDT' || !asset.price) continue;
            const lastPrice = priceTracker.assets[asset.asset];
            if (lastPrice) {
                const changePercent = ((asset.price - lastPrice) / lastPrice) * 100;
                const threshold = alertSettings.overrides[asset.asset] || alertSettings.global;
                if (Math.abs(changePercent) >= threshold) {
                    const movementText = changePercent > 0 ? 'صعود' : 'هبوط';
                    const message = `📈 *تنبيه حركة سعر لأصل\\!* \`${sanitizeMarkdownV2(asset.asset)}\`\n*الحركة:* ${movementText} بنسبة \`${sanitizeMarkdownV2(formatNumber(changePercent))}%\`\n*السعر الحالي:* \`$${sanitizeMarkdownV2(formatSmart(asset.price))}\``;
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "MarkdownV2" });
                    priceTracker.assets[asset.asset] = asset.price; 
                    trackerUpdated = true;
                }
            } else {
                priceTracker.assets[asset.asset] = asset.price;
                trackerUpdated = true;
            }
        }

        const lastTotalValue = priceTracker.totalPortfolioValue;
        if (lastTotalValue > 0) {
            const totalChangePercent = ((currentTotalValue - lastTotalValue) / lastTotalValue) * 100;
            const globalThreshold = alertSettings.global;

            if (Math.abs(totalChangePercent) >= globalThreshold) {
                const movementText = totalChangePercent > 0 ? 'صعود' : 'هبوط';
                const message = `💼 *تنبيه حركة المحفظة\\!* \n*الحركة:* ${movementText} بنسبة \`${sanitizeMarkdownV2(formatNumber(totalChangePercent))}%\`\n*القيمة الحالية:* \`$${sanitizeMarkdownV2(formatNumber(currentTotalValue))}\``;
                await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "MarkdownV2" });
                priceTracker.totalPortfolioValue = currentTotalValue; 
                trackerUpdated = true;
            }
        }

        if (trackerUpdated) {
            await savePriceTracker(priceTracker);
        }
    } catch (e) {
        console.error("CRITICAL ERROR in checkPriceMovements:", e);
    }
}
async function runDailyJobs() { try { const settings = await loadSettings(); if (!settings.dailySummary) return; const prices = await getCachedMarketPrices(); if (!prices || prices.error) return; const { total } = await okxAdapter.getPortfolio(prices); if (total === undefined) return; const history = await loadHistory(); const date = new Date().toISOString().slice(0, 10); const today = history.find(h => h.date === date); if (today) { today.total = total; } else { history.push({ date, total, time: Date.now() }); } if (history.length > 35) history.shift(); await saveHistory(history); console.log(`[Daily Summary Recorded]: ${date} - $${formatNumber(total)}`); } catch (e) { console.error("CRITICAL ERROR in runDailyJobs:", e); } }
async function runHourlyJobs() { try { const prices = await getCachedMarketPrices(); if (!prices || prices.error) return; const { total } = await okxAdapter.getPortfolio(prices); if (total === undefined) return; const history = await loadHourlyHistory(); const hourLabel = new Date().toISOString().slice(0, 13); const existingIndex = history.findIndex(h => h.label === hourLabel); if (existingIndex > -1) { history[existingIndex].total = total; } else { history.push({ label: hourLabel, total, time: Date.now() }); } if (history.length > 72) history.splice(0, history.length - 72); await saveHourlyHistory(history); } catch (e) { console.error("Error in hourly jobs:", e); } }
async function monitorVirtualTrades() { const activeTrades = await getActiveVirtualTrades(); if (activeTrades.length === 0) return; const prices = await getCachedMarketPrices(); if (!prices || prices.error) return; for (const trade of activeTrades) { const currentPrice = prices[trade.instId]?.price; if (!currentPrice) continue; let finalStatus = null; let pnl = 0; let finalPrice = 0; if (currentPrice >= trade.targetPrice) { finalPrice = trade.targetPrice; pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice); finalStatus = 'completed'; const profitPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0; const msg = `🎯 *الهدف تحقق \\(توصية افتراضية\\)\\!* ✅\n\n` + `*العملة:* \`${sanitizeMarkdownV2(trade.instId)}\`\n` + `*سعر الدخول:* \`$${sanitizeMarkdownV2(formatSmart(trade.entryPrice))}\`\n` + `*سعر الهدف:* \`$${sanitizeMarkdownV2(formatSmart(trade.targetPrice))}\`\n\n` + `💰 *الربح المحقق:* \`+${sanitizeMarkdownV2(formatNumber(pnl))}\` \\(\`+${sanitizeMarkdownV2(formatNumber(profitPercent))}%\`\\)`; await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "MarkdownV2" }); } else if (currentPrice <= trade.stopLossPrice) { finalPrice = trade.stopLossPrice; pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice); finalStatus = 'stopped'; const lossPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0; const msg = `🛑 *تم تفعيل وقف الخسارة \\(توصية افتراضية\\)\\!* 🔻\n\n` + `*العملة:* \`${sanitizeMarkdownV2(trade.instId)}\`\n` + `*سعر الدخول:* \`$${sanitizeMarkdownV2(formatSmart(trade.entryPrice))}\`\n` + `*سعر الوقف:* \`$${sanitizeMarkdownV2(formatSmart(trade.stopLossPrice))}\`\n\n` + `💸 *الخسارة:* \`${sanitizeMarkdownV2(formatNumber(pnl))}\` \\(\`${sanitizeMarkdownV2(formatNumber(lossPercent))}%\`\\)`; await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "MarkdownV2" }); } if (finalStatus) { await updateVirtualTradeStatus(trade._id, finalStatus, finalPrice); } } }
async function formatDailyCopyReport() { const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000); const closedTrades = await getCollection("tradeHistory").find({ closedAt: { $gte: twentyFourHoursAgo } }).toArray(); if (closedTrades.length === 0) { return "📊 لم يتم إغلاق أي صفقات في الـ 24 ساعة الماضية."; } const today = new Date(); const dateString = `${today.getDate().toString().padStart(2, '0')}/${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getFullYear()}`; let report = `📊 تقرير النسخ اليومي – خلال الـ24 ساعة الماضية\n🗓 التاريخ: ${dateString}\n\n`; let totalPnlWeightedSum = 0; let totalWeight = 0; for (const trade of closedTrades) { if (trade.pnlPercent === undefined || trade.entryCapitalPercent === undefined) continue; const resultEmoji = trade.pnlPercent >= 0 ? '🔼' : '🔽'; report += `🔸اسم العملة: ${trade.asset}\n`; report += `🔸 نسبة الدخول من رأس المال: ${formatNumber(trade.entryCapitalPercent)}%\n`; report += `🔸 متوسط سعر الشراء: ${formatSmart(trade.avgBuyPrice)}\n`; report += `🔸 سعر الخروج: ${formatSmart(trade.avgSellPrice)}\n`; report += `🔸 نسبة الخروج من الكمية: ${formatNumber(trade.exitQuantityPercent)}%\n`; report += `🔸 النتيجة: ${trade.pnlPercent >= 0 ? '+' : ''}${formatNumber(trade.pnlPercent)}% ${resultEmoji}\n\n`; if (trade.entryCapitalPercent > 0) { totalPnlWeightedSum += trade.pnlPercent * trade.entryCapitalPercent; totalWeight += trade.entryCapitalPercent; } } const totalPnl = totalWeight > 0 ? totalPnlWeightedSum / totalWeight : 0; const totalPnlEmoji = totalPnl >= 0 ? '📈' : '📉'; report += `إجمالي الربح الحالي خدمة النسخ: ${totalPnl >= 0 ? '+' : ''}${formatNumber(totalPnl, 2)}% ${totalPnlEmoji}\n\n`; report += `✍️ يمكنك الدخول في اي وقت تراه مناسب، الخدمة مفتوحة للجميع\n\n`; report += `📢 قناة التحديثات الرسمية:\n@abusalamachart\n\n`; report += `🌐 رابط النسخ المباشر:\n🏦 https://t.me/abusalamachart`; return report; }
async function runDailyReportJob() { try { await sendDebugMessage("Running daily copy-trading report job..."); const report = await formatDailyCopyReport(); if (report.startsWith("📊 لم يتم إغلاق أي صفقات")) { await bot.api.sendMessage(AUTHORIZED_USER_ID, report); } else { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, report); await bot.api.sendMessage(AUTHORIZED_USER_ID, "✅ تم إرسال تقرير النسخ اليومي إلى القناة بنجاح."); } } catch(e) { console.error("Error in runDailyReportJob:", e); await bot.api.sendMessage(AUTHORIZED_USER_ID, `❌ حدث خطأ أثناء إنشاء تقرير النسخ اليومي: ${e.message}`); } }
async function generateAndSendCumulativeReport(ctx, asset) { try { const trades = await getCollection("tradeHistory").find({ asset: asset }).toArray(); if (trades.length === 0) { await ctx.reply(`ℹ️ لا يوجد سجل صفقات مغلقة لعملة *${sanitizeMarkdownV2(asset)}*\\.`, { parse_mode: "MarkdownV2" }); return; } const totalPnl = trades.reduce((sum, trade) => sum + (trade.pnl || 0), 0); const totalRoi = trades.reduce((sum, trade) => sum + (trade.pnlPercent || 0), 0); const avgRoi = trades.length > 0 ? totalRoi / trades.length : 0; const winningTrades = trades.filter(t => (t.pnl || 0) > 0).length; const winRate = trades.length > 0 ? (winningTrades / trades.length) * 100 : 0; const bestTrade = trades.reduce((max, trade) => (trade.pnlPercent || 0) > (max.pnlPercent || 0) ? trade : max, trades[0]); const worstTrade = trades.reduce((min, trade) => (min.pnlPercent !== undefined && (trade.pnlPercent || 0) < min.pnlPercent) ? trade : min, { pnlPercent: 0}); const impactSign = totalPnl >= 0 ? '+' : ''; const impactEmoji = totalPnl >= 0 ? '🟢' : '🔴'; const winRateEmoji = winRate >= 50 ? '✅' : '⚠️'; let report = `*تحليل الأثر التراكمي | ${sanitizeMarkdownV2(asset)}* 🔬\n\n`; report += `*الخلاصة الاستراتيجية:*\n`; report += `تداولاتك في *${sanitizeMarkdownV2(asset)}* أضافت ما قيمته \`${sanitizeMarkdownV2(impactSign)}${sanitizeMarkdownV2(formatNumber(totalPnl))}\` ${impactEmoji} إلى محفظتك بشكل تراكمي\\.\n\n`; report += `*ملخص الأداء التاريخي:*\n`; report += ` ▪️ *إجمالي الصفقات:* \`${trades.length}\`\n`; report += ` ▪️ *معدل النجاح \\(Win Rate\\):* \`${sanitizeMarkdownV2(formatNumber(winRate))}%\` ${winRateEmoji}\n`; report += ` ▪️ *متوسط العائد \\(ROI\\):* \`${sanitizeMarkdownV2(formatNumber(avgRoi))}%\`\n\n`; report += `*أبرز الصفقات:*\n`; report += ` 🏆 *أفضل صفقة:* ربح بنسبة \`${sanitizeMarkdownV2(formatNumber(bestTrade.pnlPercent))}%\`\n`; report += ` 💔 *أسوأ صفقة:* ${worstTrade.pnlPercent < 0 ? 'خسارة' : 'ربح'} بنسبة \`${sanitizeMarkdownV2(formatNumber(worstTrade.pnlPercent))}%\`\n\n`; report += `*توصية استراتيجية خاصة:*\n`; if (avgRoi > 5 && winRate > 60) { report += `أداء *${sanitizeMarkdownV2(asset)}* يتفوق على المتوسط بشكل واضح\\. قد تفكر في زيادة حجم صفقاتك المستقبلية فيها\\.`; } else if (totalPnl < 0) { report += `أداء *${sanitizeMarkdownV2(asset)}* سلبي\\. قد ترغب في مراجعة استراتيجيتك لهذه العملة أو تقليل المخاطرة فيها\\.`; } else { report += `أداء *${sanitizeMarkdownV2(asset)}* يعتبر ضمن النطاق المقبول\\. استمر في المراقبة والتحليل\\.`; } await ctx.reply(report, { parse_mode: "MarkdownV2" }); } catch(e) { console.error(`Error generating cumulative report for ${asset}:`, e); await ctx.reply("❌ حدث خطأ أثناء إنشاء التقرير\\."); } }

// =================================================================
// SECTION 6: BOT KEYBOARDS & MENUS
// =================================================================
const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("🚀 تحليل السوق").text("💡 توصية افتراضية").row()
    .text("⚡ إحصائيات سريعة").text("📈 تحليل تراكمي").row()
    .text("🔍 مراجعة الصفقات").text("🧠 تحليل بالذكاء الاصطناعي").row()
    .text("🧮 حاسبة الربح والخسارة").text("⚙️ الإعدادات").row()
    .resized();

const virtualTradeKeyboard = new InlineKeyboard()
    .text("➕ إضافة توصية جديدة", "add_virtual_trade").row()
    .text("📈 متابعة التوصيات الحية", "track_virtual_trades");

const aiKeyboard = new InlineKeyboard()
    .text("💼 تحليل المحفظة", "ai_analyze_portfolio")
    .text("🪙 تحليل عملة", "ai_analyze_coin").row()
    .text("📰 أخبار عامة", "ai_get_general_news")
    .text("📈 أخبار محفظتي", "ai_get_portfolio_news");

async function sendSettingsMenu(ctx) { const settings = await loadSettings(); const settingsKeyboard = new InlineKeyboard().text("💰 تعيين رأس المال", "set_capital").text("💼 عرض المراكز المفتوحة", "view_positions").row().text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts").text("🗑️ حذف تنبيه سعر", "delete_alert").row().text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").text(`🚀 النشر للقناة: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost").row().text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug").text("📊 إرسال تقرير النسخ", "send_daily_report").row().text("🔥 حذف جميع البيانات 🔥", "delete_all_data"); const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*"; try { if (ctx.callbackQuery) { await ctx.editMessageText(text, { parse_mode: "MarkdownV2", reply_markup: settingsKeyboard }); } else { await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: settingsKeyboard }); } } catch(e) { console.error("Error sending settings menu:", e); } }
async function sendMovementAlertsMenu(ctx) { const alertSettings = await loadAlertSettings(); const text = `🚨 *إدارة تنبيهات حركة الأسعار*\n\n\\- *النسبة العامة الحالية:* \`${alertSettings.global}%\`\\.\n\\- يمكنك تعيين نسبة مختلفة لعملة معينة\\.`; const keyboard = new InlineKeyboard().text("📊 تعديل النسبة العامة", "set_global_alert").text("💎 تعديل نسبة عملة", "set_coin_alert").row().text("🔙 العودة للإعدادات", "back_to_settings"); await ctx.editMessageText(text, { parse_mode: "MarkdownV2", reply_markup: keyboard }); }


// =================================================================
// SECTION 7: BOT HANDLERS (REFACTORED)
// =================================================================

// --- Middleware for Authentication ---
bot.use(async (ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) {
        await next();
    } else {
        console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`);
    }
});

// --- Command Handlers ---
bot.command("start", (ctx) => {
    const welcomeMessage = `🤖 *أهلاً بك في بوت التحليل المتكامل لمنصة OKX\\.*\n\n*اضغط على الأزرار أدناه للبدء\\!*`;
    ctx.reply(welcomeMessage, { parse_mode: "MarkdownV2", reply_markup: mainKeyboard });
});

bot.command("settings", (ctx) => sendSettingsMenu(ctx));

bot.command("pnl", async (ctx) => { const text = ctx.message.text || ''; const argsString = text.substring(text.indexOf(' ') + 1); const args = argsString.trim().split(/\s+/); if (args.length !== 3) { return await ctx.reply( `❌ *صيغة غير صحيحة\\.*\n*مثال:* \`/pnl <سعر الشراء> <سعر البيع> <الكمية>\`\n\n*مثلاً: /pnl 100 120 50*`, { parse_mode: "MarkdownV2" } ); } const [buyPrice, sellPrice, quantity] = args.map(parseFloat); if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) { return await ctx.reply("❌ *خطأ:* تأكد من أن جميع القيم هي أرقام موجبة وصحيحة\\."); } const investment = buyPrice * quantity; const saleValue = sellPrice * quantity; const pnl = saleValue - investment; const pnlPercent = (investment > 0) ? (pnl / investment) * 100 : 0; const status = pnl >= 0 ? "ربح ✅" : "خسارة 🔻"; const sign = pnl >= 0 ? '+' : ''; const msg = `🧮 *نتيجة حساب الربح والخسارة*\n\n` + ` ▪️ *إجمالي تكلفة الشراء:* \`$${sanitizeMarkdownV2(formatNumber(investment))}\`\n` + ` ▪️ *إجمالي قيمة البيع:* \`$${sanitizeMarkdownV2(formatNumber(saleValue))}\`\n` + `━━━━━━━━━━━━━━━━━━━━\n` + `*صافي الربح/الخسارة:* \`${sanitizeMarkdownV2(sign)}${sanitizeMarkdownV2(formatNumber(pnl))}\` \\(\`${sanitizeMarkdownV2(sign)}${sanitizeMarkdownV2(formatNumber(pnlPercent))}%\`\\)\n` + `**الحالة النهائية: ${status}**`; await ctx.reply(msg, { parse_mode: "MarkdownV2" }); });


// --- Text Message Handler ---
bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    if (waitingState) {
        const state = waitingState;
        waitingState = null;
        await handleWaitingState(ctx, state, text);
        return;
    }

    await handleTextMessage(ctx, text);
});

// --- Callback Query Handler ---
bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;
    await handleCallbackQuery(ctx, data);
});


// --- Refactored Handler Logic ---
async function handleTextMessage(ctx, text) {
    const loadingMessage = { id: null, chat_id: null };
    
    try {
        switch (text) {
            case "📊 عرض المحفظة":
                loadingMessage.id = (await ctx.reply("⏳ جاري إعداد التقرير...")).message_id;
                loadingMessage.chat_id = ctx.chat.id;
                const prices = await getCachedMarketPrices();
                if (prices.error) throw new Error(prices.error);
                const capital = await loadCapital();
                const { assets, total, error } = await okxAdapter.getPortfolio(prices);
                if (error) throw new Error(error);
                const { caption } = await formatPortfolioMsg(assets, total, capital);
                await ctx.api.editMessageText(loadingMessage.chat_id, loadingMessage.id, caption, { parse_mode: "MarkdownV2" });
                break;

            case "🚀 تحليل السوق":
                loadingMessage.id = (await ctx.reply("⏳ جاري تحليل السوق...")).message_id;
                loadingMessage.chat_id = ctx.chat.id;
                const marketPrices = await getCachedMarketPrices();
                if (marketPrices.error) throw new Error(marketPrices.error);
                const portfolioData = await okxAdapter.getPortfolio(marketPrices);
                if (portfolioData.error) throw new Error(portfolioData.error);
                const marketMsg = await formatAdvancedMarketAnalysis(portfolioData.assets);
                await ctx.api.editMessageText(loadingMessage.chat_id, loadingMessage.id, marketMsg, { parse_mode: "MarkdownV2" });
                break;
            
            case "🔍 مراجعة الصفقات":
                loadingMessage.id = (await ctx.reply("⏳ جارٍ جلب أحدث 5 صفقات مغلقة...")).message_id;
                loadingMessage.chat_id = ctx.chat.id;
                const closedTrades = await getCollection("tradeHistory").find({ quantity: { $exists: true } }).sort({ closedAt: -1 }).limit(5).toArray();
                if (closedTrades.length === 0) {
                    await ctx.api.editMessageText(loadingMessage.chat_id, loadingMessage.id, "ℹ️ لا يوجد سجل صفقات مغلقة \\(متوافقة\\) لمراجعتها\\.");
                    return;
                }
                const keyboard = new InlineKeyboard();
                closedTrades.forEach(trade => {
                    keyboard.text(`${trade.asset} | أغلق بسعر $${formatSmart(trade.avgSellPrice)}`, `review_trade_${trade._id}`).row();
                });
                await ctx.api.editMessageText(loadingMessage.chat_id, loadingMessage.id, "👇 *اختر صفقة من القائمة أدناه لمراجعتها:*", { parse_mode: "MarkdownV2", reply_markup: keyboard });
                break;

            case "💡 توصية افتراضية":
                await ctx.reply("اختر الإجراء المطلوب للتوصيات الافتراضية:", { reply_markup: virtualTradeKeyboard });
                break;

            case "⚡ إحصائيات سريعة":
                loadingMessage.id = (await ctx.reply("⏳ جاري حساب الإحصائيات...")).message_id;
                loadingMessage.chat_id = ctx.chat.id;
                const quickStatsPrices = await getCachedMarketPrices();
                if (quickStatsPrices.error) throw new Error(quickStatsPrices.error);
                const quickStatsCapital = await loadCapital();
                const quickStatsPortfolio = await okxAdapter.getPortfolio(quickStatsPrices);
                if (quickStatsPortfolio.error) throw new Error(quickStatsPortfolio.error);
                const quickStatsMsg = await formatQuickStats(quickStatsPortfolio.assets, quickStatsPortfolio.total, quickStatsCapital);
                await ctx.api.editMessageText(loadingMessage.chat_id, loadingMessage.id, quickStatsMsg, { parse_mode: "MarkdownV2" });
                break;
            
            case "📈 أداء المحفظة":
                const performanceKeyboard = new InlineKeyboard().text("آخر 24 ساعة", "chart_24h").text("آخر 7 أيام", "chart_7d").text("آخر 30 يومًا", "chart_30d");
                await ctx.reply("اختر الفترة الزمنية لعرض تقرير الأداء:", { reply_markup: performanceKeyboard });
                break;

            case "📈 تحليل تراكمي":
                waitingState = 'cumulative_analysis_asset';
                await ctx.reply("✍️ يرجى إرسال رمز العملة التي تود تحليلها \\(مثال: `BTC`\\)\\.");
                break;

            case "🧠 تحليل بالذكاء الاصطناعي":
                await ctx.reply("اختر نوع التحليل الذي تريده:", { reply_markup: aiKeyboard });
                break;
            
            case "🧮 حاسبة الربح والخسارة":
                await ctx.reply("✍️ لحساب الربح/الخسارة، استخدم أمر `/pnl` بالصيغة التالية:\n`/pnl <سعر الشراء> <سعر البيع> <الكمية>`", {parse_mode: "MarkdownV2"});
                break;

            case "⚙️ الإعدادات":
                await sendSettingsMenu(ctx);
                break;
        }
    } catch (e) {
        console.error(`Error in handleTextMessage for "${text}":`, e);
        const errorMessage = `❌ حدث خطأ: ${sanitizeMarkdownV2(e.message)}`;
        if (loadingMessage.id && loadingMessage.chat_id) {
            await ctx.api.editMessageText(loadingMessage.chat_id, loadingMessage.id, errorMessage, { parse_mode: "MarkdownV2"});
        } else {
            await ctx.reply(errorMessage, { parse_mode: "MarkdownV2"});
        }
    }
}

async function handleCallbackQuery(ctx, data) {
    try {
        if (data === "ai_get_general_news") {
            await ctx.editMessageText("📰 جاري جلب وتلخيص آخر الأخبار العامة...");
            const summary = await getAIGeneralNewsSummary();
            const sanitizedSummary = sanitizeMarkdownV2(summary);
            await ctx.editMessageText(`*📰 ملخص الأخبار العامة بالذكاء الاصطناعي*\n\n${sanitizedSummary}`, { parse_mode: "MarkdownV2" });
            return;
        }

        if (data === "ai_get_portfolio_news") {
            await ctx.editMessageText("📈 جاري جلب وتلخيص الأخبار المتعلقة بمحفظتك...");
            const summary = await getAIPortfolioNewsSummary();
            const sanitizedSummary = sanitizeMarkdownV2(summary);
            await ctx.editMessageText(`*📈 ملخص أخبار محفظتك بالذكاء الاصطناعي*\n\n${sanitizedSummary}`, { parse_mode: "MarkdownV2" });
            return;
        }
        
        if (data === "ai_analyze_portfolio") {
            await ctx.editMessageText("🧠 جاري طلب تحليل المحفظة من الذكاء الاصطناعي...");
            const prices = await getCachedMarketPrices();
            if (!prices || prices.error) return await ctx.editMessageText("❌ فشل جلب بيانات السوق\\.");
            const capital = await loadCapital();
            const { assets, total } = await okxAdapter.getPortfolio(prices);
            const aiResponse = await getAIAnalysisForPortfolio(assets, total, capital);
            const sanitizedResponse = sanitizeMarkdownV2(aiResponse);
            await ctx.editMessageText(`*🧠 تحليل الذكاء الاصطناعي \\- المحفظة*\n\n${sanitizedResponse}`, { parse_mode: "MarkdownV2" });
            return;
        }

        if (data === "ai_analyze_coin") {
            waitingState = "ai_ask_coin";
            await ctx.editMessageText("✍️ أرسل رمز العملة التي ترغب في تحليلها \\(مثل BTC\\)\\.");
            return;
        }

        if (data.startsWith("review_trade_")) {
            const tradeId = data.split('_')[2];
            await ctx.editMessageText(`⏳ جاري تحليل صفقة \`${sanitizeMarkdownV2(tradeId.substring(0, 8))}... \``);
            const trade = await getCollection("tradeHistory").findOne({ _id: tradeId });
            if (!trade || !trade.quantity) {
                await ctx.editMessageText("❌ لم يتم العثور على الصفقة أو أنها لا تحتوي على بيانات الكمية اللازمة للتحليل\\. \\(الصفقات القديمة قد لا تدعم هذه الميزة\\)\\.");
                return;
            }
            const prices = await getCachedMarketPrices();
            const currentPrice = prices[`${trade.asset}-USDT`]?.price;
            if (!currentPrice) {
                await ctx.editMessageText(`❌ تعذر جلب السعر الحالي لعملة ${sanitizeMarkdownV2(trade.asset)}\\.`);
                return;
            }
            const reviewMessage = formatClosedTradeReview(trade, currentPrice);
            await ctx.editMessageText(reviewMessage, { parse_mode: "MarkdownV2" });
            return;
        }

        if (data.startsWith("chart_")) {
            const period = data.split('_')[1];
            await ctx.editMessageText("⏳ جاري إنشاء تقرير الأداء المتقدم...");
            let history, periodLabel, bar, limit;
            if (period === '24h') { history = await loadHourlyHistory(); periodLabel = "آخر 24 ساعة"; bar = '1H'; limit = 24; }
            else if (period === '7d') { history = await loadHistory(); periodLabel = "آخر 7 أيام"; bar = '1D'; limit = 7; }
            else if (period === '30d') { history = await loadHistory(); periodLabel = "آخر 30 يومًا"; bar = '1D'; limit = 30; }
            else { return; }
            const portfolioHistory = (period === '24h' ? history.slice(-24) : history.slice(-limit));
            if (!portfolioHistory || portfolioHistory.length < 2) { await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة\\."); return; }
            const mappedHistory = portfolioHistory.map(h => ({ ...h, time: h.time || Date.parse(h.date || h.label)}));
            const btcHistoryCandles = await getHistoricalCandles('BTC-USDT', bar, limit);
            const report = await formatPerformanceReport(period, periodLabel, mappedHistory, btcHistoryCandles);
            
            try {
                if (report.error) { 
                    await ctx.editMessageText(report.error); 
                } else { 
                    await ctx.replyWithPhoto(report.chartUrl, { caption: report.caption, parse_mode: "MarkdownV2" }); 
                    await ctx.deleteMessage(); 
                }
            } catch (chartError) {
                console.error("Chart generation failed, sending text fallback:", chartError);
                await ctx.editMessageText(report.caption, { parse_mode: "MarkdownV2" });
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
                        await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, reportContent, { parse_mode: "MarkdownV2" });
                        const newText = privatePart.replace('*تم إغلاق المركز بنجاح\\. هل تود نشر الملخص في القناة؟*', '✅ *تم نشر التقرير بنجاح في القناة\\.*');
                        await ctx.editMessageText(newText, { reply_markup: undefined, parse_mode: 'MarkdownV2' });
                    }
                } else {
                    const newText = privatePart.replace('*تم إغلاق المركز بنجاح\\. هل تود نشر الملخص في القناة؟*', '❌ *تم تجاهل نشر التقرير\\.*');
                    await ctx.editMessageText(newText, { reply_markup: undefined, parse_mode: 'MarkdownV2' });
                }
            }
            return;
        }

        switch(data) {
            case "add_virtual_trade": waitingState = 'add_virtual_trade'; await ctx.editMessageText("✍️ *لإضافة توصية افتراضية، أرسل التفاصيل في 5 أسطر منفصلة:*\n\n`BTC-USDT`\n`65000` \\(سعر الدخول\\)\n`70000` \\(سعر الهدف\\)\n`62000` \\(وقف الخسارة\\)\n`1000` \\(المبلغ الافتراضي\\)\n\n**ملاحظة:** *لا تكتب كلمات مثل 'دخول' أو 'هدف'، فقط الأرقام والرمز\\.*", { parse_mode: "MarkdownV2" }); break;
            case "track_virtual_trades": await ctx.editMessageText("⏳ جاري جلب التوصيات النشطة..."); const activeTrades = await getActiveVirtualTrades(); if (activeTrades.length === 0) { await ctx.editMessageText("✅ لا توجد توصيات افتراضية نشطة حاليًا\\.", { reply_markup: virtualTradeKeyboard }); return; } const prices = await getCachedMarketPrices(); if (!prices || prices.error) { await ctx.editMessageText(`❌ فشل جلب الأسعار، لا يمكن متابعة التوصيات\\.`, { reply_markup: virtualTradeKeyboard }); return; } let reportMsg = "📈 *متابعة حية للتوصيات النشطة:*\n" + "━━━━━━━━━━━━━━━━━━━━\n"; for (const trade of activeTrades) { const currentPrice = prices[trade.instId]?.price; if (!currentPrice) { reportMsg += `*${sanitizeMarkdownV2(trade.instId)}:* \`لا يمكن جلب السعر الحالي\\.\`\n`; } else { const pnl = (currentPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice); const pnlPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0; const sign = pnl >= 0 ? '+' : ''; const emoji = pnl >= 0 ? '🟢' : '🔴'; reportMsg += `*${sanitizeMarkdownV2(trade.instId)}* ${emoji}\n` + ` ▫️ *الدخول:* \`$${sanitizeMarkdownV2(formatSmart(trade.entryPrice))}\`\n` + ` ▫️ *الحالي:* \`$${sanitizeMarkdownV2(formatSmart(currentPrice))}\`\n` + ` ▫️ *ربح/خسارة:* \`${sanitizeMarkdownV2(sign)}${sanitizeMarkdownV2(formatNumber(pnl))}\` \\(\`${sanitizeMarkdownV2(sign)}${sanitizeMarkdownV2(formatNumber(pnlPercent))}%\`\\)\n` + ` ▫️ *الهدف:* \`$${sanitizeMarkdownV2(formatSmart(trade.targetPrice))}\`\n` + ` ▫️ *الوقف:* \`$${sanitizeMarkdownV2(formatSmart(trade.stopLossPrice))}\`\n`; } reportMsg += "━━━━━━━━━━━━━━━━━━━━\n"; } await ctx.editMessageText(reportMsg, { parse_mode: "MarkdownV2", reply_markup: virtualTradeKeyboard }); break;
            case "set_capital": waitingState = 'set_capital'; await ctx.editMessageText("💰 يرجى إرسال المبلغ الجديد لرأس المال \\(رقم فقط\\)\\."); break;
            case "back_to_settings": await sendSettingsMenu(ctx); break;
            case "manage_movement_alerts": await sendMovementAlertsMenu(ctx); break;
            case "set_global_alert": waitingState = 'set_global_alert_state'; await ctx.editMessageText("✍️ يرجى إرسال النسبة العامة الجديدة \\(مثال: `5`\\)\\."); break;
            case "set_coin_alert": waitingState = 'set_coin_alert_state'; await ctx.editMessageText("✍️ يرجى إرسال رمز العملة والنسبة\\.\n*مثال:*\n`BTC 2.5`"); break;
            case "view_positions": const positions = await loadPositions(); if (Object.keys(positions).length === 0) { await ctx.editMessageText("ℹ️ لا توجد مراكز مفتوحة\\.", { reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") }); break; } let posMsg = "📄 *قائمة المراكز المفتوحة:*\n"; for (const symbol in positions) { const pos = positions[symbol]; posMsg += `\n\\- *${sanitizeMarkdownV2(symbol)}:* متوسط الشراء \`$${sanitizeMarkdownV2(formatSmart(pos.avgBuyPrice))}\``; } await ctx.editMessageText(posMsg, { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") }); break;
            case "delete_alert": const alerts = await loadAlerts(); if (alerts.length === 0) { await ctx.editMessageText("ℹ️ لا توجد تنبيهات مسجلة\\.", { reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") }); break; } let alertMsg = "🗑️ *اختر التنبيه لحذفه:*\n\n"; alerts.forEach((alert, i) => { alertMsg += `*${i + 1}\\.* \`${sanitizeMarkdownV2(alert.instId)} ${sanitizeMarkdownV2(alert.condition)} ${sanitizeMarkdownV2(alert.price)}\`\n`; }); alertMsg += "\n*أرسل رقم التنبيه الذي تود حذفه\\.*"; waitingState = 'delete_alert_number'; await ctx.editMessageText(alertMsg, { parse_mode: "MarkdownV2" }); break;
            case "toggle_summary": case "toggle_autopost": case "toggle_debug": const settings = await loadSettings(); if (data === 'toggle_summary') settings.dailySummary = !settings.dailySummary; else if (data === 'toggle_autopost') settings.autoPostToChannel = !settings.autoPostToChannel; else if (data === 'toggle_debug') settings.debugMode = !settings.debugMode; await saveSettings(settings); await sendSettingsMenu(ctx); break;
            case "send_daily_report": await ctx.editMessageText("⏳ جاري إنشاء وإرسال تقرير النسخ اليومي..."); await runDailyReportJob(); await sendSettingsMenu(ctx); break;
            case "delete_all_data": waitingState = 'confirm_delete_all'; await ctx.editMessageText("⚠️ *تحذير: هذا الإجراء لا يمكن التراجع عنه\\!* لحذف كل شيء، أرسل: `تأكيد الحذف`", { parse_mode: "MarkdownV2" }); break;
        }
    } catch (e) {
        console.error(`Error in handleCallbackQuery for "${data}":`, e);
        await ctx.editMessageText(`❌ حدث خطأ غير متوقع أثناء معالجة طلبك: ${sanitizeMarkdownV2(e.message)}`, { parse_mode: "MarkdownV2"});
    }
}

async function handleWaitingState(ctx, state, text) {
    try {
        switch (state) {
            case 'ai_ask_coin':
                const coin = text.toUpperCase();
                const loading = await ctx.reply(`🧠 جاري تحليل عملة ${sanitizeMarkdownV2(coin)} باستخدام الذكاء الاصطناعي...`);
                const aiResponse = await getAIAnalysisForAsset(coin);
                const sanitizedResponse = sanitizeMarkdownV2(aiResponse);
                await ctx.api.editMessageText(loading.chat.id, loading.message_id, `*🧠 تحليل الذكاء الاصطناعي \\| ${sanitizeMarkdownV2(coin)}*\n\n${sanitizedResponse}`, { parse_mode: "MarkdownV2" });
                break;
            case 'cumulative_analysis_asset':
                await generateAndSendCumulativeReport(ctx, text.toUpperCase());
                break;
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
                    await ctx.reply(`✅ *تمت إضافة التوصية الافتراضية بنجاح\\.*\n\nسيتم إعلامك عند تحقيق الهدف أو تفعيل وقف الخسارة\\.`, { parse_mode: "MarkdownV2" });
                } catch (e) {
                    await ctx.reply(`❌ *خطأ في إضافة التوصية:*\n${sanitizeMarkdownV2(e.message)}\n\nالرجاء المحاولة مرة أخرى بالتنسيق الصحيح\\.`, { parse_mode: "MarkdownV2"});
                }
                break;
            case 'set_capital':
                const amount = parseFloat(text);
                if (!isNaN(amount) && amount >= 0) {
                    await saveCapital(amount);
                    await ctx.reply(`✅ *تم تحديث رأس المال إلى:* \`$${sanitizeMarkdownV2(formatNumber(amount))}\``, { parse_mode: "MarkdownV2" });
                } else {
                    await ctx.reply("❌ مبلغ غير صالح\\.");
                }
                break;
            case 'set_global_alert_state':
                const percent = parseFloat(text);
                if (!isNaN(percent) && percent > 0) {
                    const alertSettingsGlobal = await loadAlertSettings();
                    alertSettingsGlobal.global = percent;
                    await saveAlertSettings(alertSettingsGlobal);
                    await ctx.reply(`✅ تم تحديث النسبة العامة لتنبيهات الحركة إلى \`${sanitizeMarkdownV2(percent)}%\`\\.`, { parse_mode: "MarkdownV2"});
                } else {
                    await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا موجبًا\\.");
                }
                break;
            case 'set_coin_alert_state':
                const parts_coin_alert = text.split(/\s+/);
                if (parts_coin_alert.length !== 2) {
                    await ctx.reply("❌ *صيغة غير صحيحة*\\. يرجى إرسال رمز العملة ثم النسبة\\.", { parse_mode: "MarkdownV2"});
                    return;
                }
                const [symbol_coin_alert, percentStr_coin_alert] = parts_coin_alert;
                const coinPercent = parseFloat(percentStr_coin_alert);
                if (isNaN(coinPercent) || coinPercent < 0) {
                    await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا\\.");
                    return;
                }
                const alertSettingsCoin = await loadAlertSettings();
                if (coinPercent === 0) {
                    delete alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()];
                    await ctx.reply(`✅ تم حذف الإعداد المخصص لـ *${sanitizeMarkdownV2(symbol_coin_alert.toUpperCase())}* وستتبع الآن النسبة العامة\\.`, { parse_mode: "MarkdownV2"});
                } else {
                    alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()] = coinPercent;
                    await ctx.reply(`✅ تم تحديث النسبة المخصصة لـ *${sanitizeMarkdownV2(symbol_coin_alert.toUpperCase())}* إلى \`${sanitizeMarkdownV2(coinPercent)}%\`\\.`, { parse_mode: "MarkdownV2"});
                }
                await saveAlertSettings(alertSettingsCoin);
                break;
            case 'confirm_delete_all':
                if (text === 'تأكيد الحذف') {
                    await getCollection("configs").deleteMany({});
                    await getCollection("virtualTrades").deleteMany({});
                    await getCollection("tradeHistory").deleteMany({});
                    await ctx.reply("✅ تم حذف جميع بياناتك\\.");
                } else {
                    await ctx.reply("❌ تم إلغاء الحذف\\.");
                }
                break;
            case 'set_alert':
                const parts_alert = text.trim().split(/\s+/);
                if (parts_alert.length !== 3) {
                    await ctx.reply("❌ صيغة غير صحيحة\\. مثال: `BTC > 50000`", { parse_mode: "MarkdownV2"});
                    return;
                }
                const [symbol, cond, priceStr] = parts_alert;
                if (cond !== '>' && cond !== '<') {
                    await ctx.reply("❌ الشرط غير صالح\\. استخدم `>` أو `<`\\.", { parse_mode: "MarkdownV2"});
                    return;
                }
                const price = parseFloat(priceStr);
                if (isNaN(price) || price <= 0) {
                    await ctx.reply("❌ السعر غير صالح\\.");
                    return;
                }
                const allAlerts = await loadAlerts();
                allAlerts.push({ instId: symbol.toUpperCase() + '-USDT', condition: cond, price: price });
                await saveAlerts(allAlerts);
                await ctx.reply(`✅ تم ضبط التنبيه: ${sanitizeMarkdownV2(symbol.toUpperCase())} ${sanitizeMarkdownV2(cond)} ${sanitizeMarkdownV2(price)}`, { parse_mode: "MarkdownV2" });
                break;
            case 'delete_alert_number':
                let currentAlerts = await loadAlerts();
                const index = parseInt(text) - 1;
                if (isNaN(index) || index < 0 || index >= currentAlerts.length) {
                    await ctx.reply("❌ رقم غير صالح\\.");
                    return;
                }
                currentAlerts.splice(index, 1);
                await saveAlerts(currentAlerts);
                await ctx.reply(`✅ تم حذف التنبيه\\.`);
                break;
        }
    } catch (e) {
        console.error(`Error in handleWaitingState for state "${state}":`, e);
        await ctx.reply(`❌ حدث خطأ أثناء معالجة إدخالك\\. يرجى المحاولة مرة أخرى\\.`, { parse_mode: "MarkdownV2"});
    }
}


// =================================================================
// SECTION 8: SERVER AND BOT INITIALIZATION
// =================================================================
app.get("/healthcheck", (req, res) => res.status(200).send("OK"));

async function startBot() {
    if (process.env.NODE_ENV === "production") {
        console.log("Starting server for health checks...");
        app.use(express.json());
        app.use(webhookCallback(bot, "express"));
        app.listen(PORT, () => {
            console.log(`Bot server is running on port ${PORT} and listening for health checks.`);
        });
    }

    try {
        await connectDB();
        console.log("MongoDB connected successfully.");

        if (process.env.NODE_ENV !== "production") {
            console.log("Starting bot in development mode (polling)...");
            await bot.start({
                drop_pending_updates: true,
            });
        }
        
        console.log("Bot is now fully operational for OKX.");

        // Start background jobs
        console.log("Starting OKX background jobs...");
        setInterval(trackPositionHighLow, 60 * 1000);
        setInterval(checkPriceAlerts, 30 * 1000);
        setInterval(checkPriceMovements, 60 * 1000);
        setInterval(monitorVirtualTrades, 30 * 1000);
        setInterval(runHourlyJobs, 60 * 60 * 1000);
        setInterval(runDailyJobs, 24 * 60 * 60 * 1000);
        setInterval(runDailyReportJob, 24 * 60 * 60 * 1000);

      console.log("Running initial jobs on startup...");
        await runHourlyJobs();
        await runDailyJobs();
        
        // Start real-time monitoring
        connectToOKXSocket();

        await bot.api.sendMessage(AUTHORIZED_USER_ID, "✅ *تم إعادة تشغيل البوت بنجاح \\(v143\\.4 \\- Fully Sanitized\\)*\n\n\\- تم إصلاح آلية تحليل الرسائل بشكل كامل لمنع أخطاء التنسيق\\.", { parse_mode: "MarkdownV2" }).catch(console.error);

    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
        process.exit(1);
    }
}

// =================================================================
// SECTION 9: WEBSOCKET MANAGER (NEW)
// =================================================================
function connectToOKXSocket() {
    const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/private');

    ws.on('open', () => {
        console.log("OKX WebSocket Connected! Authenticating...");
        const timestamp = (Date.now() / 1000).toString();
        const prehash = timestamp + 'GET' + '/users/self/verify';
        const sign = crypto.createHmac("sha256", OKX_CONFIG.apiSecret).update(prehash).digest("base64");
        
        ws.send(JSON.stringify({
            op: "login",
            args: [{
                apiKey: OKX_CONFIG.apiKey,
                passphrase: OKX_CONFIG.passphrase,
                timestamp: timestamp,
                sign: sign,
            }]
        }));
    });

    ws.on('message', async (data) => {
        const rawData = data.toString();
        
        if (rawData === 'pong') {
            return;
        }

        try { 
            const message = JSON.parse(rawData);
            
            if (message.event === 'login' && message.code === '0') {
                console.log("WebSocket Authenticated successfully! Subscribing to account channel...");
                ws.send(JSON.stringify({
                    op: "subscribe",
                    args: [{
                        channel: "account"
                    }]
                }));
            }

            if (message.arg?.channel === 'account' && message.data) {
                console.log("Real-time balance update received via WebSocket.");
                await sendDebugMessage("تحديث لحظي للرصيد، جاري المعالجة...");
                await monitorBalanceChanges();
            }

        } catch (error) {
            console.error("Error processing WebSocket message:", error);
        }
    });

    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send('ping');
        }
    }, 25000);

    ws.on('close', () => {
        console.log("OKX WebSocket Disconnected. Reconnecting in 5 seconds...");
        clearInterval(pingInterval);
        setTimeout(connectToOKXSocket, 5000);
    });

    ws.on('error', (err) => {
        console.error("OKX WebSocket Error:", err);
    });
}


startBot();

