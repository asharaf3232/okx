// =================================================================
// Advanced Analytics Bot - v134.2 (Fixed What-If Analysis)
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
      if (json.code !== '0' || !json.data || !json.data[0] || !json.data.details) { return { error: `فشل جلب المحفظة: ${json.msg || 'بيانات غير متوقعة'}` }; }
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
      if (json.code !== '0' || !json.data || !json.data[0] || !json.data.details) { return null; }
      const balances = {};
      json.data.details.forEach(asset => {
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

// 🔧 دالة استخراج الكمية المحسنة مع أولوية للكمية الصحيحة المحفوظة
function inferClosedQuantity(trade) {
  // أولوية قصوى: الكمية المحفوظة بشكل صريح (الإصلاح الجديد)
  if (typeof trade.exitQuantity !== "undefined" && trade.exitQuantity > 0) {
    return trade.exitQuantity;
  }
  
  // خيارات احتياطية للصفقات القديمة
  if (trade.exitQuantityPercent === 100 && trade.totalAmountBought) {
    return trade.totalAmountBought;
  }
  
  // خيار احتياطي آخر: استخدام totalAmountSold إذا كان متاحاً
  if (trade.totalAmountSold && trade.totalAmountSold > 0) {
    return trade.totalAmountSold;
  }
  
  // خيار احتياطي: حساب من الاستثمار المحقق وسعر البيع المتوسط
  if (trade.realizedValue && trade.avgSellPrice && trade.avgSellPrice > 0) {
    return trade.realizedValue / trade.avgSellPrice;
  }
  
  // القيمة الافتراضية في حالة عدم وجود بيانات كافية
  return 1;
}

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
      getHistoricalCandles(instId, '1M', 240)
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

// ... (باقي الدوال - تم اختصارها لتوفير المساحة)

// =================================================================
// SECTION 4: POSITION MANAGEMENT AND ANALYSIS
// =================================================================

async function updatePositionAndAnalyze(asset, amountChange, currentPrice, currentAmount, oldTotalValue) {
  const positions = await loadPositions();
  let position = positions[asset];
  let analysisResult = { type: 'none', data: {} };

  if (amountChange > 0) {
    // شراء
    if (!position) {
      position = {
        asset,
        avgBuyPrice: currentPrice,
        totalAmountBought: amountChange,
        totalAmountSold: 0,
        totalCost: currentPrice * amountChange,
        realizedValue: 0,
        openDate: new Date().toISOString(),
        highestPrice: currentPrice,
        lowestPrice: currentPrice,
        entryCapitalPercent: oldTotalValue > 0 ? ((currentPrice * amountChange) / oldTotalValue) * 100 : 0
      };
    } else {
      const newTotalCost = position.totalCost + (currentPrice * amountChange);
      const newTotalAmount = position.totalAmountBought + amountChange;
      position.avgBuyPrice = newTotalCost / newTotalAmount;
      position.totalAmountBought = newTotalAmount;
      position.totalCost = newTotalCost;
    }
    analysisResult.type = 'buy';
  } else if (amountChange < 0) {
    // بيع
    const soldAmount = Math.abs(amountChange);
    if (position) {
      const avgSellPrice = currentPrice;
      const soldValue = avgSellPrice * soldAmount;
      position.totalAmountSold += soldAmount;
      position.realizedValue += soldValue;

      const remainingAmount = currentAmount;
      if (remainingAmount <= 0.001) {
        // إغلاق كامل للمركز
        const closedQuantity = position.totalAmountBought;
        const investedCapital = position.totalCost;
        const realizedValue = position.realizedValue;
        const finalPnl = realizedValue - investedCapital;
        const finalPnlPercent = investedCapital > 0 ? (finalPnl / investedCapital) * 100 : 0;
        const durationDays = (new Date().getTime() - new Date(position.openDate).getTime()) / (1000 * 60 * 60 * 24);

        const closeReportData = {
          asset,
          pnl: finalPnl,
          pnlPercent: finalPnlPercent,
          investedCapital,
          realizedValue,
          durationDays,
          avgBuyPrice: position.avgBuyPrice,
          avgSellPrice,
          highestPrice: position.highestPrice,
          lowestPrice: position.lowestPrice,
          entryCapitalPercent: position.entryCapitalPercent,
          exitQuantityPercent: 100,
          exitQuantity: closedQuantity, // 🔧 إضافة الكمية الصحيحة المغلقة
          totalAmountBought: position.totalAmountBought,
          totalAmountSold: position.totalAmountSold,
          totalCost: position.totalCost,
          realizedValue: position.realizedValue
        };
        
        console.log(
          `[Debug Close] Asset: ${asset}`,
          "Closed Quantity:", closedQuantity,
          "Avg Buy Price:", position.avgBuyPrice,
          "Invested Capital:", investedCapital,
          "Realized Value:", realizedValue,
          "PnL:", finalPnl,
          "ROI (%):", finalPnlPercent,
          "Avg Sell Price:", avgSellPrice
        );
        
        await saveClosedTrade(closeReportData);
        analysisResult = { type: 'close', data: closeReportData };
        delete positions[asset];
      } else {
        analysisResult.type = 'sell';
      }
    }
  }
  
  await savePositions(positions);
  analysisResult.data.position = positions[asset] || position;
  return { analysisResult };
}

// =================================================================
// SECTION 4.5: WHAT-IF ANALYSIS (FIXED)
// =================================================================

async function analyzeClosedPositionsAsIfHeld(days) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const closedTrades = await getCollection("tradeHistory").find({
      closedAt: { $gte: cutoffDate }
    }).toArray();

    if (closedTrades.length === 0) {
      return `📊 لم يتم إغلاق أي صفقات خلال آخر ${days} يوم.`;
    }

    const prices = await okxAdapter.getMarketPrices();
    if (prices.error) {
      return "❌ فشل في جلب أسعار السوق الحالية.";
    }

    let report = `🌀 *تحليل السيناريو الافتراضي - آخر ${days} يوم*\n\n`;
    report += `📈 *ماذا لو لم تخرج من الصفقات المغلقة؟*\n\n`;
    
    let totalActualPnL = 0;
    let totalHypotheticalPnL = 0;
    let totalInvestment = 0;

    for (const trade of closedTrades) {
      const assetSymbol = trade.asset;
      
      // 🔧 استخدام الدالة المحسنة لاستخراج الكمية الصحيحة
      const quantity = inferClosedQuantity(trade);
      
      const avgBuyPrice = trade.avgBuyPrice || 0;
      const exitPrice = trade.avgSellPrice || 0;
      const currentPrice = prices[`${assetSymbol}-USDT`]?.price || 0;

      if (!currentPrice || !avgBuyPrice || !exitPrice) {
        report += `ℹ️ لا يمكن جلب البيانات الكاملة لـ ${assetSymbol}, تخطى.\n\n`;
        continue;
      }

      const investment = avgBuyPrice * quantity;
      const actualPnL = (exitPrice - avgBuyPrice) * quantity;
      const actualPnLPercent = avgBuyPrice > 0 ? ((exitPrice - avgBuyPrice) / avgBuyPrice) * 100 : 0;
      const hypotheticalPnL = (currentPrice - avgBuyPrice) * quantity;
      const hypotheticalPnLPercent = avgBuyPrice > 0 ? ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100 : 0;
      const diffPnL = hypotheticalPnL - actualPnL;

      // إضافة للإجماليات
      totalActualPnL += actualPnL;
      totalHypotheticalPnL += hypotheticalPnL;
      totalInvestment += investment;

      // تحديد الألوان والرموز
      const actualEmoji = actualPnL >= 0 ? '🟢' : '🔴';
      const hypotheticalEmoji = hypotheticalPnL >= 0 ? '🟢' : '🔴';
      const diffEmoji = diffPnL >= 0 ? '🟢' : '🔴';

      report += `🔸 ${assetSymbol}:\n`;
      report += ` - الكمية المغلقة: ${formatNumber(quantity, 6)}\n`;
      report += ` - سعر الدخول: $${formatNumber(avgBuyPrice, 4)}\n`;
      report += ` - سعر البيع (الإغلاق): $${formatNumber(exitPrice, 4)}\n`;
      report += ` - السعر الحالي: $${formatNumber(currentPrice, 4)}\n`;
      report += ` - الربح/الخسارة الفعلية: ${actualEmoji} ${actualPnL >= 0 ? '+' : ''}${formatNumber(actualPnL, 2)} دولار (${actualPnLPercent.toFixed(2)}%)\n`;
      report += ` - لو احتفظت: ${hypotheticalEmoji} ${hypotheticalPnL >= 0 ? '+' : ''}${formatNumber(hypotheticalPnL, 2)} دولار (${hypotheticalPnLPercent.toFixed(2)}%)\n`;
      report += ` - الفرق المتوقع: ${diffEmoji} ${diffPnL >= 0 ? '+' : ''}${formatNumber(diffPnL, 2)} دولار\n\n`;
    }

    // إضافة الملخص الإجمالي
    if (totalInvestment > 0) {
      const totalActualPercent = (totalActualPnL / totalInvestment) * 100;
      const totalHypotheticalPercent = (totalHypotheticalPnL / totalInvestment) * 100;
      const totalDiffPnL = totalHypotheticalPnL - totalActualPnL;
      
      const actualTotalEmoji = totalActualPnL >= 0 ? '🟢' : '🔴';
      const hypotheticalTotalEmoji = totalHypotheticalPnL >= 0 ? '🟢' : '🔴';
      const diffTotalEmoji = totalDiffPnL >= 0 ? '🟢' : '🔴';

      report += `━━━━━━━━━━━━━━━━━━━━\n`;
      report += `📊 الملخص الإجمالي (${days} يوم):\n`;
      report += `▪️ إجمالي الاستثمار: $${formatNumber(totalInvestment)}\n`;
      report += `▪️ الفعلي: ${actualTotalEmoji} $${totalActualPnL >= 0 ? '+' : ''}${formatNumber(totalActualPnL)} (${totalActualPercent.toFixed(2)}%)\n`;
      report += `▪️ لو احتفظت: ${hypotheticalTotalEmoji} $${totalHypotheticalPnL >= 0 ? '+' : ''}${formatNumber(totalHypotheticalPnL)} (${totalHypotheticalPercent.toFixed(2)}%)\n`;
      report += `▪️ الفرق الكلي: ${diffTotalEmoji} $${totalDiffPnL >= 0 ? '+' : ''}${formatNumber(totalDiffPnL)}\n\n`;

      // تحليل ذكي للنتائج
      if (totalDiffPnL > 0) {
        report += `⚠️ التحليل: الخروج المبكر كلفك أرباحاً محتملة، لكن إدارة المخاطر أهم من الأرباح الافتراضية.`;
      } else if (totalDiffPnL < 0) {
        report += `✅ التحليل: قرارات الخروج كانت صائبة وحمتك من خسائر إضافية. استراتيجيتك في إدارة المخاطر فعالة.`;
      } else {
        report += `🤝 التحليل: توقيت الخروج كان مثالياً تقريباً. توازن جيد بين المخاطرة والعائد.`;
      }
    }

    return report;
  } catch (e) {
    console.error("Error in analyzeClosedPositionsAsIfHeld:", e);
    return "❌ حدث خطأ أثناء تحليل السيناريو الافتراضي.";
  }
}


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
