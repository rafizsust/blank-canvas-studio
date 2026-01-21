/**
 * IndexedDB-based audio persistence for speaking tests.
 * Allows resubmission from history even after navigating away.
 * 
 * KEY FEATURE: Audio is saved IMMEDIATELY after each question recording,
 * not just at the end of the test. This prevents data loss on crashes.
 */

const DB_NAME = 'speaking_audio_db';
const DB_VERSION = 2; // Bump version for new meta store
const STORE_NAME = 'audio_segments';
const META_STORE_NAME = 'test_meta';

export interface PersistedAudioSegment {
  key: string;
  testId: string;
  partNumber: 1 | 2 | 3;
  questionId: string;
  questionNumber: number;
  questionText: string;
  audioBlob: Blob;
  duration: number;
  savedAt: number;
}

export interface PersistedTestMeta {
  testId: string;
  topic?: string;
  difficulty?: string;
  evaluationMode?: 'basic' | 'accuracy';
  savedAt: number;
  segmentKeys: string[];
  lastPart?: 1 | 2 | 3;
  lastQuestionIndex?: number;
}

// Open IndexedDB connection
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('testId', 'testId', { unique: false });
      }
      
      // Add meta store for test-level information
      if (!db.objectStoreNames.contains(META_STORE_NAME)) {
        db.createObjectStore(META_STORE_NAME, { keyPath: 'testId' });
      }
    };
  });
}

// Save audio segment to IndexedDB
export async function saveAudioSegment(
  testId: string,
  segment: {
    key: string;
    partNumber: 1 | 2 | 3;
    questionId: string;
    questionNumber: number;
    questionText: string;
    chunks: Blob[];
    duration: number;
  }
): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    const audioBlob = new Blob(segment.chunks, { type: segment.chunks?.[0]?.type || 'audio/webm' });
    
    const record: PersistedAudioSegment = {
      key: `${testId}_${segment.key}`,
      testId,
      partNumber: segment.partNumber,
      questionId: segment.questionId,
      questionNumber: segment.questionNumber,
      questionText: segment.questionText,
      audioBlob,
      duration: segment.duration,
      savedAt: Date.now(),
    };
    
    store.put(record);
    
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    
    db.close();
    console.log(`[useSpeakingAudioPersistence] Saved audio segment: ${segment.key}`);
  } catch (err) {
    console.error('[useSpeakingAudioPersistence] Failed to save audio:', err);
  }
}

// Save all audio segments for a test
export async function saveAllAudioSegments(
  testId: string,
  segments: Record<string, {
    key: string;
    partNumber: 1 | 2 | 3;
    questionId: string;
    questionNumber: number;
    questionText: string;
    chunks: Blob[];
    duration: number;
  }>
): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    for (const segment of Object.values(segments)) {
      const audioBlob = new Blob(segment.chunks, { type: segment.chunks?.[0]?.type || 'audio/webm' });
      
      const record: PersistedAudioSegment = {
        key: `${testId}_${segment.key}`,
        testId,
        partNumber: segment.partNumber,
        questionId: segment.questionId,
        questionNumber: segment.questionNumber,
        questionText: segment.questionText,
        audioBlob,
        duration: segment.duration,
        savedAt: Date.now(),
      };
      
      store.put(record);
    }
    
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    
    db.close();
    console.log(`[useSpeakingAudioPersistence] Saved ${Object.keys(segments).length} segments for test ${testId}`);
  } catch (err) {
    console.error('[useSpeakingAudioPersistence] Failed to save all audio:', err);
  }
}

