const WebSocket = require('ws');
const fs = require('fs');

class DeltaSyncTradingBot {
    constructor() {
        // ========== CONFIGURABLE PARAMETERS ==========
        this.SYMBOL = 'BTCUSDT';        // Change to ETHUSDT, ADAUSDT, etc.
        this.TIMEFRAME = '1m';          // Change to 5m, 15m, 30m, 1h, etc.
        this.STOP_LOSS_BUFFER = 30;     // Points to subtract/add from VAL/VAH for stop loss
        // =============================================
        
        this.candles = [];
        this.position = null; // null, 'long', 'short'
        this.entryPrice = null;
        this.stopLoss = null;
        this.entryCandle = null;
        this.entryTime = null;
        this.volumeProfile = new Map();
        this.trades = [];
        this.ws = null;
        this.tradeWs = null;
        this.tradeLog = [];
        this.tradeCounter = 0;
        this.cumulativeProfit = 0;
        
        // Volume profile calculation parameters
        this.priceSteps = 100; // Number of price levels for volume profile
        
        this.initWebSocket();
        this.initTradeStream();
        this.initExcelLog();
        
        console.log('🚀 Delta Sync Trading Bot Started');
        console.log(`📊 Symbol: ${this.SYMBOL} (FUTURES)`);
        console.log(`⏰ Timeframe: ${this.TIMEFRAME}`);
        console.log(`🛑 Stop Loss Buffer: ${this.STOP_LOSS_BUFFER} points`);
        console.log('📈 Strategy: Delta in sync with price');
    }
    
    initExcelLog() {
        // Create Excel header if file doesn't exist
        const header = 'S.No,Position (Buy or Sell),Entry Price,Exit Price,Position Entry Time (IST),Position Exit Time (IST),Outcome: Profit or Loss or Breakeven,No of Points Captured or Lost,Cumulative Result Net Profit or Loss\n';
        if (!fs.existsSync('trading_log.csv')) {
            fs.writeFileSync('trading_log.csv', header);
        }
    }
    
