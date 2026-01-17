import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

import { useToast } from '@/hooks/use-toast';
import {
  Sparkles,
  RefreshCw,
  Play,
  BookOpen,
  Headphones,
  PenTool,
  Mic,
  TrendingUp,
  Loader2,
  Check,
  AlertCircle,
} from 'lucide-react';
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

interface RecommendationItem {
  module: string;
  questionType: string;
  difficulty: string;
  topic: string;
  count: number;
  priority: number; // Lower = higher priority
}

interface GeneratingState {
  isGenerating: boolean;
  module: string;
  questionType: string;
  topic: string;
  difficulty: string;
}

const MODULE_ICONS: Record<string, any> = {
  reading: BookOpen,
  listening: Headphones,
  writing: PenTool,
  speaking: Mic,
};

const MODULE_COLORS: Record<string, string> = {
  reading: 'bg-blue-500/10 text-blue-600 border-blue-200',
  listening: 'bg-purple-500/10 text-purple-600 border-purple-200',
  writing: 'bg-emerald-500/10 text-emerald-600 border-emerald-200',
  speaking: 'bg-orange-500/10 text-orange-600 border-orange-200',
};

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'bg-success/10 text-success border-success/30',
  medium: 'bg-warning/10 text-warning border-warning/30',
  hard: 'bg-destructive/10 text-destructive border-destructive/30',
};

