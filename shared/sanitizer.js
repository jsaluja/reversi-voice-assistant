// Shared sanitizer for extension runtime.
// Makes `sanitizeReasoning(reasoning, recommendedMove)` available as a global
// function in worker and window contexts. Also exports for CommonJS if used
// by Node tools (kept for compatibility; tests keep their own copy).
// Shared sanitizer for extension runtime.
// Makes `sanitizeReasoning(reasoning, recommendedMove)` available as a global
// function in worker and window contexts. Also exports for CommonJS if used
// by Node tools (kept for compatibility; tests keep their own copy).
(function (global) {
  function sanitizeReasoning(reasoning, recommendedMove) {
    if (!reasoning || typeof reasoning !== 'string') return '';
    let out = reasoning.trim();

    let removedCoordinate = false;
    try {
      const [r, c] = Array.isArray(recommendedMove) ? recommendedMove : [null, null];
      if (typeof r === 'number' && typeof c === 'number') {
        const zeroTuple = new RegExp(`\\(${r}\\s*,\\s*${c}\\)`, 'g');
        if (zeroTuple.test(out)) { out = out.replace(zeroTuple, ''); removedCoordinate = true; }

        const oneTuple = new RegExp(`\\(${r + 1}\\s*,\\s*${c + 1}\\)`, 'g');
        if (oneTuple.test(out)) { out = out.replace(oneTuple, ''); removedCoordinate = true; }

        const rowColPhrase = new RegExp(`Row\\s*${r + 1}\\s*,?\\s*Column\\s*${c + 1}`, 'gi');
        if (rowColPhrase.test(out)) { out = out.replace(rowColPhrase, ''); removedCoordinate = true; }

        const colRowPhrase = new RegExp(`Column\\s*${c + 1}\\s*,?\\s*Row\\s*${r + 1}`, 'gi');
        if (colRowPhrase.test(out)) { out = out.replace(colRowPhrase, ''); removedCoordinate = true; }
      }
    } catch (e) {
      return reasoning.trim();
    }

    // Aggressively remove common verb + parenthesized coordinate patterns like
    // "Playing at (3,2)" or "Play (3,2)" which may be produced by models.
    try {
      out = out.replace(/\b(?:Play|Playing|Move|Moving|Place|Placing|Go for|Go to|Take)\b\s*(?:at|to)?\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, '');
      // Also remove any remaining parenthesized simple coordinate tuples that match numbers,
      // in case formatting differs (e.g. extra spaces). This only affects parenthesized pairs of digits.
      // We avoid removing other numeric content by targeting the exact pattern (digit,digit).
      out = out.replace(/\(\s*\d+\s*,\s*\d+\s*\)/g, '');
    } catch (e) {
      // ignore
    }

    try {
      if (removedCoordinate) {
        const [r, c] = Array.isArray(recommendedMove) ? recommendedMove : [null, null];
        if (typeof r === 'number' && typeof c === 'number') {
          const coordPhrase = `Row ${r + 1}, Column ${c + 1}`;
          out = out.replace(/\b(Move at|move at|Play at|play at|Go for|go for)\b\s*[,;:\-]?\s*/i, (m) => `${m.trim()} ${coordPhrase} `);
          out = out.replace(/^\s*(?:at\s*)?(?:,?\s*)?(?=flips|captures|secures|gains|maintains)/i, `Move at ${coordPhrase} `);
        }
      }
    } catch (e) {
      // ignore
    }

    // Normalize common phrasing and misspellings to user-friendly wording
    out = out.replace(/edge-adjacency prohibition/gi, 'avoiding risky moves next to the board edge');
    out = out.replace(/edge adjacency prohibition/gi, 'avoiding risky moves next to the board edge');
    out = out.replace(/edge-adjacent moves/gi, 'moves next to the board edge');
    out = out.replace(/edge adjacent moves/gi, 'moves next to the board edge');

    // Catch common misspellings like "adjancent" and normalize variants
    out = out.replace(/adjancent/gi, 'adjacent');
    out = out.replace(/edge[ -]?adjancent/gi, 'edge adjacent');
    out = out.replace(/\b(edge[-\s]?adjacent|edge[-\s]?adjancent)\b/gi, 'moves next to the board edge');

    // Normalize whitespace and punctuation
    out = out.replace(/\s+([,\.])/g, '$1');
    out = out.replace(/[\s]{2,}/g, ' ');
    out = out.replace(/^[,\.\-\s]+/, '').replace(/[,\.\-\s]+$/, '');
    return out || '';
  }

  // Export in various environments
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = sanitizeReasoning;
  }
  try { global.sanitizeReasoning = sanitizeReasoning; } catch (e) {}
})(typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : this));
