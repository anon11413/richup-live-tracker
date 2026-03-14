const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Current game state (single session — one injected bot feeds data)
let gameState = {
    inflationHistory: [],     // [{turn, netWorth}]
    priceHistory: {},         // {blockIndex: [{turn, p}]}
    propertyNames: {},        // {blockIndex: {name, countryId}}
    gameTurn: 0,
    lobbyNet: 0,
    playerCount: 0,
    lastUpdate: null
};

// Track connected viewers
let viewers = new Set();

wss.on('connection', (ws, req) => {
    const isBot = req.url === '/bot';
    const isViewer = req.url === '/view' || !isBot;

    if (isBot) {
        console.log('[BOT] Injected script connected');

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);

                if (msg.type === 'reset') {
                    // New game — clear all data
                    gameState = {
                        inflationHistory: [],
                        priceHistory: {},
                        propertyNames: {},
                        gameTurn: 0,
                        lobbyNet: 0,
                        playerCount: 0,
                        lastUpdate: Date.now()
                    };
                    broadcast({ type: 'reset' });
                    console.log('[BOT] Game reset');
                }

                if (msg.type === 'snapshot') {
                    // Inflation snapshot — update existing turn or add new
                    if (msg.inflation) {
                        const hist = gameState.inflationHistory;
                        if (hist.length > 0 && hist[hist.length - 1].turn === msg.inflation.turn) {
                            hist[hist.length - 1].netWorth = msg.inflation.netWorth;
                        } else {
                            hist.push(msg.inflation);
                        }
                        gameState.lobbyNet = msg.inflation.netWorth;
                    }
                    // Price snapshots — update existing turn or add new
                    if (msg.prices) {
                        for (const [idx, entry] of Object.entries(msg.prices)) {
                            if (!gameState.priceHistory[idx]) {
                                gameState.priceHistory[idx] = [];
                            }
                            const ph = gameState.priceHistory[idx];
                            if (ph.length > 0 && ph[ph.length - 1].turn === entry.turn) {
                                ph[ph.length - 1].p = entry.p;
                            } else {
                                ph.push(entry);
                            }
                        }
                    }
                    // Property metadata
                    if (msg.propertyNames) {
                        Object.assign(gameState.propertyNames, msg.propertyNames);
                    }
                    gameState.gameTurn = msg.gameTurn || gameState.gameTurn;
                    gameState.playerCount = msg.playerCount || gameState.playerCount;
                    gameState.lastUpdate = Date.now();

                    // Broadcast to all viewers
                    broadcast({
                        type: 'snapshot',
                        inflation: msg.inflation,
                        prices: msg.prices,
                        propertyNames: msg.propertyNames,
                        gameTurn: gameState.gameTurn,
                        playerCount: gameState.playerCount
                    });
                }

                if (msg.type === 'bankruptcy') {
                    // Immediate inflation update on bankruptcy
                    if (msg.inflation) {
                        gameState.inflationHistory.push(msg.inflation);
                        gameState.lobbyNet = msg.inflation.netWorth;
                    }
                    gameState.lastUpdate = Date.now();
                    broadcast({
                        type: 'bankruptcy',
                        playerName: msg.playerName,
                        inflation: msg.inflation,
                        gameTurn: gameState.gameTurn
                    });
                }

            } catch (e) {
                console.error('[BOT] Bad message:', e.message);
            }
        });

        ws.on('close', () => {
            console.log('[BOT] Injected script disconnected');
        });

    } else {
        // Viewer connection
        viewers.add(ws);
        console.log(`[VIEWER] Connected (${viewers.size} total)`);

        // Send full current state on connect
        ws.send(JSON.stringify({
            type: 'fullState',
            ...gameState
        }));

        ws.on('close', () => {
            viewers.delete(ws);
            console.log(`[VIEWER] Disconnected (${viewers.size} remaining)`);
        });
    }
});

function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const viewer of viewers) {
        if (viewer.readyState === 1) {
            viewer.send(data);
        }
    }
}

server.listen(PORT, () => {
    console.log(`Richup Live Tracker running on port ${PORT}`);
});
