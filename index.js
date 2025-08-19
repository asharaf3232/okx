
// =================================================================
// Advanced Analytics Bot - v136.0 (Grammy Version + P&L Calculator)
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
            return { error: "خطأ استثنائي عند جلب أسعار السوق." }; 
        }
    }

    async getPortfolio(prices) {
        try {
            const path = "/api/v5/account/balance";
            const res = await fetch(`${this.baseURL}${path}`, { headers: this.getHeaders("GET", path) });
            const json = await res.json();

            if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) { 
                return { error: `فشل جلب المحفظة: ${json.msg || 'بيانات غير متوقعة'}` }; 
            }

            let assets = [], total = 0, usdtValue = 0;
            json.data[0].details.forEach(asset => {
                const amount = parseFloat(asset.eq);
                if (amount > 0) {
                    const instId = `${asset.ccy}-USDT`;
                    const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 };
                    const value = amount * priceData.price;
                    total += value;
                    if (asset.ccy === "USDT") usdtValue = value;
                    if (value >= 1) assets.push({ 
                        asset: asset.ccy, 
                        price: priceData.price, 
                        value, 
                        amount, 
                        change24h: priceData.change24h 
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
            const res = await fetch(`${this.baseURL}${path}`, { headers: this.getHeaders("GET", path) });
            const json = await res.json();

            if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) { 
                return null; 
            }

            const balances = {};
            json.data[0].details.forEach(asset => {
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
        await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true }); 
    } catch (e) { 
        console.error(`Error in saveConfig for id: ${id}`, e); 
    } 
}

async function saveClosedTrade(tradeData) { 
    try { 
        await getCollection("tradeHistory").insertOne({ 
            ...tradeData, 
            closedAt: new Date(), 
            _id: new crypto.randomBytes(16).toString("hex") 
        }); 
    } catch (e) { 
        console.error("Error in saveClosedTrade:", e); 
    } 
}

async function getHistoricalPerformance(asset) { 
    try { 
        const history = await getCollection("tradeHistory").find({ asset: asset }).toArray(); 
        if (history.length === 0) { 
            return { realizedPnl: 0, tradeCount: 0, winningTrades: 0, losingTrades: 0, avgDuration: 0 }; 
        } 
        const realizedPnl = history.reduce((sum, trade) => sum + trade.pnl, 0); 
        const winningTrades = history.filter(trade => trade.pnl > 0).length; 
        const losingTrades = history.filter(trade => trade.pnl <= 0).length; 
        const totalDuration = history.reduce((sum, trade) => sum + trade.durationDays, 0); 
        const avgDuration = history.length > 0 ? totalDuration / history.length : 0; 
        return { realizedPnl, tradeCount: history.length, winningTrades, losingTrades, avgDuration }; 
    } catch (e) { 
        return null; 
    } 
}

const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadSettings = async () => await getConfig("settings", { dailySummary: true, autoPostToChannel: false, debugMode: false, dailyReportTime: "22:00" });
const saveSettings = (settings) => saveConfig("settings", settings);
const loadPositions = async () => await getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);

function formatNumber(num, decimals = 2) { 
    const number = parseFloat(num); 
    if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals); 
    return number.toFixed(decimals); 
}

// =================================================================
// SECTION 2: P&L CALCULATION FUNCTIONS
// =================================================================

