// Board state extraction utilities using DOM elements
class ReversiAnalyzer {
  constructor() {
    this.boardState = Array(8).fill().map(() => Array(8).fill(0)); // 0=empty, 1=black, 2=white
  }

  extractBoardFromDOM() {
    // Find the reversi board container - try multiple selectors
    let boardContainer = document.querySelector('#reversi-board-inner');
    if (!boardContainer) {
      boardContainer = document.querySelector('.reversi-board-inner');
    }
    if (!boardContainer) {
      boardContainer = document.querySelector('#reversi-board-container');
    }
    if (!boardContainer) {
      console.log('❌ No reversi board container found');
      console.log('Available elements:', document.querySelectorAll('[id*="reversi"], [class*="reversi"]'));
      return null;
    }
    
    // Initialize empty board
    const board = Array(8).fill().map(() => Array(8).fill(0));
    
    // Extract current pieces from div.piece elements
    const pieces = boardContainer.querySelectorAll('div.piece');

    pieces.forEach(piece => {
      const classes = Array.from(piece.classList);
      let row = -1, col = -1, pieceType = 0;

      // Parse classes for row, column, and color
      classes.forEach(className => {
        // Look for row information (r0, r1, r2, etc.)
        const rowMatch = className.match(/^r(\d)$/);
        if (rowMatch) {
          row = parseInt(rowMatch[1]);
        }
        // Look for column information (c0, c1, c2, etc.)
        const colMatch = className.match(/^c(\d)$/);
        if (colMatch) {
          col = parseInt(colMatch[1]);
        }
        // Look for color information
        if (className === 'black') {
          pieceType = 1;
        } else if (className === 'white') {
          pieceType = 2;
        }
      });
      

      // Set board position if valid
      if (row >= 0 && row < 8 && col >= 0 && col < 8) {
        board[row][col] = pieceType;
      }
    });

    return board;
  }

  extractValidMovesFromDOM() {
    // Find all possible moves from data-square elements with possible-move class
    const possibleMoves = document.querySelectorAll('[data-square].possible-move');
    const validMoves = [];

    possibleMoves.forEach(moveElement => {
      const squareData = moveElement.getAttribute('data-square');
      if (!squareData) return;

      // Parse row and column from data-square (format: "2-3" = row 2, col 3)
      const match = squareData.match(/(\d)-(\d)/);
      if (match) {
        const row = parseInt(match[1]);
        const col = parseInt(match[2]);
        validMoves.push([row, col]);
      }
    });

    return validMoves;
  }

  extractGameStateFromDOM() {
    const boardState = this.extractBoardFromDOM();
    const validMoves = this.extractValidMovesFromDOM();

    if (!boardState) {
      return null;
    }

    return {
      board: boardState,
      validMoves: validMoves,
      moveCount: validMoves.length
    };
  }


  boardToString(board) {
    const symbols = ['.', 'B', 'W']; // Empty, Black, White
    return board.map(row => row.map(cell => symbols[cell]).join(' ')).join('\n');
  }
}

// Initialize analyzer
const reversiAnalyzer = new ReversiAnalyzer();
let lastBoardStateForContentScript = null;

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
  initializeExtension();
}

function initializeExtension() {
  console.log('🎮 Reversi Assistant content script loaded');
}

// Content script loaded
console.log('🔧 Reversi content script loaded on:', window.location.href);

// Audio context with smart initialization
let audioContext = null;
let userHasInteracted = false; // Must be set by real user interaction
let currentAudioElement = null; // Track current playing audio for interruption
let audioAnalyzer = null;
let visualizationActive = false;

// Function to enable audio after user interaction
function enableAudio() {
  if (!userHasInteracted) {
    userHasInteracted = true;
    console.log('🔊 Audio enabled via user interaction');
    
    // Create/resume audio context
    if (!window.audioContext) {
      try {
        window.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      } catch (error) {
        console.error('Failed to create audio context:', error);
      }
    }
    
    // Resume audio context if suspended
    if (window.audioContext && window.audioContext.state === 'suspended') {
      window.audioContext.resume().then(() => {
        console.log('🔊 Audio context resumed after user interaction');
      });
    }
  }
}

// Add event listeners for user interactions (especially game moves)
document.addEventListener('click', enableAudio, { once: false });
document.addEventListener('keydown', enableAudio, { once: false });
document.addEventListener('touchstart', enableAudio, { once: false });

