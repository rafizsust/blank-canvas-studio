import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AILoadingScreen } from '@/components/common/AILoadingScreen';
import { CreditDisplay } from '@/components/common/CreditDisplay';
import { SelectableCard } from '@/components/common/SelectableCard';
import { useToast } from '@/hooks/use-toast';
import { describeApiError } from '@/lib/apiErrors';
import { useAuth } from '@/hooks/useAuth';
import { useTopicCompletions } from '@/hooks/useTopicCompletions';
import { useSmartTopicCycle } from '@/hooks/useSmartTopicCycle';
import { supabase } from '@/integrations/supabase/client';
import { playCompletionSound, playErrorSound } from '@/lib/sounds';
import { 
  READING_TOPICS, 
  LISTENING_TOPICS, 
  WRITING_TASK1_TOPICS, 
  WRITING_TASK2_TOPICS,
  SPEAKING_TOPICS_PART1,
  SPEAKING_TOPICS_PART2,
  SPEAKING_TOPICS_PART3,
  SPEAKING_TOPICS_FULL,
} from '@/lib/ieltsTopics';
import { 
  BookOpen, 
  Headphones, 
  Sparkles, 
  Clock, 
  Target, 
  Zap,
  Brain,
  Settings2,
  PenTool,
  Mic
} from 'lucide-react';
import { 
  PracticeModule, 
  DifficultyLevel, 
  ReadingQuestionType, 
  ListeningQuestionType,
  WritingTaskType,
  SpeakingPartType,
  QUESTION_COUNTS,
  getDefaultTime,
  saveGeneratedTestAsync,
  setCurrentTest,
  GeneratedTest
} from '@/types/aiPractice';
import { Link } from 'react-router-dom';

// Question type options - ALL IELTS QUESTION TYPES
const READING_QUESTION_TYPES: { value: ReadingQuestionType; label: string; description: string }[] = [
  { value: 'TRUE_FALSE_NOT_GIVEN', label: 'True/False/Not Given', description: 'Decide if statements match the passage' },
  { value: 'YES_NO_NOT_GIVEN', label: 'Yes/No/Not Given', description: 'Decide if statements agree with the views' },
  { value: 'MATCHING_HEADINGS', label: 'Matching Headings', description: 'Match paragraphs with suitable headings' },
  { value: 'MATCHING_INFORMATION', label: 'Matching Information', description: 'Match statements to paragraphs' },
  { value: 'MATCHING_SENTENCE_ENDINGS', label: 'Matching Sentence Endings', description: 'Complete sentences with correct endings' },
  { value: 'MULTIPLE_CHOICE', label: 'Multiple Choice (Single)', description: 'Choose one correct answer' },
  { value: 'MULTIPLE_CHOICE_MULTIPLE', label: 'Multiple Choice (Multi)', description: 'Choose multiple correct answers' },
  { value: 'FILL_IN_BLANK', label: 'Fill in the Blank', description: 'Complete sentences with words from passage' },
  { value: 'SUMMARY_COMPLETION', label: 'Summary/Word Bank', description: 'Fill in a summary using word bank' },
  { value: 'TABLE_COMPLETION', label: 'Table Completion', description: 'Complete a table with information' },
  { value: 'FLOWCHART_COMPLETION', label: 'Flowchart Completion', description: 'Complete steps in a process flowchart' },
  { value: 'MAP_LABELING', label: 'Map/Diagram Labeling', description: 'Label parts of a map or diagram' },
];

const LISTENING_QUESTION_TYPES: { value: ListeningQuestionType; label: string; description: string }[] = [
  { value: 'FILL_IN_BLANK', label: 'Fill in the Blank', description: 'Complete notes while listening' },
  { value: 'MULTIPLE_CHOICE_SINGLE', label: 'Multiple Choice (Single)', description: 'Choose one correct answer' },
  { value: 'MULTIPLE_CHOICE_MULTIPLE', label: 'Multiple Choice (Multi)', description: 'Choose multiple correct answers' },
  { value: 'MATCHING_CORRECT_LETTER', label: 'Matching', description: 'Match items with options' },
  { value: 'TABLE_COMPLETION', label: 'Table Completion', description: 'Complete a table with information' },
  { value: 'FLOWCHART_COMPLETION', label: 'Flowchart Completion', description: 'Complete process steps' },
  { value: 'DRAG_AND_DROP_OPTIONS', label: 'Drag and Drop', description: 'Drag options to correct positions' },
  { value: 'MAP_LABELING', label: 'Map Labeling', description: 'Label locations on a map' },
];

const WRITING_TASK_TYPES: { value: WritingTaskType; label: string; description: string; defaultTime: number }[] = [
  { value: 'FULL_TEST', label: 'Full Test', description: 'Task 1 + Task 2 together (60 min)', defaultTime: 60 },
  { value: 'TASK_1', label: 'Task 1 (Report)', description: 'Describe visual data (chart, graph, diagram)', defaultTime: 20 },
  { value: 'TASK_2', label: 'Task 2 (Essay)', description: 'Write an essay on a given topic', defaultTime: 40 },
];

// Task 1 visual types for dropdown
const WRITING_TASK1_VISUAL_TYPES = [
  { value: 'RANDOM', label: 'Random', description: 'Any visual type' },
  { value: 'BAR_CHART', label: 'Bar Chart', description: 'Vertical or horizontal bars' },
  { value: 'LINE_GRAPH', label: 'Line Graph', description: 'Trends over time' },
  { value: 'PIE_CHART', label: 'Pie Chart', description: 'Proportions and percentages' },
  { value: 'TABLE', label: 'Table', description: 'Data in rows and columns' },
  { value: 'MIXED_CHARTS', label: 'Mixed Charts', description: 'Two or more chart types' },
  { value: 'PROCESS_DIAGRAM', label: 'Process Diagram', description: 'Steps in a process' },
  { value: 'MAP', label: 'Map Comparison', description: 'Before and after maps' },
  { value: 'COMPARISON_DIAGRAM', label: 'Comparison Diagram', description: 'Comparing two items' },
];

// Task 2 essay types for dropdown  
const WRITING_TASK2_ESSAY_TYPES = [
  { value: 'RANDOM', label: 'Random', description: 'Any essay type' },
  { value: 'OPINION', label: 'Opinion/Agree-Disagree', description: 'Express your opinion' },
  { value: 'DISCUSSION', label: 'Discussion', description: 'Discuss both views' },
  { value: 'PROBLEM_SOLUTION', label: 'Problem & Solution', description: 'Problems and solutions' },
  { value: 'ADVANTAGES_DISADVANTAGES', label: 'Advantages & Disadvantages', description: 'Pros and cons' },
  { value: 'TWO_PART_QUESTION', label: 'Two-Part Question', description: 'Answer two related questions' },
];

const SPEAKING_PART_TYPES: { value: SpeakingPartType; label: string; description: string }[] = [
  { value: 'FULL_TEST', label: 'Full Test', description: 'All 3 parts (11-14 minutes)' },
  { value: 'PART_1', label: 'Part 1 Only', description: 'Introduction and interview' },
  { value: 'PART_2', label: 'Part 2 Only', description: 'Individual long turn with cue card' },
  { value: 'PART_3', label: 'Part 3 Only', description: 'Discussion and abstract topics' },
];

// Note: Difficulty options removed from test-taker UI - admin portal still has them

// Reading passage specifications - fixed to 4 paragraphs
const READING_PASSAGE_PARAGRAPHS = 4;

// Listening configuration - TEMPORARY: 1 min for testing (revert to 240 for production)
const LISTENING_AUDIO_DURATION_SECONDS = 60; // 1 min for testing
// Fixed question count for Reading and Listening
const FIXED_QUESTION_COUNT = 7;
// Question types that require 2 speakers
const MULTI_SPEAKER_QUESTION_TYPES: ListeningQuestionType[] = [
  'FILL_IN_BLANK',
  'MULTIPLE_CHOICE_SINGLE',
  'MULTIPLE_CHOICE_MULTIPLE',
  'MATCHING_CORRECT_LETTER',
  'DRAG_AND_DROP_OPTIONS',
];