// Calculate P&L for open positions
async function calculateOpenPositionPnL() {
    try {
        const positions = await loadPositions();
        if (Object.keys(positions).length === 0) {
            return { message: "لا توجد مراكز مفتوحة حالياً", positions: [] };
        }

        const prices = await okxAdapter.getMarketPrices();
        if (!prices || prices.error) {
            return { error: "فشل جلب أسعار السوق", positions: [] };
        }

        let totalPnL = 0;
        let positionsData = [];

        for (const symbol in positions) {
            const position = positions[symbol];
            const currentPrice = prices[`${symbol}-USDT`]?.price;

            if (!currentPrice) continue;

            // Calculate unrealized P&L
            const unrealizedPnL = (currentPrice - position.avgBuyPrice) * position.totalAmountBought;
            const unrealizedPnLPercent = position.totalCost > 0 ? (unrealizedPnL / position.totalCost) * 100 : 0;

            totalPnL += unrealizedPnL;

            positionsData.push({
                symbol,
                avgBuyPrice: position.avgBuyPrice,
                currentPrice,
                amount: position.totalAmountBought,
                unrealizedPnL,
                unrealizedPnLPercent,
                highestPrice: position.highestPrice || currentPrice,
                lowestPrice: position.lowestPrice || currentPrice
            });
        }

        return {
            totalPnL,
            totalPnLPercent: positions.reduce((sum, pos) => sum + pos.unrealizedPnLPercent, 0) / positions.length || 0,
            positions: positionsData
        };
    } catch (error) {
        console.error("Error calculating open positions P&L:", error);
        return { error: "حدث خطأ أثناء حساب الربح والخسارة للمراكز المفتوحة", positions: [] };
    }
}

// Calculate P&L for closed trades
async function calculateClosedTradesPnL(asset = null) {
    try {
        let filter = {};
        if (asset) {
            filter.asset = asset.toUpperCase();
        }

        const trades = await getCollection("tradeHistory").find(filter).sort({ closedAt: -1 }).toArray();

        if (trades.length === 0) {
            return { 
                message: asset ? `لا يوجد تاريخ صفقات مغلقة لعملة ${asset}` : "لا يوجد تاريخ صفقات مغلقة",
                trades: [] 
            };
        }

        let totalPnL = 0;
        let tradesData = [];

        trades.forEach(trade => {
            totalPnL += trade.pnl;
            tradesData.push({
                asset: trade.asset,
                avgBuyPrice: trade.avgBuyPrice,
                avgSellPrice: trade.avgSellPrice,
                amount: trade.quantity || 1, // Use quantity if available, otherwise default to 1
                pnl: trade.pnl,
                pnlPercent: trade.pnlPercent,
                duration: trade.durationDays,
                closedAt: trade.closedAt
            });
        });

        return {
            totalPnL,
            totalPnLPercent: trades.reduce((sum, trade) => sum + trade.pnlPercent, 0) / trades.length || 0,
            trades: tradesData
        };
    } catch (error) {
        console.error("Error calculating closed trades P&L:", error);
        return { error: "حدث خطأ أثناء حساب الربح والخسارة للصفقات المغلقة", trades: [] };
    }
}

