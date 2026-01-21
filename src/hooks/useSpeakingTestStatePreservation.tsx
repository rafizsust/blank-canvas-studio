/**
 * Speaking Test State Preservation Hook
 * 
 * Persists speaking test state (phase, part, question) to sessionStorage
 * to enable recovery after crashes/refreshes.
 */

import { useCallback, useEffect, useRef } from 'react';

export interface SpeakingTestState {
  testId: string;
  phase: string;
  currentPart: 1 | 2 | 3;
  questionIndex: number;
  evaluationMode: 'basic' | 'accuracy';
  selectedAccent: string;
  testStartedAt?: number;
  lastActivityAt: number;
}

const STORAGE_KEY_PREFIX = 'speaking_test_state:';
const STATE_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours

export function useSpeakingTestStatePreservation(testId: string | undefined) {
  const storageKey = testId ? `${STORAGE_KEY_PREFIX}${testId}` : null;
  const lastSaveRef = useRef<number>(0);
  const THROTTLE_MS = 1000; // Only save once per second max

  // Save state to sessionStorage
  const saveState = useCallback((state: Omit<SpeakingTestState, 'testId' | 'lastActivityAt'>) => {
    if (!storageKey || !testId) return;
    
    // Throttle saves to avoid performance impact
    const now = Date.now();
    if (now - lastSaveRef.current < THROTTLE_MS) return;
    lastSaveRef.current = now;
    
    try {
      const fullState: SpeakingTestState = {
        ...state,
        testId,
        lastActivityAt: now,
      };
      sessionStorage.setItem(storageKey, JSON.stringify(fullState));
    } catch (e) {
      console.warn('[useSpeakingTestStatePreservation] Failed to save state:', e);
    }
  }, [storageKey, testId]);

  // Load state from sessionStorage
  const loadState = useCallback((): SpeakingTestState | null => {
    if (!storageKey) return null;
    
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return null;
      
      const state: SpeakingTestState = JSON.parse(raw);
      
      // Check if state is expired
      const age = Date.now() - state.lastActivityAt;
      if (age > STATE_EXPIRY_MS) {
        sessionStorage.removeItem(storageKey);
        return null;
      }
      
      return state;
    } catch (e) {
      console.warn('[useSpeakingTestStatePreservation] Failed to load state:', e);
      return null;
    }
  }, [storageKey]);

  // Clear state
  const clearState = useCallback(() => {
    if (storageKey) {
      try {
        sessionStorage.removeItem(storageKey);
      } catch (e) {
        // ignore
      }
    }
  }, [storageKey]);

  // Check if we have a valid saved state for this test
  const hasSavedState = useCallback((): boolean => {
    return loadState() !== null;
  }, [loadState]);

  // Cleanup expired states on mount
  useEffect(() => {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key?.startsWith(STORAGE_KEY_PREFIX)) {
          const raw = sessionStorage.getItem(key);
          if (raw) {
            try {
              const state = JSON.parse(raw);
              if (Date.now() - state.lastActivityAt > STATE_EXPIRY_MS) {
                keysToRemove.push(key);
              }
            } catch {
              keysToRemove.push(key);
            }
          }
        }
      }
      keysToRemove.forEach(k => sessionStorage.removeItem(k));
    } catch (e) {
      // ignore
    }
  }, []);

  return {
    saveState,
    loadState,
    clearState,
    hasSavedState,
  };
}

/**
 * Get all tests with preserved state (for history page)
 */
export function getTestsWithPreservedState(): string[] {
  const testIds: string[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(STORAGE_KEY_PREFIX)) {
        const testId = key.replace(STORAGE_KEY_PREFIX, '');
        const raw = sessionStorage.getItem(key);
        if (raw) {
          try {
            const state = JSON.parse(raw);
            if (Date.now() - state.lastActivityAt < STATE_EXPIRY_MS) {
              testIds.push(testId);
            }
          } catch {
            // skip invalid
          }
        }
      }
    }
  } catch (e) {
    // ignore
  }
  return testIds;
}

/**
 * Get preserved state for a specific test (for history page)
 */
export function getPreservedStateForTest(testId: string): SpeakingTestState | null {
  try {
    const raw = sessionStorage.getItem(`${STORAGE_KEY_PREFIX}${testId}`);
    if (!raw) return null;
    
    const state: SpeakingTestState = JSON.parse(raw);
    const age = Date.now() - state.lastActivityAt;
    if (age > STATE_EXPIRY_MS) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

/**
 * Clear preserved state for a specific test
 */
export function clearPreservedStateForTest(testId: string): void {
  try {
    sessionStorage.removeItem(`${STORAGE_KEY_PREFIX}${testId}`);
  } catch {
    // ignore
  }
}