const MODULES = ['reading', 'listening', 'writing', 'speaking'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

const QUESTION_TYPES: Record<string, string[]> = {
  reading: ['mixed', 'TRUE_FALSE_NOT_GIVEN', 'MULTIPLE_CHOICE_SINGLE', 'MATCHING_HEADINGS', 'SUMMARY_COMPLETION', 'SENTENCE_COMPLETION', 'NOTE_COMPLETION'],
  listening: ['mixed', 'FILL_IN_BLANK', 'MULTIPLE_CHOICE_SINGLE', 'TABLE_COMPLETION', 'MAP_LABELING', 'NOTE_COMPLETION'],
  writing: ['FULL_TEST', 'TASK_1', 'TASK_2'],
  speaking: ['FULL_TEST', 'PART_1', 'PART_2', 'PART_3'],
};

function getTopicsForModule(module: string, questionType?: string): readonly string[] {
  switch (module) {
    case 'reading':
      return READING_TOPICS;
    case 'listening':
      return LISTENING_TOPICS;
    case 'writing':
      if (questionType === 'TASK_1') return WRITING_TASK1_TOPICS;
      if (questionType === 'TASK_2') return WRITING_TASK2_TOPICS;
      return [...WRITING_TASK1_TOPICS, ...WRITING_TASK2_TOPICS];
    case 'speaking':
      switch (questionType) {
        case 'PART_1': return SPEAKING_TOPICS_PART1;
        case 'PART_2': return SPEAKING_TOPICS_PART2;
        case 'PART_3': return SPEAKING_TOPICS_PART3;
        default: return SPEAKING_TOPICS_FULL;
      }
    default:
      return [];
  }
}

export default function TestBankRecommendations() {
  const [allRecommendations, setAllRecommendations] = useState<RecommendationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState<GeneratingState | null>(null);
  const [recentlyGenerated, setRecentlyGenerated] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<string>('reading');
  const { toast } = useToast();

  const fetchRecommendations = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch all ready tests from generated_test_audio
      const { data, error } = await supabase
        .from('generated_test_audio')
        .select('module, question_type, difficulty, topic')
        .eq('status', 'ready');

      if (error) throw error;

      // Aggregate counts by combination
      const countMap = new Map<string, number>();
      (data || []).forEach((item) => {
        const key = `${item.module}|${item.question_type || 'mixed'}|${item.difficulty}|${item.topic}`;
        countMap.set(key, (countMap.get(key) || 0) + 1);
      });

      // Build all possible combinations with counts
      const allCombinations: RecommendationItem[] = [];

      for (const mod of MODULES) {
        const questionTypes = QUESTION_TYPES[mod] || ['mixed'];

        for (const qType of questionTypes) {
          const topics = getTopicsForModule(mod, qType);

          for (const diff of DIFFICULTIES) {
            for (const topic of topics) {
              const key = `${mod}|${qType}|${diff}|${topic}`;
              const count = countMap.get(key) || 0;

              allCombinations.push({
                module: mod,
                questionType: qType,
                difficulty: diff,
                topic: topic,
                count: count,
                priority: count, // Lower count = higher priority
              });
            }
          }
        }
      }

      // Sort by count (ascending) then by module, question type
      allCombinations.sort((a, b) => {
        if (a.count !== b.count) return a.count - b.count;
        if (a.module !== b.module) return a.module.localeCompare(b.module);
        if (a.questionType !== b.questionType) return a.questionType.localeCompare(b.questionType);
        return a.topic.localeCompare(b.topic);
      });

      setAllRecommendations(allCombinations);
    } catch (err) {
      console.error('Error fetching recommendations:', err);
      toast({
        title: 'Error',
        description: 'Failed to load recommendations',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchRecommendations();
  }, [fetchRecommendations]);

  const generateTest = async (item: RecommendationItem) => {
    const key = `${item.module}|${item.questionType}|${item.difficulty}|${item.topic}`;
    
    setGenerating({
      isGenerating: true,
      module: item.module,
      questionType: item.questionType,
      topic: item.topic,
      difficulty: item.difficulty,
    });

    try {
      // Build payload matching TestFactoryAdmin
      const payload: Record<string, unknown> = {
        module: item.module,
        topic: item.topic,
        difficulty: item.difficulty,
        quantity: 1, // Generate 1 test at a time for recommendations
        question_type: item.questionType,
      };

      // Add writing-specific fields
      if (item.module === 'writing') {
        payload.writingTask1VisualType = 'RANDOM';
        payload.writingTask2EssayType = 'RANDOM';
        
        // Random topic selection for writing
        if (item.questionType === 'FULL_TEST') {
          const task1Topic = WRITING_TASK1_TOPICS[Math.floor(Math.random() * WRITING_TASK1_TOPICS.length)];
          const task2Topic = WRITING_TASK2_TOPICS[Math.floor(Math.random() * WRITING_TASK2_TOPICS.length)];
          payload.topic = `${task1Topic} / ${task2Topic}`;
          payload.writingTask1Topic = task1Topic;
          payload.writingTask2Topic = task2Topic;
        } else if (item.questionType === 'TASK_1') {
          payload.topic = WRITING_TASK1_TOPICS[Math.floor(Math.random() * WRITING_TASK1_TOPICS.length)];
        } else {
          payload.topic = WRITING_TASK2_TOPICS[Math.floor(Math.random() * WRITING_TASK2_TOPICS.length)];
        }
      }

      // Add speaking-specific fields
      if (item.module === 'speaking') {
        payload.monologue = false;
      }

      const { data, error } = await supabase.functions.invoke('bulk-generate-tests', {
        body: payload,
      });

      if (error) throw error;

      if ((data as any)?.success) {
        toast({
          title: 'Generation Started!',
          description: `Generating 1 ${item.module} test for "${item.topic}"`,
        });

        // Mark as recently generated
        setRecentlyGenerated((prev) => new Set(prev).add(key));

        // Refresh recommendations after a delay
        setTimeout(() => {
          fetchRecommendations();
        }, 3000);
      } else {
        throw new Error((data as any)?.error || 'Failed to start generation');
      }
    } catch (err: any) {
      console.error('Generation failed:', err);
      toast({
        title: 'Generation Failed',
        description: err.message || 'Could not start test generation',
        variant: 'destructive',
      });
    } finally {
      setGenerating(null);
    }
  };

  const formatQuestionType = (qType: string) => {
    return qType.replace(/_/g, ' ').replace(/FULL TEST/gi, 'Full Test');
  };

  // Get recommendations filtered by module, with MIXED question types
  // Prioritize diversity: 1 of each question type before repeating
  const getModuleRecommendations = (module: string) => {
    const moduleRecs = allRecommendations.filter((r) => r.module === module);
    const questionTypes = QUESTION_TYPES[module] || ['mixed'];
    
    // Group by question type
    const byType = new Map<string, RecommendationItem[]>();
    questionTypes.forEach((qt) => byType.set(qt, []));
    
    moduleRecs.forEach((rec) => {
      const existing = byType.get(rec.questionType);
      if (existing) {
        existing.push(rec);
      } else {
        byType.set(rec.questionType, [rec]);
      }
    });
    
    // Round-robin pick: take 1 from each question type in order until we have 10
    const result: RecommendationItem[] = [];
    let typeIndex = 0;
    const maxIterations = moduleRecs.length; // Safety limit
    let iterations = 0;
    
    while (result.length < 10 && iterations < maxIterations) {
      const qt = questionTypes[typeIndex % questionTypes.length];
      const pool = byType.get(qt);
      
      if (pool && pool.length > 0) {
        // Take the first (lowest count) item from this type
        const item = pool.shift()!;
        result.push(item);
      }
      
      typeIndex++;
      iterations++;
    }
    
    return result;
  };

  const renderRecommendationsList = (recommendations: RecommendationItem[]) => {
    if (recommendations.length === 0) {
      return (
        <div className="text-center py-8 text-muted-foreground">
          <Check className="w-12 h-12 mx-auto mb-4 text-success" />
          <p>Great coverage! All combinations have tests.</p>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {recommendations.map((item, idx) => {
          const key = `${item.module}|${item.questionType}|${item.difficulty}|${item.topic}`;
          const isGenerating = generating?.module === item.module &&
            generating?.questionType === item.questionType &&
            generating?.topic === item.topic &&
            generating?.difficulty === item.difficulty;
          const wasRecentlyGenerated = recentlyGenerated.has(key);
          const ModuleIcon = MODULE_ICONS[item.module] || BookOpen;

          return (
            <div
              key={idx}
              className={`flex items-center justify-between p-4 border rounded-lg transition-all ${
                wasRecentlyGenerated
                  ? 'bg-success/5 border-success/30'
                  : 'hover:bg-muted/50'
              }`}
            >
              <div className="flex items-center gap-3 flex-1">
                {/* Priority indicator */}
                <div className="flex flex-col items-center">
                  <span className="text-lg font-bold text-muted-foreground">#{idx + 1}</span>
                  {item.count === 0 && (
                    <AlertCircle className="w-4 h-4 text-destructive mt-1" />
                  )}
                </div>

                {/* Module icon */}
                <div className={`p-2 rounded-lg ${MODULE_COLORS[item.module]}`}>
                  <ModuleIcon className="w-4 h-4" />
                </div>

                {/* Details */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary" className="text-xs">
                      {formatQuestionType(item.questionType)}
                    </Badge>
                    <Badge variant="outline" className={DIFFICULTY_COLORS[item.difficulty]}>
                      {item.difficulty}
                    </Badge>
                  </div>
                  <span className="text-sm text-muted-foreground truncate max-w-[300px]">
                    {item.topic}
                  </span>
                </div>
              </div>

              {/* Count & Generate button */}
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="text-2xl font-bold">{item.count}</div>
                  <div className="text-xs text-muted-foreground">tests</div>
                </div>

                <Button
                  onClick={() => generateTest(item)}
                  disabled={isGenerating || !!generating}
                  className="min-w-[120px]"
                  variant={item.count === 0 ? 'default' : 'outline'}
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : wasRecentlyGenerated ? (
                    <>
                      <Check className="w-4 h-4 mr-2" />
                      Queued
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 mr-2" />
                      Generate 1
                    </>
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // Calculate stats per module
  const getModuleStats = (module: string) => {
    const moduleRecs = allRecommendations.filter((r) => r.module === module);
    const zeroCount = moduleRecs.filter((r) => r.count === 0).length;
    const lowCount = moduleRecs.filter((r) => r.count > 0 && r.count < 3).length;
    return { zeroCount, lowCount, total: moduleRecs.length };
  };

  return (
    <Card className="border-0 shadow-lg">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-gradient-to-br from-primary to-accent">
              <Sparkles className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-primary" />
                Smart Recommendations
              </CardTitle>
              <CardDescription>
                Tests with the lowest coverage per module. Generate with one click!
              </CardDescription>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={fetchRecommendations} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />
            ))}
          </div>
        ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-4 mb-6">
              <TabsTrigger value="reading" className="flex items-center gap-2">
                <BookOpen className="w-4 h-4" />
                <span className="hidden sm:inline">Reading</span>
                <Badge variant="secondary" className="ml-1 text-xs">
                  {getModuleStats('reading').zeroCount}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="listening" className="flex items-center gap-2">
                <Headphones className="w-4 h-4" />
                <span className="hidden sm:inline">Listening</span>
                <Badge variant="secondary" className="ml-1 text-xs">
                  {getModuleStats('listening').zeroCount}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="writing" className="flex items-center gap-2">
                <PenTool className="w-4 h-4" />
                <span className="hidden sm:inline">Writing</span>
                <Badge variant="secondary" className="ml-1 text-xs">
                  {getModuleStats('writing').zeroCount}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="speaking" className="flex items-center gap-2">
                <Mic className="w-4 h-4" />
                <span className="hidden sm:inline">Speaking</span>
                <Badge variant="secondary" className="ml-1 text-xs">
                  {getModuleStats('speaking').zeroCount}
                </Badge>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="reading">
              {renderRecommendationsList(getModuleRecommendations('reading'))}
            </TabsContent>
            <TabsContent value="listening">
              {renderRecommendationsList(getModuleRecommendations('listening'))}
            </TabsContent>
            <TabsContent value="writing">
              {renderRecommendationsList(getModuleRecommendations('writing'))}
            </TabsContent>
            <TabsContent value="speaking">
              {renderRecommendationsList(getModuleRecommendations('speaking'))}
            </TabsContent>
          </Tabs>
        )}

        {/* Footer stats */}
        {!loading && (
          <div className="mt-6 p-4 bg-muted/50 rounded-lg">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Showing top 10 recommendations per module based on lowest test counts
              </span>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-destructive/10 text-destructive">
                  {getModuleStats(activeTab).zeroCount} with 0 tests
                </Badge>
                <Badge variant="outline" className="bg-warning/10 text-warning">
                  {getModuleStats(activeTab).lowCount} with 1-2 tests
                </Badge>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