// Format P&L results for display
function formatPnLDisplay(data, type = "open") {
    if (data.error) {
        return `❌ ${data.error}`;
    }

    if (type === "open") {
        if (data.positions.length === 0) {
            return data.message || "ℹ️ لا توجد مراكز مفتوحة";
        }

        let msg = `📊 *حاسبة الربح والخسارة للمراكز المفتوحة*

`;
        msg += `*إجمالي الربح/الخسارة:* ${data.totalPnL >= 0 ? '🟢' : '🔴'} \`${data.totalPnL >= 0 ? '+' : ''}$${formatNumber(data.totalPnL)}\` (${data.totalPnLPercent >= 0 ? '+' : ''}${formatNumber(data.totalPnLPercent)}%)

`;

        data.positions.forEach(pos => {
            const status = pos.unrealizedPnL >= 0 ? '🟢 ربح' : '🔴 خسارة';
            msg += `*${pos.symbol}*
`;
            msg += `▪️ *متوسط الشراء:* \`$${formatNumber(pos.avgBuyPrice, 4)}\`
`;
            msg += `▪️ *السعر الحالي:* \`$${formatNumber(pos.currentPrice, 4)}\`
`;
            msg += `▪️ *الربح/الخسارة:* ${status} \`${pos.unrealizedPnL >= 0 ? '+' : ''}$${formatNumber(pos.unrealizedPnL)}\` (${pos.unrealizedPnLPercent >= 0 ? '+' : ''}${formatNumber(pos.unrealizedPnLPercent)}%)
`;
            msg += `▪️ *الكمية:* \`${formatNumber(pos.amount)}\`
`;
            msg += `▪️ *المدى:* \`$${formatNumber(pos.lowestPrice, 4)} - $${formatNumber(pos.highestPrice, 4)}\`

`;
        });

        return msg;
    } else {
        if (data.trades.length === 0) {
            return data.message || "ℹ️ لا يوجد تاريخ صفقات مغلقة";
        }

        let msg = `📊 *حاسبة الربح والخسارة للصفقات المغلقة*

`;
        msg += `*إجمالي الربح/الخسارة:* ${data.totalPnL >= 0 ? '🟢' : '🔴'} \`${data.totalPnL >= 0 ? '+' : ''}$${formatNumber(data.totalPnL)}\` (${data.totalPnLPercent >= 0 ? '+' : ''}${formatNumber(data.totalPnLPercent)}%)

`;

        data.trades.forEach((trade, index) => {
            const status = trade.pnl >= 0 ? '🟢 ربح' : '🔴 خسارة';
            msg += `*${index + 1}. ${trade.asset}*
`;
            msg += `▪️ *متوسط الشراء:* \`$${formatNumber(trade.avgBuyPrice, 4)}\`
`;
            msg += `▪️ *متوسط البيع:* \`$${formatNumber(trade.avgSellPrice, 4)}\`
`;
            msg += `▪️ *الربح/الخسارة:* ${status} \`${trade.pnl >= 0 ? '+' : ''}$${formatNumber(trade.pnl)}\` (${trade.pnlPercent >= 0 ? '+' : ''}${formatNumber(trade.pnlPercent)}%)
`;
            msg += `▪️ *الكمية:* \`${formatNumber(trade.amount)}\`
`;
            msg += `▪️ *مدة التداول:* \`${formatNumber(trade.duration)} يوم\`
`;
            msg += `▪️ *تاريخ الإغلاق:* \`${new Date(trade.closedAt).toLocaleDateString('ar-EG')}\`

`;
        });

        return msg;
    }
}

// =================================================================
// SECTION 3: BOT COMMANDS AND HANDLERS
// =================================================================

// Main keyboard with P&L calculator button
const mainKeyboard = new Keyboard()
.text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
.text("🚀 تحليل السوق").text("💡 توصية افتراضية").row()
.text("⚡ إحصائيات سريعة").text("📈 تحليل تراكمي").row()
.text("🔍 مراجعة الصفقات").text("🧮 حاسبة الربح والخسارة").row()
.text("⚙️ الإعدادات").resized();

// P&L calculator keyboard
const pnlCalculatorKeyboard = new InlineKeyboard()
.text("📊 حساب الربح والخسارة للمراكز المفتوحة", "calculate_open_pnl")
.text("📉 حساب الربح والخسارة للصفقات المغلقة", "calculate_closed_pnl")
.row()
.text("📊 حساب الربح والخسارة لعملة معينة (مغلقة)", "calculate_asset_pnl")
.text("🔙 العودة للقائمة الرئيسية", "back_to_main");

