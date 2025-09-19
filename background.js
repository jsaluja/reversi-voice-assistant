let captureInterval = null;
let lastBoardStateForOpenAI = null;
let currentTTSInstance = null;

// Helper function to check if a tab URL matches the extension's content script scope
function isValidGameTab(tab) {
  if (!tab || !tab.url) return false;
  try {
    const url = new URL(tab.url);
    return url.hostname.includes('cardgames.io');
  } catch (e) {
    return false;
  }
}

// Load shared sanitizer for reasoning text (available as global `sanitizeReasoning`)
try {
  // Use chrome.runtime.getURL to resolve extension-relative path in service worker
  if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
    importScripts(chrome.runtime.getURL('shared/sanitizer.js'));
  } else {
    // Fallback: try plain importScripts for other worker contexts
    importScripts('shared/sanitizer.js');
  }
} catch (e) {
  // If importScripts isn't available or file not found, it's okay — we'll fallback to a safe behavior later
}

/* Inlined OpenAIAnalyzer class to avoid dynamic import/importScripts issues
   in the service worker environment. This is the same logic as in
   openai_analyzer.js but embedded here so the background worker can
   instantiate it directly without cross-file imports. */
class OpenAIAnalyzer {
  // Remove incorrect edge claims if move not actually on an edge (0-based)
  sanitizeEdgeReasoning(recommendedMove, reasoning) {
    try {
      if (!Array.isArray(recommendedMove) || recommendedMove.length !== 2) return reasoning;
      const [r, c] = recommendedMove;
      const isEdge = (r === 0 || r === 7 || c === 0 || c === 7);
      if (isEdge) return reasoning; // Legit edge, no change
      // Not on edge – strip any edge-claim phrases
      if (typeof reasoning === 'string') {
        const patterns = [
          /secures (the )?right edge/gi,
          /secures (the )?left edge/gi,
          /secures (the )?top edge/gi,
            /secures (the )?bottom edge/gi,
          /captures (opponent pieces on the |opponent pieces on |the )?right edge/gi,
          /captures (opponent pieces on the |opponent pieces on |the )?left edge/gi,
          /captures (opponent pieces on the |opponent pieces on |the )?top edge/gi,
          /captures (opponent pieces on the |opponent pieces on |the )?bottom edge/gi,
          /captures opponent pieces on right edge/gi,
          /captures opponent pieces on left edge/gi,
          /captures opponent pieces on top edge/gi,
          /captures opponent pieces on bottom edge/gi,
          /gains? (the )?right edge/gi,
          /gains? (the )?left edge/gi,
          /gains? (the )?top edge/gi,
          /gains? (the )?bottom edge/gi,
          /takes (the )?right edge/gi,
          /takes (the )?left edge/gi,
          /takes (the )?top edge/gi,
          /takes (the )?bottom edge/gi,
          /captures edge and/gi,
          /captures edge,/gi,
          /captures (the )?edge(?!\s+and\s+blocks)/gi,
          /securing.*edge/gi,
          /strengthening board control by? (securing|taking) (the )?right edge/gi,
          /preventing opponent'?s? edge access/gi,
          // Filter out incorrect diagonal edge terminology
          /captures (the )?top-right edge/gi,
          /captures (the )?top-left edge/gi,
          /captures (the )?bottom-right edge/gi,
          /captures (the )?bottom-left edge/gi,
          /secures (the )?top-right edge/gi,
          /secures (the )?top-left edge/gi,
          /secures (the )?bottom-right edge/gi,
          /secures (the )?bottom-left edge/gi,
          /gains? (the )?top-right edge/gi,
          /gains? (the )?top-left edge/gi,
          /gains? (the )?bottom-right edge/gi,
          /gains? (the )?bottom-left edge/gi,
          /takes (the )?top-right edge/gi,
          /takes (the )?top-left edge/gi,
          /takes (the )?bottom-right edge/gi,
          /takes (the )?bottom-left edge/gi
        ];
        let cleaned = reasoning;
        for (const p of patterns) cleaned = cleaned.replace(p, '').trim();
        
        // Fix common LLM errors - remove extra "s" after move descriptions
        cleaned = cleaned.replace(/\b(Strong central move|Safe central move|Available move|Strong edge position|Safe central position)\s+s\b/gi, '$1');
        
        // Collapse duplicate spaces and trailing punctuation spacing
        cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/\s+([,\.])/g, '$1').trim();
        if (cleaned.length === 0) cleaned = 'Solid positional move maintaining interior stability.';
        // Ensure first character is capitalized
        if (cleaned.length > 0) {
          cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
        }
        return cleaned;
      }
      return reasoning;
    } catch (e) {
      return reasoning;
    }
  }
  constructor(apiKey, endpoint, deployment, apiVersion = '2024-04-01-preview') {
    if (!endpoint || !deployment) {
      throw new Error('Azure OpenAI configuration required: endpoint and deployment must be provided');
    }

    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.deployment = deployment;
    this.apiVersion = apiVersion;

  const sanitized = String(endpoint).replace(/\/+$/g, '');
    // build base URL without trailing slash issues
    this.baseUrl = `${String(endpoint).replace(/\/+$/g, '')}/openai/deployments/${deployment}/chat/completions?api-version=${this.apiVersion}`;
    this.isAzure = true;
  }

  formatBoardForLLM(board) {
    const symbols = { 0: '.', 1: 'B', 2: 'W' };
    let boardStr = '  0 1 2 3 4 5 6 7\n';
    for (let row = 0; row < 8; row++) {
      boardStr += `${row} `;
      for (let col = 0; col < 8; col++) {
        boardStr += `${symbols[board[row][col]]} `;
      }
      boardStr += '\n';
    }
    return boardStr;
  }

  calculateGamePhase(boardState) {
    let totalPieces = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (boardState[r][c] !== 0) totalPieces++;
      }
    }
    
    if (totalPieces <= 6) return 'opening';
    if (totalPieces < 20) return 'early';
    if (totalPieces < 45) return 'mid';
    return 'late';
  }

  isEdgeRecaptureMove(row, col, boardState, currentPlayer = 1) {
    // Check if this edge move captures opponent pieces OR prevents opponent edge takeover
    const opponent = currentPlayer === 1 ? 2 : 1;
    
    // Check all 8 directions for valid captures
    const directions = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    let capturesAnyPieces = false;
    
    for (const [dr, dc] of directions) {
      const captured = [];
      let r = row + dr;
      let c = col + dc;
      
      // Follow direction while finding opponent pieces
      while (r >= 0 && r < 8 && c >= 0 && c < 8 && boardState[r][c] === opponent) {
        captured.push([r, c]);
        r += dr;
        c += dc;
      }
      
      // Valid capture if we find our piece at the end AND captured at least one opponent piece
      if (r >= 0 && r < 8 && c >= 0 && c < 8 && boardState[r][c] === currentPlayer && captured.length > 0) {
        capturesAnyPieces = true;
        break;
      }
    }
    
    // ADDITIONAL CHECK: Is this a critical edge defense/recapture position?
    if (!capturesAnyPieces) {
      // Check if opponent has pieces on this edge and we need to secure it
      let edgePositions = [];
      if (row === 0) {
        edgePositions = [[0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[0,6],[0,7]];
      } else if (row === 7) {
        edgePositions = [[7,0],[7,1],[7,2],[7,3],[7,4],[7,5],[7,6],[7,7]];
      } else if (col === 0) {
        edgePositions = [[0,0],[1,0],[2,0],[3,0],[4,0],[5,0],[6,0],[7,0]];
      } else if (col === 7) {
        edgePositions = [[0,7],[1,7],[2,7],[3,7],[4,7],[5,7],[6,7],[7,7]];
      }
      
      // Count control on this edge
      let ourControl = 0;
      let opponentControl = 0;
      for (const [r, c] of edgePositions) {
        if (boardState[r][c] === currentPlayer) ourControl++;
        else if (boardState[r][c] === opponent) opponentControl++;
      }
      
      // This is a critical recapture if opponent has edge presence and we need to contest it
      if (opponentControl > 0 && ourControl > 0) {
        capturesAnyPieces = true; // Treat as high priority recapture
      }
    }
    
    return capturesAnyPieces;
  }

  isSecureEdgeMove(row, col, boardState, currentPlayer = 1) {
    // Check if an edge move is secure (won't be immediately recaptured)
    const opponent = currentPlayer === 1 ? 2 : 1;
    
    // PRIORITY 1: If this captures any pieces on edge, check if it's still secure
    if (this.isEdgeRecaptureMove(row, col, boardState, currentPlayer)) {
      // Even if it captures pieces, check if opponent can immediately recapture
      return this.checkEdgeSecurityAfterMove(row, col, boardState, currentPlayer);
    }
    
    // PRIORITY 2: For non-capture edge moves, check basic security
    return this.checkEdgeSecurityAfterMove(row, col, boardState, currentPlayer);
  }

  checkEdgeSecurityAfterMove(row, col, boardState, currentPlayer = 1) {
    // Simulate the move and check if opponent can immediately recapture
    const opponent = currentPlayer === 1 ? 2 : 1;
    
    // Create a copy of the board with our move played
    const testBoard = boardState.map(row => [...row]);
    testBoard[row][col] = currentPlayer;
    
    // Simulate the actual captures this move would make
    const directions = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    for (const [dr, dc] of directions) {
      const captured = [];
      let r = row + dr;
      let c = col + dc;
      
      while (r >= 0 && r < 8 && c >= 0 && c < 8 && testBoard[r][c] === opponent) {
        captured.push([r, c]);
        r += dr;
        c += dc;
      }
      
      if (r >= 0 && r < 8 && c >= 0 && c < 8 && testBoard[r][c] === currentPlayer && captured.length > 0) {
        // Apply the captures
        for (const [cr, cc] of captured) {
          testBoard[cr][cc] = currentPlayer;
        }
      }
    }
    
    // Now check if opponent has any moves that can recapture our position OR create edge vulnerabilities
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (testBoard[r][c] === 0) { // Empty position
          // Check if opponent can make a valid move here
          let hasValidMove = false;
          const potentialCaptures = [];
          
          for (const [dr, dc] of directions) {
            const wouldCapture = [];
            let tr = r + dr;
            let tc = c + dc;
            
            while (tr >= 0 && tr < 8 && tc >= 0 && tc < 8 && testBoard[tr][tc] === currentPlayer) {
              wouldCapture.push([tr, tc]);
              tr += dr;
              tc += dc;
            }
            
            if (tr >= 0 && tr < 8 && tc >= 0 && tc < 8 && testBoard[tr][tc] === opponent && wouldCapture.length > 0) {
              hasValidMove = true;
              potentialCaptures.push(...wouldCapture);
              
              // Check if our edge position would be recaptured
              for (const [wr, wc] of wouldCapture) {
                if (wr === row && wc === col) {
                  return false; // Our move can be immediately recaptured
                }
              }
            }
          }
          
          // Additional check: if this is an edge move and opponent could place adjacent to us on same edge
          if (hasValidMove && (row === 0 || row === 7 || col === 0 || col === 7)) {
            // Check if opponent move is adjacent to our edge position on the same edge
            const sameEdge = (row === 0 && r === 0) || (row === 7 && r === 7) || 
                           (col === 0 && c === 0) || (col === 7 && c === 7);
            const adjacent = Math.abs(r - row) <= 1 && Math.abs(c - col) <= 1;
            
            if (sameEdge && adjacent && potentialCaptures.length >= 2) {
              // Opponent could establish strong edge presence next to us
              return false;
            }
          }
        }
      }
    }
    
    return true; // Move appears secure
  }

  classifyMoves(boardState, validMoves, currentPlayer = 1) {
    // Helper to determine true edge/corner status (0-based indices)
    const isCorner = (r, c) => (r === 0 || r === 7) && (c === 0 || c === 7);
    const isEdge = (r, c) => !isCorner(r, c) && (r === 0 || r === 7 || c === 0 || c === 7);

    const cornerMoves = [];
    const edgeRecaptureMoves = [];  // NEW: Highest priority edge moves
    const edgeMoves = [];
    const safeInteriorMoves = [];
    const edgeAdjacentMoves = [];
    const dangerousMoves = [];

    for (const [r, c] of validMoves) {
      // Check if corner-adjacent dangerous
      if (this.isCornerAdjacentDangerous(r, c, boardState)) {
        dangerousMoves.push([r, c, 'DANGEROUS: Corner-adjacent']);
        continue;
      }

      // Check move type
      if (isCorner(r, c)) {
        cornerMoves.push([r, c, 'CORNER: High priority']);
      } else if (isEdge(r, c)) {
        // Re-evaluate edge priority: always prioritize actual capturing edge moves even if risky
        const opponent = currentPlayer === 1 ? 2 : 1;
        const directions = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
        let flipsPieces = false;
        for (const [dr, dc] of directions) {
          let tr = r + dr, tc = c + dc;
            let seenOpponent = false;
          while (tr >= 0 && tr < 8 && tc >= 0 && tc < 8 && boardState[tr][tc] === opponent) {
            seenOpponent = true; tr += dr; tc += dc;
          }
          if (seenOpponent && tr >= 0 && tr < 8 && tc >= 0 && tc < 8 && boardState[tr][tc] === currentPlayer) { flipsPieces = true; break; }
        }
        const secure = this.checkEdgeSecurityAfterMove(r, c, boardState, currentPlayer);
        if (flipsPieces) {
          edgeRecaptureMoves.push([r, c, secure ? 'EDGE CAPTURE: Takes opponent pieces' : 'EDGE CAPTURE (RISKY): Takes opponent pieces']);
        } else if (secure) {
          edgeRecaptureMoves.push([r, c, 'EDGE: Secure position']);
        } else {
          edgeAdjacentMoves.push([r, c, 'RISKY: Vulnerable edge - can be recaptured']);
        }
      } else if (r >= 2 && r <= 5 && c >= 2 && c <= 5) {
        safeInteriorMoves.push([r, c, 'SAFE: Central position']);
      } else if (r === 1 || r === 6 || c === 1 || c === 6) {
        edgeAdjacentMoves.push([r, c, 'RISKY: Edge-adjacent']);
      } else {
        safeInteriorMoves.push([r, c, 'SAFE: Interior position']);
      }
    }

    return {
      cornerMoves,
      edgeRecaptureMoves,  // NEW: Separate category for edge recaptures
      edgeMoves, 
      safeInteriorMoves,
      edgeAdjacentMoves,
      dangerousMoves
    };
  }

  createPrompt(boardState, validMoves, moveCount, currentPlayer = 1) {
    const boardStr = this.formatBoardForLLM(boardState);
    const playerSymbol = currentPlayer === 1 ? 'B (Black)' : 'W (White)';
    const opponentSymbol = currentPlayer === 1 ? 'W (White)' : 'B (Black)';
    const gamePhase = this.calculateGamePhase(boardState);

    // Classify moves by safety and strategic value
    const classified = this.classifyMoves(boardState, validMoves, currentPlayer);
    
    // Build recommended moves list (EXCLUSIVE priority - only highest available category)
    let recommendedMoves = [];
    let availableCategories = [];

    // Priority 1: Corners (if available, ONLY show corners)
    if (classified.cornerMoves.length > 0) {
      recommendedMoves = classified.cornerMoves;
      availableCategories = ['CORNERS'];
    }
    // Priority 2: Edge Recaptures (HIGHEST PRIORITY after corners)
    else if (classified.edgeRecaptureMoves.length > 0) {
      recommendedMoves = classified.edgeRecaptureMoves;
      availableCategories = ['EDGE RECAPTURES'];
    }
    // Priority 3: Secure Edges (if no corners/recaptures, ONLY show secure edges)
    else if (classified.edgeMoves.length > 0) {
      recommendedMoves = classified.edgeMoves;
      availableCategories = ['EDGES'];
    }
    // Priority 4: Safe Interior (if no corners/edges, ONLY show safe interior)
    else if (classified.safeInteriorMoves.length > 0) {
      recommendedMoves = classified.safeInteriorMoves;
      availableCategories = ['SAFE INTERIOR'];
    }
    // Priority 5: Edge-Adjacent (forced choice)
    else if (classified.edgeAdjacentMoves.length > 0) {
      recommendedMoves = classified.edgeAdjacentMoves;
      availableCategories = ['EDGE-ADJACENT (FORCED)'];
    }
    // Priority 6: Dangerous (last resort)
    else if (classified.dangerousMoves.length > 0) {
      recommendedMoves = classified.dangerousMoves;
      availableCategories = ['DANGEROUS (LAST RESORT)'];
    }

    const movesStr = recommendedMoves.map(([r, c, desc]) => `(${r},${c}) - ${desc}`).join(', ');
    const categoriesStr = availableCategories.join(', ');

    // If only one move in highest priority category, return it directly without LLM call
    if (recommendedMoves.length === 1) {
      const [row, col, desc] = recommendedMoves[0];
      const categoryName = availableCategories[0];
      
      // Validate coordinates are within board bounds
      if (row < 0 || row >= 8 || col < 0 || col >= 8) {
        console.error(`Invalid coordinates: Row ${row}, Column ${col}`);
        // Fall back to LLM analysis instead of using invalid move
        // Continue with normal LLM prompt creation...
      }
      
      let reasoning;
      if (categoryName === 'CORNERS') {
        // Name the specific corner
        if (row === 0 && col === 0) reasoning = 'Captures top-left corner.';
        else if (row === 0 && col === 7) reasoning = 'Captures top-right corner.';
        else if (row === 7 && col === 0) reasoning = 'Captures bottom-left corner.';
        else if (row === 7 && col === 7) reasoning = 'Captures bottom-right corner.';
        else reasoning = 'Secures corner position.';
      } else if (categoryName === 'EDGE RECAPTURES') {
        // Check what this move actually does before describing it
        const opponent = currentPlayer === 1 ? 2 : 1;
        const directions = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
        let actuallyFlipsPieces = false;
        
        for (const [dr, dc] of directions) {
          let testR = row + dr, testC = col + dc;
          let hasOpponentBetween = false;
          while (testR >= 0 && testR < 8 && testC >= 0 && testC < 8) {
            if (boardState && boardState[testR] && boardState[testR][testC] === opponent) {
              hasOpponentBetween = true;
              testR += dr; testC += dc;
            } else {
              break;
            }
          }
          if (hasOpponentBetween && testR >= 0 && testR < 8 && testC >= 0 && testC < 8 && 
              boardState && boardState[testR] && boardState[testR][testC] === currentPlayer) {
            actuallyFlipsPieces = true;
            break;
          }
        }
        
        // Generate accurate reasoning based on what actually happens
        if (actuallyFlipsPieces) {
          if (row === 0) reasoning = 'Captures opponent pieces on top edge.';
          else if (row === 7) reasoning = 'Captures opponent pieces on bottom edge.';
          else if (col === 0) reasoning = 'Captures opponent pieces on left edge.';
          else if (col === 7) reasoning = 'Captures opponent pieces on right edge.';
          else reasoning = 'Captures opponent pieces.';
        } else {
          if (row === 0) reasoning = 'Secures top edge position.';
          else if (row === 7) reasoning = 'Secures bottom edge position.';
          else if (col === 0) reasoning = 'Secures left edge position.';
          else if (col === 7) reasoning = 'Secures right edge position.';
          else reasoning = 'Secures edge position.';
        }
      } else if (categoryName === 'EDGES') {
        // Name the specific edge
        if (row === 0) reasoning = 'Captures top edge.';
        else if (row === 7) reasoning = 'Captures bottom edge.';
        else if (col === 0) reasoning = 'Captures left edge.';
        else if (col === 7) reasoning = 'Captures right edge.';
        else reasoning = 'Captures edge for board control.';
      } else if (categoryName === 'SAFE INTERIOR') {
        reasoning = 'Safe central position.';
      } else if (categoryName === 'EDGE-ADJACENT (FORCED)') {
        reasoning = 'Only available safe move.';
      } else {
        reasoning = 'Only legal move available.';
      }
      
      return {
        recommendedMove: [row, col],
        reasoning: this.sanitizeEdgeReasoning([row, col], reasoning)
      };
    }

  return `You are a Reversi/Othello strategist. Choose the best move for ${playerSymbol} from the pre-filtered safe options.

CURRENT BOARD (B=Black, W=White, .=Empty):
${boardStr}
YOUR ROLE: You are playing as ${playerSymbol}. Your goal is to maximize ${playerSymbol}'s winning chances.
OPPONENT: ${opponentSymbol}

RECOMMENDED MOVES (0-based coordinates, pre-filtered for safety): ${movesStr}
AVAILABLE CATEGORIES: ${categoriesStr}
MOVE COUNT: ${moveCount}
GAME PHASE: ${gamePhase}

SIMPLE STRATEGY:
1. CORNERS: Always take corners if available - they control edges and can't be recaptured
2. EDGES: Good for board control when safe  
3. SAFE INTERIOR: Central positions that don't expose edges to opponent
4. Choose the move with best strategic value from the recommended list

CRITICAL SAFETY RULES (MUST FOLLOW):
- CORNER-ADJACENT DANGER: AVOID positions adjacent to EMPTY corners as this gives opponent immediate corner access: avoid (0,1), (1,0), (1,1) if corner (0,0) is empty; avoid (0,6), (1,6), (1,7) if corner (0,7) is empty; avoid (6,0), (6,1), (7,1) if corner (7,0) is empty; avoid (6,6), (6,7), (7,6) if corner (7,7) is empty
- EDGE-ADJACENT DANGER: NEVER CHOOSE positions adjacent to edges (rows/cols 1 and 6) when ANY safe interior moves exist - they expose edges to opponent: positions like (1,X), (6,X), (X,1), (X,6) should ONLY be chosen if absolutely NO moves available in rows 2-5, cols 2-5
- EDGE CAUTION: Playing on edges (row 0, 7 or col 0, 7) is risky unless you control the adjacent corners
- INTERIOR PREFERENCE: In early game, prefer central positions (rows 2-5, cols 2-5) unless tactical advantage is overwhelming
- LOOK-AHEAD DEFENSE: Before choosing any move, mentally simulate opponent's best response - avoid moves that create opponent opportunities

STRATEGIC PRIORITY ORDER:
1. CORNERS: Always capture available corners - they control two edges and cannot be recaptured
2. EDGE CAPTURES: Secure new edges (top, bottom, left, right) - crucial for board control
3. EDGE DEFENSE: Secure the edge if opponent plays next to our edge piece and we can capture the opponent's piece on that edge with our move
4. DEFENSIVE BLOCKING: Avoid moves on rows, columns adjacent to edges. Avoid playing next to empty corners unless edge is completely empty or already secured by us
5. EDGE RECAPTURE: If opponent has played next to our edge piece, Capture the opponent's piece on that edge with our move
7. CENTRAL CONTROL: Build strong central position for mobility and future options
8. TACTICAL GAINS: High flip counts only if position remains strategically sound, and especially in last 3 moves
9. FORCING MOVES: Create situations where opponent has only one move which you can then counter effectively, or opponent is not allowed any move and is forced to pass
10. ENDGAME STRATEGY: In late game, prioritize moves that maximize final board control and limit opponent options

TERMINOLOGY:
- ONLY use these edge names: "top edge", "bottom edge", "left edge", "right edge"
- ONLY use these corner names: "top-left corner", "top-right corner", "bottom-left corner", "bottom-right corner"
- Row 0 = top edge, Row 7 = bottom edge, Column 0 = left edge, Column 7 = right edge
- Row 0 Column 0 = top-left corner, Row 0 Column 7 = top-right corner, Row 7 Column 0 = bottom-left corner, Row 7 Column 7 = bottom-right corner

EXPLANATION REQUIREMENTS:
- CONCISE: Keep reasoning to 5-10 seconds of TTS reading time (approximately 15-30 words)
- Focus on ONE main strategic benefit: corner safety, edge control, or defensive blocking
- Mention flip count only if significant (3+ pieces): "flipping 5 pieces"
- Use clear, natural language: "secures center", "captures edge", "secures top edge", "blocks opponent edge", "safe position"
- For ${gamePhase} game: ${gamePhase === 'opening' ? 'Very brief: "Strong central move" or "Safe corner capture"' : gamePhase === 'early' ? 'Concise strategic benefit: "Blocks left edge" or "Secures safe position"' : 'One key tactical advantage: "Controls center" or "Prevents corner access"'}

RESPONSE FORMAT (STRICT):
Return ONLY valid JSON: { "recommendedMove": [row, col], "reasoning": "explanation with strategic context" }
- Coordinates MUST be 0-based integers
- Include defensive reasoning and strategic benefits
- NO extra fields, commentary, or markdown`;
  }

  async analyzePosition(boardState, validMoves, moveCount, currentPlayer = 1) {
    if (!this.apiKey) throw new Error('Azure OpenAI API key not configured');
    const promptResult = this.createPrompt(boardState, validMoves, moveCount, currentPlayer);

    // If createPrompt returned a direct result (only one move), return it immediately
    if (promptResult && typeof promptResult === 'object' && promptResult.recommendedMove) {
      return promptResult;
    }

    // Otherwise, promptResult is a string prompt - proceed with LLM call
    const prompt = promptResult;

    try {
      const headers = { 'Content-Type': 'application/json', 'api-key': this.apiKey };
      const body = {
        messages: [
          { role: 'system', content: 'You are a world-class Reversi/Othello strategist. RETURN ONLY JSON with schema {"recommendedMove":[row,col],"reasoning":"text"}. Use 0-based integer coordinates. Explain moves in natural language that players understand - include strategic reasoning and benefits. Only mention flip counts when significant (3+ pieces). For opening moves (<=6 pieces total) keep explanations brief. For early/mid/late game provide more informative explanations.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0,
        max_tokens: 500
      };

      const response = await fetch(this.baseUrl, {
        method: 'POST', headers, body: JSON.stringify(body)
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '<no body>');
        throw new Error(`Azure OpenAI API error: ${response.status} ${response.statusText} - ${text} - url=${this.baseUrl}`);
      }

      const data = await response.json();
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('Invalid Azure response structure: missing content');

      // Strict mode: require the model to return exact JSON with `recommendedMove` and `reasoning`.
      // Prompt instructs the model to return ONLY JSON in the shape:
      // { "recommendedMove": [row, col], "reasoning": "explain..." }
      let parsed = null;
      try {
        parsed = JSON.parse(content);
      } catch (parseErr) {
        throw new Error('Azure OpenAI returned non-JSON content while strict JSON was expected');
      }

      if (!parsed || !Array.isArray(parsed.recommendedMove) || parsed.recommendedMove.length !== 2) {
        throw new Error('Azure OpenAI returned JSON but missing required `recommendedMove` array [row,col]');
      }

      // Normalize recommended move
      const [r, c] = parsed.recommendedMove;
      if (typeof r !== 'number' || typeof c !== 'number') {
        throw new Error('Azure OpenAI returned `recommendedMove` with non-numeric coordinates');
      }

      const candidate = [r, c];

      // Ensure the returned move is a legal valid move
      const isValidMove = validMoves.some(([vr, vc]) => vr === candidate[0] && vc === candidate[1]);
      if (!isValidMove) {
        throw new Error('Azure OpenAI returned a move that is not among the valid moves');
      }

  // Return the OpenAI recommendation (post-sanitized to strip incorrect edge claims)
  const sanitizedReasoning = this.sanitizeEdgeReasoning(candidate, String(parsed.reasoning || ''));
  return { recommendedMove: candidate, reasoning: sanitizedReasoning };
    } catch (error) {
      console.error('Azure OpenAI analysis failed:', error);
      return this.getEngineRecommendation(boardState, validMoves, currentPlayer);
    }
  }

  enforceAbsoluteSafety(resultObj, boardState, validMoves, currentPlayer = 1) {
    if (!resultObj || !resultObj.recommendedMove) return this.getEngineRecommendation(boardState, validMoves, currentPlayer);
    const [r, c] = resultObj.recommendedMove;
    const isValid = validMoves.some(([vr, vc]) => vr === r && vc === c);
    if (!isValid) return this.getEngineRecommendation(boardState, validMoves, currentPlayer);
    if ((r === 1 || r === 6 || c === 1 || c === 6) && this.isEdgeAdjacentUnsafe(r, c, boardState, currentPlayer)) {
      const nonEdgeMoves = validMoves.filter(([rr, cc]) => rr !== 1 && rr !== 6 && cc !== 1 && cc !== 6);
      const centerMoves = nonEdgeMoves.filter(([rr, cc]) => rr >= 2 && rr <= 5 && cc >= 2 && cc <= 5);
      if (centerMoves.length > 0) {
        return { recommendedMove: centerMoves[0], reasoning: this.sanitizeEdgeReasoning(centerMoves[0], 'Safe central position.') };
      }
      if (nonEdgeMoves.length > 0) {
        return { recommendedMove: nonEdgeMoves[0], reasoning: this.sanitizeEdgeReasoning(nonEdgeMoves[0], 'Secure interior position.') };
      }
      return this.getEngineRecommendation(boardState, validMoves, currentPlayer);
    }
    if (this.isCornerAdjacentDangerous(r, c, boardState)) {
      const nonDangerMoves = validMoves.filter(([rr, cc]) => !this.isCornerAdjacentDangerous(rr, cc, boardState) && rr !== 1 && rr !== 6 && cc !== 1 && cc !== 6);
      if (nonDangerMoves.length > 0) return { recommendedMove: nonDangerMoves[0], reasoning: this.sanitizeEdgeReasoning(nonDangerMoves[0], 'Choosing safer position to avoid dangerous corner-adjacent risks.') };
      return this.getEngineRecommendation(boardState, validMoves, currentPlayer);
    }
    // Always return sanitized reasoning for final result
    return { recommendedMove: resultObj.recommendedMove, reasoning: this.sanitizeEdgeReasoning(resultObj.recommendedMove, resultObj.reasoning) };
  }

  filterSafeMoves(openaiMoves, boardState, validMoves, currentPlayer = 1) {
    const safeMoves = [];
    const normalizeMove = (raw) => {
      if (!raw) return null;
      if (Array.isArray(raw) && raw.length === 2) {
        const [r, c] = raw;
        if (typeof r === 'number' && typeof c === 'number') return [r, c];
        return null;
      }
      if (typeof raw === 'string') {
        const cleaned = raw.replace(/[^0-9,\-]/g, '');
        const parts = cleaned.split(',').map(s => s.trim()).filter(s => s.length);
        if (parts.length === 2) {
          const r = Number(parts[0]);
          const c = Number(parts[1]);
          if (!Number.isNaN(r) && !Number.isNaN(c)) return [r, c];
        }
      }
      return null;
    };

    for (const moveData of openaiMoves) {
      let rawMove = null; let reasoning = '';
      if (Array.isArray(moveData) && moveData.length === 2) rawMove = moveData;
      else if (moveData && typeof moveData === 'object') {
        if (moveData.move) rawMove = moveData.move;
        if (moveData.reasoning) reasoning = moveData.reasoning;
        if (!rawMove && typeof moveData.row === 'number' && typeof moveData.col === 'number') rawMove = [moveData.row, moveData.col];
      }
      const normalized = normalizeMove(rawMove);
      if (!normalized) continue;
      const [row, col] = normalized;
      if (row < 0 || row > 7 || col < 0 || col > 7) continue;
      const isValidMove = validMoves.some(([r, c]) => r === row && c === col);
      if (!isValidMove) continue;
      if (row === 1 || row === 6 || col === 1 || col === 6) continue;
      if (this.isCornerAdjacentDangerous(row, col, boardState)) continue;
      safeMoves.push({ move: [row, col], reasoning: reasoning || '' });
    }
    safeMoves.sort((a, b) => { const score = (m) => { const [r, c] = m.move; if (r >= 2 && r <= 5 && c >= 2 && c <= 5) return 0; return 1; }; return score(a) - score(b); });
    return safeMoves;
  }

  isEdgeAdjacentUnsafe(row, col, boardState, currentPlayer = 1) {
    const isEdgeAdjacent = (row === 1 || row === 6) || (col === 1 || col === 6);
    if (!isEdgeAdjacent) return false;
    if (row === 1 && !this.controlsEdge(boardState, 0, 'row', currentPlayer)) return true;
    if (row === 6 && !this.controlsEdge(boardState, 7, 'row', currentPlayer)) return true;
    if (col === 1 && !this.controlsEdge(boardState, 0, 'col', currentPlayer)) return true;
    if (col === 6 && !this.controlsEdge(boardState, 7, 'col', currentPlayer)) return true;
    return false;
  }

  controlsEdge(boardState, edgeIndex, type, currentPlayer = 1) {
    let ourPieces = 0; let opponentPieces = 0;
    for (let i = 0; i < 8; i++) {
      const cell = type === 'row' ? boardState[edgeIndex][i] : boardState[i][edgeIndex];
      if (cell === currentPlayer) ourPieces++; else if (cell !== 0) opponentPieces++;
    }
    return ourPieces >= 3 && ourPieces >= (opponentPieces * 2);
  }

  isCornerAdjacentDangerous(row, col, boardState) {
    const corners = [[0,0],[0,7],[7,0],[7,7]];
    const dangerZones = [ [[0,1],[1,0],[1,1]], [[0,6],[1,6],[1,7]], [[6,0],[6,1],[7,1]], [[6,6],[6,7],[7,6]] ];
    for (let i = 0; i < corners.length; i++) {
      const [cRow, cCol] = corners[i];
      if (boardState[cRow][cCol] === 0) {
        const isDangerZone = dangerZones[i].some(([dRow, dCol]) => dRow === row && dCol === col);
        if (isDangerZone) return true;
      }
    }
    return false;
  }

  getEngineRecommendation(boardState, validMoves, currentPlayer = 1) {
    const playerName = currentPlayer === 1 ? 'Black' : 'White';
    const gamePhase = this.calculateGamePhase(boardState);
    const opponent = currentPlayer === 1 ? 2 : 1;
    
    // Helper function for flip calculation
    const directions = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    const flipsForMove = (board, move, currentPlayer) => {
      const [row, col] = move;
      const boardCopy = board.map(r => [...r]);
      const opponent = currentPlayer === 1 ? 2 : 1;
      let totalFlips = 0;

      if (boardCopy[row][col] !== 0) return -1;

      for (const [dx, dy] of directions) {
        let r = row + dx, c = col + dy;
        const toFlip = [];
        while (r >= 0 && r < 8 && c >= 0 && c < 8 && boardCopy[r][c] === opponent) {
          toFlip.push([r, c]);
          r += dx; c += dy;
        }
        if (r >= 0 && r < 8 && c >= 0 && c < 8 && boardCopy[r][c] === currentPlayer && toFlip.length > 0) {
          totalFlips += toFlip.length;
        }
      }
      return totalFlips;
    };

    // Helper function to get edge/corner names and controlled edges
    const getPositionName = (row, col) => {
      // Corner positions with their controlled edges
      if (row === 0 && col === 0) return { name: 'top-left corner', edges: 'top and left edges' };
      if (row === 0 && col === 7) return { name: 'top-right corner', edges: 'top and right edges' };
      if (row === 7 && col === 0) return { name: 'bottom-left corner', edges: 'bottom and left edges' };
      if (row === 7 && col === 7) return { name: 'bottom-right corner', edges: 'bottom and right edges' };
      
      // Edge positions
      if (row === 0) return { name: 'top edge', edges: null };
      if (row === 7) return { name: 'bottom edge', edges: null };
      if (col === 0) return { name: 'left edge', edges: null };
      if (col === 7) return { name: 'right edge', edges: null };
      
      return { name: 'center', edges: null };
    };

    // Helper function for edge risk assessment
    const classifyEdgeRisk = (row, col, boardState, currentPlayer) => {
      if (!(row === 0 || row === 7 || col === 0 || col === 7)) return 'not-edge';
      
      let cornerPositions = [];
      if (row === 0) cornerPositions = [[0,0], [0,7]]; // Top edge
      else if (row === 7) cornerPositions = [[7,0], [7,7]]; // Bottom edge
      else if (col === 0) cornerPositions = [[0,0], [7,0]]; // Left edge  
      else if (col === 7) cornerPositions = [[0,7], [7,7]]; // Right edge
      
      let ourCorners = 0, opponentCorners = 0;
      for (const [cr, cc] of cornerPositions) {
        if (boardState[cr][cc] === currentPlayer) ourCorners++;
        else if (boardState[cr][cc] === opponent) opponentCorners++;
      }
      
      if (opponentCorners > 0) return 'risky'; // Opponent controls corner(s)
      if (ourCorners > 0) return 'safe'; // We control corner(s)
      return 'neutral'; // No one controls corners
    };

    // Helper function to detect edge blocking opportunities
    const detectEdgeBlockingOpportunity = (row, col, boardState, opponent) => {
      if (!(row === 0 || row === 7 || col === 0 || col === 7)) return false;
      
      // Check if this move blocks opponent's edge development
      let edgePositions = [];
      if (row === 0) edgePositions = [[0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[0,6],[0,7]];
      else if (row === 7) edgePositions = [[7,0],[7,1],[7,2],[7,3],[7,4],[7,5],[7,6],[7,7]];
      else if (col === 0) edgePositions = [[0,0],[1,0],[2,0],[3,0],[4,0],[5,0],[6,0],[7,0]];
      else if (col === 7) edgePositions = [[0,7],[1,7],[2,7],[3,7],[4,7],[5,7],[6,7],[7,7]];
      
      let opponentCount = 0;
      for (const [er, ec] of edgePositions) {
        if (boardState[er][ec] === opponent) opponentCount++;
      }
      
      return opponentCount >= 2; // Opponent has significant edge presence
    };

    // Helper function to simulate move and get resulting board state
    const simulateMove = (boardState, move, player) => {
      const [row, col] = move;
      const newBoard = boardState.map(r => [...r]);
      const opponent = player === 1 ? 2 : 1;
      
      if (newBoard[row][col] !== 0) return null; // Invalid move
      
      newBoard[row][col] = player;
      
      // Apply flips
      for (const [dx, dy] of directions) {
        let r = row + dx, c = col + dy;
        const toFlip = [];
        while (r >= 0 && r < 8 && c >= 0 && c < 8 && newBoard[r][c] === opponent) {
          toFlip.push([r, c]);
          r += dx; c += dy;
        }
        if (r >= 0 && r < 8 && c >= 0 && c < 8 && newBoard[r][c] === player && toFlip.length > 0) {
          for (const [fr, fc] of toFlip) {
            newBoard[fr][fc] = player;
          }
        }
      }
      
      return newBoard;
    };

    // Helper function to get valid moves for a board state
    const getValidMovesForBoard = (board, player) => {
      const moves = [];
      const opponent = player === 1 ? 2 : 1;
      
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          if (board[row][col] !== 0) continue;
          
          let isValid = false;
          for (const [dx, dy] of directions) {
            let r = row + dx, c = col + dy;
            let hasOpponentBetween = false;
            while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === opponent) {
              hasOpponentBetween = true;
              r += dx; c += dy;
            }
            if (hasOpponentBetween && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === player) {
              isValid = true;
              break;
            }
          }
          
          if (isValid) moves.push([row, col]);
        }
      }
      
      return moves;
    };

    // Helper function to detect threats after our move
    const detectThreatsAfterMove = (ourMove, boardState, currentPlayer) => {
      const opponent = currentPlayer === 1 ? 2 : 1;
      const afterOurMove = simulateMove(boardState, ourMove, currentPlayer);
      if (!afterOurMove) return { cornerThreats: [], edgeThreats: [] };
      
      const opponentMoves = getValidMovesForBoard(afterOurMove, opponent);
      const cornerThreats = [];
      const edgeThreats = [];
      
      for (const opponentMove of opponentMoves) {
        const [r, c] = opponentMove;
        
        // Check for corner threats
        if ((r === 0 || r === 7) && (c === 0 || c === 7)) {
          const positionInfo = getPositionName(r, c);
          cornerThreats.push({
            move: opponentMove,
            corner: positionInfo.name
          });
        }
        
        // Check for edge completion threats
        if (r === 0 || r === 7 || c === 0 || c === 7) {
          const afterOpponentMove = simulateMove(afterOurMove, opponentMove, opponent);
          if (afterOpponentMove) {
            // Check if opponent would control most/all of an edge
            const edgeControl = checkEdgeControl(afterOpponentMove, r, c, opponent);
            if (edgeControl.threat) {
              const positionInfo = getPositionName(r, c);
              edgeThreats.push({
                move: opponentMove,
                edge: positionInfo.name,
                controlLevel: edgeControl.controlLevel
              });
            }
          }
        }
      }
      
      return { cornerThreats, edgeThreats };
    };

    // Helper function to check edge control after a move
    const checkEdgeControl = (boardState, row, col, player) => {
      let edgePositions = [];
      let edgeName = '';
      
      if (row === 0) {
        edgePositions = [[0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[0,6],[0,7]];
        edgeName = 'top edge';
      } else if (row === 7) {
        edgePositions = [[7,0],[7,1],[7,2],[7,3],[7,4],[7,5],[7,6],[7,7]];
        edgeName = 'bottom edge';
      } else if (col === 0) {
        edgePositions = [[0,0],[1,0],[2,0],[3,0],[4,0],[5,0],[6,0],[7,0]];
        edgeName = 'left edge';
      } else if (col === 7) {
        edgePositions = [[0,7],[1,7],[2,7],[3,7],[4,7],[5,7],[6,7],[7,7]];
        edgeName = 'right edge';
      } else {
        return { threat: false, controlLevel: 0 };
      }
      
      let playerCount = 0;
      let totalPieces = 0;
      
      for (const [er, ec] of edgePositions) {
        if (boardState[er][ec] === player) playerCount++;
        if (boardState[er][ec] !== 0) totalPieces++;
      }
      
      const controlPercentage = totalPieces > 0 ? playerCount / totalPieces : 0;
      const threat = controlPercentage >= 0.6; // Threat if opponent would control 60%+ of edge
      
      return { threat, controlLevel: controlPercentage, edgeName };
    };

    // 1. HIGHEST PRIORITY: Corner captures (control two edges)
    const cornerMoves = validMoves.filter(([r, c]) => (r === 0 || r === 7) && (c === 0 || c === 7));
  if (cornerMoves.length > 0) {
      let bestCorner = cornerMoves[0];
      let bestCornerFlips = flipsForMove(boardState, cornerMoves[0], currentPlayer);
      for (const mv of cornerMoves) {
        const f = flipsForMove(boardState, mv, currentPlayer);
        if (f > bestCornerFlips) {
          bestCornerFlips = f;
          bestCorner = mv;
        }
      }
      const [cr, cc] = bestCorner;
      const positionInfo = getPositionName(cr, cc);
      const flipText = bestCornerFlips >= 3 ? ` and flipping ${bestCornerFlips} pieces` : '';
      
      if (gamePhase === 'opening') {
        return { recommendedMove: bestCorner, reasoning: this.sanitizeEdgeReasoning(bestCorner, `Strong corner${flipText}.`) };
      } else if (gamePhase === 'early') {
        return { recommendedMove: bestCorner, reasoning: this.sanitizeEdgeReasoning(bestCorner, `Excellent ${positionInfo.name} capture - corners cannot be recaptured${flipText}.`) };
      } else {
        return { recommendedMove: bestCorner, reasoning: this.sanitizeEdgeReasoning(bestCorner, `Secures ${positionInfo.name}, controlling ${positionInfo.edges}${flipText}.`) };
      }
    }

    // 2. EDGE CAPTURES: High priority for securing edges
    const edgeMoves = validMoves.filter(([r, c]) => r === 0 || r === 7 || c === 0 || c === 7);
    const safeEdges = edgeMoves.filter(([r, c]) => {
      // First check: avoid corner-adjacent dangerous positions
      if (this.isCornerAdjacentDangerous(r, c, boardState)) {
        return false;
      }
      
      const risk = classifyEdgeRisk(r, c, boardState, currentPlayer);
      const flipCount = flipsForMove(boardState, [r, c], currentPlayer);
      const flipThreshold = gamePhase === 'late' ? 3 : gamePhase === 'mid' ? 4 : 6;
      
      return risk === 'safe' || risk === 'neutral' || (risk === 'risky' && flipCount >= flipThreshold);
    });
    
  if (safeEdges.length > 0) {
      let bestEdge = safeEdges[0];
      let bestEdgeFlips = flipsForMove(boardState, safeEdges[0], currentPlayer);
      for (const mv of safeEdges) {
        const f = flipsForMove(boardState, mv, currentPlayer);
        if (f > bestEdgeFlips) {
          bestEdgeFlips = f;
          bestEdge = mv;
        }
      }
      const [er, ec] = bestEdge;
      const positionInfo = getPositionName(er, ec);
      const risk = classifyEdgeRisk(er, ec, boardState, currentPlayer);
      const riskDesc = risk === 'safe' ? 'Secures' : risk === 'neutral' ? 'Captures' : 'Takes';
      const flipText = bestEdgeFlips >= 4 ? `, flipping ${bestEdgeFlips} pieces` : '';
      
      if (gamePhase === 'opening') {
        return { recommendedMove: bestEdge, reasoning: this.sanitizeEdgeReasoning(bestEdge, `Strong edge position${flipText}.`) };
      } else if (gamePhase === 'early') {
        return { recommendedMove: bestEdge, reasoning: this.sanitizeEdgeReasoning(bestEdge, `${riskDesc} ${positionInfo.name}${flipText}.`) };
      } else {
        return { recommendedMove: bestEdge, reasoning: this.sanitizeEdgeReasoning(bestEdge, `${riskDesc} ${positionInfo.name} control${flipText}.`) };
      }
    }

    // 3. DEFENSIVE PRIORITY: Prevent opponent corner/edge captures
    const safeMoves = [];
    const riskyMoves = [];
    
    for (const move of validMoves) {
      const threats = detectThreatsAfterMove(move, boardState, currentPlayer);
      const hasCornerThreats = threats.cornerThreats.length > 0;
      const hasEdgeThreats = threats.edgeThreats.length > 0;
      
      if (!hasCornerThreats && !hasEdgeThreats) {
        safeMoves.push(move);
      } else {
        riskyMoves.push({
          move,
          cornerThreats: threats.cornerThreats,
          edgeThreats: threats.edgeThreats
        });
      }
    }
    
    // If we have safe moves (no threats after), use them for remaining priorities
    const movesToConsider = safeMoves.length > 0 ? safeMoves : validMoves;
    
    if (safeMoves.length === 0) {
      // All moves are risky - choose least risky (fewer threats)
      riskyMoves.sort((a, b) => {
        const aThreats = a.cornerThreats.length + a.edgeThreats.length;
        const bThreats = b.cornerThreats.length + b.edgeThreats.length;
        return aThreats - bThreats;
      });
      
      const leastRisky = riskyMoves[0];
      const [lr, lc] = leastRisky.move;
      const threatDesc = leastRisky.cornerThreats.length > 0 ? 
        `minimizes corner threats` : `limits edge threats`;
      return { recommendedMove: leastRisky.move, reasoning: this.sanitizeEdgeReasoning(leastRisky.move, `Defensive choice, ${threatDesc}.`) };
    }

    // 4. EDGE BLOCKING/STEALING: Priority for disrupting opponent edge development
    const blockingMoves = movesToConsider.filter(([r, c]) => detectEdgeBlockingOpportunity(r, c, boardState, opponent));
  if (blockingMoves.length > 0) {
      let bestBlocking = blockingMoves[0];
      let bestBlockingFlips = flipsForMove(boardState, blockingMoves[0], currentPlayer);
      for (const mv of blockingMoves) {
        const f = flipsForMove(boardState, mv, currentPlayer);
        if (f > bestBlockingFlips) {
          bestBlockingFlips = f;
          bestBlocking = mv;
        }
      }
      const [br, bc] = bestBlocking;
      const positionInfo = getPositionName(br, bc);
      const flipText = bestBlockingFlips >= 3 ? `, flipping ${bestBlockingFlips} pieces` : '';
      
      if (gamePhase === 'opening') {
        return { recommendedMove: bestBlocking, reasoning: this.sanitizeEdgeReasoning(bestBlocking, `Good position${flipText}.`) };
      } else if (gamePhase === 'early') {
        return { recommendedMove: bestBlocking, reasoning: this.sanitizeEdgeReasoning(bestBlocking, `Blocks opponent development${flipText}.`) };
      } else {
        return { recommendedMove: bestBlocking, reasoning: this.sanitizeEdgeReasoning(bestBlocking, `Disrupts opponent's ${positionInfo.name} development${flipText}.`) };
      }
    }

    // 5. SAFE INTERIOR MOVES: Defensive fallback (ALWAYS prefer over edge-adjacent)
    const safeValidMoves = movesToConsider.filter(([r, c]) => r !== 1 && r !== 6 && c !== 1 && c !== 6);
  if (safeValidMoves.length > 0) {
      const centerMoves = safeValidMoves.filter(([r, c]) => r >= 2 && r <= 5 && c >= 2 && c <= 5);
      const safeMove = centerMoves.length > 0 ? centerMoves[0] : safeValidMoves[0];
      const [sr, sc] = safeMove;
      
      if (gamePhase === 'opening') {
        return { recommendedMove: safeMove, reasoning: this.sanitizeEdgeReasoning(safeMove, `Safe central move.`) };
      } else if (gamePhase === 'early') {
        return { recommendedMove: safeMove, reasoning: this.sanitizeEdgeReasoning(safeMove, `Safe position avoiding edges.`) };
      } else {
        return { recommendedMove: safeMove, reasoning: this.sanitizeEdgeReasoning(safeMove, `Safe central control.`) };
      }
    }

    // 6. EDGE-ADJACENT MOVES: Last resort when forced
    const edgeAdjacentMoves = movesToConsider.filter(([r, c]) => (r === 1 || r === 6 || c === 1 || c === 6));
  if (edgeAdjacentMoves.length > 0) {
      let bestMove = edgeAdjacentMoves[0];
      let bestFlips = flipsForMove(boardState, edgeAdjacentMoves[0], currentPlayer);
      for (const mv of edgeAdjacentMoves) {
        const f = flipsForMove(boardState, mv, currentPlayer);
        if (f > bestFlips) {
          bestFlips = f;
          bestMove = mv;
        }
      }
      const [br, bc] = bestMove;
      const flipText = bestFlips >= 3 ? `, flipping ${bestFlips} pieces` : '';
      
      if (gamePhase === 'opening') {
        return { recommendedMove: bestMove, reasoning: this.sanitizeEdgeReasoning(bestMove, `Available move${flipText}.`) };
      } else if (gamePhase === 'early') {
        return { recommendedMove: bestMove, reasoning: this.sanitizeEdgeReasoning(bestMove, `Calculated risk for better position${flipText}.`) };
      } else {
        return { recommendedMove: bestMove, reasoning: this.sanitizeEdgeReasoning(bestMove, `Calculated risk near board edge${flipText}.`) };
      }
    }

    // FINAL FALLBACK: Any remaining moves
    if (movesToConsider.length > 0) {
      return { recommendedMove: movesToConsider[0], reasoning: this.sanitizeEdgeReasoning(movesToConsider[0], `Only available move.`) };
    }

    // No moves left
    return { recommendedMove: null, reasoning: this.sanitizeEdgeReasoning(null, `No legal moves.`) };
  }
}


