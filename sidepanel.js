// Side panel JavaScript for Reversi Assistant
class SidePanelManager {
    constructor() {
        // Game elements
        this.agentState = document.getElementById('agentState');
        this.agentEmoji = document.getElementById('agentEmoji');
        this.agentText = document.getElementById('agentText');
        this.audioVisualizer = document.getElementById('audioVisualizer');
        this.blackBar = document.getElementById('blackRaceBar');
        this.whiteBar = document.getElementById('whiteRaceBar');
        this.blackScore = document.getElementById('blackRaceScore');
        this.whiteScore = document.getElementById('whiteRaceScore');
        this.predictedBlackBar = document.getElementById('predictedBlackRaceBar');
        this.predictedWhiteBar = document.getElementById('predictedWhiteRaceBar');
        this.predictedBlackScore = document.getElementById('predictedBlackRaceScore');
        this.predictedWhiteScore = document.getElementById('predictedWhiteRaceScore');
        this.predictedScoresHeader = document.getElementById('predictedScoresHeader');
        this.predictedScoresContainer = document.getElementById('predictedRaceContainer');
        this.recommendationSection = document.getElementById('recommendationSection');
        this.recPosition = document.getElementById('recPosition');
        this.recReasoning = document.getElementById('recReasoning');
        this.currentBoardGrid = document.getElementById('currentBoardGrid');
        this.predictedBoardGrid = document.getElementById('predictedBoardGrid');
        
        // Initialize both board grids
        this.initializeBoardGrids();
        
        // Control elements removed - using floating button on main tab
        
        // Settings elements
        this.openaiEndpoint = document.getElementById('openaiEndpoint');
        this.openaiKey = document.getElementById('openaiKey');
        this.saveAllSettings = document.getElementById('saveAllSettings');
        this.settingsStatus = document.getElementById('settingsStatus');
        
        // TTS settings
        this.ttsAzure = document.getElementById('ttsAzure');
        this.ttsElevenlabs = document.getElementById('ttsElevenlabs');
        this.azureSettings = document.getElementById('azureSettings');
        this.elevenlabsSettings = document.getElementById('elevenlabsSettings');
        this.azureKey = document.getElementById('azureKey');
        this.azureRegion = document.getElementById('azureRegion');
        this.elevenlabsKey = document.getElementById('elevenlabsKey');
        this.elevenlabsVoiceId = document.getElementById('elevenlabsVoiceId');
    // Side panel no longer includes start/stop controls (floating main page button used).
    // Do not initialize toggle DOM elements here.
        
        this.currentState = 'watching';
        this.gameData = null;
        this.isCapturing = false;
        this.assistantActive = false; // Track assistant state
        this.thinkingInterval = null; // For cycling thinking emojis
        
        this.init();
        
        // Initially hide recommendation section and clear any stale data
        this.clearAllRecommendationData();
        this.hideRecommendationSection();
    }
    