// Specifically listen for clicks on the game board (Reversi moves)
document.addEventListener('click', (event) => {
  // Check if click is on game board area (common Reversi selectors)
  const target = event.target;
  if (target.closest('.board, .game-board, [class*="board"], [class*="cell"], [class*="square"]') ||
      target.tagName === 'TD' || target.tagName === 'TH' ||
      target.hasAttribute('data-square')) {
    console.log('🎮 Game move detected - enabling audio and hiding overlay');
    enableAudio();
    hideRecommendationOverlay();
  }
}, { once: false });

// Create floating start/stop button
function createFloatingButton() {
  const button = document.createElement('div');
  button.id = 'reversi-assistant-toggle';
  button.innerHTML = `
    <div class="toggle-icon">▶️</div>
    <div class="toggle-text">Start Assistant</div>
  `;
  button.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: linear-gradient(135deg, #4CAF50, #45a049);
    color: white;
    border: none;
    border-radius: 12px;
    padding: 12px 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    z-index: 10000;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    transition: all 0.3s ease;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
    backdrop-filter: blur(10px);
  `;
  
  // Hover effects
  button.addEventListener('mouseenter', () => {
    button.style.transform = 'translateY(-2px)';
    button.style.boxShadow = '0 6px 20px rgba(0,0,0,0.3)';
  });
  
  button.addEventListener('mouseleave', () => {
    button.style.transform = 'translateY(0)';
    button.style.boxShadow = '0 4px 16px rgba(0,0,0,0.2)';
  });
  
  // Click handler
  button.addEventListener('click', () => {
    enableAudio(); // Enable audio on click
    toggleAssistant();
  });
  
  document.body.appendChild(button);
  return button;
}

// Toggle assistant state
let assistantActive = false;
function toggleAssistant() {
  assistantActive = !assistantActive;
  const button = document.getElementById('reversi-assistant-toggle');
  const icon = button.querySelector('.toggle-icon');
  const text = button.querySelector('.toggle-text');
  
  if (assistantActive) {
    icon.textContent = '⏸️';
    text.textContent = 'Stop Assistant';
    button.style.background = 'linear-gradient(135deg, #f44336, #d32f2f)';
    console.log('🤖 Reversi Assistant activated');
    
    // Send activation message to background
    chrome.runtime.sendMessage({
      type: 'TOGGLE_ASSISTANT',
      active: true
    });
  } else {
    icon.textContent = '▶️';
    text.textContent = 'Start Assistant';
    button.style.background = 'linear-gradient(135deg, #4CAF50, #45a049)';
    console.log('🤖 Reversi Assistant deactivated');
    
    // Send deactivation message to background
    chrome.runtime.sendMessage({
      type: 'TOGGLE_ASSISTANT',
      active: false
    });
  }
}

// Initialize floating button
createFloatingButton();

// Game board overlay for recommendations
let gameOverlay = null;

function createGameBoardOverlay() {
  // Find the specific Reversi board inner element
  const gameBoard = document.querySelector('#reversi-board-inner') || 
                   document.querySelector('.reversi-board-inner') ||
                   document.querySelector('[id*="board-inner"]') ||
                   document.querySelector('.board, .game-board, [class*="board"], table');
  
  if (!gameBoard) {
    console.log('🎯 Game board not found for overlay');
    return null;
  }
  
  
  // Create overlay container
  const overlay = document.createElement('div');
  overlay.id = 'reversi-recommendation-overlay';
  overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 1000;
    display: none;
  `;
  
  // Position overlay relative to game board
  const boardStyle = window.getComputedStyle(gameBoard);
  
  // Make game board container relative if it isn't already
  if (boardStyle.position === 'static') {
    gameBoard.style.position = 'relative';
  }
  
  gameBoard.appendChild(overlay);
  return overlay;
}

function showRecommendationOverlay(row, col, boardSize = 8) {
  if (!gameOverlay) {
    gameOverlay = createGameBoardOverlay();
  }
  
  if (!gameOverlay) return;
  
  // Clear previous recommendation
  gameOverlay.innerHTML = '';
  
  // Try to find the exact cell using data-square attribute
  const targetSquare = `${row}-${col}`;
  const targetCell = document.querySelector(`[data-square="${targetSquare}"]`);
  
  if (targetCell) {
    
    // Get the cell's position relative to the board
    const boardRect = gameOverlay.parentElement.getBoundingClientRect();
    const cellRect = targetCell.getBoundingClientRect();
    
    // Calculate cell position relative to board
    const cellLeft = cellRect.left - boardRect.left;
    const cellTop = cellRect.top - boardRect.top;
    
    // Make circle 15% smaller than cell (cells are square, so width = height)
    const circleSize = cellRect.width * 0.85;
    
    // Calculate circle position to center it in the cell
    const circleLeft = cellLeft + (cellRect.width - circleSize) / 2;
    const circleTop = cellTop + (cellRect.width - circleSize) / 2;
    
    // Convert to percentages (board is square, so width = height)
    const leftPercent = (circleLeft / boardRect.width) * 100;
    const topPercent = (circleTop / boardRect.width) * 100;
    const circleSizePercent = (circleSize / boardRect.width) * 100;
    
    // Create recommendation indicator
    const indicator = document.createElement('div');
    indicator.className = 'recommendation-indicator';
    
    indicator.style.cssText = `
      position: absolute;
      left: ${leftPercent}%;
      top: ${topPercent}%;
      width: ${circleSizePercent}%;
      height: ${circleSizePercent}%;
      background: rgba(255, 215, 0, 0.3);
      border: 3px solid #FFD700;
      border-radius: 50%;
      box-shadow: 
        0 0 15px rgba(255, 215, 0, 0.8),
        0 0 25px rgba(255, 215, 0, 0.6),
        0 0 35px rgba(255, 215, 0, 0.4);
      animation: recommendation-pulse 2s ease-in-out infinite alternate;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      color: #FFD700;
      text-shadow: 0 0 10px rgba(255, 215, 0, 0.8);
      font-weight: bold;
    `;
    
    // Add pulsing star icon
    indicator.innerHTML = '⭐';
    
    gameOverlay.appendChild(indicator);
    gameOverlay.style.display = 'block';
    
  } else {
    console.warn(`🎯 Cell with data-square="${targetSquare}" not found, skipping overlay`);
  }
}

function hideRecommendationOverlay() {
  if (gameOverlay) {
    gameOverlay.style.display = 'none';
    gameOverlay.innerHTML = '';
  }
  console.log('🎯 Hiding recommendation overlay');
}

// Add CSS animation for the overlay
const overlayStyles = document.createElement('style');
overlayStyles.textContent = `
  @keyframes recommendation-pulse {
    from {
      transform: scale(0.95);
      box-shadow: 
        0 0 15px rgba(255, 215, 0, 0.8),
        0 0 25px rgba(255, 215, 0, 0.6),
        0 0 35px rgba(255, 215, 0, 0.4);
    }
    to {
      transform: scale(1.05);
      box-shadow: 
        0 0 20px rgba(255, 215, 0, 1),
        0 0 35px rgba(255, 215, 0, 0.8),
        0 0 50px rgba(255, 215, 0, 0.6);
    }
  }
  
  .recommendation-indicator {
    transition: all 0.3s ease;
  }
  
  .recommendation-indicator:hover {
    transform: scale(1.1) !important;
  }
`;
document.head.appendChild(overlayStyles);

// Also try to enable when extension is activated
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'EXTENSION_ACTIVATED') {
    console.log('🔊 Extension activated - attempting to enable audio');
    enableAudio();
  } else if (message.type === 'SHOW_RECOMMENDATION_OVERLAY') {
    // Show recommendation overlay on main game board
    const { row, col } = message.position;
    showRecommendationOverlay(row, col);
  } else if (message.type === 'HIDE_RECOMMENDATION_OVERLAY') {
    // Hide recommendation overlay
    hideRecommendationOverlay();
  }
});