// Inline AzureTTS class since importScripts doesn't work with modules
class AzureTTS {
  constructor(subscriptionKey, region) {
    this.subscriptionKey = subscriptionKey;
    this.region = region;
    this.tokenUrl = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
    this.ttsUrl = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  async getAccessToken() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const response = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': this.subscriptionKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      if (!response.ok) {
        throw new Error(`Token request failed: ${response.status}`);
      }

      this.accessToken = await response.text();
      this.tokenExpiry = Date.now() + (9 * 60 * 1000);
      
      return this.accessToken;
      
    } catch (error) {
      console.error('Failed to get Azure access token:', error);
      throw error;
    }
  }

  async speakText(text, voice = 'en-US-AriaNeural') {
    if (!this.subscriptionKey || !this.region) {
      throw new Error('Azure TTS not configured');
    }

    try {
      const token = await this.getAccessToken();
      
      const ssml = `
        <speak version='1.0' xml:lang='en-US'>
          <voice xml:lang='en-US' xml:gender='Female' name='${voice}'>
            <prosody rate='medium' pitch='medium'>
              ${text}
            </prosody>
          </voice>
        </speak>
      `;
      
      const response = await fetch(this.ttsUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3'
        },
        body: ssml
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('🔊 TTS error response:', errorText);
        throw new Error(`Azure TTS failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const audioArrayBuffer = await response.arrayBuffer();
      
      if (audioArrayBuffer.byteLength === 0) {
        throw new Error('Azure TTS returned empty audio data');
      }


      // Extract actual audio duration from MP3 data using a simple approach
      let audioDuration = 3000; // Default fallback duration
      
      try {
        // Estimate duration from MP3 file size and bitrate
        // Azure TTS uses 128kbps mono MP3 = 16KB/second
        const estimatedDuration = Math.max(2000, (audioArrayBuffer.byteLength / 16000) * 1000);
        audioDuration = Math.round(estimatedDuration);
      } catch (error) {
        console.warn('Could not estimate audio duration, using fallback:', error);
      }

      // Send audio to content script for immediate playback
      const audioArray = Array.from(new Uint8Array(audioArrayBuffer));
      
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && isValidGameTab(tabs[0])) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'PLAY_AUDIO',
            audioData: audioArray,
            text: text,
            estimatedDuration: audioDuration
          }, (response) => {
            if (chrome.runtime.lastError) {
              console.error('Failed to send audio to content script:', chrome.runtime.lastError.message);
              // Reset to watching state if audio fails
              chrome.runtime.sendMessage({
                type: 'agentState',
                state: 'watching'
              });
            }
          });
        } else {
          console.error('No active tab found for audio playback');
          // Reset to watching state if no tab
          chrome.runtime.sendMessage({
            type: 'agentState',
            state: 'watching'
          });
        }
      });
      
      return Promise.resolve();
      
    } catch (error) {
      console.error('Azure TTS failed:', error);
      throw error;
    }
  }

  async speakMoveRecommendation(analysis) {
    let fullText = '';
    try {
      if (analysis && Array.isArray(analysis.recommendedMove)) {
        const [row, col] = analysis.recommendedMove;
        const coordinates = `Row ${row + 1}, Column ${col + 1}`;

        // Build a single canonical text used for both speech and UI to ensure they match exactly.
        const reasoningText = analysis.reasoning && typeof analysis.reasoning === 'string' ? analysis.reasoning.trim() : '';
        // Use a clear, user-facing phrasing that includes coordinates and concise reasoning.
        const spokenAndDisplayText = reasoningText ? `${coordinates}. ${reasoningText}` : `${coordinates}.`;

        // Store the display text for UI use and speak the same string
        this.lastRecommendationDisplay = spokenAndDisplayText;
        console.log('🔊 Talking:', spokenAndDisplayText);
        await this.speakText(spokenAndDisplayText);
        return;
      } else if (analysis && analysis.recommendedMove === null) {
        // No safe move - announce reasoning directly
        fullText = analysis.reasoning || 'No safe move available under current policy.';
        console.log('🔊 Talking:', fullText);
        await this.speakText(fullText);
        return;
      } else {
        fullText = analysis && analysis.reasoning ? analysis.reasoning : 'Recommendation unavailable.';
        console.log('🔊 Talking:', fullText);
        await this.speakText(fullText);
        return;
      }
    } catch (e) {
      console.error('Azure TTS speakMoveRecommendation failed:', e);
      throw e;
    }
  }
}

// Eleven Labs TTS class
class ElevenLabsTTS {
  constructor(apiKey, voiceId = 'pNInz6obpgDQGcFmaJgB') {
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.baseUrl = 'https://api.elevenlabs.io/v1';
  }

  async speakText(text) {
    try {
      console.log('🔊 Using Eleven Labs TTS for:', text);
      
      const response = await fetch(`${this.baseUrl}/text-to-speech/${this.voiceId}`, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
            style: 0.0,
            use_speaker_boost: true
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Eleven Labs TTS error:', response.status, errorText);
        throw new Error(`Eleven Labs TTS failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const audioArrayBuffer = await response.arrayBuffer();
      console.log('🔊 Eleven Labs TTS audio generated, size:', audioArrayBuffer.byteLength);

      // Send audio to content script for playback
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && isValidGameTab(tabs[0])) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'PLAY_AUDIO',
            audioData: Array.from(new Uint8Array(audioArrayBuffer))
          }, (response) => {
            if (chrome.runtime.lastError) {
              console.error('Failed to send audio to content script:', chrome.runtime.lastError.message);
              // Reset to watching state if audio fails
              chrome.runtime.sendMessage({
                type: 'agentState',
                state: 'watching'
              });
            } else {
              console.log('✅ Audio sent to content script successfully');
              
              // Set timeout to reset state after audio finishes
              const estimatedDuration = Math.max(3000, text.length * 100); // Estimate based on text length
              currentAudioStateTimeout = setTimeout(() => {
                console.log('🔊 Audio playback estimated to be complete, resetting state');
                chrome.runtime.sendMessage({
                  type: 'agentState',
                  state: 'watching'
                });
                currentAudioStateTimeout = null;
              }, estimatedDuration);
            }
          });
        }
      });

    } catch (error) {
      console.error('Eleven Labs TTS failed:', error);
      throw error;
    }
  }

  async speakMoveRecommendation(analysis) {
    let fullText = '';
    try {
      if (analysis && Array.isArray(analysis.recommendedMove)) {
        const [row, col] = analysis.recommendedMove;
        const coordinates = `Row ${row + 1}, Column ${col + 1}`;

        // Build a single canonical string for both speech and UI to guarantee they match.
        const reasoningText = analysis.reasoning && typeof analysis.reasoning === 'string' ? analysis.reasoning.trim() : '';
        const spokenAndDisplayText = reasoningText ? `${coordinates}. ${reasoningText}` : `${coordinates}.`;

        this.lastRecommendationDisplay = spokenAndDisplayText;
        console.log('🔊 Talking:', spokenAndDisplayText);
        await this.speakText(spokenAndDisplayText);
        return;
      } else if (analysis && analysis.recommendedMove === null) {
        // No safe move - announce reasoning directly
        fullText = analysis.reasoning || 'No safe move available under current policy.';
        console.log('🔊 Talking:', fullText);
        await this.speakText(fullText);
        return;
      } else {
        fullText = analysis && analysis.reasoning ? analysis.reasoning : 'Recommendation unavailable.';
        console.log('🔊 Talking:', fullText);
        await this.speakText(fullText);
        return;
      }
    } catch (e) {
      console.error('ElevenLabsTTS speakMoveRecommendation failed:', e);
      throw e;
    }
  }
}

