
// =================================================================
// Advanced Analytics Bot - v134.1 (Robust Coin Info) + PnL Alerts + Cooldown
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
const AUTHORIZED_USER_ID = parseInt(process.env.AUTORIZED_USER_ID || process.env.AUTHORIZED_USER_ID);

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
        !json.data[0].details
      ) {
        return {
          error: `فشل جلب المحفظة: ${json.msg || "بيانات غير متوقعة"}`,
        };
      }
      let assets = [],
        total = 0,
        usdtValue = 0;
      json.data[0].details.forEach((asset) => {
        const amount = parseFloat(asset.eq);
        if (amount > 0) {
          const instId = `${asset.ccy}-USDT`;
          const priceData =
            prices[instId] || {
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
        !json.data[0].details
      ) {
        return null;
      }
      const balances = {};
      json.data[0].details.forEach((asset) => {
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
    return await getCollection("virtualTrades").find({ status: "active" }).toArray();
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

// تنبيهات الحركة: إضافة حقول جديدة افتراضيًا
const loadAlertSettings = async () =>
  await getConfig("alertSettings", {
    global: 5,
    overrides: {},
    cooldownMinutes: 15, // مهلة افتراضية
    minAssetValueForAlerts: 50, // حد أدنى لقيمة الأصل لإرسال التنبيه
  });

const saveAlertSettings = (settings) => saveConfig("alertSettings", settings);

const loadPriceTracker = async () =>
  await getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => saveConfig("priceTracker", tracker);

function formatNumber(num, decimals = 2) {
  const number = parseFloat(num);
  if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals);
  return number.toFixed(decimals);
}

// أدوات مساعدة للوقت والتنسيق
const minutesDiff = (fromTs, toTs) => (toTs - fromTs) / (1000 * 60);
function cairoTimeString(date = new Date()) {
  return date.toLocaleString("ar-EG", { timeZone: "Africa/Cairo" });
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
    if (tickerJson.code !== "0" || !tickerJson.data[0]) {
      return { error: `لم يتم العثور على العملة.` };
    }
    const tickerData = tickerJson.data[0];
    return {
      price: parseFloat(tickerData.last),
      high24h: parseFloat(tickerData.high24h),
      low24h: parseFloat(tickerData.low24h),
      vol24h: parseFloat(tickerData.volCcy24h),
    };
  } catch {
    throw new Error("خطأ في الاتصال بالمنصة لجلب بيانات السوق.");
  }
}

async function getHistoricalCandles(instId, bar = "1D", limit = 100) {
  let allCandles = [];
  let before = "";
  const maxLimitPerRequest = 100;
  try {
    while (allCandles.length < limit) {
      const currentLimit = Math.min(maxLimitPerRequest, limit - allCandles.length);
      const url = `${okxAdapter.baseURL}/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=${currentLimit}${before}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.code !== "0" || !json.data || json.data.length === 0) break;

      const newCandles = json.data.map((c) => ({
        time: parseInt(c[0]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
      }));
      allCandles.push(...newCandles);
      if (newCandles.length < maxLimitPerRequest) break;
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
      getHistoricalCandles(instId, "1D", 365),
      getHistoricalCandles(instId, "1M", 240),
    ]);
    if (yearlyCandles.length === 0) return null;

    const getHighLow = (candles) => {
      if (!candles || candles.length === 0)
        return { high: 0, low: Infinity };
      return candles.reduce(
        (acc, candle) => ({
          high: Math.max(acc.high, candle.high),
          low: Math.min(acc.low, candle.low),
        }),
        { high: 0, low: Infinity }
      );
    };

    const weeklyCandles = yearlyCandles.slice(-7);
    const monthlyCandles = yearlyCandles.slice(-30);

    const formatLow = (low) => (low === Infinity ? 0 : low);

    const weeklyExtremes = getHighLow(weeklyCandles);
    const monthlyExtremes = getHighLow(monthlyCandles);
    const yearlyExtremes = getHighLow(yearlyCandles);
    const allTimeExtremes = getHighLow(allTimeCandles);

    return {
      weekly: { high: weeklyExtremes.high, low: formatLow(weeklyExtremes.low) },
      monthly: { high: monthlyExtremes.high, low: formatLow(monthlyExtremes.low) },
      yearly: { high: yearlyExtremes.high, low: formatLow(yearlyExtremes.low) },
      allTime: { high: allTimeExtremes.high, low: formatLow(allTimeExtremes.low) },
    };
  } catch (error) {
    console.error(`Error in getAssetPriceExtremes for ${instId}:`, error);
    return null;
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
  const candleData = await getHistoricalCandles(instId, "1D", 51);
  if (candleData.length < 51) return { error: "بيانات الشموع غير كافية." };
  const closes = candleData.map((c) => c.close);
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

  const dailyReturns = [];
  for (let i = 1; i < values.length; i++) {
    dailyReturns.push((values[i] - values[i - 1]) / values[i - 1]);
  }
  const bestDayChange = Math.max(...dailyReturns) * 100;
  const worstDayChange = Math.min(...dailyReturns) * 100;
  const avgReturn =
    dailyReturns.reduce((sum, ret) => sum + ret, 0) / dailyReturns.length;

  const volatility =
    Math.sqrt(
      dailyReturns
        .map((x) => Math.pow(x - avgReturn, 2))
        .reduce((a, b) => a + b) / dailyReturns.length
    ) * 100;

  let volText = "متوسط";
  if (volatility < 1) volText = "منخفض";
  if (volatility > 5) volText = "مرتفع";

  return {
    startValue,
    endValue,
    pnl,
    pnlPercent,
    maxValue,
    minValue,
    avgValue,
    bestDayChange,
    worstDayChange,
    volatility,
    volText,
  };
}

function createChartUrl(
  data,
  type = "line",
  title = "",
  labels = [],
  dataLabel = ""
) {
  if (!data || data.length === 0) return null;
  const pnl = data[data.length - 1] - data[0];
  const chartColor = pnl >= 0 ? "rgb(75, 192, 75)" : "rgb(255, 99, 132)";
  const chartBgColor = pnl >= 0 ? "rgba(75, 192, 75, 0.2)" : "rgba(255, 99, 132, 0.2)";
  const chartConfig = {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: dataLabel,
          data: data,
          fill: true,
          backgroundColor: chartBgColor,
          borderColor: chartColor,
          tension: 0.1,
        },
      ],
    },
    options: { title: { display: true, text: title } },
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
  let msg =
    `*مراقبة الأصول 🔬:*\n**عملية استحواذ جديدة 🟢**\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`\n`;
  msg += `🔸 **نوع العملية:** تعزيز مركز / بناء مركز جديد\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`;
  msg += ` ▪️ **سعر التنفيذ:** \`$${formatNumber(price, 4)}\`\n`;
  msg += ` ▪️ **الكمية المضافة:** \`${formatNumber(Math.abs(amountChange), 6)}\`\n`;
  msg += ` ▪️ **التكلفة الإجمالية للصفقة:** \`$${formatNumber(tradeValue)}\`\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n*التأثير على هيكل المحفظة:*\n`;
  msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${formatNumber(tradeSizePercent)}%\`\n`;
  msg += ` ▪️ **الوزن الجديد للأصل:** \`${formatNumber(newAssetWeight)}%\`\n`;
  msg += ` ▪️ **السيولة المتبقية (USDT):** \`$${formatNumber(newUsdtValue)}\`\n`;
  msg += ` ▪️ **مؤشر السيولة الحالي:** \`${formatNumber(newCashPercent)}%\`\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${cairoTimeString()}`;
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
  let msg =
    `*مراقبة الأصول 🔬:*\n**مناورة تكتيكية 🟠**\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`\n`;
  msg += `🔸 **نوع العملية:** تخفيف المركز / جني أرباح جزئي\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`;
  msg += ` ▪️ **سعر التنفيذ:** \`$${formatNumber(price, 4)}\`\n`;
  msg += ` ▪️ **الكمية المخففة:** \`${formatNumber(Math.abs(amountChange), 6)}\`\n`;
  msg += ` ▪️ **العائد الإجمالي للصفقة:** \`$${formatNumber(tradeValue)}\`\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n*التأثير على هيكل المحفظة:*\n`;
  msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${formatNumber(tradeSizePercent)}%\`\n`;
  msg += ` ▪️ **الوزن الجديد للأصل:** \`${formatNumber(newAssetWeight)}%\`\n`;
  msg += ` ▪️ **السيولة الجديدة (USDT):** \`$${formatNumber(newUsdtValue)}\`\n`;
  msg += ` ▪️ **مؤشر السيولة الحالي:** \`${formatNumber(newCashPercent)}%\`\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${cairoTimeString()}`;
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
  let msg =
    `*ملف المهمة المكتملة 📂:*\n**تم إغلاق مركز ${asset} بنجاح ✅**\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `*النتيجة النهائية للمهمة:*\n`;
  msg += ` ▪️ **الحالة:** **${pnl >= 0 ? "مربحة" : "خاسرة"}**\n`;
  msg += ` ▪️ **صافي الربح/الخسارة:** \`${pnlSign}$${formatNumber(pnl)}\` ${emoji}\n`;
  msg += ` ▪️ **نسبة العائد على الاستثمار (ROI):** \`${pnlSign}${formatNumber(pnlPercent)}%\`\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n*الجدول الزمني والأداء:*\n`;
  msg += ` ▪️ **مدة الاحتفاظ بالمركز:** \`${formatNumber(durationDays, 1)} يوم\`\n`;
  msg += ` ▪️ **متوسط سعر الدخول:** \`$${formatNumber(avgBuyPrice, 4)}\`\n`;
  msg += ` ▪️ **متوسط سعر الخروج:** \`$${formatNumber(avgSellPrice, 4)}\`\n`;
  msg += ` ▪️ **أعلى قمة سعرية مسجلة:** \`$${formatNumber(highestPrice, 4)}\`\n`;
  msg += ` ▪️ **أدنى قاع سعري مسجل:** \`$${formatNumber(lowestPrice, 4)}\`\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ الإغلاق:* ${cairoTimeString()}`;
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
  msg += ` ▪️ *حجم الدخول:* تم تخصيص \`${formatNumber(tradeSizePercent)}%\` من المحفظة لهذه الصفقة.\n`;
  msg += ` ▪️ *استهلاك السيولة:* استهلك هذا الدخول \`${formatNumber(cashConsumedPercent)}%\` من السيولة النقدية المتاحة.\n`;
  msg += ` ▪️ *السيولة المتبقية:* بعد الصفقة، أصبحت السيولة تشكل \`${formatNumber(newCashPercent)}%\` من المحفظة.\n`;
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
  msg += ` ▪️ *الإجراء:* تم بيع \`${formatNumber(soldPercent)}%\` من مركزنا لتأمين الأرباح.\n`;
  msg += ` ▪️ *النتيجة:* ربح محقق على الجزء المباع بنسبة \`${formatNumber(partialPnlPercent)}%\` 🟢.\n`;
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
  msg += ` ▪️ **العائد النهائي على الاستثمار (ROI):** \`${pnlSign}${formatNumber(pnlPercent)}%\` ${emoji}\n`;
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

async function formatPortfolioMsg(assets, total, capital) {
  const positions = await loadPositions();
  const usdtAsset = assets.find((a) => a.asset === "USDT") || { value: 0 };
  const cashPercent = total > 0 ? (usdtAsset.value / total) * 100 : 0;
  const investedPercent = 100 - cashPercent;
  const pnl = capital > 0 ? total - capital : 0;
  const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
  const pnlSign = pnl >= 0 ? "+" : "";
  const pnlEmoji = pnl >= 0 ? "🟢⬆️" : "🔴⬇️";

  let dailyPnlText = " `لا توجد بيانات كافية`";
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
    const dailySign = dailyPnl >= 0 ? "+" : "";
    const dailyEmoji = dailyPnl >= 0 ? "🟢⬆️" : "🔴⬇️";
    dailyPnlText = ` ${dailyEmoji} \`$${dailySign}${formatNumber(
      dailyPnl
    )}\` (\`${dailySign}${formatNumber(dailyPnlPercent)}%\`)`;
  }

  let caption = `🧾 *التقرير التحليلي للمحفظة*\n\n`;
  caption += `*بتاريخ: ${cairoTimeString()}*\n`;
  caption += `━━━━━━━━━━━━━━━━━━━\n*نظرة عامة على الأداء:*\n`;
  caption += ` ▫️ *القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`;
  if (capital > 0) caption += ` ▫️ *رأس المال:* \`$${formatNumber(capital)}\`\n`;
  caption += ` ▫️ *إجمالي الربح غير المحقق:* ${pnlEmoji} \`$${pnlSign}${formatNumber(
    pnl
  )}\` (\`${pnlSign}${formatNumber(pnlPercent)}%\`)\n`;
  caption += ` ▫️ *الأداء اليومي (24س):*${dailyPnlText}\n`;
  caption += ` ▫️ *السيولة:* 💵 نقدي ${formatNumber(
    cashPercent
  )}% / 📈 مستثمر ${formatNumber(investedPercent)}%\n`;
  caption += `━━━━━━━━━━━━━━━━━━━━\n*مكونات المحفظة:*\n`;

  const cryptoAssets = assets.filter((a) => a.asset !== "USDT");
  cryptoAssets.forEach((a, index) => {
    const percent = total > 0 ? (a.value / total) * 100 : 0;
    const position = positions[a.asset];
    caption += `\n╭─ *${a.asset}/USDT*\n`;
    caption += `├─ *القيمة الحالية:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(
      percent
    )}%\`)\n`;
    if (position?.avgBuyPrice) {
      caption += `├─ *متوسط الشراء:* \`$${formatNumber(position.avgBuyPrice, 4)}\`\n`;
    }
    caption += `├─ *سعر السوق:* \`$${formatNumber(a.price, 4)}\`\n`;
    const dailyChangeEmoji = a.change24h >= 0 ? "🟢⬆️" : "🔴⬇️";
    caption += `├─ *الأداء اليومي:* ${dailyChangeEmoji} \`${formatNumber(
      a.change24h * 100
    )}%\`\n`;
    if (position?.avgBuyPrice > 0) {
      const totalCost = position.avgBuyPrice * a.amount;
      const assetPnl = a.value - totalCost;
      const assetPnlPercent = totalCost > 0 ? (assetPnl / totalCost) * 100 : 0;
      const assetPnlEmoji = assetPnl >= 0 ? "🟢" : "🔴";
      const assetPnlSign = assetPnl >= 0 ? "+" : "";
      caption += `╰─ *ربح/خسارة غير محقق:* ${assetPnlEmoji} \`$${assetPnlSign}${formatNumber(
        assetPnl
      )}\` (\`${assetPnlSign}${formatNumber(assetPnlPercent)}%\`)`;
    } else {
      caption += `╰─ *ربح/خسارة غير محقق:* \`غير مسجل\``;
    }

    if (index < cryptoAssets.length - 1) {
      caption += `\n━━━━━━━━━━━━━━━━━━━━`;
    }
  });

  caption += `\n\n━━━━━━━━━━━━━━━━━━━━\n*USDT (الرصيد النقدي)* 💵\n`;
  caption += `*القيمة:* \`$${formatNumber(usdtAsset.value)}\` (*الوزن:* \`${formatNumber(
    cashPercent
  )}%\`)`;
  return { caption };
}

async function formatAdvancedMarketAnalysis(ownedAssets = []) {
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

  const ownedSymbols = ownedAssets.map((a) => a.asset);
  let msg = `🚀 *تحليل السوق المتقدم (OKX)* | ${new Date().toLocaleDateString("ar-EG")}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━\n`;

  const avgGainerChange =
    topGainers.length > 0
      ? topGainers.reduce((sum, g) => sum + g.change24h, 0) / topGainers.length
      : 0;
  const avgLoserChange =
    topLosers.length > 0
      ? topLosers.reduce((sum, l) => sum + Math.abs(l.change24h), 0) / topLosers.length
      : 0;

  let sentimentText = "محايدة 😐\n(هناك فرص للنمو لكن التقلبات عالية)";
  if (avgGainerChange > avgLoserChange * 1.5) {
    sentimentText = "صعودي 🟢\n(معنويات السوق إيجابية، والرابحون يتفوقون)";
  } else if (avgLoserChange > avgGainerChange * 1.5) {
    sentimentText = "هبوطي 🔴\n(معنويات السوق سلبية، والخاسرون يسيطرون)";
  }

  msg += `📊 *معنويات السوق:* ${sentimentText}\n━━━━━━━━━━━━━━━━━━━\n\n`;
  msg +=
    "📈 *أكبر الرابحين (24س):*\n" +
    topGainers
      .map((c) => {
        const symbol = c.instId.split("-")[0];
        const ownedMark = ownedSymbols.includes(symbol) ? " ✅" : "";
        return ` - \`${c.instId}\`: \`+${formatNumber(c.change24h * 100)}%\`${ownedMark}`;
      })
      .join("\n") +
    "\n\n";
  msg +=
    "📉 *أكبر الخاسرين (24س):*\n" +
    topLosers
      .map((c) => {
        const symbol = c.instId.split("-")[0];
        const ownedMark = ownedSymbols.includes(symbol) ? " ✅" : "";
        return ` - \`${c.instId}\`: \`${formatNumber(c.change24h * 100)}%\`${ownedMark}`;
      })
      .join("\n") +
    "\n\n";
  msg +=
    "📊 *الأعلى في حجم التداول:*\n" +
    highVolume
      .map((c) => ` - \`${c.instId}\`: \`${(c.volCcy24h / 1e6).toFixed(2)}M\` USDT`)
      .join("\n") +
    "\n\n";

  let smartRecommendation =
    "💡 *توصية:* راقب الأصول ذات حجم التداول المرتفع، فهي غالبًا ما تقود اتجاه السوق.";
  const ownedGainers = topGainers.filter((g) => ownedSymbols.includes(g.instId.split("-")[0]));
  const ownedLosers = topLosers.filter((l) => ownedSymbols.includes(l.instId.split("-")[0]));
  if (ownedGainers.length > 0) {
    smartRecommendation = `💡 *توصية ذكية:* عملة *${
      ownedGainers[0].instId.split("-")[0]
    }* التي تملكها ضمن أكبر الرابحين. قد تكون فرصة جيدة لتقييم المركز.`;
  } else if (ownedLosers.length > 0) {
    smartRecommendation = `💡 *توصية ذكية:* عملة *${
      ownedLosers[0].instId.split("-")[0]
    }* التي تملكها ضمن أكبر الخاسرين. قد يتطلب الأمر مراجعة وقف الخسارة أو استراتيجيتك.`;
  }

  msg += `${smartRecommendation}`;
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
  if (capital > 0) {
    msg += `📈 *نسبة الربح/الخسارة:* \`${formatNumber(pnlPercent)}%\`\n`;
    msg += `🎯 *الحالة:* ${statusEmoji} ${statusText}\n`;
  }

  msg += `\n━━━━━━━━━━━━━━━━━━━━\n*تحليل القمم والقيعان للأصول:*\n`;
  const cryptoAssets = assets.filter((a) => a.asset !== "USDT");
  if (cryptoAssets.length === 0) {
    msg += "\n`لا توجد أصول في محفظتك لتحليلها.`";
  } else {
    const assetExtremesPromises = cryptoAssets.map((asset) =>
      getAssetPriceExtremes(`${asset.asset}-USDT`)
    );
    const assetExtremesResults = await Promise.all(assetExtremesPromises);
    cryptoAssets.forEach((asset, index) => {
      const extremes = assetExtremesResults[index];
      msg += `\n🔸 *${asset.asset}:*\n`;
      if (extremes) {
        msg += ` *الأسبوعي:* قمة \`$${formatNumber(extremes.weekly.high, 4)}\` / قاع \`$${formatNumber(
          extremes.weekly.low,
          4
        )}\`\n`;
        msg += ` *الشهري:* قمة \`$${formatNumber(extremes.monthly.high, 4)}\` / قاع \`$${formatNumber(
          extremes.monthly.low,
          4
        )}\`\n`;
        msg += ` *السنوي:* قمة \`$${formatNumber(extremes.yearly.high, 4)}\` / قاع \`$${formatNumber(
          extremes.yearly.low,
          4
        )}\`\n`;
        msg += ` *التاريخي:* قمة \`$${formatNumber(extremes.allTime.high, 4)}\` / قاع \`$${formatNumber(
          extremes.allTime.low,
          4
        )}\``;
      } else {
        msg += ` \`تعذر جلب البيانات التاريخية.\``;
      }
    });
  }

  msg += `\n\n⏰ *آخر تحديث:* ${cairoTimeString()}`;
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
    const btcChange = ((btcEnd - btcStart) / btcStart) * 100;
    btcPerformanceText = `\`${btcChange >= 0 ? "+" : ""}${formatNumber(btcChange)}%\``;
    if (stats.pnlPercent > btcChange) {
      benchmarkComparison = `▪️ *النتيجة:* أداء أعلى من السوق ✅`;
    } else {
      benchmarkComparison = `▪️ *النتيجة:* أداء أقل من السوق ⚠️`;
    }
  }

  const chartLabels = history.map((h) =>
    period === "24h"
      ? new Date(h.time).getHours() + ":00"
      : new Date(h.time).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" })
  );
  const chartDataPoints = history.map((h) => h.total);
  const chartUrl = createChartUrl(
    chartDataPoints,
    "line",
    `أداء المحفظة - ${periodLabel}`,
    chartLabels,
    "قيمة المحفظة ($)"
  );

  const pnlSign = stats.pnl >= 0 ? "+" : "";
  const emoji = stats.pnl >= 0 ? "🟢⬆️" : "🔴⬇️";

  let caption = `📊 *تحليل أداء المحفظة | ${periodLabel}*\n\n`;
  caption += `📈 *النتيجة:* ${emoji} \`$${pnlSign}${formatNumber(stats.pnl)}\` (\`${pnlSign}${formatNumber(
    stats.pnlPercent
  )}%\`)\n`;
  caption += `*التغير الصافي: من \`$${formatNumber(stats.startValue)}\` إلى \`$${formatNumber(
    stats.endValue
  )}\`*\n\n`;
  caption += `*📝 مقارنة معيارية (Benchmark):*\n`;
  caption += `▪️ *أداء محفظتك:* \`${stats.pnlPercent >= 0 ? "+" : ""}${formatNumber(
    stats.pnlPercent
  )}%\`\n`;
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

async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount, oldTotalValue) {
  if (!asset || price === undefined || price === null || isNaN(price))
    return { analysisResult: null };

  const positions = await loadPositions();
  let position = positions[asset];
  let analysisResult = { type: "none", data: {} };

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
        risk: { pnlAlerts: {} },
        alerts: {},
      };
    } else {
      position.totalAmountBought += amountChange;
      position.totalCost += tradeValue;
      position.avgBuyPrice = position.totalCost / position.totalAmountBought;
    }
    analysisResult.type = "buy";
  } else if (amountChange < 0 && position) {
    const soldAmount = Math.abs(amountChange);
    position.realizedValue = (position.realizedValue || 0) + soldAmount * price;
    position.totalAmountSold = (position.totalAmountSold || 0) + soldAmount;

    if (newTotalAmount * price < 1) {
      const totalCost = parseFloat(position.totalCost);
      const realizedValue = parseFloat(position.realizedValue);
      const finalPnl = realizedValue - totalCost;
      const finalPnlPercent = totalCost > 0 ? (finalPnl / totalCost) * 100 : 0;

      const closeDate = new Date();
      const openDate = new Date(position.openDate);
      const durationDays = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24);

      const avgSellPrice =
        position.totalAmountSold > 0 ? position.realizedValue / position.totalAmountSold : 0;

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

    const { assets: newAssets, total: newTotalValue, usdtValue: newUsdtValue, error } =
      await okxAdapter.getPortfolio(prices);
    if (error || newTotalValue === undefined) {
      await sendDebugMessage(`Portfolio fetch error: ${error}`);
      return;
    }

    if (Object.keys(previousBalances).length === 0) {
      await sendDebugMessage("Initializing first balance state.");
      await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue });
      return;
    }

    const allAssets = new Set([...Object.keys(previousBalances), ...Object.keys(currentBalance)]);
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
      const newAssetWeight = newTotalValue > 0 ? (newAssetValue / newTotalValue) * 100 : 0;
      const newCashPercent = newTotalValue > 0 ? (newUsdtValue / newTotalValue) * 100 : 0;

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
        await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" });
        if (settings.autoPostToChannel) {
          await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, {
            parse_mode: "Markdown",
          });
        }
      } else if (analysisResult.type === "sell") {
        privateMessage = formatPrivateSell(baseDetails);
        publicMessage = formatPublicSell(baseDetails);
        await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" });
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
          await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" });
        } else {
          const confirmationKeyboard = new InlineKeyboard()
            .text("✅ نعم، انشر التقرير", "publish_report")
            .text("❌ لا، تجاهل", "ignore_report");
          const hiddenMarker = `\n${JSON.stringify(publicMessage)}`;
          const confirmationMessage =
            `*تم إغلاق المركز بنجاح. هل تود نشر الملخص في القناة؟*\n\n` +
            `${privateMessage}${hiddenMarker}`;
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
      if (!currentPrice) continue;

      if (!position.highestPrice || currentPrice > position.highestPrice) {
        position.highestPrice = currentPrice;
        positionsUpdated = true;
      }
      if (!position.lowestPrice || currentPrice < position.lowestPrice) {
        position.lowestPrice = currentPrice;
        positionsUpdated = true;
      }

      // تأمين هياكل التنبيهات
      position.risk = position.risk || {};
      position.risk.pnlAlerts = position.risk.pnlAlerts || {};
      position.alerts = position.alerts || {};
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

// دالة مساعدة لإرسال تنبيه PnL مع احترام المهلة وحد القيمة
async function maybeSendPnlAlert({
  symbol,
  currentPrice,
  position,
  assetValue,
  assetWeightPercent,
  isProfit,
  pnlAbs,
  pnlPct,
  alertSettings,
}) {
  try {
    // الحد الأدنى لقيمة الأصل
    if (assetValue < (alertSettings.minAssetValueForAlerts || 50)) return false;

    const cooldownMinutes =
      (position.alerts && position.alerts.cooldownMinutes) ||
      alertSettings.cooldownMinutes ||
      15;

    const now = Date.now();
    const last = position.alerts?.lastAlertAt || 0;
    if (last && minutesDiff(last, now) < cooldownMinutes) return false;

    position.alerts = position.alerts || {};
    position.alerts.lastAlertAt = now;

    const sign = isProfit ? "+" : "";
    const emoji = isProfit ? "🟢" : "🔴";

    const msg =
      `🔔 *تنبيه ${isProfit ? "ربح" : "خسارة"} غير محقق*\n` +
      `*الأصل:* \`${symbol}/USDT\`\n` +
      `▪️ *القيمة الحالية:* \`$${formatNumber(assetValue)}\` (*الوزن:* \`${formatNumber(
        assetWeightPercent
      )}%\`)\n` +
      `▪️ *المتوسط:* \`$${formatNumber(position.avgBuyPrice, 4)}\` | *السعر الحالي:* \`$${formatNumber(
        currentPrice,
        4
      )}\`\n` +
      `▪️ *غير محقق:* ${emoji} \`${sign}$${formatNumber(pnlAbs)}\` (\`${sign}${formatNumber(
        pnlPct
      )}%\`)\n` +
      `\n⏰ *آخر تحديث:* ${cairoTimeString()}`;

    await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
    return true;
  } catch (e) {
    console.error("Error sending PnL alert:", e);
    return false;
  }
}

// تعديل checkPriceMovements: يرسل تنبيهات الحركة التقليدية + تنبيهات PnL مع Cooldown
async function checkPriceMovements() {
  try {
    await sendDebugMessage("Checking price movements...");
    const alertSettings = await loadAlertSettings();
    const priceTracker = await loadPriceTracker();
    const prices = await okxAdapter.getMarketPrices();
    if (!prices || prices.error) return;

    const portfolio = await okxAdapter.getPortfolio(prices);
    const { assets, total: currentTotalValue, error } = portfolio;
    if (error || currentTotalValue === undefined) return;

    const positions = await loadPositions();

    if (priceTracker.totalPortfolioValue === 0) {
      priceTracker.totalPortfolioValue = currentTotalValue;
      assets.forEach((a) => {
        if (a.price) priceTracker.assets[a.asset] = a.price;
      });
      await savePriceTracker(priceTracker);
      return;
    }

    let trackerUpdated = false;

    const assetValueMap = {};
    assets.forEach((a) => (assetValueMap[a.asset] = a.value || 0));

    for (const asset of assets) {
      if (asset.asset === "USDT" || !asset.price) continue;

      // تنبيه الحركة التقليدي
      const lastPrice = priceTracker.assets[asset.asset];
      if (lastPrice) {
        const changePercent = ((asset.price - lastPrice) / lastPrice) * 100;
        const movementThreshold =
          alertSettings.overrides[asset.asset] || alertSettings.global;

        if (Math.abs(changePercent) >= movementThreshold) {
          const movementText = changePercent > 0 ? "صعود" : "هبوط";
          const message =
            `📈 *تنبيه حركة سعر لأصل!* \`${asset.asset}\`\n` +
            `*الحركة:* ${movementText} بنسبة \`${formatNumber(changePercent)}%\`\n` +
            `*السعر الحالي:* \`$${formatNumber(asset.price, 4)}\``;
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

      // تنبيه PnL لكل مركز
      const symbol = asset.asset;
      const position = positions[symbol];
      if (!position || !position.avgBuyPrice || position.avgBuyPrice <= 0) continue;

      position.risk = position.risk || {};
      position.risk.pnlAlerts = position.risk.pnlAlerts || {};
      position.alerts = position.alerts || {};

      const avgBuy = parseFloat(position.avgBuyPrice) || 0;
      const qty =
        parseFloat(position.totalAmountBought || 0) - parseFloat(position.totalAmountSold || 0);
      if (qty <= 0) continue;

      const currentValue = asset.price * qty;
      const cost = avgBuy * qty;