    // Convert UTC timestamp to IST
    convertToIST(timestamp) {
        const date = new Date(timestamp);
        // Use Intl.DateTimeFormat for proper IST conversion
        return new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).format(date);
    }
    
    initWebSocket() {
        // Use Futures WebSocket endpoint
        const wsUrl = `wss://fstream.binance.com/ws/${this.SYMBOL.toLowerCase()}@kline_${this.TIMEFRAME}`;
        this.ws = new WebSocket(wsUrl);
        
        this.ws.on('open', () => {
            console.log('📡 Futures Kline WebSocket connected');
        });
        
        this.ws.on('message', (data) => {
            const parsedData = JSON.parse(data);
            if (parsedData.k) {
                this.processKlineData(parsedData.k);
            }
        });
        
        this.ws.on('error', (error) => {
            console.error('❌ Futures Kline WebSocket error:', error);
        });
        
        this.ws.on('close', () => {
            console.log('🔌 Futures Kline WebSocket disconnected. Reconnecting...');
            setTimeout(() => this.initWebSocket(), 5000);
        });
    }
    
    initTradeStream() {
        // Use Futures WebSocket endpoint for trade stream
        const tradeUrl = `wss://fstream.binance.com/ws/${this.SYMBOL.toLowerCase()}@trade`;
        this.tradeWs = new WebSocket(tradeUrl);
        
        this.tradeWs.on('open', () => {
            console.log('📡 Futures Trade WebSocket connected');
        });
        
        this.tradeWs.on('message', (data) => {
            const trade = JSON.parse(data);
            this.processTrade(trade);
        });
        
        this.tradeWs.on('error', (error) => {
            console.error('❌ Futures Trade WebSocket error:', error);
        });
        
        this.tradeWs.on('close', () => {
            console.log('🔌 Futures Trade WebSocket disconnected. Reconnecting...');
            setTimeout(() => this.initTradeStream(), 5000);
        });
    }
    
    processTrade(trade) {
        const price = parseFloat(trade.p);
        const quantity = parseFloat(trade.q);
        const isBuyerMaker = trade.m;
        
        // Get timeframe in milliseconds
        let timeframeMs;
        if (this.TIMEFRAME.endsWith('m')) {
            timeframeMs = parseInt(this.TIMEFRAME) * 60 * 1000;
        } else if (this.TIMEFRAME.endsWith('h')) {
            timeframeMs = parseInt(this.TIMEFRAME) * 60 * 60 * 1000;
        } else {
            timeframeMs = 60 * 1000; // Default to 1 minute
        }
        
        // Store trade for current candle volume profile calculation
        const currentTime = Math.floor(Date.now() / timeframeMs) * timeframeMs;
        
        if (!this.trades[currentTime]) {
            this.trades[currentTime] = [];
        }
        
        this.trades[currentTime].push({
            price,
            quantity,
            isBuy: !isBuyerMaker, // Buyer maker means sell order matched
            timestamp: trade.T
        });
    }
    
    processKlineData(kline) {
        if (!kline.x) return; // Only process closed candles
        
        const candle = {
            openTime: kline.t,
            closeTime: kline.T,
            open: parseFloat(kline.o),
            high: parseFloat(kline.h),
            low: parseFloat(kline.l),
            close: parseFloat(kline.c),
            volume: parseFloat(kline.v),
            trades: this.trades[kline.t] || []
        };
        
        // Calculate volume profile metrics
        this.calculateVolumeProfile(candle);
        
        // Add candle to history
        this.candles.push(candle);
        if (this.candles.length > 100) {
            this.candles.shift(); // Keep only last 100 candles
        }
        
        // Clear trades for this timeframe
        delete this.trades[kline.t];
        
        console.log(`\n📊 New Candle Closed - ${this.convertToIST(candle.openTime)}`);
        console.log(`💰 OHLC: ${candle.open.toFixed(2)} | ${candle.high.toFixed(2)} | ${candle.low.toFixed(2)} | ${candle.close.toFixed(2)}`);
        console.log(`📈 Volume: ${candle.volume.toFixed(2)}`);
        console.log(`🎯 VPOC: ${candle.vpoc?.toFixed(2) || 'N/A'} | VAH: ${candle.vah?.toFixed(2) || 'N/A'} | VAL: ${candle.val?.toFixed(2) || 'N/A'}`);
        console.log(`⚖️ Delta: ${candle.delta?.toFixed(2) || 'N/A'}`);
        
        // Check for exit conditions first
        this.checkExitConditions();
        
        // Check for trading signals
        this.checkSignals();
        
        // Update position management
        this.managePosition();
    }
    
    calculateVolumeProfile(candle) {
        const trades = candle.trades;
        if (!trades || trades.length === 0) {
            candle.delta = 0;
            candle.vpoc = candle.close;
            candle.vah = candle.high;
            candle.val = candle.low;
            return;
        }
        
        // Calculate price levels
        const priceRange = candle.high - candle.low;
        if (priceRange === 0) {
            candle.delta = 0;
            candle.vpoc = candle.close;
            candle.vah = candle.high;
            candle.val = candle.low;
            return;
        }
        
        const priceStep = priceRange / this.priceSteps;
        const volumeByPrice = new Map();
        
        let buyVolume = 0;
        let sellVolume = 0;
        
        // Process each trade
        trades.forEach(trade => {
            if (trade.isBuy) {
                buyVolume += trade.quantity;
            } else {
                sellVolume += trade.quantity;
            }
            
            // Calculate price level
            const priceLevel = Math.floor((trade.price - candle.low) / priceStep) * priceStep + candle.low;
            const levelKey = priceLevel.toFixed(2);
            
            if (!volumeByPrice.has(levelKey)) {
                volumeByPrice.set(levelKey, { volume: 0, buyVolume: 0, sellVolume: 0 });
            }
            
            const level = volumeByPrice.get(levelKey);
            level.volume += trade.quantity;
            if (trade.isBuy) {
                level.buyVolume += trade.quantity;
            } else {
                level.sellVolume += trade.quantity;
            }
        });
        
        // Calculate Delta
        candle.delta = buyVolume - sellVolume;
        
        if (volumeByPrice.size === 0) {
            candle.vpoc = candle.close;
            candle.vah = candle.high;
            candle.val = candle.low;
            return;
        }
        
        // Find VPOC (Volume Point of Control)
        let maxVolume = 0;
        let vpocPrice = candle.close;
        
        volumeByPrice.forEach((data, price) => {
            if (data.volume > maxVolume) {
                maxVolume = data.volume;
                vpocPrice = parseFloat(price);
            }
        });
        
        candle.vpoc = vpocPrice;
        
        // Calculate Value Area (70% of volume)
        const totalVolume = Array.from(volumeByPrice.values()).reduce((sum, data) => sum + data.volume, 0);
        const valueAreaVolume = totalVolume * 0.7;
        
        // Sort price levels by volume
        const sortedLevels = Array.from(volumeByPrice.entries())
            .sort((a, b) => b[1].volume - a[1].volume);
        
        let accumulatedVolume = 0;
        const valueAreaPrices = [];
        
        for (const [price, data] of sortedLevels) {
            valueAreaPrices.push(parseFloat(price));
            accumulatedVolume += data.volume;
            if (accumulatedVolume >= valueAreaVolume) break;
        }
        
        candle.vah = Math.max(...valueAreaPrices);
        candle.val = Math.min(...valueAreaPrices);
    }
    
    checkExitConditions() {
        if (!this.position || this.candles.length < 2) return;
        
        const currentCandle = this.candles[this.candles.length - 1];
        const previousCandle = this.candles[this.candles.length - 2];
        
        if (this.position === 'long') {
            // Exit condition: When a following candle closes crosses the previous candle's VAL
            if (currentCandle.close < previousCandle.val) {
                this.closePosition(`Exit condition met - price closed below previous VAL (${previousCandle.val.toFixed(2)})`);
                return;
            }
        } else if (this.position === 'short') {
            // Exit condition: When a following candle closes crosses the previous candle's VAH
            if (currentCandle.close > previousCandle.vah) {
                this.closePosition(`Exit condition met - price closed above previous VAH (${previousCandle.vah.toFixed(2)})`);
                return;
            }
        }
    }
    
    checkSignals() {
        if (this.candles.length < 2 || this.position !== null) return;
        
        const currentCandle = this.candles[this.candles.length - 1];
        const previousCandle = this.candles[this.candles.length - 2];
        
        if (!currentCandle.delta || !previousCandle.vpoc) return;
        
        // Buy Signal Logic
        if (this.checkBuySignal(currentCandle)) {
            this.generateBuySignal(previousCandle);
        }
        // Sell Signal Logic
        else if (this.checkSellSignal(currentCandle)) {
            this.generateSellSignal(previousCandle);
        }
    }
    
    checkBuySignal(current) {
        // Positive delta and green candle (price closes above open)
        return current.delta > 0 && current.close > current.open;
    }
    
    checkSellSignal(current) {
        // Negative delta and red candle (price closes below open)
        return current.delta < 0 && current.close < current.open;
    }
    
    generateBuySignal(previousCandle) {
        this.position = 'long';
        this.entryPrice = previousCandle.vpoc;
        this.stopLoss = previousCandle.val - this.STOP_LOSS_BUFFER; // VAL - 30 points
        this.entryCandle = this.candles.length - 1;
        this.entryTime = Date.now();
        
        console.log('\n🟢 BUY SIGNAL GENERATED!');
        console.log(`📍 Entry Price: ${this.entryPrice.toFixed(2)}`);
        console.log(`🛑 Stop Loss: ${this.stopLoss.toFixed(2)} (VAL - ${this.STOP_LOSS_BUFFER})`);
        console.log(`💰 Risk: ${(this.entryPrice - this.stopLoss).toFixed(2)} points per unit`);
        console.log(`⏰ Entry Time: ${this.convertToIST(this.entryTime)}`);
    }
    
    generateSellSignal(previousCandle) {
        this.position = 'short';
        this.entryPrice = previousCandle.vpoc;
        this.stopLoss = previousCandle.vah + this.STOP_LOSS_BUFFER; // VAH + 30 points
        this.entryCandle = this.candles.length - 1;
        this.entryTime = Date.now();
        
        console.log('\n🔴 SELL SIGNAL GENERATED!');
        console.log(`📍 Entry Price: ${this.entryPrice.toFixed(2)}`);
        console.log(`🛑 Stop Loss: ${this.stopLoss.toFixed(2)} (VAH + ${this.STOP_LOSS_BUFFER})`);
        console.log(`💰 Risk: ${(this.stopLoss - this.entryPrice).toFixed(2)} points per unit`);
        console.log(`⏰ Entry Time: ${this.convertToIST(this.entryTime)}`);
    }
    
    managePosition() {
        if (!this.position || this.candles.length < 3) return;
        
        const currentCandle = this.candles[this.candles.length - 1];
        const entryIndex = this.entryCandle;
        
        // Check for break-even condition (second candle after entry)
        if (this.candles.length >= entryIndex + 2) {
            const secondCandleAfterEntry = this.candles[entryIndex + 1];
            const previousCandle = this.candles[this.candles.length - 2];
            
            if (this.position === 'long') {
                // Check if price continues to be in sync
                if (this.isLongPositionInSync(currentCandle)) {
                    console.log('💚 Long position in sync - holding position');
                }
                
                // Move to break-even: if second candle closes above previous candle high
                if (secondCandleAfterEntry.close > previousCandle.high && this.stopLoss < this.entryPrice) {
                    this.stopLoss = this.entryPrice;
                    console.log(`📈 Long position - Moving stop loss to break even: ${this.stopLoss.toFixed(2)}`);
                }
                
                // Check stop loss
                if (currentCandle.close <= this.stopLoss) {
                    this.closePosition(`Stop loss hit at ${currentCandle.close.toFixed(2)}`);
                }
                
            } else if (this.position === 'short') {
                // Check if price continues to be in sync
                if (this.isShortPositionInSync(currentCandle)) {
                    console.log('❤️ Short position in sync - holding position');
                }
                
                // Move to break-even: if second candle closes below previous candle low
                if (secondCandleAfterEntry.close < previousCandle.low && this.stopLoss > this.entryPrice) {
                    this.stopLoss = this.entryPrice;
                    console.log(`📉 Short position - Moving stop loss to break even: ${this.stopLoss.toFixed(2)}`);
                }
                
                // Check stop loss
                if (currentCandle.close >= this.stopLoss) {
                    this.closePosition(`Stop loss hit at ${currentCandle.close.toFixed(2)}`);
                }
            }
        }
    }
    
    isLongPositionInSync(currentCandle) {
        if (this.candles.length < 2) return false;
        const previousCandle = this.candles[this.candles.length - 2];
        return currentCandle.close > previousCandle.high && currentCandle.delta > 0;
    }
    
    isShortPositionInSync(currentCandle) {
        if (this.candles.length < 2) return false;
        const previousCandle = this.candles[this.candles.length - 2];
        return currentCandle.close < previousCandle.low && currentCandle.delta < 0;
    }
    
    closePosition(reason) {
        if (!this.position) return;
        
        const currentPrice = this.candles[this.candles.length - 1].close;
        const exitTime = Date.now();
        let pnl = 0;
        let points = 0;
        let outcome = '';
        
        if (this.position === 'long') {
            pnl = currentPrice - this.entryPrice;
            points = pnl;
        } else {
            pnl = this.entryPrice - currentPrice;
            points = pnl;
        }
        
        // Update cumulative profit
        this.cumulativeProfit += pnl;
        
        // Determine outcome
        if (pnl > 0) {
            outcome = 'Profit';
        } else if (pnl < 0) {
            outcome = 'Loss';
        } else {
            outcome = 'Breakeven';
        }
        
        console.log(`\n🔄 POSITION CLOSED: ${this.position.toUpperCase()}`);
        console.log(`📝 Reason: ${reason}`);
        console.log(`💰 Entry: ${this.entryPrice.toFixed(2)} | Exit: ${currentPrice.toFixed(2)}`);
        console.log(`📊 P&L: ${pnl.toFixed(2)} points ${pnl >= 0 ? '✅' : '❌'}`);
        console.log(`⏰ Exit Time: ${this.convertToIST(exitTime)}`);
        console.log(`💼 Cumulative P&L: ${this.cumulativeProfit.toFixed(2)} points`);
        
        // Log to Excel
        this.logToExcel(this.position, this.entryPrice, currentPrice, outcome, points, this.entryTime, exitTime);
        
        // Reset position
        this.position = null;
        this.entryPrice = null;
        this.stopLoss = null;
        this.entryCandle = null;
        this.entryTime = null;
    }
    
    logToExcel(position, entryPrice, exitPrice, outcome, points, entryTime, exitTime) {
        this.tradeCounter++;
        const positionType = position === 'long' ? 'Buy' : 'Sell';
        const entryTimeIST = this.convertToIST(entryTime);
        const exitTimeIST = this.convertToIST(exitTime);
        
        const csvLine = `${this.tradeCounter},${positionType},${entryPrice.toFixed(2)},${exitPrice.toFixed(2)},"${entryTimeIST}","${exitTimeIST}",${outcome},${points.toFixed(2)},${this.cumulativeProfit.toFixed(2)}\n`;
        
        fs.appendFileSync('trading_log.csv', csvLine);
        
        console.log(`📝 Trade logged to Excel: #${this.tradeCounter} | ${positionType} | ${outcome}: ${points.toFixed(2)} points | Cumulative: ${this.cumulativeProfit.toFixed(2)}`);
    }
    
    getStatus() {
        return {
            symbol: this.SYMBOL,
            timeframe: this.TIMEFRAME,
            stopLossBuffer: this.STOP_LOSS_BUFFER,
            position: this.position,
            entryPrice: this.entryPrice,
            stopLoss: this.stopLoss,
            currentPrice: this.candles.length > 0 ? this.candles[this.candles.length - 1].close : null,
            candleCount: this.candles.length,
            totalTrades: this.tradeCounter,
            cumulativeProfit: this.cumulativeProfit
        };
    }
    
    disconnect() {
        if (this.ws) {
            this.ws.close();
        }
        if (this.tradeWs) {
            this.tradeWs.close();
        }
        console.log('🔌 Bot disconnected');
    }
}