// Helper function to get the appropriate TTS instance based on settings
async function getTTSInstance() {
  const ttsSettings = await chrome.storage.sync.get(['ttsProvider', 'azureKey', 'azureRegion', 'elevenlabsKey', 'elevenlabsVoiceId']);
  
  const provider = ttsSettings.ttsProvider || 'azure';
  
  if (provider === 'elevenlabs') {
    if (ttsSettings.elevenlabsKey) {
      return new ElevenLabsTTS(ttsSettings.elevenlabsKey, ttsSettings.elevenlabsVoiceId);
    } else {
      console.error('Eleven Labs API key not configured');
      return null;
    }
  } else {
    // Default to Azure TTS
    if (ttsSettings.azureKey && ttsSettings.azureRegion) {
      return new AzureTTS(ttsSettings.azureKey, ttsSettings.azureRegion);
    } else {
      console.error('Azure TTS settings not configured');
      return null;
    }
  }
}

// Convert any 0-based coordinate mentions inside free text to 1-based for user-facing display.
// Examples: "(3,2)" -> "(4,3)", "Row 3, Column 2" -> "Row 4, Column 3"
function convertCoordsInTextOneIndexed(text) {
  if (!text || typeof text !== 'string') return text;
  try {
    // Parenthesized pairs like (3,2)
    text = text.replace(/\(\s*(\d+)\s*,\s*(\d+)\s*\)/g, (m, a, b) => `(${Number(a) + 1},${Number(b) + 1})`);

    // Row X, Column Y
    text = text.replace(/Row\s+(\d+)\s*,?\s*Column\s+(\d+)/gi, (m, a, b) => `Row ${Number(a) + 1}, Column ${Number(b) + 1}`);

    // Row X, Col Y (short form)
    text = text.replace(/Row\s+(\d+)\s*,?\s*Col\s+(\d+)/gi, (m, a, b) => `Row ${Number(a) + 1}, Col ${Number(b) + 1}`);

    return text;
  } catch (e) {
    return text;
  }
}

