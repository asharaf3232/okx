// =================================================================
// Advanced Analytics Bot - v139.1 (News Function Fixed)
// =================================================================
// --- IMPORTS ---
const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
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

// --- State Variables ---
let waitingState = null;

// --- AI Setup ---
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

// =================================================================
// SECTION 1: OKX API ADAPTER
// =================================================================
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
                    const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 };
                    const value = amount * priceData.price;
                    total += value;
                    if (asset.ccy === "USDT") usdtValue = value;
                    if (value >= 1) {
                        assets.push({ asset: asset.ccy, price: priceData.price, value, amount, change24h: priceData.change24h });
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
const saveAlerts = (alerts) => saveConfig("priceAlerts", alerts);
const loadAlertSettings = async () => await getConfig("alertSettings", { global: 5, overrides: {} });
const saveAlertSettings = (settings) => saveConfig("alertSettings", settings);
const loadPriceTracker = async () => await getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => saveConfig("priceTracker", tracker);

// --- Utility Functions ---
const formatNumber = (num, decimals = 2) => { const number = parseFloat(num); return isNaN(number) || !isFinite(number) ? (0).toFixed(decimals) : number.toFixed(decimals); };
const sendDebugMessage = async (message) => { const settings = await loadSettings(); if (settings.debugMode) { try { await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug (OKX):* ${message}`, { parse_mode: "Markdown" }); } catch (e) { console.error("Failed to send debug message:", e); } } };
const sanitizeMarkdownV2 = (text) => { if (!text) return ''; const charsToEscape = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!']; let sanitizedText = text; for (const char of charsToEscape) { sanitizedText = sanitizedText.replace(new RegExp('\\' + char, 'g'), '\\' + char); } return sanitizedText; };

// Placeholder for formatting functions (SECTION 3) - Keep them as they are, they are well-structured.
function formatPortfolioMsg(assets, total, capital) { /* ... Original Code ... */ }
// ... All other format... functions from the original code go here ...


// =================================================================
// SECTION 3: DATA PROCESSING & AI ANALYSIS
// =================================================================

// --- Market Data Processing ---
async function getInstrumentDetails(instId) { /* ... Original Code ... */ }
async function getHistoricalCandles(instId, bar = '1D', limit = 100) { /* ... Original Code ... */ }
async function getAssetPriceExtremes(instId) { /* ... Original Code ... */ }
function calculateSMA(closes, period) { /* ... Original Code ... */ }
function calculateRSI(closes, period = 14) { /* ... Original Code ... */ }
async function getTechnicalAnalysis(instId) { /* ... Original Code ... */ }
function calculatePerformanceStats(history) { /* ... Original Code ... */ }
function createChartUrl(data, type = 'line', title = '', labels = [], dataLabel = '') { /* ... Original Code ... */ }

// --- AI Analysis Services ---
async function analyzeWithAI(prompt) {
    try {
        // This base prompt sets the persona and adds the disclaimer.
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

async function getAIAnalysisForAsset(asset) { /* ... Original Code ... */ }
async function getAIAnalysisForPortfolio(assets, total, capital) { /* ... Original Code ... */ }

// --- News Service (IMPROVED) ---
async function getLatestCryptoNews(searchQuery) {
    try {
        const apiKey = process.env.NEWS_API_KEY;
        if (!apiKey) throw new Error("NEWS_API_KEY is not configured.");
        
        // Get today's date minus 3 days for the 'from' parameter for recent news
        const fromDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        // REMOVED '&language=ar' to get a wider range of news (mostly English).
        // The AI will handle the translation and summarization in Arabic.
        // CHANGED 'sortBy' to 'relevancy' to get more accurate articles.
        const url = `https://newsapi.org/v2/everything?q=(${searchQuery})&sortBy=relevancy&from=${fromDate}&pageSize=10&apiKey=${apiKey}`;
        
        const res = await fetch(url);
        const data = await res.json();

        if (data.status !== 'ok') {
            if (data.code === 'apiKeyInvalid' || data.code === 'apiKeyMissing') {
                 throw new Error("مفتاح NewsAPI غير صالح أو مفقود. يرجى التحقق من إعداداتك.");
            }
            throw new Error(`NewsAPI error: ${data.message}`);
        }
        
        // Return more data for the AI to process, including content.
        return data.articles.map(article => ({
            title: article.title,
            source: article.source.name,
            content: article.content || article.description, // Prefer content over description for better summary
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

    // The articles are now likely in English, so we need to instruct the AI accordingly.
    const articlesForPrompt = newsArticles.map(a => `Source: ${a.source}\nTitle: ${a.title}\nContent: ${a.content}`).join('\n\n---\n\n');
    
    // New, more detailed prompt for the AI
    const prompt = `You are an expert news editor. The following is a list of recent news articles, likely in English. Your task is to:
1. Identify the 3-4 most important news items related to the cryptocurrency market.
2. Summarize them concisely in PROFESSIONAL ARABIC.
3. Based on these summaries, write a short paragraph in ARABIC about the general market sentiment (e.g., bullish, bearish, uncertain).

News Articles:\n${articlesForPrompt}`;

    return await analyzeWithAI(prompt);
}

async function getAIPortfolioNewsSummary() {
    const prices = await okxAdapter.getMarketPrices();
    if (prices.error) throw new Error("فشل جلب أسعار السوق لتحليل أخبار المحفظة.");
    const { assets, error } = await okxAdapter.getPortfolio(prices);
    if (error) throw new Error("فشل جلب المحفظة لتحليل الأخبار.");

    const cryptoAssets = assets.filter(a => a.asset !== "USDT");
    if (cryptoAssets.length === 0) {
        return "ℹ️ لا تحتوي محفظتك على عملات رقمية لجلب أخبار متعلقة بها.";
    }

    // Make the search query more specific to get relevant news
    const assetSymbols = cryptoAssets.map(a => `"${a.asset} crypto"`).join(' OR '); 
    
    const newsArticles = await getLatestCryptoNews(assetSymbols);
    if (newsArticles.error) return `❌ فشل في جلب الأخبار: ${newsArticles.error}`;
    if (newsArticles.length === 0) return `ℹ️ لم يتم العثور على أخبار حديثة متعلقة بأصول محفظتك (${assetSymbols.replace(/"/g, '').replace(/ crypto/g, '')}).`;
    
    const articlesForPrompt = newsArticles.map(a => `Source: ${a.source}\nTitle: ${a.title}\nContent: ${a.content}`).join('\n\n---\n\n');
    
    // New, more detailed prompt for the AI
    const prompt = `You are a personal financial advisor. My portfolio contains the following assets: ${assetSymbols}. Below is a list of recent news articles, likely in English. Your task is to:
1. Summarize the most important news from the list that could affect my investments.
2. Explain the potential impact of each news item simply.
3. All your output MUST be in PROFESSIONAL ARABIC.

News Articles:\n${articlesForPrompt}`;

    return await analyzeWithAI(prompt);
}


// =================================================================
// SECTION 4: BACKGROUND JOBS & DYNAMIC MANAGEMENT
// =================================================================
// All background job functions (monitorBalanceChanges, trackPositionHighLow, etc.) go here.
// They are mostly well-contained and can be kept as they are.
async function monitorBalanceChanges() { /* ... Original Code ... */ }
// ... All other job functions should be here.


// =================================================================
// SECTION 5: BOT KEYBOARDS & MENUS
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

async function sendSettingsMenu(ctx) { /* ... Original Code ... */ }
async function sendMovementAlertsMenu(ctx) { /* ... Original Code ... */ }


// =================================================================
// SECTION 6: BOT HANDLERS (REFACTORED)
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
    const welcomeMessage = `🤖 *أهلاً بك في بوت التحليل المتكامل لمنصة OKX.*\n\n*اضغط على الأزرار أدناه للبدء!*`;
    ctx.reply(welcomeMessage, { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

bot.command("settings", (ctx) => sendSettingsMenu(ctx));
bot.command("pnl", async (ctx) => { /* ... Original Code ... */ });


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
async function handleTextMessage(ctx, text) { /* ... Original Refactored Code ... */ }

async function handleCallbackQuery(ctx, data) {
    try {
        // --- AI News Summary Handlers ---
        if (data === "ai_get_general_news") {
            await ctx.editMessageText("📰 جاري جلب وتلخيص آخر الأخبار العامة...");
            const summary = await getAIGeneralNewsSummary();
            await ctx.editMessageText(`*📰 ملخص الأخبار العامة بالذكاء الاصطناعي*\n\n${summary}`, { parse_mode: "Markdown" });
            return;
        }

        if (data === "ai_get_portfolio_news") {
            await ctx.editMessageText("📈 جاري جلب وتلخيص الأخبار المتعلقة بمحفظتك...");
            const summary = await getAIPortfolioNewsSummary();
            await ctx.editMessageText(`*📈 ملخص أخبار محفظتك بالذكاء الاصطناعي*\n\n${summary}`, { parse_mode: "Markdown" });
            return;
        }
        
        if (data.startsWith("chart_")) {
            // Handle chart callbacks
        } else if (data.startsWith("review_trade_")) {
            // Handle trade review callbacks
        } else {
            // Handle other static callbacks
            switch(data) {
                case "ai_analyze_portfolio":
                    // ... logic
                    break;
                case "ai_analyze_coin":
                    waitingState = "ai_ask_coin";
                    await ctx.editMessageText("✍️ أرسل رمز العملة التي ترغب في تحليلها (مثل BTC).");
                    break;
                // ... other cases
            }
        }
    } catch (e) {
        console.error(`Error in handleCallbackQuery for "${data}":`, e);
        await ctx.editMessageText(`❌ حدث خطأ غير متوقع أثناء معالجة طلبك: ${e.message}`);
    }
}

async function handleWaitingState(ctx, state, text) { /* ... Original Refactored Code ... */ }


// =================================================================
// SECTION 7: SERVER AND BOT INITIALIZATION
// =================================================================
app.get("/healthcheck", (req, res) => res.status(200).send("OK"));

async function startBot() {
    try {
        await connectDB();
        console.log("MongoDB connected successfully.");

        if (process.env.NODE_ENV === "production") {
            console.log("Starting bot in production mode (webhook)...");
            app.use(express.json());
            app.use(webhookCallback(bot, "express"));
            app.listen(PORT, () => {
                console.log(`Bot server is running on port ${PORT}`);
            });
        } else {
            console.log("Starting bot in development mode (polling)...");
            await bot.start({
                drop_pending_updates: true,
            });
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

        console.log("Running initial jobs on startup...");
        await runHourlyJobs();
        await runDailyJobs();
        await monitorBalanceChanges();

        await bot.api.sendMessage(AUTHORIZED_USER_ID, "✅ *تم إعادة تشغيل البوت بنجاح (نسخة v2)*\n\nتم إصلاح وتحسين وظيفة تحليل الأخبار.", { parse_mode: "Markdown" }).catch(console.error);

    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
        process.exit(1);
    }
}

startBot();