// Load all audio segments for a test
export async function loadAudioSegments(testId: string): Promise<PersistedAudioSegment[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('testId');
    
    const segments: PersistedAudioSegment[] = await new Promise((resolve, reject) => {
      const request = index.getAll(testId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    
    db.close();
    console.log(`[useSpeakingAudioPersistence] Loaded ${segments.length} segments for test ${testId}`);
    return segments;
  } catch (err) {
    console.error('[useSpeakingAudioPersistence] Failed to load audio:', err);
    return [];
  }
}

// Check if a test has persisted audio
export async function hasPersistedAudio(testId: string): Promise<boolean> {
  try {
    const segments = await loadAudioSegments(testId);
    return segments.length > 0;
  } catch {
    return false;
  }
}

// Delete audio segments for a test (after successful submission)
export async function deleteAudioSegments(testId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('testId');
    
    // Get all keys for this test
    const segments: PersistedAudioSegment[] = await new Promise((resolve, reject) => {
      const request = index.getAll(testId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    
    // Delete each segment
    for (const segment of segments) {
      store.delete(segment.key);
    }
    
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    
    db.close();
    console.log(`[useSpeakingAudioPersistence] Deleted ${segments.length} segments for test ${testId}`);
  } catch (err) {
    console.error('[useSpeakingAudioPersistence] Failed to delete audio:', err);
  }
}

// Get all tests with persisted audio (for history page)
export async function getTestsWithPersistedAudio(): Promise<string[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    
    const allRecords: PersistedAudioSegment[] = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    
    db.close();
    
    // Get unique test IDs
    const testIds = [...new Set(allRecords.map(r => r.testId))];
    return testIds;
  } catch (err) {
    console.error('[useSpeakingAudioPersistence] Failed to get tests with audio:', err);
    return [];
  }
}

// Clean up old audio (older than 7 days)
export async function cleanupOldAudio(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE_NAME, META_STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const metaStore = tx.objectStore(META_STORE_NAME);
    
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
    
    const allRecords: PersistedAudioSegment[] = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    
    let deleted = 0;
    const testIdsToCleanup = new Set<string>();
    
    for (const record of allRecords) {
      if (record.savedAt < cutoff) {
        store.delete(record.key);
        testIdsToCleanup.add(record.testId);
        deleted++;
      }
    }
    
    // Also clean up meta records for deleted tests
    for (const testId of testIdsToCleanup) {
      metaStore.delete(testId);
    }
    
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    
    db.close();
    if (deleted > 0) {
      console.log(`[useSpeakingAudioPersistence] Cleaned up ${deleted} old segments`);
    }
  } catch (err) {
    console.error('[useSpeakingAudioPersistence] Failed to cleanup old audio:', err);
  }
}

/**
 * Save test metadata (topic, difficulty, evaluation mode)
 * Call this when starting a test so history page can show context
 */
export async function saveTestMeta(meta: Omit<PersistedTestMeta, 'savedAt' | 'segmentKeys'>): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(META_STORE_NAME, 'readwrite');
    const store = tx.objectStore(META_STORE_NAME);
    
    const record: PersistedTestMeta = {
      ...meta,
      savedAt: Date.now(),
      segmentKeys: [],
    };
    
    store.put(record);
    
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    
    db.close();
  } catch (err) {
    console.warn('[useSpeakingAudioPersistence] Failed to save test meta:', err);
  }
}

/**
 * Get test metadata
 */
export async function getTestMeta(testId: string): Promise<PersistedTestMeta | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(META_STORE_NAME, 'readonly');
    const store = tx.objectStore(META_STORE_NAME);
    
    const meta: PersistedTestMeta | undefined = await new Promise((resolve, reject) => {
      const request = store.get(testId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    
    db.close();
    return meta || null;
  } catch (err) {
    console.warn('[useSpeakingAudioPersistence] Failed to get test meta:', err);
    return null;
  }
}

/**
 * Update test metadata with latest progress
 */
export async function updateTestMetaProgress(
  testId: string,
  lastPart: 1 | 2 | 3,
  lastQuestionIndex: number
): Promise<void> {
  try {
    const existing = await getTestMeta(testId);
    if (!existing) return;
    
    const db = await openDB();
    const tx = db.transaction(META_STORE_NAME, 'readwrite');
    const store = tx.objectStore(META_STORE_NAME);
    
    store.put({
      ...existing,
      lastPart,
      lastQuestionIndex,
      savedAt: Date.now(),
    });
    
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    
    db.close();
  } catch (err) {
    console.warn('[useSpeakingAudioPersistence] Failed to update test meta progress:', err);
  }
}

/**
 * Delete test metadata
 */
export async function deleteTestMeta(testId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(META_STORE_NAME, 'readwrite');
    const store = tx.objectStore(META_STORE_NAME);
    
    store.delete(testId);
    
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    
    db.close();
  } catch (err) {
    console.warn('[useSpeakingAudioPersistence] Failed to delete test meta:', err);
  }
}

/**
 * Get all test IDs that have both persisted audio AND meta
 * Returns richer info for history page
 */
export async function getRecoverableTests(): Promise<Array<{
  testId: string;
  meta: PersistedTestMeta | null;
  segmentCount: number;
  totalDuration: number;
}>> {
  try {
    const testIds = await getTestsWithPersistedAudio();
    const results: Array<{
      testId: string;
      meta: PersistedTestMeta | null;
      segmentCount: number;
      totalDuration: number;
    }> = [];
    
    for (const testId of testIds) {
      const segments = await loadAudioSegments(testId);
      const meta = await getTestMeta(testId);
      
      results.push({
        testId,
        meta,
        segmentCount: segments.length,
        totalDuration: segments.reduce((acc, s) => acc + s.duration, 0),
      });
    }
    
    return results;
  } catch (err) {
    console.error('[useSpeakingAudioPersistence] Failed to get recoverable tests:', err);
    return [];
  }
}