// Auto-reload extension in development
if (chrome.runtime.getManifest().version_name === 'dev' || !('update_url' in chrome.runtime.getManifest())) {
  chrome.runtime.onInstalled.addListener(() => {
    console.log('Extension reloaded');
  });
}

// Removed screenshot download functionality - no longer needed

function stopCurrentAudio() {
  // Clear any pending audio state timeout
  if (currentAudioStateTimeout) {
    clearTimeout(currentAudioStateTimeout);
    currentAudioStateTimeout = null;
    console.log('🔊 Cleared audio state timeout due to interruption');
  }
  
  // Send message to content script to stop any playing audio
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && isValidGameTab(tabs[0])) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'STOP_AUDIO' }, (response) => {
        if (chrome.runtime.lastError) {
          console.log('Content script not ready for audio stop:', chrome.runtime.lastError.message);
        } else {
          console.log('🔊 Audio stop message sent to content script');
        }
      });
    }
  });
}

function toggleCapture(tab) {
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
    console.log('Board analysis stopped.');
  } else {
    // Check if tab is valid for the extension
    if (!isValidGameTab(tab)) {
      console.log('Extension only works on cardgames.io domain');
      return;
    }
    
    // Send activation message to enable audio
    chrome.tabs.sendMessage(tab.id, { type: 'EXTENSION_ACTIVATED' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('Content script not ready for activation:', chrome.runtime.lastError.message);
      } else {
        console.log('🔊 Extension activation message sent');
      }
    });
    
    captureInterval = setInterval(() => {
      chrome.tabs.sendMessage(tab.id, { type: 'ANALYZE_BOARD' }, (response) => {
        if (chrome.runtime.lastError) {
          console.log('Content script not ready:', chrome.runtime.lastError.message);
          // Content script is automatically injected via manifest.json
          // No need for manual injection here
        }
      });
    }, 1000);
      
    console.log('Board analysis started.');
  }
}

