// Reversi Game Engine - Based on Invent With Python
class ReversiEngine {
  constructor() {
    this.EMPTY = 0;
    this.BLACK = 1;
    this.WHITE = 2;
    this.DIRECTIONS = [
      [-1, -1], [-1, 0], [-1, 1],
      [0, -1],           [0, 1],
      [1, -1],  [1, 0],  [1, 1]
    ];
  }

  // Create a new empty board
  getNewBoard() {
    return Array(8).fill().map(() => Array(8).fill(this.EMPTY));
  }

  // Set up starting position
  getStartingBoard() {
    const board = this.getNewBoard();
    board[3][3] = this.WHITE;
    board[3][4] = this.BLACK;
    board[4][3] = this.BLACK;
    board[4][4] = this.WHITE;
    return board;
  }

  // Check if coordinates are on the board
  isOnBoard(x, y) {
    return x >= 0 && x <= 7 && y >= 0 && y <= 7;
  }

  // Check if a move is valid
  isValidMove(board, tile, xstart, ystart) {
    if (!this.isOnBoard(xstart, ystart) || board[xstart][ystart] !== this.EMPTY) {
      return false;
    }

    board[xstart][ystart] = tile; // Temporarily place the tile

    const otherTile = tile === this.BLACK ? this.WHITE : this.BLACK;

    let tilesToFlip = [];
    for (const [xdirection, ydirection] of this.DIRECTIONS) {
      let x = xstart;
      let y = ystart;
      x += xdirection;
      y += ydirection;

      if (this.isOnBoard(x, y) && board[x][y] === otherTile) {
        x += xdirection;
        y += ydirection;
        if (!this.isOnBoard(x, y)) {
          continue;
        }
        while (board[x][y] === otherTile) {
          x += xdirection;
          y += ydirection;
          if (!this.isOnBoard(x, y)) {
            break;
          }
        }
        if (!this.isOnBoard(x, y)) {
          continue;
        }
        if (board[x][y] === tile) {
          while (true) {
            x -= xdirection;
            y -= ydirection;
            if (x === xstart && y === ystart) {
              break;
            }
            tilesToFlip.push([x, y]);
          }
        }
      }
    }

    board[xstart][ystart] = this.EMPTY; // Restore the empty space
    
    return tilesToFlip.length > 0 ? tilesToFlip : false;
  }

  // Get all valid moves for a player
  getValidMoves(board, tile) {
    const validMoves = [];
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        if (this.isValidMove(board, tile, x, y) !== false) {
          validMoves.push([x, y]);
        }
      }
    }
    return validMoves;
  }

  // Make a move on the board
  makeMove(board, tile, xstart, ystart) {
    const tilesToFlip = this.isValidMove(board, tile, xstart, ystart);
    if (tilesToFlip === false) {
      return false;
    }

    board[xstart][ystart] = tile;
    for (const [x, y] of tilesToFlip) {
      board[x][y] = tile;
    }
    return true;
  }

  // Get board copy
  getBoardCopy(board) {
    return board.map(row => [...row]);
  }

  // Check if a position is on corner
  isOnCorner(x, y) {
    return (x === 0 && y === 0) || (x === 7 && y === 0) || (x === 0 && y === 7) || (x === 7 && y === 7);
  }

  // Get board score
  getScoreOfBoard(board) {
    let blackScore = 0;
    let whiteScore = 0;
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        if (board[x][y] === this.BLACK) {
          blackScore++;
        }
        if (board[x][y] === this.WHITE) {
          whiteScore++;
        }
      }
    }
    return { black: blackScore, white: whiteScore };
  }

  // Determine who goes first based on current board state
  whoGoesFirst(board) {
    const score = this.getScoreOfBoard(board);
    const totalPieces = score.black + score.white;
    
    // Starting position has 4 pieces, black goes first
    if (totalPieces === 4) return this.BLACK;
    
    // If odd number of pieces placed, it's white's turn
    // If even number of pieces placed, it's black's turn
    return (totalPieces % 2 === 0) ? this.BLACK : this.WHITE;
  }

  // Convert board to string for debugging
  boardToString(board) {
    const symbols = ['.', 'B', 'W'];
    let result = '  0 1 2 3 4 5 6 7\n';
    for (let x = 0; x < 8; x++) {
      result += x + ' ';
      for (let y = 0; y < 8; y++) {
        result += symbols[board[x][y]] + ' ';
      }
      result += '\n';
    }
    return result;
  }

  // Evaluate move quality (simple heuristic)
  evaluateMove(board, tile, x, y) {
    let score = 0;
    
    // Corner moves are very valuable
    if (this.isOnCorner(x, y)) {
      score += 100;
    }
    
    // Edge moves are somewhat valuable
    if (x === 0 || x === 7 || y === 0 || y === 7) {
      score += 10;
    }
    
    // Avoid moves adjacent to corners (unless corner is occupied by us)
    const cornerAdjacent = [
      [0, 1], [1, 0], [1, 1], // Near (0,0)
      [0, 6], [1, 6], [1, 7], // Near (0,7)
      [6, 0], [6, 1], [7, 1], // Near (7,0)
      [6, 6], [6, 7], [7, 6]  // Near (7,7)
    ];
    
    for (const [cx, cy] of cornerAdjacent) {
      if (x === cx && y === cy) {
        score -= 20;
      }
    }
    
    // Count pieces that would be flipped
    const tilesToFlip = this.isValidMove(board, tile, x, y);
    if (tilesToFlip) {
      score += tilesToFlip.length;
    }
    
    return score;
  }

  // Get best moves sorted by quality
  getBestMoves(board, tile, count = 3) {
    const validMoves = this.getValidMoves(board, tile);
    const evaluatedMoves = validMoves.map(([x, y]) => ({
      x, y,
      score: this.evaluateMove(board, tile, x, y),
      notation: String.fromCharCode(97 + y) + (x + 1) // Convert to chess notation (a1, b2, etc.)
    }));
    
    evaluatedMoves.sort((a, b) => b.score - a.score);
    return evaluatedMoves.slice(0, count);
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined') {
  module.exports = ReversiEngine;
}
