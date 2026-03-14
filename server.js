const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Sort array by .turn, keep last entry per turn (dedup)
function dedupeByTurn(arr) {
    const map = new Map();
    arr.forEach(entry => map.set(entry.turn, entry));
    return Array.from(map.values()).sort((a, b) => a.turn - b.turn);
}

// Insert or update an entry by turn, maintaining sorted order
function upsertByTurn(arr, entry) {
    const existingIdx = arr.findIndex(e => e.turn === entry.turn);
    if (existingIdx >= 0) {
        arr[existingIdx] = entry;
    } else {
        arr.push(entry);
        // Re-sort only if out of order
        if (arr.length >= 2 && arr[arr.length - 2].turn > entry.turn) {
            arr.sort((a, b) => a.turn - b.turn);
        }
    }
}

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

                if (msg.type === 'fullHistory') {
                    // Bulk history dump from mid-game injection
                    if (msg.inflationHistory && Array.isArray(msg.inflationHistory)) {
                        gameState.inflationHistory = dedupeByTurn(msg.inflationHistory);
                        if (gameState.inflationHistory.length > 0) {
                            gameState.lobbyNet = gameState.inflationHistory[gameState.inflationHistory.length - 1].netWorth;
                        }
                    }
                    if (msg.priceHistory) {
                        for (const [idx, entries] of Object.entries(msg.priceHistory)) {
                            if (Array.isArray(entries)) {
                                gameState.priceHistory[idx] = dedupeByTurn(entries);
                            }
                        }
                    }
                    if (msg.propertyNames) {
                        Object.assign(gameState.propertyNames, msg.propertyNames);
                    }
                    gameState.gameTurn = msg.gameTurn || gameState.gameTurn;
                    gameState.playerCount = msg.playerCount || gameState.playerCount;
                    gameState.lastUpdate = Date.now();

                    // Send full state to all viewers
                    broadcast({
                        type: 'fullState',
                        ...gameState
                    });
                    console.log('[BOT] Full history received — ' + gameState.inflationHistory.length + ' inflation entries');
                }

                if (msg.type === 'snapshot') {
                    // Inflation snapshot — upsert by turn
                    if (msg.inflation) {
                        upsertByTurn(gameState.inflationHistory, msg.inflation);
                        gameState.lobbyNet = msg.inflation.netWorth;
                    }
                    // Price snapshots — upsert by turn
                    if (msg.prices) {
                        for (const [idx, entry] of Object.entries(msg.prices)) {
                            if (!gameState.priceHistory[idx]) {
                                gameState.priceHistory[idx] = [];
                            }
                            upsertByTurn(gameState.priceHistory[idx], entry);
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