// Handle extension icon clicks
chrome.action.onClicked.addListener((tab) => {
  // Enable side panel for this tab
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'sidepanel.html',
    enabled: true
  });
  
  toggleCapture(tab);
});

// Import Reversi engine (we'll need to include it in manifest)
// For now, we'll create a simple inline version
const reversiEngine = {
  EMPTY: 0, BLACK: 1, WHITE: 2,
  
  getValidMoves(board, tile) {
    const validMoves = [];
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        if (this.isValidMove(board, tile, x, y)) {
          validMoves.push([x, y]);
        }
      }
    }
    return validMoves;
  },
  
  isValidMove(board, tile, x, y) {
    if (x < 0 || x > 7 || y < 0 || y > 7 || board[x][y] !== this.EMPTY) {
      return false;
    }
    
    const otherTile = tile === this.BLACK ? this.WHITE : this.BLACK;
    const directions = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    
    for (const [dx, dy] of directions) {
      let nx = x + dx, ny = y + dy;
      let hasOpponentPiece = false;
      
      while (nx >= 0 && nx <= 7 && ny >= 0 && ny <= 7 && board[nx][ny] === otherTile) {
        hasOpponentPiece = true;
        nx += dx;
        ny += dy;
      }
      
      if (hasOpponentPiece && nx >= 0 && nx <= 7 && ny >= 0 && ny <= 7 && board[nx][ny] === tile) {
        return true;
      }
    }
    return false;
  },
  
  whoGoesFirst(board) {
    let blackCount = 0, whiteCount = 0;
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        if (board[x][y] === this.BLACK) blackCount++;
        if (board[x][y] === this.WHITE) whiteCount++;
      }
    }
    const totalPieces = blackCount + whiteCount;
    return (totalPieces % 2 === 0) ? this.BLACK : this.WHITE;
  },

  getBestMove(board, tile) {
    const validMoves = this.getValidMoves(board, tile);
    if (validMoves.length === 0) return null;
    
    // Simple scoring: prefer corners, then edges, avoid dangerous squares
    let bestMove = validMoves[0];
    let bestScore = -1000;
    
    for (const [x, y] of validMoves) {
      let score = 0;
      
      // Corner bonus
      if ((x === 0 || x === 7) && (y === 0 || y === 7)) {
        score += 100;
      }
      // Edge bonus (but not next to corners)
      else if (x === 0 || x === 7 || y === 0 || y === 7) {
        score += 10;
      }
      
      // Avoid squares next to corners if corner is empty
      const dangerousSquares = [
        [0, 1], [1, 0], [1, 1], // near (0,0)
        [0, 6], [1, 6], [1, 7], // near (0,7)
        [6, 0], [6, 1], [7, 1], // near (7,0)
        [6, 6], [6, 7], [7, 6]  // near (7,7)
      ];
      
      for (const [dx, dy] of dangerousSquares) {
        if (x === dx && y === dy) {
          score -= 50;
        }
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestMove = [x, y];
      }
    }
    
    return bestMove;
  }
};