// Bot authorization
bot.use(async (ctx, next) => { 
    if (ctx.from?.id === AUTHORIZED_USER_ID) { 
        await next(); 
    } else { 
        console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`); 
    } 
});

// Start command
bot.command("start", (ctx) => { 
    const welcomeMessage = `🤖 *أهلاً بك في بوت التحليل المتكامل لمنصة OKX.*

` + 
    `*اضغط على الأزرار أدناه للبدء!*`; 
    ctx.reply(welcomeMessage, { parse_mode: "Markdown", reply_markup: mainKeyboard }); 
});

// P&L calculator command
bot.command("pnl", async (ctx) => {
    const text = ctx.message.text || '';
    const argsString = text.substring(text.indexOf(' ') + 1);
    const args = argsString.trim().split(/\s+/);

    if (args.length > 0 && args[0].toLowerCase() !== "open" && args[0].toLowerCase() !== "closed") {
        // Calculate P&L for a specific asset
        const asset = args[0];
        await ctx.reply(`⏳ جاري حساب الربح والخسارة لعملة ${asset}...`);

        const pnlData = await calculateClosedTradesPnL(asset);
        const display = formatPnLDisplay(pnlData, "closed");

        await ctx.reply(display, { parse_mode: "Markdown" });
    } else {
        // Show P&L calculator menu
        await ctx.reply("🧮 *حاسبة الربح والخسارة*\n\nاختر نوع الحساب الذي تريد إجراؤه:", {
            parse_mode: "Markdown",
            reply_markup: pnlCalculatorKeyboard
        });
    }
});

// Handle callback queries
bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;

    try {
        switch(data) {
            case "calculate_open_pnl":
                await ctx.editMessageText("⏳ جاري حساب الربح والخسارة للمراكز المفتوحة...");
                const openPnLData = await calculateOpenPositionPnL();
                const openPnLDisplay = formatPnLDisplay(openPnLData, "open");
                await ctx.editMessageText(openPnLDisplay, { parse_mode: "Markdown" });
                break;

            case "calculate_closed_pnl":
                await ctx.editMessageText("⏳ جاري حساب الربح والخسارة للصفقات المغلقة...");
                const closedPnLData = await calculateClosedTradesPnL();
                const closedPnLDisplay = formatPnLDisplay(closedPnLData, "closed");
                await ctx.editMessageText(closedPnLDisplay, { parse_mode: "Markdown" });
                break;

            case "calculate_asset_pnl":
                waitingState = "calculate_asset_pnl";
                await ctx.editMessageText("✍️ يرجى إرسال رمز العملة التي تريد حساب الربح والخسارة لها (مثال: `BTC`).");
                break;

            case "back_to_main":
                await ctx.editMessageText("⏳ جاري العودة للقائمة الرئيسية...");
                setTimeout(() => {
                    ctx.reply("الرجاء اختيار خيار من القائمة الرئيسية:", { reply_markup: mainKeyboard });
                }, 1000);
                break;
        }
    } catch (error) {
        console.error("Error in callback_query handler:", error);
        try {
            await ctx.reply("❌ حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى.");
        } catch (e) {
            console.error("Failed to send error message to user:", e);
        }
    }
});

// Handle text input for asset-specific P&L calculation
bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    if (waitingState === "calculate_asset_pnl") {
        waitingState = null;

        const asset = text.toUpperCase();
        if (!asset || asset.length < 2) {
            await ctx.reply("❌ رمز العملة غير صالح. يرجى إدخال رمز صحيح (مثال: BTC).");
            return;
        }

        await ctx.reply(`⏳ جاري حساب الربح والخسارة لعملة ${asset}...`);

        const pnlData = await calculateClosedTradesPnL(asset);
        const display = formatPnLDisplay(pnlData, "closed");

        await ctx.reply(display, { parse_mode: "Markdown" });
    }
});

// =================================================================
// SECTION 4: SERVER AND BOT INITIALIZATION
// =================================================================
app.get("/healthcheck", (req, res) => res.status(200).send("OK"));

async function startBot() {
    try {
        await connectDB();
        console.log("MongoDB connected.");

        if (process.env.NODE_ENV === "production") {
            app.use(express.json());
            app.use(webhookCallback(bot, "express"));
            app.listen(PORT, () => { 
                console.log(`Bot server is running on port ${PORT}`); 
            });
        } else {
            console.log("Bot starting with polling...");
            await bot.start({
                drop_pending_updates: true,
            });
        }

        console.log("Bot is now fully operational for OKX.");

        // Send startup notification
        await bot.api.sendMessage(AUTHORIZED_USER_ID, "✅ *تم إعادة تشغيل البوت بنجاح*\n\nتم تفعيل المراقبة المتقدمة لمنصة OKX.", {
            parse_mode: "Markdown"
        }).catch(console.error);
    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
        process.exit(1);
    }
}

startBot();