interface SpeakerConfig {
  gender: 'male' | 'female';
  accent: string;
  voiceName: string;
}

export default function AIPractice() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();

  // Form state
  const [activeModule, setActiveModule] = useState<PracticeModule>('reading');
  const [readingQuestionType, setReadingQuestionType] = useState<ReadingQuestionType>('TRUE_FALSE_NOT_GIVEN');
  const [listeningQuestionType, setListeningQuestionType] = useState<ListeningQuestionType>('FILL_IN_BLANK');
  const [writingTaskType, setWritingTaskType] = useState<WritingTaskType>('TASK_1');
  const [writingTask1VisualType, setWritingTask1VisualType] = useState('RANDOM');
  const [writingTask2EssayType, setWritingTask2EssayType] = useState('RANDOM');
  const [writingTimeMinutes, setWritingTimeMinutes] = useState(20);
  const [speakingPartType, setSpeakingPartType] = useState<SpeakingPartType>('FULL_TEST');
  const [difficulty] = useState<DifficultyLevel>('medium'); // Default difficulty, not user-selectable
  const [topicPreference, setTopicPreference] = useState('');
  const [timeMinutes, setTimeMinutes] = useState(10);
  const [audioSpeed, setAudioSpeed] = useState(1);

  // Update writing time when task type changes
  useEffect(() => {
    const taskConfig = WRITING_TASK_TYPES.find(t => t.value === writingTaskType);
    if (taskConfig) {
      setWritingTimeMinutes(taskConfig.defaultTime);
    }
  }, [writingTaskType]);

  // Topic completion tracking (legacy hooks for displaying completion counts)
  const readingCompletions = useTopicCompletions('reading');
  const listeningCompletions = useTopicCompletions('listening');
  const writingCompletions = useTopicCompletions('writing');
  const speakingCompletions = useTopicCompletions('speaking');

  // Smart-Cycle topic rotation for each module
  // These hooks implement the balanced round-robin algorithm
  const readingSmartCycle = useSmartTopicCycle('reading');
  const listeningSmartCycle = useSmartTopicCycle('listening');
  // Writing needs subtype for correct topic list
  // For FULL_TEST, we use TASK_2 topics as the primary cycle (Task 2 is the main essay)
  const writingSubtype = writingTaskType === 'TASK_1' ? 'TASK_1' : 'TASK_2';
  const writingSmartCycle = useSmartTopicCycle('writing', writingSubtype);
  // Speaking needs subtype for correct topic list  
  const speakingSubtype = speakingPartType === 'PART_1' ? 'PART_1' 
    : speakingPartType === 'PART_2' ? 'PART_2' 
    : speakingPartType === 'PART_3' ? 'PART_3' 
    : 'FULL_TEST';
  const speakingSmartCycle = useSmartTopicCycle('speaking', speakingSubtype);

  // Get the current smart cycle hook based on active module
  const currentSmartCycle = useMemo(() => {
    switch (activeModule) {
      case 'reading': return readingSmartCycle;
      case 'listening': return listeningSmartCycle;
      case 'writing': return writingSmartCycle;
      case 'speaking': return speakingSmartCycle;
      default: return readingSmartCycle;
    }
  }, [activeModule, readingSmartCycle, listeningSmartCycle, writingSmartCycle, speakingSmartCycle]);

  // Get topics based on current module/subtype
  const currentTopics = useMemo(() => {
    switch (activeModule) {
      case 'reading':
        return READING_TOPICS;
      case 'listening':
        return LISTENING_TOPICS;
      case 'writing':
        return writingTaskType === 'TASK_1' ? WRITING_TASK1_TOPICS : WRITING_TASK2_TOPICS;
      case 'speaking':
        switch (speakingPartType) {
          case 'PART_1': return SPEAKING_TOPICS_PART1;
          case 'PART_2': return SPEAKING_TOPICS_PART2;
          case 'PART_3': return SPEAKING_TOPICS_PART3;
          default: return SPEAKING_TOPICS_FULL;
        }
      default:
        return [];
    }
  }, [activeModule, writingTaskType, speakingPartType]);

  // Get the completion hook for current module
  const currentCompletions = useMemo(() => {
    switch (activeModule) {
      case 'reading': return readingCompletions;
      case 'listening': return listeningCompletions;
      case 'writing': return writingCompletions;
      case 'speaking': return speakingCompletions;
      default: return readingCompletions;
    }
  }, [activeModule, readingCompletions, listeningCompletions, writingCompletions, speakingCompletions]);

  // Reading-specific configuration - fixed values
  const readingQuestionCount = FIXED_QUESTION_COUNT;

  // Listening-specific configuration - fixed values  
  const listeningAudioDuration = LISTENING_AUDIO_DURATION_SECONDS;
  const listeningQuestionCount = FIXED_QUESTION_COUNT;
  
  // IELTS Part 1 Spelling Mode configuration for Fill-in-Blank
  const [spellingModeEnabled, setSpellingModeEnabled] = useState(false);
  const [spellingTestScenario, setSpellingTestScenario] = useState<'phone_call' | 'hotel_booking' | 'job_inquiry'>('phone_call');
  const [spellingDifficulty, setSpellingDifficulty] = useState<'low' | 'high'>('low');
  const [numberFormat, setNumberFormat] = useState<'phone_number' | 'date' | 'postcode'>('phone_number');
  
  // Monologue mode for Fill-in-Blank (single speaker like IELTS Part 4)
  const [monologueModeEnabled, setMonologueModeEnabled] = useState(false);
  
  // Speaker configuration - default values used in API call
  // NOTE: Kore & Puck are both female voices. Using correct gender mapping.
  const speaker1Config: SpeakerConfig = {
    gender: 'female',
    accent: 'en-GB',
    voiceName: 'Kore', // Female voice for listening tests (speaker 1)
  };
  const speaker2Config: SpeakerConfig = {
    gender: 'male',
    accent: 'en-GB',
    voiceName: 'Charon', // Male voice for listening tests (speaker 2)
  };

  // Determine if current question type needs 2 speakers
  // For Fill-in-Blank, this is overridden by monologue mode toggle
  const needsTwoSpeakers = listeningQuestionType === 'FILL_IN_BLANK' 
    ? !monologueModeEnabled 
    : MULTI_SPEAKER_QUESTION_TYPES.includes(listeningQuestionType);

  // Loading state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStep, setGenerationStep] = useState(0);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const currentQuestionType = activeModule === 'reading' ? readingQuestionType 
    : activeModule === 'listening' ? listeningQuestionType
    : activeModule === 'writing' ? writingTaskType
    : speakingPartType;
  
  // For reading and listening, use fixed question count; for others, use predefined counts
  const questionCount = activeModule === 'reading' 
    ? readingQuestionCount 
    : activeModule === 'listening'
    ? listeningQuestionCount
    : (QUESTION_COUNTS[currentQuestionType] || 5);

  const progressSteps = activeModule === 'reading' 
    ? ['Analyzing topic', 'Generating passage', 'Creating questions', 'Preparing explanations', 'Finalizing']
    : activeModule === 'listening'
    ? ['Analyzing topic', 'Generating dialogue', 'Creating audio', 'Generating questions', 'Finalizing']
    : activeModule === 'writing'
    ? ['Analyzing topic', 'Creating prompt', writingTaskType === 'TASK_1' ? 'Generating chart/graph' : 'Preparing task', 'Finalizing']
    : ['Analyzing topic', 'Creating questions', 'Generating audio prompts', 'Preparing cue card', 'Finalizing'];


  const handleGenerate = async () => {
    if (!user) {
      toast({
        title: 'Login Required',
        description: 'Please log in to generate AI practice tests',
        variant: 'destructive',
      });
      navigate('/auth?returnTo=/ai-practice');
      return;
    }

    // OPTIMIZATION: Check DB cache BEFORE calling edge function (saves quota + bandwidth)
    // Now supports reading, listening, writing, and speaking modules
    if (activeModule === 'reading' || activeModule === 'listening' || activeModule === 'speaking' || activeModule === 'writing') {
      try {
        console.log(`[cache] Checking DB cache for pre-generated ${activeModule} test...`);
        
        // Fetch cached presets, user's already-used presets, and successfully submitted presets in parallel
        const [cachedTestsResult, usedPresetsResult, submittedPresetsResult] = await Promise.all([
          supabase
            .from('generated_test_audio')
            .select('*')
            .eq('module', activeModule)
            .eq('is_published', true)
            .eq('status', 'ready')
            .limit(50),
          supabase
            .from('ai_practice_tests')
            .select('preset_id')
            .eq('user_id', user.id)
            .not('preset_id', 'is', null),
          // Get presets that have been successfully submitted (have results)
          supabase
            .from('ai_practice_results')
            .select('test_id, ai_practice_tests!inner(preset_id)')
            .eq('user_id', user.id)
        ]);

        const { data: cachedTests, error: cacheError } = cachedTestsResult;
        const usedPresetIds = new Set(
          (usedPresetsResult.data || []).map(r => r.preset_id).filter(Boolean)
        );
        // Presets that user has successfully submitted - these should never be re-served
        const submittedPresetIds = new Set(
          (submittedPresetsResult.data || [])
            .map((r: any) => r.ai_practice_tests?.preset_id)
            .filter(Boolean)
        );
        
        console.log('[cache] fetched rows:', cachedTests?.length || 0, 'usedPresets:', usedPresetIds.size, 'submittedPresets:', submittedPresetIds.size);

        if (!cacheError && cachedTests && cachedTests.length > 0) {
          // IMPORTANT: Preset cache must respect user selections.
          // If we can't find a preset that matches the requested constraints, we must treat it as a cache MISS
          // (and fall back to AI generation) rather than serving a random preset from the same module.

          const normalizeTopic = (value: string) =>
            value
              .toLowerCase()
              .trim()
              .replace(/\s*&\s*/g, " and ")
              .replace(/\s+/g, " ");

          // CRITICAL: Treat whitespace-only topic preference as empty (no manual selection)
          // This prevents matching presets when user enters just spaces
          const cleanedTopicPreference = topicPreference.trim();
          const effectiveTopicForPreset = (cleanedTopicPreference || currentSmartCycle.nextTopic || "").trim();

          // Apply STRICT filters (no fallback to unrelated presets)
          // For Writing Task 1: filter by specific visual type (BAR_CHART, LINE_GRAPH, etc.) if user selected one
          let effectiveQuestionType: string = currentQuestionType;
          if (activeModule === 'writing' && writingTaskType === 'TASK_1' && writingTask1VisualType !== 'RANDOM') {
            effectiveQuestionType = writingTask1VisualType;
          }
          
          let matchingTests = cachedTests.filter((t) => t.question_type === effectiveQuestionType);

          // Back-compat: older writing presets were sometimes stored with question_type=TASK_1.
          // If that happens, we can still match by the payload's declared visual_type/chartData.type.
          if (
            matchingTests.length === 0 &&
            activeModule === 'writing' &&
            writingTaskType === 'TASK_1' &&
            writingTask1VisualType !== 'RANDOM'
          ) {
            const wanted = writingTask1VisualType;
            matchingTests = cachedTests.filter((t) => {
              if (t.question_type !== 'TASK_1') return false;
              const payload = t.content_payload as any;
              const wt = payload?.writingTask;
              const vt = wt?.visual_type || wt?.chartData?.type;
              return vt === wanted;
            });
            console.log('[cache] back-compat TASK_1 payload visual filter:', matchingTests.length, 'wanted:', wanted);
          }

          console.log('[cache] after question_type filter:', matchingTests.length, 'expected:', effectiveQuestionType);

          if (matchingTests.length === 0) {
            console.log('[cache] MISS: no presets match requested question type; proceeding with edge function');
          } else {
            // Note: Difficulty filter removed - test takers get tests at any difficulty level
              // Filter by topic (manual selection OR smart-cycle topic)
              // Skip topic filter only for writing tests (topics are randomly selected)
              // Speaking tests (including FULL_TEST) should always respect user's topic selection
              const skipTopicFilter = activeModule === 'writing';
              
              // CRITICAL: For modules that require topic matching (reading, listening, speaking parts),
              // we MUST have a topic to match. If no topic is available, don't use presets.
              const requiresTopicMatch = !skipTopicFilter;
              
              if (effectiveTopicForPreset && !skipTopicFilter) {
                const wanted = normalizeTopic(effectiveTopicForPreset);
                matchingTests = matchingTests.filter((t) => normalizeTopic(t.topic) === wanted);
                console.log('[cache] after topic filter:', matchingTests.length, 'expected:', effectiveTopicForPreset);
              } else if (requiresTopicMatch && !effectiveTopicForPreset) {
                // No topic available but topic matching is required - skip preset cache
                console.log('[cache] MISS: topic matching required but no topic available; proceeding with edge function');
                matchingTests = []; // Clear to force edge function
              }

              if (effectiveTopicForPreset && !skipTopicFilter && matchingTests.length === 0) {
                console.log('[cache] MISS: no presets match requested topic; proceeding with edge function');
              } else {
                // Exclude presets user has already successfully submitted (never re-serve these)
                const nonSubmittedTests = matchingTests.filter((t) => !submittedPresetIds.has(t.id));
                console.log('[cache] after excluding submitted presets:', nonSubmittedTests.length, 'of', matchingTests.length);

                if (nonSubmittedTests.length === 0) {
                  console.log('[cache] MISS: all presets have been submitted by user; proceeding with edge function');
                } else {
                  // Exclude presets the user has already taken (avoid repetition within cycle)
                  const freshTests = nonSubmittedTests.filter((t) => !usedPresetIds.has(t.id));
                  console.log('[cache] after excluding used presets:', freshTests.length, 'of', nonSubmittedTests.length);

                  // If all non-submitted presets used, allow re-use from non-submitted pool
                  const testsToChooseFrom = freshTests.length > 0 ? freshTests : nonSubmittedTests;

                if (testsToChooseFrom.length > 0) {
                  // Pick random matching test
                  const cachedTest = testsToChooseFrom[Math.floor(Math.random() * testsToChooseFrom.length)];
                  const payload = cachedTest.content_payload as Record<string, unknown>;

                  // Module-specific validation and payload extraction
                  let isValidPayload = false;
                  let generatedTest: GeneratedTest | null = null;
                  
                  if (activeModule === 'reading' || activeModule === 'listening') {
                    // Normalize DB preset payloads into the UI's expected shape.
                    const rawQuestionGroups = (payload as any)?.questionGroups ?? (payload as any)?.question_groups;
                    const rawQuestions = (payload as any)?.questions;

                    const normalizedQuestionGroups: unknown[] | undefined =
                      Array.isArray(rawQuestionGroups) && rawQuestionGroups.length > 0
                        ? rawQuestionGroups
                        : Array.isArray(rawQuestions) && rawQuestions.length > 0
                          ? [
                              {
                                id: `preset-group-${cachedTest.id}`,
                                instruction: (payload as any)?.instruction ?? '',
                                question_type: cachedTest.question_type,
                                start_question: (rawQuestions[0]?.question_number as number) ?? 1,
                                end_question:
                                  (rawQuestions[rawQuestions.length - 1]?.question_number as number) ?? rawQuestions.length,
                                options:
                                  (payload as any)?.table_data
                                    ? { table_data: (payload as any).table_data }
                                    : undefined,
                                questions: rawQuestions,
                              },
                            ]
                          : undefined;

                    const questionGroups = normalizedQuestionGroups as unknown[] | undefined;
                    if (questionGroups && Array.isArray(questionGroups) && questionGroups.length > 0) {
                      isValidPayload = true;
                      generatedTest = {
                        id: crypto.randomUUID(),
                        module: activeModule,
                        questionType: currentQuestionType,
                        difficulty,
                        topic: cachedTest.topic,
                        timeMinutes: timeMinutes,
                        passage: (payload as any).passage,
                        audioUrl: cachedTest.audio_url || undefined,
                        audioBase64: undefined,
                        audioFormat: undefined,
                        sampleRate: undefined,
                        transcript: cachedTest.transcript || ((payload as any).transcript as string) || undefined,
                        questionGroups: questionGroups as any,
                        writingTask: undefined,
                        speakingParts: undefined,
                        isPreset: true,
                        presetId: cachedTest.id,
                        totalQuestions: (questionGroups as any[]).reduce((acc, g) => acc + (g.questions?.length || 0), 0),
                        generatedAt: new Date().toISOString(),
                      };
                    }
                  } else if (activeModule === 'speaking') {
                    // Speaking preset payloads in DB are stored as:
                    // - { part1, part2, part3, audioUrls, audioFormat }
                    // or { parts: [...], audioUrls }
                    // or already-normalized { speakingParts: [...] }
                    const rawPayload: any = payload as any;

                    const normalizeQuestions = (
                      rawQuestions: any,
                      rawSampleAnswers: any
                    ): any[] => {
                      const qs: any[] = Array.isArray(rawQuestions) ? rawQuestions : [];
                      const sas: any[] = Array.isArray(rawSampleAnswers) ? rawSampleAnswers : [];

                      return qs
                        .map((q, idx) => {
                          const text = typeof q === 'string'
                            ? q
                            : (q?.question_text ?? q?.questionText ?? q?.text ?? '');

                          const sampleAnswer = typeof q === 'object' && q
                            ? (q.sample_answer ?? q.sampleAnswer ?? sas[idx])
                            : sas[idx];

                          return {
                            id: crypto.randomUUID(),
                            question_number: idx + 1,
                            question_text: String(text ?? '').trim(),
                            ...(sampleAnswer ? { sample_answer: String(sampleAnswer) } : {}),
                          };
                        })
                        .filter((q) => q.question_text.length > 0);
                    };

                    const transformPart = (rawPart: any, partNumber: 1 | 2 | 3) => {
                      if (!rawPart) return null;

                      const instruction = String(rawPart.instruction ?? '').trim();
                      
                      // Part 2 presets often have cue_card content instead of questions array
                      // For Part 2: treat the cue_card as the main question if no questions array exists
                      let questions = normalizeQuestions(
                        rawPart.questions,
                        rawPart.sample_answers ?? rawPart.sampleAnswers
                      );

                      // Handle Part 2 cue_card format from bulk generation
                      if (questions.length === 0 && partNumber === 2 && rawPart.cue_card) {
                        questions = [{
                          id: crypto.randomUUID(),
                          question_number: 1,
                          question_text: String(rawPart.cue_card).trim(),
                          ...(rawPart.sample_answer ? { sample_answer: String(rawPart.sample_answer) } : {}),
                        }];
                      }

                      // For Part 2: instruction alone is valid if we have cue_card content
                      const hasValidContent = partNumber === 2 
                        ? (instruction || rawPart.cue_card)
                        : (instruction && questions.length > 0);

                      if (!hasValidContent) return null;

                      // Parse cue_card into topic and content if not already separate
                      let cueCardTopic = rawPart.cue_card_topic ?? rawPart.cueCardTopic;
                      let cueCardContent = rawPart.cue_card_content ?? rawPart.cueCardContent;
                      
                      // If cue_card_topic/cue_card_content not set, parse from cue_card field
                      if (!cueCardTopic && !cueCardContent && rawPart.cue_card) {
                        const cueCard = String(rawPart.cue_card).trim();
                        const lines = cueCard.split('\n').map((l: string) => l.trim()).filter(Boolean);
                        if (lines.length > 0) {
                          // First line is the topic (main question)
                          cueCardTopic = lines[0];
                          // Rest are the content (sub-questions/bullet points)
                          cueCardContent = lines.slice(1).join('\n');
                        }
                      }
                      
                      return {
                        id: crypto.randomUUID(),
                        part_number: partNumber,
                        instruction,
                        questions,
                        cue_card_topic: cueCardTopic,
                        cue_card_content: cueCardContent,
                        preparation_time_seconds: rawPart.preparation_time_seconds ?? rawPart.preparation_time,
                        speaking_time_seconds: rawPart.speaking_time_seconds ?? rawPart.speaking_time,
                        time_limit_seconds: rawPart.time_limit_seconds,
                      };
                    };

                    const normalizedSpeakingParts: any[] = [];

                    // Preferred: part1/part2/part3 shape (how admin presets are stored)
                    const p1 = transformPart(rawPayload.part1, 1);
                    const p2 = transformPart(rawPayload.part2, 2);
                    const p3 = transformPart(rawPayload.part3, 3);
                    if (p1) normalizedSpeakingParts.push(p1);
                    if (p2) normalizedSpeakingParts.push(p2);
                    if (p3) normalizedSpeakingParts.push(p3);

                    // Fallback: { parts: [...] }
                    if (normalizedSpeakingParts.length === 0 && Array.isArray(rawPayload.parts)) {
                      rawPayload.parts.forEach((p: any, idx: number) => {
                        const pn = (p?.part_number ?? idx + 1) as 1 | 2 | 3;
                        const part = transformPart(p, pn);
                        if (part) normalizedSpeakingParts.push(part);
                      });
                    }

                    // Fallback: already-normalized speakingParts (ensure ids exist)
                    if (normalizedSpeakingParts.length === 0 && Array.isArray(rawPayload.speakingParts)) {
                      rawPayload.speakingParts.forEach((p: any, idx: number) => {
                        const pn = (p?.part_number ?? idx + 1) as 1 | 2 | 3;
                        let qs = Array.isArray(p?.questions)
                          ? p.questions.map((q: any, qIdx: number) => ({
                              id: q?.id ?? crypto.randomUUID(),
                              question_number: q?.question_number ?? qIdx + 1,
                              question_text: String(q?.question_text ?? '').trim(),
                              ...(q?.sample_answer ? { sample_answer: q.sample_answer } : {}),
                            })).filter((q: any) => q.question_text)
                          : [];

                        // Handle Part 2 cue_card format - create a question from cue_card if no questions exist
                        if (qs.length === 0 && pn === 2 && (p?.cue_card || p?.cue_card_topic)) {
                          const cueCardText = String(p.cue_card || p.cue_card_topic).trim();
                          qs = [{
                            id: crypto.randomUUID(),
                            question_number: 1,
                            question_text: cueCardText,
                            ...(p?.sample_answer ? { sample_answer: String(p.sample_answer) } : {}),
                          }];
                        }
                        
                        // Part 2 can be valid even without explicit questions if it has cue_card
                        const hasValidContent = pn === 2 
                          ? (qs.length > 0 || p?.cue_card_topic || p?.cue_card_content || p?.cue_card)
                          : qs.length > 0;
                        if (!hasValidContent) return;
                        
                        // Parse cue_card into topic and content if not already separate
                        let cueCardTopic = p?.cue_card_topic;
                        let cueCardContent = p?.cue_card_content;
                        
                        if (!cueCardTopic && !cueCardContent && p?.cue_card) {
                          const cueCard = String(p.cue_card).trim();
                          const lines = cueCard.split('\n').map((l: string) => l.trim()).filter(Boolean);
                          if (lines.length > 0) {
                            cueCardTopic = lines[0];
                            cueCardContent = lines.slice(1).join('\n');
                          }
                        }
                        
                        normalizedSpeakingParts.push({
                          id: p?.id ?? crypto.randomUUID(),
                          part_number: pn,
                          instruction: String(p?.instruction ?? '').trim(),
                          questions: qs,
                          cue_card_topic: cueCardTopic,
                          cue_card_content: cueCardContent,
                          preparation_time_seconds: p?.preparation_time_seconds,
                          speaking_time_seconds: p?.speaking_time_seconds,
                          time_limit_seconds: p?.time_limit_seconds,
                        });
                      });
                    }

                    const speakingAudioUrls = rawPayload.audioUrls;
                    const hasSpeakingAudioUrls =
                      speakingAudioUrls &&
                      typeof speakingAudioUrls === 'object' &&
                      Object.keys(speakingAudioUrls).length > 0;

                    if (normalizedSpeakingParts.length > 0) {
                      isValidPayload = true;
                      generatedTest = {
                        id: crypto.randomUUID(),
                        module: 'speaking',
                        questionType: currentQuestionType,
                        difficulty,
                        topic: cachedTest.topic,
                        timeMinutes: timeMinutes,
                        passage: undefined,
                        audioUrl: cachedTest.audio_url || undefined,
                        audioBase64: undefined,
                        audioFormat: undefined,
                        sampleRate: undefined,
                        transcript: undefined,
                        questionGroups: undefined,
                        writingTask: undefined,
                        speakingParts: normalizedSpeakingParts,
                        speakingAudioUrls: hasSpeakingAudioUrls ? (speakingAudioUrls as any) : undefined,
                        isPreset: true,
                        presetId: cachedTest.id,
                        totalQuestions: normalizedSpeakingParts.reduce(
                          (acc: number, p: any) => acc + (p.questions?.length || 0),
                          0
                        ),
                        generatedAt: new Date().toISOString(),
                      };
                    }
                  } else if (activeModule === 'writing') {
                    // Writing test validation - check for writingTask
                    const writingTask = (payload as any)?.writingTask;
                    if (writingTask && (writingTask.instruction || writingTask.task1 || writingTask.task2)) {
                      isValidPayload = true;
                      generatedTest = {
                        id: crypto.randomUUID(),
                        module: 'writing',
                        questionType: currentQuestionType,
                        difficulty,
                        topic: cachedTest.topic,
                        timeMinutes: writingTimeMinutes,
                        passage: undefined,
                        audioUrl: undefined,
                        audioBase64: undefined,
                        audioFormat: undefined,
                        sampleRate: undefined,
                        transcript: undefined,
                        questionGroups: undefined,
                        writingTask: writingTask,
                        speakingParts: undefined,
                        isPreset: true,
                        presetId: cachedTest.id,
                        totalQuestions: writingTask.task1 && writingTask.task2 ? 2 : 1,
                        generatedAt: new Date().toISOString(),
                      };
                    }
                  }

                  if (isValidPayload && generatedTest) {
                    console.log('[cache] HIT! Using pre-generated test:', cachedTest.id, cachedTest.topic);

                    setCurrentTest(generatedTest);
                    await saveGeneratedTestAsync(generatedTest, user.id);
                    playCompletionSound();

                    toast({
                      title: 'Test Ready!',
                      description: `Using pre-generated ${activeModule} test: ${cachedTest.topic}`,
                    });

                    // Navigate to the correct page based on module
                    if (activeModule === 'reading') {
                      navigate(`/ai-practice/reading/${generatedTest.id}`);
                    } else if (activeModule === 'listening') {
                      navigate(`/ai-practice/listening/${generatedTest.id}`);
                    } else if (activeModule === 'speaking') {
                      navigate(`/ai-practice/speaking/${generatedTest.id}`);
                    } else if (activeModule === 'writing') {
                      navigate(`/ai-practice/writing/${generatedTest.id}`);
                    }
                    return; // Skip edge function call entirely
                  } else {
                    console.log('[cache] MISS: payload missing valid content for', activeModule);
                  }
                }
              }
            }
          }
        }
        console.log('[cache] MISS, proceeding with edge function...');
      } catch (cacheErr) {
        console.warn('[cache] Check failed, proceeding with generation:', cacheErr);
      }
    }

    setIsGenerating(true);
    setGenerationStep(0);

    // Simulate progress steps
    const stepInterval = setInterval(() => {
      setGenerationStep(prev => {
        if (prev < progressSteps.length - 1) return prev + 1;
        return prev;
      });
    }, 3000);

    try {
      // Build reading-specific configuration - fixed 4 paragraphs
      const readingConfig = activeModule === 'reading' ? {
        passagePreset: 'medium',
        paragraphCount: READING_PASSAGE_PARAGRAPHS,
      } : undefined;

      // Build listening-specific configuration with speaker settings
      // Calculate word count from duration (150 words per minute)
      const estimatedWordCount = Math.round((listeningAudioDuration / 60) * 150);
      const listeningConfig = activeModule === 'listening' ? {
        durationSeconds: listeningAudioDuration,
        wordCount: estimatedWordCount,
        useWordCountMode: false,
        speakerConfig: {
          speaker1: speaker1Config,
          speaker2: needsTwoSpeakers ? speaker2Config : undefined,
          useTwoSpeakers: needsTwoSpeakers,
        },
        // IELTS Part 1 Spelling Mode settings (only for Fill-in-Blank when not in monologue mode)
        spellingMode: listeningQuestionType === 'FILL_IN_BLANK' && spellingModeEnabled && !monologueModeEnabled ? {
          enabled: true,
          testScenario: spellingTestScenario,
          spellingDifficulty: spellingDifficulty,
          numberFormat: numberFormat,
        } : undefined,
        // Monologue mode for Fill-in-Blank (like IELTS Part 4)
        monologueMode: listeningQuestionType === 'FILL_IN_BLANK' && monologueModeEnabled,
      } : undefined;

      // Build writing-specific configuration
      const writingConfig = activeModule === 'writing' ? {
        taskType: writingTaskType,
        task1VisualType: writingTask1VisualType,
        task2EssayType: writingTask2EssayType,
        timeMinutes: writingTimeMinutes,
      } : undefined;

      // Use writing time for writing module
      const finalTimeMinutes = activeModule === 'writing' ? writingTimeMinutes : timeMinutes;

      // Smart-Cycle: If no manual topic selected, use the next topic from the round-robin algorithm
      const effectiveTopic = topicPreference.trim() || currentSmartCycle.nextTopic || undefined;

      // Use native fetch with extended timeout for long-running AI generation (listening TTS can take 3+ min)
      const controller = new AbortController();
      setAbortController(controller); // Store for cancel button
      const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5 minute timeout
      
      const session = await supabase.auth.getSession();
      const accessToken = session.data.session?.access_token;
      
      let data: any;
      let error: any;
      
      try {
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-ai-practice`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
              'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            },
            body: JSON.stringify({
              module: activeModule,
              questionType: currentQuestionType,
              // Note: difficulty removed from test-taker API call
              topicPreference: effectiveTopic,
              questionCount,
              timeMinutes: finalTimeMinutes,
              readingConfig,
              listeningConfig,
              writingConfig,
            }),
            signal: controller.signal,
          }
        );
        
        clearTimeout(timeoutId);
        
        const responseData = await response.json();
        
        if (!response.ok) {
          error = new Error(responseData.error || `Request failed with status ${response.status}`);
          (error as any).edgeFunctionData = responseData;
        } else {
          data = responseData;
        }
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          error = new Error('Request timed out. The AI generation is taking longer than expected. Please try again.');
        } else {
          error = fetchError;
        }
      }

      clearInterval(stepInterval);

      // Check for errors - handle both edge function errors and data.error
      if (error) {
        // Try to extract more specific error message from the response
        throw error;
      }

      if (data?.error) {
        // Create error object with full context from edge function response
        const errorWithContext = new Error(data.error);
        (errorWithContext as any).edgeFunctionData = data;
        throw errorWithContext;
      }

      // Save to localStorage
      const generatedTest: GeneratedTest = {
        id: data.testId || crypto.randomUUID(),
        module: activeModule,
        questionType: currentQuestionType,
        difficulty,
        topic: data.topic || topicPreference || 'Random Topic',
        timeMinutes: finalTimeMinutes,
        passage: data.passage,
        // Audio fields - ensure both camelCase and snake_case are captured for R2 URLs
        audioUrl: data.audioUrl || data.audio_url || null,
        audioBase64: data.audioBase64,
        audioFormat: data.audioFormat,
        sampleRate: data.sampleRate,
        transcript: data.transcript,
        questionGroups: data.questionGroups,
        writingTask: data.writingTask,
        speakingParts: data.speakingParts,
        isPreset: Boolean(data?.isPreset),
        presetId: data?.presetId,
        totalQuestions: activeModule === 'writing' ? 1 : 
          activeModule === 'speaking' ? (data.speakingParts?.reduce((acc: number, p: any) => acc + (p.questions?.length || 0), 0) || 0) : 
          // For MCMA, totalQuestions is always 3 (standardized)
          (activeModule === 'reading' && currentQuestionType === 'MULTIPLE_CHOICE_MULTIPLE') ? 3 : questionCount,
        generatedAt: new Date().toISOString(),
      };

      // Save to memory cache and persist to Supabase
      setCurrentTest(generatedTest);
      await saveGeneratedTestAsync(generatedTest, user.id);

      // Play completion sound
      playCompletionSound();

      toast({
        title: 'Test Generated!',
        description: `Your ${activeModule} practice test is ready`,
      });

      // Navigate to the correct practice test based on module
      if (activeModule === 'writing') {
        navigate(`/ai-practice/writing/${generatedTest.id}`);
      } else if (activeModule === 'speaking') {
        navigate(`/ai-practice/speaking/${generatedTest.id}`);
      } else if (activeModule === 'reading') {
        navigate(`/ai-practice/reading/${generatedTest.id}`);
      } else if (activeModule === 'listening') {
        navigate(`/ai-practice/listening/${generatedTest.id}`);
      } else {
        navigate(`/ai-practice/test/${generatedTest.id}`);
      }

    } catch (err: any) {
      console.error('Generation error:', err);
      clearInterval(stepInterval);
      playErrorSound();
      
      const errorDesc = describeApiError(err);
      
      // Error handling for quota issues - user will see error toast
      
      toast({
        title: errorDesc.title,
        description: (
          <div className="flex flex-col gap-2">
            <span>{errorDesc.description}</span>
            {errorDesc.action && (
              <Link to={errorDesc.action.href} className="text-primary-foreground underline text-sm font-medium hover:opacity-80 mt-1">
                {errorDesc.action.label} →
              </Link>
            )}
          </div>
        ),
        variant: 'destructive',
        duration: 8000,
      });
    } finally {
      setIsGenerating(false);
      setGenerationStep(0);
    }
  };

  // Calculate estimated generation time for listening based on audio duration
  const getListeningEstimate = () => {
    const durationSec = listeningAudioDuration;
    
    if (durationSec <= 90) return { text: '60-120 seconds', seconds: 90 };
    if (durationSec <= 120) return { text: '90-150 seconds', seconds: 120 };
    if (durationSec <= 180) return { text: '2-3 minutes', seconds: 150 };
    return { text: '3-4 minutes', seconds: 210 };
  };

  // Calculate estimated generation time for reading based on fixed passage length
  const getReadingEstimate = () => {
    // Fixed 4 paragraphs
    return { text: '20-35 seconds', seconds: 27 };
  };

  const listeningEstimate = getListeningEstimate();
  const readingEstimate = getReadingEstimate();

  // Get estimate based on active module
  const getModuleEstimate = () => {
    switch (activeModule) {
      case 'listening': return listeningEstimate;
      case 'reading': return readingEstimate;
      case 'writing': return { text: '10-20 seconds', seconds: 15 };
      case 'speaking': return { text: '15-25 seconds', seconds: 20 };
      default: return { text: '15-30 seconds', seconds: 22 };
    }
  };

  const moduleEstimate = getModuleEstimate();

  const handleAbortGeneration = () => {
    if (abortController) {
      abortController.abort();
    }
    setIsGenerating(false);
    setGenerationStep(0);
    setAbortController(null);
    toast({
      title: 'Generation Cancelled',
      description: 'Test generation was cancelled. You can try again when ready.',
    });
  };

  if (isGenerating) {
    return (
      <AILoadingScreen
        title="Generating Your Practice Test"
        description={`Creating a personalized ${activeModule} test with ${questionCount} ${currentQuestionType.replace(/_/g, ' ').toLowerCase()} questions.`}
        progressSteps={progressSteps}
        currentStepIndex={generationStep}
        estimatedTime={moduleEstimate.text}
        estimatedSeconds={moduleEstimate.seconds}
        onAbort={handleAbortGeneration}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Navbar />
      
      <main className="flex-1 py-8">
        <div className="container max-w-5xl mx-auto px-4">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <div className="text-center flex-1">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 text-primary mb-4">
                <Sparkles className="w-4 h-4" />
                <span className="text-sm font-medium">AI-Powered Practice</span>
              </div>
              <h1 className="text-3xl md:text-4xl font-bold mb-3">
                Generate Custom Practice Tests
              </h1>
              <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
                Create personalized IELTS practice questions tailored to your needs. 
                AI generates unique questions, answers, and explanations instantly.
              </p>
            </div>
          </div>

          {/* History Link and Credit Display */}
          <div className="flex justify-between items-center mb-4 gap-2 flex-wrap">
            <div className="flex items-center gap-3">
              <CreditDisplay compact />
            </div>
            <Link to="/ai-practice/history">
              <Button variant="outline" size="sm">
                <Clock className="w-4 h-4 mr-2" />
                View History
              </Button>
            </Link>
          </div>

          {!user && (
            <Card className="mb-6 border-warning/50 bg-warning/5">
              <CardContent className="py-4 flex items-center gap-4">
                <Brain className="w-8 h-8 text-warning shrink-0" />
                <div className="flex-1">
                  <p className="font-medium">Login Required</p>
                  <p className="text-sm text-muted-foreground">
                    Please log in and add your Gemini API key in Settings to generate practice tests.
                  </p>
                </div>
                <Link to="/auth?returnTo=/ai-practice">
                  <Button>Get Started</Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {/* Module Tabs */}
          <Tabs value={activeModule} onValueChange={(v) => setActiveModule(v as PracticeModule)} className="mb-6">
            <TabsList className="grid w-full grid-cols-4 h-auto p-1">
              <TabsTrigger value="reading" className="flex items-center gap-2 py-3">
                <BookOpen className="w-4 h-4" />
                <span className="hidden sm:inline">Reading</span>
              </TabsTrigger>
              <TabsTrigger value="listening" className="flex items-center gap-2 py-3">
                <Headphones className="w-4 h-4" />
                <span className="hidden sm:inline">Listening</span>
              </TabsTrigger>
              <TabsTrigger value="writing" className="flex items-center gap-2 py-3">
                <PenTool className="w-4 h-4" />
                <span className="hidden sm:inline">Writing</span>
              </TabsTrigger>
              <TabsTrigger value="speaking" className="flex items-center gap-2 py-3">
                <Mic className="w-4 h-4" />
                <span className="hidden sm:inline">Speaking</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="reading" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BookOpen className="w-5 h-5 text-primary" />
                    Reading Practice Configuration
                  </CardTitle>
                  <CardDescription>
                    Generate a reading passage with questions tailored to your skill level.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Question Type Selection */}
                  <div className="space-y-3">
                    <Label className="text-base font-medium">Question Type</Label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {READING_QUESTION_TYPES.map((type) => (
                        <SelectableCard
                          key={type.value}
                          isSelected={readingQuestionType === type.value}
                          onClick={() => setReadingQuestionType(type.value)}
                          autoScrollOnSelect
                        >
                          <div className="font-medium pr-6">{type.label}</div>
                          <div className="text-sm text-muted-foreground">{type.description}</div>
                        </SelectableCard>
                      ))}
                    </div>
                  </div>

                  {/* Fixed Configuration Info */}
                  <div className="space-y-4 border-t pt-6">
                    <div className="p-4 rounded-lg bg-muted/50 border">
                      <div className="flex items-start gap-3">
                        <Target className="w-5 h-5 text-primary mt-0.5" />
                        <div>
                          <div className="font-medium text-sm">Test Configuration</div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {READING_PASSAGE_PARAGRAPHS} paragraphs • {FIXED_QUESTION_COUNT} questions
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="listening" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Headphones className="w-5 h-5 text-primary" />
                    Listening Practice Configuration
                  </CardTitle>
                  <CardDescription>
                    Generate audio dialogue with questions tailored to your skill level.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Question Type Selection */}
                  <div className="space-y-3">
                    <Label className="text-base font-medium">Question Type</Label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {LISTENING_QUESTION_TYPES.map((type) => (
                        <SelectableCard
                          key={type.value}
                          isSelected={listeningQuestionType === type.value}
                          onClick={() => setListeningQuestionType(type.value)}
                          autoScrollOnSelect
                        >
                          <div className="font-medium pr-6">{type.label}</div>
                          <div className="text-sm text-muted-foreground">{type.description}</div>
                        </SelectableCard>
                      ))}
                    </div>
                  </div>

                  {/* Monologue Toggle - Only for Fill-in-Blank */}
                  {listeningQuestionType === 'FILL_IN_BLANK' && (
                    <div className="space-y-4 border-t pt-6">
                      <div className="flex items-center justify-between">
                        <Label className="text-base font-medium flex items-center gap-2">
                          <Headphones className="w-4 h-4" />
                          Monologue Mode (IELTS Part 4 Style)
                        </Label>
                        <div 
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${monologueModeEnabled ? 'bg-primary' : 'bg-muted'}`}
                          onClick={() => {
                            setMonologueModeEnabled(!monologueModeEnabled);
                            // Disable spelling mode when monologue is enabled
                            if (!monologueModeEnabled) {
                              setSpellingModeEnabled(false);
                            }
                          }}
                        >
                          <span 
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${monologueModeEnabled ? 'translate-x-6' : 'translate-x-1'}`}
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Single speaker monologue (like a lecture or tour guide). Spelling mode is not available in this mode.
                      </p>
                    </div>
                  )}

                  {/* Fixed Configuration Info */}
                  <div className="space-y-4 border-t pt-6">
                    <div className="p-4 rounded-lg bg-muted/50 border">
                      <div className="flex items-start gap-3">
                        <Settings2 className="w-5 h-5 text-primary mt-0.5" />
                        <div>
                          <div className="font-medium text-sm">Test Configuration</div>
                          <p className="text-xs text-muted-foreground mt-1">
                            4 min audio • {FIXED_QUESTION_COUNT} questions
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Estimated Generation Time */}
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/5 border border-primary/20">
                      <Clock className="w-4 h-4 text-primary" />
                      <span className="text-sm">
                        <span className="text-muted-foreground">Estimated generation time:</span>{' '}
                        <span className="font-medium text-primary">3-4 min</span>
                      </span>
                    </div>
                  </div>

                  {/* IELTS Part 1 Spelling Mode - Only for Fill-in-Blank when NOT in monologue mode */}
                  {listeningQuestionType === 'FILL_IN_BLANK' && !monologueModeEnabled && (
                    <div className="space-y-4 border-t pt-6">
                      <div className="flex items-center justify-between">
                        <Label className="text-base font-medium flex items-center gap-2">
                          <Sparkles className="w-4 h-4" />
                          Spelling Mode (IELTS Part 1 Style)
                        </Label>
                        <div 
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${spellingModeEnabled ? 'bg-primary' : 'bg-muted'}`}
                          onClick={() => setSpellingModeEnabled(!spellingModeEnabled)}
                        >
                          <span 
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${spellingModeEnabled ? 'translate-x-6' : 'translate-x-1'}`}
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Include name/number spelling in dialogues (e.g., "S-H-A-R-M-A", "double seven, five, nine")
                      </p>
                      
                      {spellingModeEnabled && (
                        <div className="space-y-4 p-4 rounded-lg border bg-card">
                          <div className="space-y-2">
                            <Label className="text-xs text-muted-foreground">Test Scenario</Label>
                            <Select value={spellingTestScenario} onValueChange={(v: 'phone_call' | 'hotel_booking' | 'job_inquiry') => setSpellingTestScenario(v)}>
                              <SelectTrigger className="h-9">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="phone_call">Phone Call</SelectItem>
                                <SelectItem value="hotel_booking">Hotel Booking</SelectItem>
                                <SelectItem value="job_inquiry">Job Inquiry</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs text-muted-foreground">Spelling Difficulty</Label>
                            <Select value={spellingDifficulty} onValueChange={(v: 'low' | 'high') => setSpellingDifficulty(v)}>
                              <SelectTrigger className="h-9">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="low">Low (Common names)</SelectItem>
                                <SelectItem value="high">High (Unusual names)</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs text-muted-foreground">Number Format</Label>
                            <Select value={numberFormat} onValueChange={(v: 'phone_number' | 'date' | 'postcode') => setNumberFormat(v)}>
                              <SelectTrigger className="h-9">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="phone_number">Phone Number</SelectItem>
                                <SelectItem value="date">Date</SelectItem>
                                <SelectItem value="postcode">Postcode</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Audio Speed */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-base font-medium">Audio Speed</Label>
                      <span className="text-sm text-muted-foreground">{audioSpeed}x</span>
                    </div>
                    <Slider
                      value={[audioSpeed]}
                      onValueChange={([v]) => setAudioSpeed(v)}
                      min={0.5}
                      max={2.0}
                      step={0.1}
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>0.5x</span>
                      <span>1.0x</span>
                      <span>2.0x</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="writing" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <PenTool className="w-5 h-5 text-primary" />
                    Writing Practice Configuration
                  </CardTitle>
                  <CardDescription>
                    Generate writing tasks with AI evaluation after submission
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Task Type Selection */}
                  <div className="space-y-3">
                    <Label className="text-base font-medium">Task Type</Label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {WRITING_TASK_TYPES.map((type) => (
                        <SelectableCard
                          key={type.value}
                          isSelected={writingTaskType === type.value}
                          onClick={() => setWritingTaskType(type.value)}
                          autoScrollOnSelect
                        >
                          <div className="font-medium pr-6">{type.label}</div>
                          <div className="text-sm text-muted-foreground">{type.description}</div>
                          <Badge variant="secondary" className="mt-2">
                            {type.value === 'FULL_TEST' ? '400+ words' : type.value === 'TASK_1' ? '150+ words' : '250+ words'}
                          </Badge>
                        </SelectableCard>
                      ))}
                    </div>
                  </div>

                  {/* Question Type Dropdowns - only for Task 1 or Task 2 (not Full Test) */}
                  {writingTaskType !== 'FULL_TEST' && (
                    <div className="space-y-4 border-t pt-6">
                      <Label className="text-base font-medium">Question Type</Label>
                      
                      {/* Task 1 Visual Type */}
                      {writingTaskType === 'TASK_1' && (
                        <div className="space-y-2">
                          <Label className="text-sm text-muted-foreground">Visual Type</Label>
                          <Select value={writingTask1VisualType} onValueChange={setWritingTask1VisualType}>
                            <SelectTrigger className="max-w-md">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {WRITING_TASK1_VISUAL_TYPES.map((type) => (
                                <SelectItem key={type.value} value={type.value}>
                                  <div className="flex flex-col">
                                    <span>{type.label}</span>
                                    <span className="text-xs text-muted-foreground">{type.description}</span>
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {/* Task 2 Essay Type */}
                      {writingTaskType === 'TASK_2' && (
                        <div className="space-y-2">
                          <Label className="text-sm text-muted-foreground">Essay Type</Label>
                          <Select value={writingTask2EssayType} onValueChange={setWritingTask2EssayType}>
                            <SelectTrigger className="max-w-md">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {WRITING_TASK2_ESSAY_TYPES.map((type) => (
                                <SelectItem key={type.value} value={type.value}>
                                  <div className="flex flex-col">
                                    <span>{type.label}</span>
                                    <span className="text-xs text-muted-foreground">{type.description}</span>
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Time Configuration */}
                  <div className="space-y-4 border-t pt-6">
                    <div className="flex items-center justify-between">
                      <Label className="text-base font-medium">Test Duration</Label>
                      <Badge variant="outline" className="text-lg font-mono">
                        {writingTimeMinutes} min
                      </Badge>
                    </div>
                    <Slider
                      value={[writingTimeMinutes]}
                      onValueChange={([val]) => setWritingTimeMinutes(val)}
                      min={writingTaskType === 'FULL_TEST' ? 10 : 10}
                      max={writingTaskType === 'FULL_TEST' ? 90 : writingTaskType === 'TASK_1' ? 30 : 60}
                      step={5}
                      className="max-w-md"
                    />
                    <p className="text-sm text-muted-foreground">
                      {writingTaskType === 'FULL_TEST' 
                        ? 'Official time: 60 minutes for both tasks' 
                        : writingTaskType === 'TASK_1'
                        ? 'Official time: 20 minutes'
                        : 'Official time: 40 minutes'}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="speaking" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Mic className="w-5 h-5 text-primary" />
                    AI Speaking Practice Configuration
                  </CardTitle>
                  <CardDescription>
                    Live conversation with AI examiner using Gemini Live Audio
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Test Parts */}
                  <div className="space-y-3">
                    <Label className="text-base font-medium">Test Parts</Label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {SPEAKING_PART_TYPES.map((type) => (
                        <SelectableCard
                          key={type.value}
                          isSelected={speakingPartType === type.value}
                          onClick={() => setSpeakingPartType(type.value)}
                          autoScrollOnSelect
                        >
                          <div className="font-medium pr-6">{type.label}</div>
                          <div className="text-sm text-muted-foreground">{type.description}</div>
                        </SelectableCard>
                      ))}
                    </div>
                  </div>

                  {/* Difficulty affects question complexity */}
                  <div className="p-4 rounded-lg bg-muted/50 border">
                    <div className="flex items-start gap-3">
                      <Brain className="w-5 h-5 text-primary mt-0.5" />
                      <div>
                        <div className="font-medium text-sm">Difficulty-based Question Complexity</div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {difficulty === 'easy' && 'Simple, familiar topics with straightforward questions'}
                          {difficulty === 'medium' && 'Standard IELTS topics with moderately complex follow-ups'}
                          {difficulty === 'hard' && 'Abstract topics requiring sophisticated vocabulary and analysis'}
                          {difficulty === 'expert' && 'Highly abstract, philosophical questions demanding band 8+ responses'}
                        </p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* Common Settings */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings2 className="w-5 h-5" />
                Practice Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Topic Preference with Visual Cards - Hidden for Writing (has visual/essay type selectors) */}
              {activeModule !== 'writing' && (
                <div className="space-y-3">
                  <Label className="text-base font-medium">
                    Topic Preference
                  </Label>
                  
                  {/* Smart Cycle option - shows next topic from round-robin */}
                  <SelectableCard
                    isSelected={!topicPreference}
                    onClick={() => setTopicPreference('')}
                    className="max-w-md"
                  >
                    <div className="flex flex-col gap-1 pr-6">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-primary" />
                        <span className="font-medium">Smart Cycle</span>
                        <span className="text-xs text-muted-foreground">(recommended)</span>
                      </div>
                      {currentSmartCycle.nextTopic && (
                        <div className="text-xs text-muted-foreground ml-6">
                          Next: <span className="text-foreground font-medium">{currentSmartCycle.nextTopic}</span>
                          {currentSmartCycle.cycleCount > 0 && (
                            <span className="ml-1">(Cycle {currentSmartCycle.cycleCount + 1})</span>
                          )}
                        </div>
                      )}
                    </div>
                  </SelectableCard>

                  {/* Topic Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-[300px] overflow-y-auto pr-1">
                    {currentTopics.map((topic) => {
                      const count = currentCompletions.completions[topic] || 0;
                      return (
                        <SelectableCard
                          key={topic}
                          isSelected={topicPreference === topic}
                          onClick={() => setTopicPreference(topic)}
                          autoScrollOnSelect
                          className="py-3"
                        >
                          <div className="flex items-center justify-between gap-2 pr-6">
                            <span className="text-sm font-medium truncate">{topic}</span>
                            {count > 0 && (
                              <Badge variant="secondary" className="shrink-0 text-xs">
                                {count}×
                              </Badge>
                            )}
                          </div>
                        </SelectableCard>
                      );
                    })}
                  </div>

                  {/* Custom topic input - only for Speaking */}
                  {activeModule === 'speaking' && (
                    <div className="flex flex-col gap-2 max-w-md">
                      <Label className="text-sm text-muted-foreground">Or type your own:</Label>
                      <Input
                        id="topic"
                        value={topicPreference}
                        onChange={(e) => setTopicPreference(e.target.value.slice(0, 100))}
                        placeholder="Enter custom topic..."
                        maxLength={100}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Time Setting - Hidden for Listening (audio length determines time) and Writing (has its own time config) */}
              {activeModule !== 'listening' && activeModule !== 'writing' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-base font-medium flex items-center gap-2">
                      <Clock className="w-4 h-4" />
                      Time Limit
                    </Label>
                    <span className="font-medium">{timeMinutes} minutes</span>
                  </div>
                  <Slider
                    value={[timeMinutes]}
                    onValueChange={([v]) => setTimeMinutes(v)}
                    min={2}
                    max={activeModule === 'reading' ? 20 : 10}
                    step={activeModule === 'reading' ? 2 : 1}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>2 min</span>
                    <span>
                      {activeModule === 'reading' 
                        ? `Recommended: ${Math.ceil(readingQuestionCount * 2)} min`
                        : `Recommended: ${Math.min(10, getDefaultTime(questionCount))} min`
                      }
                    </span>
                    <span>{activeModule === 'reading' ? '20 min' : '10 min'}</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Generate Button */}
          <Card className="bg-gradient-to-br from-primary/5 to-accent/5 border-primary/20">
            <CardContent className="py-6">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="text-center sm:text-left">
                  <h3 className="font-bold text-lg mb-1">Ready to Practice?</h3>
                  <p className="text-muted-foreground">
                    {questionCount} {currentQuestionType.replace(/_/g, ' ').toLowerCase()} questions • {activeModule === 'listening' ? `${Math.floor(listeningAudioDuration / 60)} min audio` : `${timeMinutes} minutes`} • {difficulty} difficulty
                  </p>
                </div>
                <Button 
                  size="lg" 
                  className="btn-ai gap-2 min-w-[200px]"
                  onClick={handleGenerate}
                  disabled={!user}
                >
                  <Zap className="w-5 h-5" />
                  Generate Test
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>

      <Footer />
    </div>
  );
}