// Audio state management
let currentAudioStateTimeout = null;

// Handle popup button clicks and board analysis
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TOGGLE_CAPTURE') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        toggleCapture(tabs[0]);
        sendResponse({ success: true });
      }
    });
    return true;
  } else if (message.type === 'GET_CAPTURE_STATE') {
    sendResponse({ isCapturing: captureInterval !== null });
    return true;
  } else if (message.type === 'GAME_STATE_EXTRACTED') {
    handleGameStateAnalysis(message.boardState, message.validMoves, message.moveCount, message.timestamp);
    sendResponse({ success: true });
    return true;
  } else if (message.type === 'AUDIO_DURATION_DETECTED') {
    // Handle actual audio duration from content script
    console.log('🔊 Audio duration detected:', message.actualDuration, 'ms for text:', message.text);
    
    // Clear any existing timeout
    if (currentAudioStateTimeout) {
      clearTimeout(currentAudioStateTimeout);
    }
    
    // Set timeout to change state back to watching after actual duration
    currentAudioStateTimeout = setTimeout(() => {
      console.log('🔊 Audio duration completed, changing state to watching');
      chrome.runtime.sendMessage({
        type: 'agentState',
        state: 'watching'
      });
      currentAudioStateTimeout = null;
    }, message.actualDuration);
    
    return true;
  } else if (message.type === 'AUDIO_FREQUENCY_DATA') {
    // Forward audio frequency data to side panel
    chrome.runtime.sendMessage({
      type: 'AUDIO_FREQUENCY_DATA',
      frequencies: message.frequencies
    });
    return true;
  } else if (message.type === 'AUDIO_VISUALIZATION_STOPPED') {
    // Forward visualization stop to side panel
    chrome.runtime.sendMessage({
      type: 'AUDIO_VISUALIZATION_STOPPED'
    });
    return true;
  } else if (message.type === 'TOGGLE_ASSISTANT') {
    // Handle assistant toggle from floating button
    if (message.active) {
      console.log('🤖 Assistant activated via floating button');
      if (captureInterval === null) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) {
            toggleCapture(tabs[0]);
          }
        });
      }
    } else {
      console.log('🤖 Assistant deactivated via floating button');
      if (captureInterval !== null) {
        clearInterval(captureInterval);
        captureInterval = null;
        console.log('🛑 Game capture stopped');
      }
    }
    
    // Forward toggle state to sidepanel
    chrome.runtime.sendMessage({
      type: 'TOGGLE_ASSISTANT',
      active: message.active
    });
    return true;
  }
});