    init() {
        // Set up tab navigation
        this.setupTabNavigation();
        
        // Control handlers removed - using floating button on main tab
        
        // Set up settings handlers
        this.setupSettingsHandlers();
        
        // Load saved settings
        this.loadSettings();
        
        // Get initial capture state
        this.updateCaptureState();
        
        // Listen for messages from content script
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            console.log('📨 Side panel received message:', message.type, message);
            
            if (message.type === 'gameUpdate') {
                this.updateGameData(message.data);
            } else if (message.type === 'agentState') {
                console.log('🔄 Updating agent state to:', message.state);
                this.updateAgentState(message.state);
            } else if (message.type === 'recommendation') {
                console.log('💡 Received recommendation:', message.data);
                this.updateRecommendation(message.data);
            } else if (message.type === 'AUDIO_FREQUENCY_DATA') {
                this.updateAudioVisualization(message.frequencies);
            } else if (message.type === 'AUDIO_VISUALIZATION_STOPPED') {
                this.resetAudioVisualization();
            } else if (message.type === 'TOGGLE_ASSISTANT') {
                this.handleAssistantToggle(message.active);
            }
        });
        
        
        // Don't request initial data - wait for assistant to be activated
        // this.requestGameData();
        
        // Set up periodic updates
        setInterval(() => {
            // Always request basic game state for current scores display
            // Assistant activation controls whether AI analysis happens
            this.requestGameData();
        }, 1000);
    }
    
    requestGameData() {
        // Only request game state for display purposes
        // The assistant will handle AI analysis separately when active
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {type: 'getGameState'}, (response) => {
                    if (chrome.runtime.lastError) {
                        console.log('Content script not ready:', chrome.runtime.lastError.message);
                    }
                });
            }
        });
    }
    
    updateAgentState(state) {
        this.currentState = state;
        
        // Clear any existing thinking interval
        if (this.thinkingInterval) {
            clearInterval(this.thinkingInterval);
            this.thinkingInterval = null;
        }
        
        const stateConfig = {
            'watching': { emoji: '👁️', text: 'Watching', class: 'watching' },
            'thinking': { emoji: '🧠', text: 'Thinking', class: 'thinking' },
            'talking': { emoji: '🔊', text: 'Talking', class: 'talking' }
        };
        
        const config = stateConfig[state] || stateConfig['watching'];
        
        // Handle thinking state with dynamic emoji cycling
        if (state === 'thinking') {
            this.startThinkingAnimation();
        } else {
            // Update emoji and text for non-thinking states
            this.agentEmoji.textContent = config.emoji;
            this.agentText.textContent = config.text;
        }
        
        // Update animation class
        this.agentEmoji.className = `agent-emoji ${config.class}`;
        
        // Handle audio visualizer for talking state
        if (state === 'talking') {
            this.audioVisualizer.classList.add('active');
        } else {
            this.audioVisualizer.classList.remove('active');
        }
        
        // Hide recommendation content during thinking state (keep container for stable layout)
        const recommendationSection = document.getElementById('recommendationSection');
        
        if (state === 'thinking') {
            recommendationSection.style.visibility = 'hidden';
            recommendationSection.style.opacity = '0';
        } else {
            recommendationSection.style.visibility = 'visible';
            recommendationSection.style.opacity = '1';
        }
    }
    
    startThinkingAnimation() {
        // Always start with brain, always end with target, randomize middle ones
        const middleEmojis = ['🤔', '⚡', '🔍', '💡', '🔬', '⚙️', '🎲'];
        
        let cycleCount = 0;
        const totalCycles = 4 + Math.floor(Math.random() * 3); // 4-6 cycles before ending
        
        // Set initial state (always start with brain)
        this.agentEmoji.textContent = '🧠';
        this.agentText.textContent = 'Thinking';
        
        // Dynamic cycling with random middle states
        this.thinkingInterval = setInterval(() => {
            cycleCount++;
            
            if (cycleCount >= totalCycles) {
                // Always end with target
                this.agentEmoji.textContent = '🎯';
                this.agentText.textContent = 'Thinking'; // Keep text as "Thinking"
                clearInterval(this.thinkingInterval);
                this.thinkingInterval = null;
            } else {
                // Random middle emoji only, keep text as "Thinking"
                const randomIndex = Math.floor(Math.random() * middleEmojis.length);
                this.agentEmoji.textContent = middleEmojis[randomIndex];
                this.agentText.textContent = 'Thinking'; // Always "Thinking"
            }
        }, 600 + Math.random() * 400); // Random interval between 600-1000ms
    }
    
    updateGameData(data) {
        if (!data) return;
        
        // Check if the game state has actually changed (user made a move)
        const gameStateChanged = !this.lastGameData || 
            this.lastGameData.blackCount !== data.blackCount ||
            this.lastGameData.whiteCount !== data.whiteCount;
        
        // Store game data for board grid updates
        const previousGameData = this.lastGameData;
        this.lastGameData = data;
        
        const blackCount = data.blackCount || 0;
        const whiteCount = data.whiteCount || 0;
        
        // Check if this is a new game (reset to starting position: 2 black, 2 white)
        const isNewGame = (blackCount === 2 && whiteCount === 2) && 
                         (previousGameData && (previousGameData.blackCount > 2 || previousGameData.whiteCount > 2));
        
        if (isNewGame) {
            console.log('🆕 New game detected - clearing all recommendation data');
            this.clearAllRecommendationData();
            this.hideRecommendationSection();
        }
        
        // Calculate percentages for progress bars
        const total = Math.max(1, blackCount + whiteCount); // Avoid division by zero
        const blackPercent = (blackCount / 64) * 100;
        const whitePercent = (whiteCount / 64) * 100;
        
        // Update progress bars (horizontal race style)
        this.blackBar.style.width = `${blackPercent}%`;
        this.whiteBar.style.width = `${whitePercent}%`;
        
        // Update score text
        this.blackScore.textContent = `${blackCount}`;
        this.whiteScore.textContent = `${whiteCount}`;
        
        // Only update board grid if game state changed, preserving current recommendation
        if (gameStateChanged) {
            console.log('🎮 Game state changed - clearing recommendation');
            this.currentRecommendation = null;
            this.currentPlayer = null;
            this.updateBoardGrids(data, null, null);
        } else {
            // Game state hasn't changed, preserve recommendation
            this.updateBoardGrids(data, this.currentRecommendation, this.currentPlayer);
        }
    }
    
    initializeBoardGrids() {
        // Initialize current board grid
        this.currentBoardGrid.innerHTML = '';
        this.currentBoardCells = [];
        
        for (let row = 0; row < 8; row++) {
            this.currentBoardCells[row] = [];
            for (let col = 0; col < 8; col++) {
                const cell = document.createElement('div');
                cell.className = 'board-cell';
                cell.dataset.row = row;
                cell.dataset.col = col;
                
                this.currentBoardGrid.appendChild(cell);
                this.currentBoardCells[row][col] = cell;
            }
        }
        
        // Initialize predicted board grid
        this.predictedBoardGrid.innerHTML = '';
        this.predictedBoardCells = [];
        
        for (let row = 0; row < 8; row++) {
            this.predictedBoardCells[row] = [];
            for (let col = 0; col < 8; col++) {
                const cell = document.createElement('div');
                cell.className = 'board-cell';
                cell.dataset.row = row;
                cell.dataset.col = col;
                
                this.predictedBoardGrid.appendChild(cell);
                this.predictedBoardCells[row][col] = cell;
            }
        }
    }
    
    updateBoardGrids(gameData, recommendedPosition, currentPlayer) {
        // Update current board
        this.updateSingleBoard(this.currentBoardCells, gameData, recommendedPosition, true);
        
        // Update predicted board and scores (if we have a recommendation)
        if (recommendedPosition && gameData && currentPlayer) {
            const predictedBoard = this.simulateMove(gameData.board, recommendedPosition, currentPlayer);
            const predictedGameData = { ...gameData, board: predictedBoard };
            this.updateSingleBoard(this.predictedBoardCells, predictedGameData, null, false);
            
            // Calculate and show predicted scores
            this.updatePredictedScores(predictedBoard);
            this.showPredictedScores();
        } else {
            // No recommendation, show same as current board and hide predicted scores
            this.updateSingleBoard(this.predictedBoardCells, gameData, null, false);
            this.hidePredictedScores();
        }
    }
    
    updateSingleBoard(boardCells, gameData, recommendedPosition, showRecommendation) {
        // Clear all cells first
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const cell = boardCells[row][col];
                cell.innerHTML = '';
                cell.className = 'board-cell';
            }
        }
        
        // Add pieces if we have board data
        if (gameData && gameData.board) {
            for (let row = 0; row < 8; row++) {
                for (let col = 0; col < 8; col++) {
                    const cell = boardCells[row][col];
                    const piece = gameData.board[row][col];
                    
                    if (piece === 1) { // Black piece
                        const pieceEl = document.createElement('div');
                        pieceEl.className = 'board-piece black';
                        cell.appendChild(pieceEl);
                    } else if (piece === 2) { // White piece
                        const pieceEl = document.createElement('div');
                        pieceEl.className = 'board-piece white';
                        cell.appendChild(pieceEl);
                    }
                }
            }
        }
        
        // Add recommendation highlight only to current board
        if (showRecommendation && recommendedPosition) {
            const { row, col } = recommendedPosition;
            if (row >= 0 && row < 8 && col >= 0 && col < 8) {
                const cell = boardCells[row][col];
                cell.classList.add('recommended');
                
                // Add star to empty recommended cell
                if (!cell.querySelector('.board-piece')) {
                    const star = document.createElement('div');
                    star.className = 'board-piece recommended';
                    star.innerHTML = '⭐';
                    star.style.display = 'flex';
                    star.style.alignItems = 'center';
                    star.style.justifyContent = 'center';
                    star.style.fontSize = '10px';
                    cell.appendChild(star);
                }
            }
        }
    }
    
    simulateMove(originalBoard, recommendedPosition, currentPlayer) {
        if (!originalBoard || !recommendedPosition) return originalBoard;
        const board = originalBoard.map(r => [...r]);
        const { row, col } = recommendedPosition;
        if (row < 0 || row > 7 || col < 0 || col > 7) return board;

        // Use the provided current player (1=Black, 2=White)
        const opponent = currentPlayer === 1 ? 2 : 1;

        // If target cell not empty, just return copy
        if (board[row][col] !== 0) return board;

        // Gather flips using proper Reversi rules
        const directions = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
        let anyFlips = false;
        const toFlipTotal = [];
        for (const [dx, dy] of directions) {
            let r = row + dx, c = col + dy;
            const path = [];
            while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === opponent) {
                path.push([r, c]); r += dx; c += dy;
            }
            if (path.length > 0 && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === currentPlayer) {
                anyFlips = true; toFlipTotal.push(...path);
            }
        }
        if (!anyFlips) return board; // invalid move safeguard
        board[row][col] = currentPlayer;
        for (const [fr, fc] of toFlipTotal) board[fr][fc] = currentPlayer;
        return board;
    }
    
    updatePredictedScores(predictedBoard) {
        // Count pieces in predicted board
        let blackCount = 0, whiteCount = 0;
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                if (predictedBoard[row][col] === 1) blackCount++;
                else if (predictedBoard[row][col] === 2) whiteCount++;
            }
        }
        
        const totalPieces = blackCount + whiteCount;
        const blackPercent = totalPieces > 0 ? (blackCount / 64) * 100 : 0;
        const whitePercent = totalPieces > 0 ? (whiteCount / 64) * 100 : 0;
        
        console.log('🔮 Predicted scores:', { blackCount, whiteCount, blackPercent, whitePercent });
        
        // Update predicted score bars (horizontal race style)
        this.predictedBlackBar.style.width = `${blackPercent}%`;
        this.predictedWhiteBar.style.width = `${whitePercent}%`;
        
        // Update predicted score text
        this.predictedBlackScore.textContent = `${blackCount}`;
        this.predictedWhiteScore.textContent = `${whiteCount}`;
    }
    
    showPredictedScores() {
        console.log('📊 Showing predicted scores');
        this.predictedScoresHeader.style.display = 'block';
        this.predictedScoresContainer.style.display = 'block';
    }
    
    hidePredictedScores() {
        console.log('📊 Hiding predicted scores');
        this.predictedScoresHeader.style.display = 'none';
        this.predictedScoresContainer.style.display = 'none';
    }
    
    hideRecommendationSection() {
        // Hide the parent section div to prevent empty space
        this.recommendationSection.parentElement.style.display = 'none';
    }
    
    showRecommendationSection() {
        // Show the parent section div
        this.recommendationSection.parentElement.style.display = 'block';
    }
    
    clearAllRecommendationData() {
        // Clear recommendation data and reset UI to clean state
        this.currentRecommendation = null;
        this.recPosition.textContent = '-';
        this.recReasoning.textContent = '-';
        this.hidePredictedScores();
        
        // Clear board grids to empty state
        if (this.currentBoardCells) {
            this.currentBoardCells.forEach(row => {
                row.forEach(cell => {
                    cell.className = 'board-cell';
                    cell.textContent = '';
                });
            });
        }
        
        if (this.predictedBoardCells) {
            this.predictedBoardCells.forEach(row => {
                row.forEach(cell => {
                    cell.className = 'board-cell';
                    cell.textContent = '';
                });
            });
        }
        
        console.log('🧹 Cleared all recommendation data');
    }
    
    handleAssistantToggle(active) {
        console.log('🤖 Assistant toggle:', active);
        this.assistantActive = active;
        
        if (active) {
            // Don't show recommendation section immediately - wait for actual recommendation
            // this.showRecommendationSection();
            // Request initial game data when assistant becomes active
            this.requestGameData();
        } else {
            this.hideRecommendationSection();
            // Clear all recommendation data when assistant is deactivated
            this.clearAllRecommendationData();
        }
    }
    
    updateRecommendation(data) {
        // Only process recommendations if assistant is active
        if (!this.assistantActive) {
            console.log('🤖 Ignoring recommendation - assistant not active');
            return;
        }
        
        if (!data || !data.position) {
            this.recPosition.textContent = '-';
            // If a reasoning message exists, show it (e.g., "No safe non-edge-adjacent moves available")
            if (data && data.reasoning) this.recReasoning.textContent = data.reasoning; else this.recReasoning.textContent = '-';
            this.currentRecommendation = null;
            this.currentPlayer = null;
            this.updateBoardGrids(this.lastGameData, null, null);
            return;
        }
        
        // Show recommendation section now that we have actual data
        this.showRecommendationSection();
        
        // Store the current recommendation to persist it
        this.currentRecommendation = data.position;
        this.currentPlayer = data.currentPlayer; // Store current player from recommendation
        
        // Extract a coordinate-only header and a separate reasoning paragraph.
        // Prefer `data.displayText` (which is typically "Row X, Column Y. concise reasoning")
        // If `data.displayText` contains a leading "Row ..., Column ..." prefix, split it.
        let coordsText = '';
        let reasoningText = '';

        if (data.displayText && typeof data.displayText === 'string') {
            // Match a leading 'Row <n>, Column <m>' (case-insensitive) and optional trailing sentence
            const m = data.displayText.match(/^(Row\s*\d+\s*,\s*Column\s*\d+)\s*\.?\s*(.*)$/i);
            if (m) {
                coordsText = m[1];
                reasoningText = (m[2] || '').trim();
            } else {
                // If it doesn't match, use whole displayText as coords header (fallback)
                coordsText = data.displayText.trim();
            }
        }

        // If coords not present but numeric position exists, build coords from position
        if (!coordsText && data.position && typeof data.position.row === 'number' && typeof data.position.col === 'number') {
            coordsText = `Row ${data.position.row + 1}, Column ${data.position.col + 1}`;
        }

        // For the paragraph below the grids, prefer `data.reasoning` (already sanitized by background),
        // otherwise use any trailing portion parsed from `displayText`.
        if (data.reasoning && typeof data.reasoning === 'string' && data.reasoning.trim().length) {
            reasoningText = data.reasoning.trim();
        }

        // Apply to DOM. If missing, show '-' to indicate absence.
        this.recPosition.textContent = '⭐ ' + coordsText || '-';
        this.recReasoning.textContent = reasoningText || '-';
        
        // Update visual board grid with the new recommendation
        console.log('💡 New recommendation received - showing highlight');
        this.updateBoardGrids(this.lastGameData, this.currentRecommendation, this.currentPlayer);
    }
    
    updateAudioVisualization(frequencies) {
        const audioBars = this.audioVisualizer.querySelectorAll('.audio-bar');
        
        frequencies.forEach((frequency, index) => {
            if (audioBars[index]) {
                // Map frequency (0-255) to height (2px-18px)
                const height = Math.max(2, Math.min(18, (frequency / 255) * 16 + 2));
                audioBars[index].style.height = `${height}px`;
            }
        });
    }
    
    resetAudioVisualization() {
        const audioBars = this.audioVisualizer.querySelectorAll('.audio-bar');
        audioBars.forEach(bar => {
            bar.style.height = '2px';
        });
    }
    
    setupTabNavigation() {
        const tabBtns = document.querySelectorAll('.tab-btn');
        const tabContents = document.querySelectorAll('.tab-content');
        
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetTab = btn.getAttribute('data-tab');
                
                // Remove active class from all tabs and contents
                tabBtns.forEach(b => b.classList.remove('active'));
                tabContents.forEach(c => c.classList.remove('active'));
                
                // Add active class to clicked tab and corresponding content
                btn.classList.add('active');
                document.getElementById(targetTab).classList.add('active');
            });
        });
    }
    
    
    setupSettingsHandlers() {
        // Unified save button handler
        this.saveAllSettings.addEventListener('click', () => {
            this.saveAllSettingsMethod();
        });
        
        // TTS provider radio button handlers
        this.ttsAzure.addEventListener('change', () => {
            if (this.ttsAzure.checked) {
                this.azureSettings.style.display = 'block';
                this.elevenlabsSettings.style.display = 'none';
                // Immediately save provider selection
                chrome.storage.sync.set({ ttsProvider: 'azure' });
                console.log('🔊 Switched to Azure TTS');
            }
        });
        
        this.ttsElevenlabs.addEventListener('change', () => {
            if (this.ttsElevenlabs.checked) {
                this.azureSettings.style.display = 'none';
                this.elevenlabsSettings.style.display = 'block';
                // Immediately save provider selection
                chrome.storage.sync.set({ ttsProvider: 'elevenlabs' });
                console.log('🔊 Switched to Eleven Labs TTS');
            }
        });
    }
    
    updateCaptureState() {
        chrome.runtime.sendMessage({ type: 'GET_CAPTURE_STATE' }, (response) => {
            if (response) {
                this.isCapturing = response.isCapturing;
            }
        });
    }
    
    
    async loadSettings() {
        const result = await chrome.storage.sync.get([
            'openaiEndpoint', 'openaiApiKey', 'openaiDeployment',
            'ttsProvider', 'azureKey', 'azureRegion', 'elevenlabsKey', 'elevenlabsVoiceId'
        ]);
        
        // Load OpenAI settings
    if (result.openaiEndpoint) this.openaiEndpoint.value = result.openaiEndpoint;
    if (result.openaiApiKey) this.openaiKey.value = result.openaiApiKey;
        
        // Load TTS provider settings
        const ttsProvider = result.ttsProvider || 'azure';
        if (ttsProvider === 'azure') {
            this.ttsAzure.checked = true;
            this.azureSettings.style.display = 'block';
            this.elevenlabsSettings.style.display = 'none';
        } else if (ttsProvider === 'elevenlabs') {
            this.ttsElevenlabs.checked = true;
            this.azureSettings.style.display = 'none';
            this.elevenlabsSettings.style.display = 'block';
        }
        
        // Load Azure settings
        if (result.azureKey) this.azureKey.value = result.azureKey;
        if (result.azureRegion) this.azureRegion.value = result.azureRegion;
        
        // Load Eleven Labs settings
        if (result.elevenlabsKey) this.elevenlabsKey.value = result.elevenlabsKey;
        if (result.elevenlabsVoiceId) this.elevenlabsVoiceId.value = result.elevenlabsVoiceId;
    }
        
    async saveAllSettingsMethod() {
        try {
            // Save OpenAI/Azure settings. Allow users to paste the full Azure URL
            // e.g. https://.../openai/deployments/{deployment}/chat/completions?api-version=2025-01-01-preview
            const endpointInput = (this.openaiEndpoint.value || '').trim();
            const parsed = this.parseAzureOpenAIUrl(endpointInput);

            const openaiSettings = {
                openaiEndpoint: parsed.endpoint || endpointInput,
                openaiApiKey: this.openaiKey.value,
                openaiDeployment: parsed.deployment || null,
                openaiApiVersion: parsed.apiVersion || undefined
            };

            // Require that we were able to extract a deployment from the pasted URL
            if (!openaiSettings.openaiDeployment) {
                this.showStatus(this.settingsStatus, 'Please paste the full Azure OpenAI URL that includes the deployment name.', 'error');
                return;
            }

            // Before saving, test connectivity to the constructed Azure chat/completions URL
            const testUrl = `${openaiSettings.openaiEndpoint.replace(/\/+$/,'')}/openai/deployments/${openaiSettings.openaiDeployment}/chat/completions${openaiSettings.openaiApiVersion ? `?api-version=${openaiSettings.openaiApiVersion}` : ''}`;

            // Prepare a minimal ping body (temperature 0, very small token count)
            const testBody = {
                messages: [{ role: 'system', content: 'ping' }],
                temperature: 0,
                max_tokens: 1
            };

            // Perform test call
            let testResponse;
            try {
                testResponse = await fetch(testUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'api-key': openaiSettings.openaiApiKey
                    },
                    body: JSON.stringify(testBody)
                });
            } catch (networkError) {
                console.error('Endpoint connectivity test failed (network):', networkError);
                this.showStatus(this.settingsStatus, `Connection failed: ${networkError.message}`, 'error');
                return;
            }

            if (!testResponse.ok) {
                const text = await testResponse.text().catch(() => '<no body>');
                console.error('Endpoint connectivity test returned error:', testResponse.status, text);
                this.showStatus(this.settingsStatus, `Connection failed: ${testResponse.status} ${testResponse.statusText} - ${text}`, 'error');
                return;
            }

            // If test passed, save the settings
            // Save TTS settings
            const ttsProvider = this.ttsAzure.checked ? 'azure' : 'elevenlabs';
            const ttsSettings = { ttsProvider };
            if (ttsProvider === 'azure') {
                ttsSettings.azureKey = this.azureKey.value;
                ttsSettings.azureRegion = this.azureRegion.value;
            } else if (ttsProvider === 'elevenlabs') {
                ttsSettings.elevenlabsKey = this.elevenlabsKey.value;
                ttsSettings.elevenlabsVoiceId = this.elevenlabsVoiceId.value || 'pNInz6obpgDQGcFmaJgB'; // Default voice
            }

            // Combine all settings
            const allSettings = { ...openaiSettings, ...ttsSettings };
            await chrome.storage.sync.set(allSettings);
            this.showStatus(this.settingsStatus, 'All settings saved and endpoint validated!', 'success');

        } catch (error) {
            console.error('Failed to save settings:', error);
            this.showStatus(this.settingsStatus, 'Failed to save settings', 'error');
        }
    }

    // Parse a pasted Azure OpenAI full URL and extract root endpoint, deployment, and api-version
    // Accepts strings like:
    // https://your-resource.openai.azure.com/openai/deployments/gpt-4.1-mini/chat/completions?api-version=2025-01-01-preview
    // Returns { endpoint: 'https://your-resource.openai.azure.com', deployment: 'gpt-4.1-mini', apiVersion: '2025-01-01-preview' }
    parseAzureOpenAIUrl(input) {
        if (!input || typeof input !== 'string') return {};

        try {
            const url = new URL(input.startsWith('http') ? input : `https://${input}`);

            // Look for the deployments path segment
            // Expected path: /openai/deployments/{deployment}/chat/completions
            const pathParts = url.pathname.split('/').filter(Boolean);
            let deployment = null;
            for (let i = 0; i < pathParts.length - 1; i++) {
                if (pathParts[i] === 'deployments' && pathParts[i + 1]) {
                    deployment = pathParts[i + 1];
                    break;
                }
            }

            // api-version may be in search params
            const apiVersion = url.searchParams.get('api-version') || null;

            // Root endpoint is origin (protocol + host + optional port)
            const endpoint = `${url.protocol}//${url.host}`;

            return { endpoint, deployment, apiVersion };
        } catch (e) {
            // Not a valid URL - return empty to let caller use raw input
            return {};
        }
    }

    showStatus(element, message, type) {
        element.textContent = message;
        element.className = `status ${type}`;
        
        setTimeout(() => {
            element.className = 'status';
        }, 3000);
    }
}

// Initialize the side panel manager when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SidePanelManager();
});