// Usage
const bot = new DeltaSyncTradingBot();

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n⚠️ Received SIGINT. Shutting down gracefully...');
    bot.disconnect();
    process.exit(0);
});

// Status reporting every 5 minutes
setInterval(() => {
    const status = bot.getStatus();
    console.log('\n📋 STATUS REPORT');
    console.log(`📊 Symbol: ${status.symbol} | Timeframe: ${status.timeframe}`);
    console.log(`🎯 Position: ${status.position || 'None'}`);
    if (status.position) {
        console.log(`📍 Entry: ${status.entryPrice?.toFixed(2) || 'N/A'}`);
        console.log(`🛑 Stop Loss: ${status.stopLoss?.toFixed(2) || 'N/A'}`);
        console.log(`💹 Current: ${status.currentPrice?.toFixed(2) || 'N/A'}`);
        if (status.position === 'long') {
            const unrealizedPnL = status.currentPrice - status.entryPrice;
            console.log(`💰 Unrealized P&L: ${unrealizedPnL.toFixed(2)} points`);
        } else if (status.position === 'short') {
            const unrealizedPnL = status.entryPrice - status.currentPrice;
            console.log(`💰 Unrealized P&L: ${unrealizedPnL.toFixed(2)} points`);
        }
    }
    console.log(`📊 Candles Processed: ${status.candleCount}`);
    console.log(`📈 Total Trades: ${status.totalTrades}`);
    console.log(`💼 Cumulative P&L: ${status.cumulativeProfit?.toFixed(2) || '0.00'} points`);
}, 5 * 60 * 1000);

module.exports = DeltaSyncTradingBot;