async function handleGameStateAnalysis(boardState, validMoves, moveCount, timestamp) {
  console.log('🎯 Analyzing game state:', {
    moveCount,
    validMoves: validMoves.length,
    timestamp
  });

  // Hide any existing recommendation overlay when new game state is detected
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    if (tabs[0] && isValidGameTab(tabs[0])) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'HIDE_RECOMMENDATION_OVERLAY'
      });
    }
  });

  // Stop any currently playing audio before starting new analysis
  stopCurrentAudio();

  // Update agent state to thinking
  chrome.runtime.sendMessage({
    type: 'agentState',
    state: 'thinking'
  });

  // Check if there's only one valid move - skip OpenAI and use direct TTS
  if (validMoves.length === 1) {
    console.log('🎯 Only one valid move - skipping OpenAI analysis');
    
    const singleMove = validMoves[0];
  const movePosition = `Row ${singleMove[0] + 1}, Col ${singleMove[1] + 1}`;
    
    // Random phrases for single move situations with more context
    const singleMovePhases = [
      "Go for",
      "Your only option is", 
      "Take the only available spot at",
      "The only possible move is",
      "Must play"
    ];
    
  const randomPhrase = singleMovePhases[Math.floor(Math.random() * singleMovePhases.length)];
  let fullText = `${randomPhrase} ${movePosition}`;
    
    // Generate more descriptive reasoning for UI
    const descriptiveReasoning = `${randomPhrase} the only legal move available.`;
    
    try {
      // Update agent state to talking
      chrome.runtime.sendMessage({
        type: 'agentState',
        state: 'talking'
      });

      const tts = await getTTSInstance();
      if (tts) {
        currentTTSInstance = tts;
        await tts.speakText(fullText);
      }
      
        // Send single move recommendation to side panel
      chrome.runtime.sendMessage({
        type: 'recommendation',
        data: {
          // Always send structured numeric position for consistency
          position: { row: singleMove[0], col: singleMove[1] },
          // Use the exact spoken text as the UI display so audio and UI match
          displayText: fullText,
          reasoning: convertCoordsInTextOneIndexed(descriptiveReasoning),
          recommendedMove: singleMove,
          validMoves: validMoves,
          boardState: boardState
        }
      });
      
      // Send recommendation overlay to content script (structured position)
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (tabs[0] && isValidGameTab(tabs[0])) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'SHOW_RECOMMENDATION_OVERLAY',
            position: { row: singleMove[0], col: singleMove[1] }
          });
        }
      });
      
    } catch (error) {
      console.error('TTS failed for single move:', error);
    }
    
    // Reset to watching state
    chrome.runtime.sendMessage({
      type: 'agentState',
      state: 'watching'
    });
    
    return; // Exit early - no OpenAI needed
  }

  // Check if board state is the same as last OpenAI call
  const currentBoardStateString = JSON.stringify(boardState);
  if (lastBoardStateForOpenAI === currentBoardStateString) {
    // Reset to watching state
    chrome.runtime.sendMessage({
      type: 'agentState',
      state: 'watching'
    });
    return; // Exit early, no error
  }

  // Get Azure OpenAI settings from storage and request strategic analysis
  const result = await chrome.storage.sync.get(['openaiApiKey', 'openaiEndpoint', 'openaiDeployment', 'openaiApiVersion']);

  console.log('🤖 Requesting Azure OpenAI strategic analysis...');

  // Require explicit Azure settings saved in extension settings. Fail fast if not present.
  if (!result.openaiApiKey || !result.openaiEndpoint || !result.openaiDeployment) {
    console.error('Azure OpenAI configuration missing. Please set the full Azure URL or endpoint, deployment, and api key in extension settings.');
    // Reset to watching state and avoid analysis
    chrome.runtime.sendMessage({ type: 'agentState', state: 'watching' });
    return;
  }

    try {
      // Instantiate the inlined OpenAIAnalyzer directly (no imports needed)
      let analysis = null;
      // Instantiate analyzer and run strict analysis. Do NOT fallback silently - let errors bubble
      const apiKeyToUse = result.openaiApiKey;
      const endpointToUse = result.openaiEndpoint;
      const deploymentToUse = result.openaiDeployment;
      const apiVersionToUse = result.openaiApiVersion || undefined;

      const analyzer = new OpenAIAnalyzer(apiKeyToUse, endpointToUse, deploymentToUse, apiVersionToUse);

      // Determine currentPlayer by counting pieces (fewer pieces -> that player's turn)
      let blackCount = 0, whiteCount = 0;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          if (boardState[r][c] === 1) blackCount++;
          else if (boardState[r][c] === 2) whiteCount++;
        }
      }
      const currentPlayer = blackCount <= whiteCount ? 1 : 2;

      analysis = await analyzer.analyzePosition(boardState, validMoves, moveCount, currentPlayer);
    
  // Store current board state after successful OpenAI call
  lastBoardStateForOpenAI = currentBoardStateString;
    
    console.log('🎯 OpenAI Analysis:', analysis);
    if (analysis && Array.isArray(analysis.recommendedMove)) {
      console.log(`💡 Recommended move: (${analysis.recommendedMove[0]}, ${analysis.recommendedMove[1]})`);
    } else if (analysis && analysis.recommendedMove === null) {
      console.log('⚠️ No safe recommended move available under current policy.');
    } else {
      console.log('⚠️ Invalid recommendedMove format:', analysis?.recommendedMove);
    }
    console.log(`📝 Reasoning: ${analysis?.reasoning || 'No reasoning provided'}`);
    
    // If analyzer explicitly refused to recommend a move under safety rules, notify UI and stop
    if (!analysis || analysis.recommendedMove === null) {
      console.log('🛑 Analyzer indicated no safe move; sending notification to UI.');
      // Sanitize reasoning before sending to UI so it matches any spoken text
      const sanitizedReason = (function(){ try { const s = sanitizeReasoningLocal(analysis ? analysis.reasoning : 'No analysis result', null); return s && s.length ? s : (analysis ? String(analysis.reasoning || 'No analysis result').trim() : 'No analysis result'); } catch(e){ return analysis ? String(analysis.reasoning || 'No analysis result').trim() : 'No analysis result'; }})();
      chrome.runtime.sendMessage({ type: 'recommendation', data: { position: null, displayText: '-', reasoning: sanitizedReason, predictedScore: null } });
      // Reset to watching state and skip TTS/overlay
      chrome.runtime.sendMessage({ type: 'agentState', state: 'watching' });
      return;
    }

    // Use Azure TTS to announce the OpenAI recommendation and get display text
    // Default display text (1-based for humans)
    let displayText = `Row ${analysis.recommendedMove[0] + 1}, Col ${analysis.recommendedMove[1] + 1}`;

    // Use shared sanitizer if available; otherwise fall back to requiring the shared file (for Node) or a no-op.
    const sanitizeReasoningLocal = (typeof sanitizeReasoning === 'function')
      ? sanitizeReasoning
      : ((reasoning, move) => {
          // If shared sanitizer isn't available, return original reasoning to avoid hiding information
          if (!reasoning || typeof reasoning !== 'string') return '';
          try {
            const mod = (typeof require === 'function') ? require('./shared/sanitizer.js') : null;
            if (typeof mod === 'function') return mod(reasoning, move);
          } catch (e) {
            // ignore
          }
          return reasoning.trim();
        });
    
    // Prepare sanitized reasoning once so we don't convert coordinates multiple times
    let sanitizedRaw = (function(){ try { const s = sanitizeReasoningLocal(analysis.reasoning, analysis.recommendedMove); return s && s.length ? s : (analysis ? String(analysis.reasoning || '').trim() : ''); } catch(e){ return analysis ? String(analysis.reasoning || '').trim() : ''; }})();
    let sanitizedConverted = sanitizedRaw ? convertCoordsInTextOneIndexed(sanitizedRaw) : sanitizedRaw;
    
    try {
      // Update agent state to talking
      chrome.runtime.sendMessage({
        type: 'agentState',
        state: 'talking'
      });

      const tts = await getTTSInstance();
      if (tts) {
        currentTTSInstance = tts;
        // Use sanitizedConverted so TTS doesn't repeat coordinates the UI already shows
        const spokenSanitized = sanitizedConverted || '';

        // Build full speech text and display text locally so UI and audio are identical
        const [row, col] = analysis.recommendedMove;
        const coordinates = `Row ${row + 1}, Column ${col + 1}`;
        const spokenAndDisplayText = spokenSanitized ? `${coordinates}. ${spokenSanitized}` : `${coordinates}.`;

        // Speak and use the exact same text for UI
        await tts.speakText(spokenAndDisplayText);
        displayText = spokenAndDisplayText || displayText;

        // State will be managed by audio duration controller inside TTS - don't change here
      } else {
        console.log('⚠️ TTS not configured');
        // Reset immediately if TTS not configured
        chrome.runtime.sendMessage({
          type: 'agentState',
          state: 'watching'
        });
      }
    } catch (ttsError) {
      console.error('❌ TTS failed:', ttsError);
      // Reset to watching state on error
      chrome.runtime.sendMessage({
        type: 'agentState',
        state: 'watching'
      });
    }

        // Send recommendation to side panel with the same phrase used in audio
    chrome.runtime.sendMessage({
      type: 'recommendation',
      data: {
        position: {
          row: analysis.recommendedMove[0],
          col: analysis.recommendedMove[1]
        },
        displayText: displayText,
        // Send the already-prepared sanitized and converted reasoning to avoid double conversion
        reasoning: sanitizedConverted || '',
        predictedScore: await calculatePredictedScore(boardState, analysis.recommendedMove),
        currentPlayer: currentPlayer
      }
    });

    // Show recommendation overlay on main game board
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0] && isValidGameTab(tabs[0])) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'SHOW_RECOMMENDATION_OVERLAY',
          position: {
            row: analysis.recommendedMove[0],
            col: analysis.recommendedMove[1]
          }
        });
      }
    });
  } catch (openaiError) {
    console.error('❌ OpenAI analysis failed:', openaiError);
    if (openaiError && openaiError.raw) {
      console.error('❌ Raw Azure model content:', openaiError.raw);
    }
    // Reset to watching state on error
    chrome.runtime.sendMessage({
      type: 'agentState',
      state: 'watching'
    });
    // Don't store board state if OpenAI call failed
  }
}