// Audio visualization setup
function setupAudioVisualization(audioElement) {
  try {
    if (!window.audioContext) {
      window.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    // Create audio source from the audio element
    const source = window.audioContext.createMediaElementSource(audioElement);
    const analyzer = window.audioContext.createAnalyser();
    
    // Configure analyzer
    analyzer.fftSize = 64; // Small for performance
    analyzer.smoothingTimeConstant = 0.8;
    
    // Connect audio graph
    source.connect(analyzer);
    analyzer.connect(window.audioContext.destination);
    
    // Start visualization
    audioAnalyzer = analyzer;
    visualizationActive = true;
    startVisualization();
    
  } catch (error) {
    console.error('Failed to setup audio visualization:', error);
  }
}

function startVisualization() {
  if (!visualizationActive || !audioAnalyzer) return;
  
  const bufferLength = audioAnalyzer.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  
  function updateVisualization() {
    if (!visualizationActive) return;
    
    audioAnalyzer.getByteFrequencyData(dataArray);
    
    // Send frequency data to side panel for visualization
    chrome.runtime.sendMessage({
      type: 'AUDIO_FREQUENCY_DATA',
      frequencies: Array.from(dataArray.slice(0, 7)) // Use first 7 frequencies for 7 bars
    });
    
    requestAnimationFrame(updateVisualization);
  }
  
  updateVisualization();
}

function stopVisualization() {
  visualizationActive = false;
  audioAnalyzer = null;
  
  // Reset visualization bars
  chrome.runtime.sendMessage({
    type: 'AUDIO_VISUALIZATION_STOPPED'
  });
}

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.type === 'getGameState') {
    // Send current game state to side panel
    const analyzer = new ReversiAnalyzer();
    const gameState = analyzer.extractGameStateFromDOM();
    
    if (gameState) {
      // Count pieces
      let blackCount = 0, whiteCount = 0;
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          if (gameState.board[row][col] === 1) blackCount++;
          else if (gameState.board[row][col] === 2) whiteCount++;
        }
      }
      
      // Send to side panel
      chrome.runtime.sendMessage({
        type: 'gameUpdate',
        data: {
          blackCount,
          whiteCount,
          validMoves: gameState.validMoves,
          board: gameState.board
        }
      });
    }
    
    sendResponse({ success: true });
  } else if (message.type === 'PLAY_AUDIO') {
    // Handle audio playback from background script
    console.log('🔊 Received PLAY_AUDIO message:', message.text);
    
    try {
      if (!userHasInteracted) {
        console.log('🔇 Audio blocked - waiting for user to make a move. Audio will work after first game interaction.');
        
        // Silently fail - no intrusive UI elements
        // Audio will work after user makes their first move
        chrome.runtime.sendMessage({
          type: 'AUDIO_ACTUALLY_ENDED',
          text: message.text,
          error: 'Waiting for first user move'
        });
        
        sendResponse({ success: false, error: 'User interaction required' });
        return false;
      }

      const audioData = new Uint8Array(message.audioData);
      
      if (audioData.length === 0) {
        console.error('🔊 Audio data is empty!');
        
        // Notify background that audio failed so UI state can reset
        chrome.runtime.sendMessage({
          type: 'AUDIO_ACTUALLY_ENDED',
          text: message.text,
          error: 'Empty audio data'
        });
        
        sendResponse({ success: false, error: 'Empty audio data' });
        return false;
      }
      
      const audioBlob = new Blob([audioData], { type: 'audio/mpeg' });
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      
      // Set volume explicitly
      audio.volume = 1.0;
      audio.preload = 'auto';
      audio.crossOrigin = 'anonymous';
            
      audio.onloadedmetadata = () => {
        const actualDurationMs = Math.round(audio.duration * 1000);
        
        // Send the actual duration back to background script
        chrome.runtime.sendMessage({
          type: 'AUDIO_DURATION_DETECTED',
          actualDuration: actualDurationMs,
          text: message.text
        });
        
        // Set up audio analysis for visualization after metadata is loaded
        try {
          setupAudioVisualization(audio);
        } catch (vizError) {
          console.error('🔊 Audio visualization setup failed:', vizError);
        }
      };
      
      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        if (document.body.contains(audio)) {
          document.body.removeChild(audio);
        }
        
        // Stop visualization
        stopVisualization();
        
        // Clear current audio reference
        if (currentAudioElement === audio) {
          currentAudioElement = null;
        }
        
        // Notify background that audio actually ended
        chrome.runtime.sendMessage({
          type: 'AUDIO_ACTUALLY_ENDED',
          text: message.text
        });
      };
      
      audio.onerror = (error) => {
        console.error('🔊 Audio playback error:', error);
        console.error('🔊 Audio error details:', audio.error);
        URL.revokeObjectURL(audioUrl);
        if (document.body.contains(audio)) {
          document.body.removeChild(audio);
        }
        
        // Clear current audio reference
        if (currentAudioElement === audio) {
          currentAudioElement = null;
        }
      };
      
      // Stop any currently playing audio
      if (currentAudioElement) {
        try {
          currentAudioElement.pause();
          currentAudioElement.currentTime = 0;
          if (document.body.contains(currentAudioElement)) {
            document.body.removeChild(currentAudioElement);
          }
        } catch (e) {
          console.log('Error stopping previous audio:', e);
        }
      }
      
      // Set as current audio and add to DOM
      currentAudioElement = audio;
      document.body.appendChild(audio);
      
      // Start playback
      
      // Ensure audio context is resumed (required for some browsers)
      if (window.audioContext && window.audioContext.state === 'suspended') {
        console.log('🔊 Resuming suspended audio context');
        window.audioContext.resume().then(() => {
          console.log('🔊 Audio context resumed');
        }).catch((err) => {
          console.error('🔊 Failed to resume audio context:', err);
        });
      }
      
      // Handle audio play promise
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          console.log('🔊 Audio duration:', audio.duration);
        }).catch((error) => {
          console.error('🔊 Audio play() failed:', error);
          console.error('🔊 Error name:', error.name);
          console.error('🔊 Error message:', error.message);
          
          // Clean up on play failure
          if (currentAudioElement === audio) {
            currentAudioElement = null;
          }
          if (document.body.contains(audio)) {
            document.body.removeChild(audio);
          }
          
          // Stop any visualization that might have started
          stopVisualization();
          
          // Notify background that audio failed so UI state can reset
          chrome.runtime.sendMessage({
            type: 'AUDIO_ACTUALLY_ENDED',
            text: message.text,
            error: error.message
          });
        });
      } else {
        console.log('🔊 Audio play() returned undefined (older browser)');
      }
      
      sendResponse({ success: true });
      return false; // Send response immediately after starting playback
    } catch (error) {
      console.error('Audio processing failed:', error);
      sendResponse({ success: false, error: error.message });
      return false;
    }
  } else if (message.type === 'STOP_AUDIO') {
    // Handle audio stop request from background script
    console.log('🔊 Received STOP_AUDIO request');
    
    if (currentAudioElement) {
      try {
        currentAudioElement.pause();
        currentAudioElement.currentTime = 0;
        
        // Stop visualization
        stopVisualization();
        
        // Clean up the audio element
        if (document.body.contains(currentAudioElement)) {
          document.body.removeChild(currentAudioElement);
        }
        
        currentAudioElement = null;
        
        sendResponse({ success: true, stopped: true });
      } catch (error) {
        console.error('Error stopping audio:', error);
        sendResponse({ success: false, error: error.message });
      }
    } else {
      sendResponse({ success: true, noAudio: true });
    }
    
    return false;
  } else if (message.type === 'ANALYZE_BOARD') {
    
    // Check if assistant is active - if not, only send basic game state without AI analysis
    if (!assistantActive) {
      console.log('🤖 Assistant not active - sending basic game state only');
      const analyzer = new ReversiAnalyzer();
      const gameState = analyzer.extractGameStateFromDOM();
      
      if (gameState) {
        // Send basic game state to side panel without AI analysis
        chrome.runtime.sendMessage({
          type: 'gameUpdate',
          data: {
            blackCount: gameState.board.flat().filter(cell => cell === 1).length,
            whiteCount: gameState.board.flat().filter(cell => cell === 2).length,
            validMoves: gameState.validMoves,
            board: gameState.board
          }
        });
      }
      
      sendResponse({ success: true, assistantInactive: true });
      return;
    }
    
    // Extract game state from DOM
    const analyzer = new ReversiAnalyzer();
    const gameState = analyzer.extractGameStateFromDOM();
    
    if (gameState) {
      // Check if no valid moves detected - don't call background script
      if (gameState.validMoves.length === 0) {
        console.log('⚠️ No valid moves detected - skipping background script call');
        sendResponse({ success: true, skipped: true, reason: 'no_valid_moves' });
        return;
      }
      
      // Check if board state changed before sending to background
      const currentBoardStateString = JSON.stringify(gameState.board);
      if (lastBoardStateForContentScript === currentBoardStateString) {
        sendResponse({ success: true, skipped: true });
        return;
      }
      
      // Send extracted data to background script for analysis
      chrome.runtime.sendMessage({
        type: 'GAME_STATE_EXTRACTED',
        boardState: gameState.board,
        validMoves: gameState.validMoves,
        moveCount: gameState.moveCount,
        timestamp: new Date().toISOString()
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('Error sending game state:', chrome.runtime.lastError.message);
        } else {
          console.log('✅ Game state sent to background script');
          // Store board state after successful send
          lastBoardStateForContentScript = currentBoardStateString;
        }
      });
      sendResponse({ success: true });
    } else {
      console.log('❌ No Reversi game detected on this page');
      sendResponse({ success: false });
    }
  }
  
  return true; // Keep message channel open
});
