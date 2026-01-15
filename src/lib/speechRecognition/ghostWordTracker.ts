/**
 * Ghost Word Tracker (Chrome Only)
 * 
 * ENHANCED VERSION: Captures not just fillers but also words that Chrome's 
 * aggressive cleanup removes during proactive restarts.
 * 
 * Root Cause: When the watchdog triggers a restart every ~35s, Chrome may:
 * 1. Drop the last few words of the current segment
 * 2. Skip words during the restart gap
 * 3. Aggressively remove fillers from final results
 * 
 * Solution: Track all interim words and compare with finals to recover missed content.
 */

const FILLER_WHITELIST = new Set([
  "um", "uh", "erm", "ah", "er", "hmm", "hm", "mm", "mmm", "mhm",
  "umm", "ummm", "uhh", "ahh", "ehm", "uh,", "um,", "umm,", "mmm,"
]);

// Common words that shouldn't be recovered even if they appear to be "missing"
const NOISE_BLACKLIST = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were",
  "to", "of", "in", "on", "at", "for", "with", "by", "it", "this", "that"
]);

interface GhostWord {
  word: string;
  firstSeen: number;
  lastSeen: number;
  occurrenceCount: number;
  duration: number;
  // NEW: Track if this word appeared in a sequence (contextual stability)
  contextWords: string[];
}

// Sliding window to track recent interim sequences for context
interface InterimSnapshot {
  words: string[];
  timestamp: number;
}

export class GhostWordTracker {
  private ghostWords: Map<string, GhostWord> = new Map();
  private acceptedGhosts: string[] = [];
  private recentInterims: InterimSnapshot[] = [];
  
  // Acceptance thresholds - RELAXED for better recovery
  private readonly MIN_OCCURRENCES = 2;
  private readonly MIN_DURATION_MS = 150; // Reduced from 200ms
  private readonly MAX_INTERIM_HISTORY = 20;
  
  reset(): void {
    this.ghostWords.clear();
    this.acceptedGhosts = [];
    this.recentInterims = [];
  }
  
  /**
   * Track interim words that might be ghost words
   * ENHANCED: Stores full interim snapshots for context analysis
   */
  trackInterimWords(words: string[]): void {
    const now = Date.now();
    
    // Store snapshot for sequence analysis
    if (words.length > 0) {
      this.recentInterims.push({ words: [...words], timestamp: now });
      // Keep only recent history
      if (this.recentInterims.length > this.MAX_INTERIM_HISTORY) {
        this.recentInterims.shift();
      }
    }
    
    for (const rawWord of words) {
      const word = rawWord.toLowerCase().trim().replace(/[.,!?;:'"]+$/, ''); // Strip trailing punctuation
      
      // Only track meaningful words
      if (word.length < 2) continue;
      
      const existing = this.ghostWords.get(word);
      
      if (existing) {
        existing.lastSeen = now;
        existing.occurrenceCount++;
        existing.duration = now - existing.firstSeen;
        // Track adjacent words for context
        const wordIndex = words.findIndex(w => w.toLowerCase().trim().replace(/[.,!?;:'"]+$/, '') === word);
        if (wordIndex > 0) {
          const prevWord = words[wordIndex - 1].toLowerCase().trim();
          if (!existing.contextWords.includes(prevWord)) {
            existing.contextWords.push(prevWord);
          }
        }
      } else {
        this.ghostWords.set(word, {
          word,
          firstSeen: now,
          lastSeen: now,
          occurrenceCount: 1,
          duration: 0,
          contextWords: []
        });
      }
    }
  }
  
  /**
   * ENHANCED: Check if a ghost word should be accepted
   * 
   * Acceptance criteria (ANY TWO must be true):
   * 1. Appears in ≥2 interim events
   * 2. Duration ≥150ms (was visible for meaningful time)
   * 3. Is in filler whitelist
   * 4. NEW: Has contextual stability (appears with same adjacent words multiple times)
   * 5. NEW: Word length ≥4 (longer words are less likely to be noise)
   */
  private shouldAcceptGhost(ghost: GhostWord): boolean {
    const word = ghost.word.toLowerCase();
    
    // Never recover blacklisted common words (too likely to be noise)
    if (NOISE_BLACKLIST.has(word)) return false;
    
    let criteriaMetCount = 0;
    
    if (ghost.occurrenceCount >= this.MIN_OCCURRENCES) criteriaMetCount++;
    if (ghost.duration >= this.MIN_DURATION_MS) criteriaMetCount++;
    if (FILLER_WHITELIST.has(word)) criteriaMetCount++;
    if (ghost.contextWords.length >= 1) criteriaMetCount++; // Has stable context
    if (word.length >= 4) criteriaMetCount++; // Longer words are more reliable
    
    return criteriaMetCount >= 2;
  }
  
  /**
   * ENHANCED: Extract ghost words that meet acceptance criteria
   * Now includes sequence-based recovery for content lost during restarts
   */
  extractAcceptedGhosts(finalWords: Set<string>): string[] {
    const accepted: string[] = [];
    const now = Date.now();
    
    // Normalize final words set
    const normalizedFinals = new Set<string>();
    for (const word of finalWords) {
      normalizedFinals.add(word.toLowerCase().trim().replace(/[.,!?;:'"]+$/, ''));
    }
    
    for (const [word, ghost] of this.ghostWords) {
      // Skip if word appears in final result
      if (normalizedFinals.has(word.toLowerCase())) continue;
      
      // Skip very recent single-frame noise (appeared only once in last 100ms)
      if (ghost.occurrenceCount === 1 && ghost.duration < 100) continue;
      
      // Skip if the ghost is too old (likely from a previous segment)
      if (now - ghost.lastSeen > 5000) continue;
      
      if (this.shouldAcceptGhost(ghost)) {
        accepted.push(ghost.word);
        this.acceptedGhosts.push(ghost.word);
      }
    }
    
    // Clear tracked ghosts after extraction
    this.ghostWords.clear();
    
    return accepted;
  }
  
  /**
   * Get all accepted ghost words for this session
   */
  getAllAcceptedGhosts(): string[] {
    return [...this.acceptedGhosts];
  }
  
  /**
   * Get recent interim snapshots (for debugging)
   */
  getRecentInterims(): InterimSnapshot[] {
    return [...this.recentInterims];
  }
  
  /**
   * Check if a word is in the filler whitelist
   */
  static isFillerWord(word: string): boolean {
    return FILLER_WHITELIST.has(word.toLowerCase().trim());
  }
}