// Calculate predicted score after making a move
async function calculatePredictedScore(boardState, move) {
  const [row, col] = move;
  
  // Create a copy of the board
  const newBoard = boardState.map(row => [...row]);
  
  // Count current pieces
  let currentBlack = 0, currentWhite = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (boardState[r][c] === 1) currentBlack++;
      else if (boardState[r][c] === 2) currentWhite++;
    }
  }
  
  // Determine current player (who has fewer pieces goes first in most cases)
  const currentPlayer = currentBlack <= currentWhite ? 1 : 2;
  
  // Simulate the move using reversi engine
  if (reversiEngine.isValidMove(newBoard, currentPlayer, row, col)) {
    // Place the piece
    newBoard[row][col] = currentPlayer;
    
    // Count flips in all directions
    const directions = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    let totalFlips = 0;
    
    for (const [dx, dy] of directions) {
      let flipsInDirection = [];
      let nx = row + dx, ny = col + dy;
      
      // Find opponent pieces to flip
      while (nx >= 0 && nx <= 7 && ny >= 0 && ny <= 7) {
        if (newBoard[nx][ny] === 0) break; // Empty square
        if (newBoard[nx][ny] === currentPlayer) {
          // Found our piece, flip all in between
          for (const [fr, fc] of flipsInDirection) {
            newBoard[fr][fc] = currentPlayer;
            totalFlips++;
          }
          break;
        } else {
          // Opponent piece, add to potential flips
          flipsInDirection.push([nx, ny]);
        }
        nx += dx;
        ny += dy;
      }
    }
    
    // Count new totals
    let newBlack = 0, newWhite = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (newBoard[r][c] === 1) newBlack++;
        else if (newBoard[r][c] === 2) newWhite++;
      }
    }
    
    return { black: newBlack, white: newWhite };
  }
  
  // If move is invalid, return current scores
  return { black: currentBlack, white: currentWhite };
}

function analyzeMovesLocally(board, player, validMoves) {
  // Simple local analysis before sending to OpenAI
  const evaluatedMoves = validMoves.map(([x, y]) => {
    let score = 0;
    
    // Corner bonus
    if ((x === 0 || x === 7) && (y === 0 || y === 7)) score += 100;
    
    // Edge bonus
    if (x === 0 || x === 7 || y === 0 || y === 7) score += 10;
    
    // Count flips (simplified)
    score += Math.random() * 5; // Placeholder for actual flip counting
    
    return {
      move: [x, y],
      notation: String.fromCharCode(97 + y) + (x + 1),
      score: score
    };
  });
  
  evaluatedMoves.sort((a, b) => b.score - a.score);
  const topMoves = evaluatedMoves.slice(0, 3);
  
  console.log('Top 3 moves:', topMoves);
  
  // This is where we'd integrate OpenAI and TTS
  const suggestion = `Best move appears to be ${topMoves[0].notation}`;
  console.log('AI Suggestion:', suggestion);
}

// Enable side panel on extension install/startup
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// Handle extension icon clicks (alternative trigger)
chrome.action.onClicked.addListener((tab) => {
  toggleCapture(tab);
});

// Handle tab activation - stop audio and switch to watching state
chrome.tabs.onActivated.addListener((activeInfo) => {
  console.log('📑 Tab activated:', activeInfo.tabId);
  
  // Stop any playing audio immediately
  stopAudioPlayback();
  
  // Switch state to watching
  chrome.runtime.sendMessage({
    type: 'agentStateUpdate',
    state: 'watching'
  }).catch(() => {
    // Ignore errors if side panel not open
  });
  
  console.log('🔊 Audio stopped and state set to watching due to tab activation');
});

// ... callAzureOpenAI removed to enforce single analyzer code path ...
