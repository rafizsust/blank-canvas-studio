import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { AlertTriangle, CheckCircle2, Target, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  READING_TOPICS,
  LISTENING_TOPICS,
  WRITING_TASK1_TOPICS,
  WRITING_TASK2_TOPICS,
  SPEAKING_TOPICS_FULL,
} from '@/lib/ieltsTopics';

interface CoverageData {
  module: string;
  questionType: string;
  difficulty: string;
  topic: string;
  count: number;
}

interface GapItem {
  module: string;
  questionType: string;
  difficulty: string;
  topic: string;
  existingCount: number;
}

const MODULES = ['reading', 'listening', 'writing', 'speaking'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

const QUESTION_TYPES: Record<string, string[]> = {
  reading: ['mixed', 'TRUE_FALSE_NOT_GIVEN', 'MULTIPLE_CHOICE_SINGLE', 'MATCHING_HEADINGS', 'SUMMARY_COMPLETION'],
  listening: ['mixed', 'FILL_IN_BLANK', 'MULTIPLE_CHOICE_SINGLE', 'TABLE_COMPLETION', 'MAP_LABELING'],
  writing: ['FULL_TEST', 'TASK_1', 'TASK_2'],
  speaking: ['FULL_TEST', 'PART_1', 'PART_2', 'PART_3'],
};

function getTopicsForModule(module: string): readonly string[] {
  switch (module) {
    case 'reading': return READING_TOPICS;
    case 'listening': return LISTENING_TOPICS;
    case 'writing': return [...WRITING_TASK1_TOPICS, ...WRITING_TASK2_TOPICS];
    case 'speaking': return SPEAKING_TOPICS_FULL;
    default: return [];
  }
}

export default function PresetCoverageGaps() {
  const [selectedModule, setSelectedModule] = useState<string>('all');
  const [coverageData, setCoverageData] = useState<CoverageData[]>([]);
  const [gaps, setGaps] = useState<GapItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchCoverage = async () => {
    setLoading(true);
    try {
      // Fetch all published presets from generated_test_audio
      const { data, error } = await supabase
        .from('generated_test_audio')
        .select('module, question_type, difficulty, topic')
        .eq('is_published', true)
        .eq('status', 'ready');

      if (error) throw error;

      // Aggregate counts
      const countMap = new Map<string, CoverageData>();
      (data || []).forEach((item) => {
        const key = `${item.module}|${item.question_type || 'mixed'}|${item.difficulty}|${item.topic}`;
        const existing = countMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          countMap.set(key, {
            module: item.module,
            questionType: item.question_type || 'mixed',
            difficulty: item.difficulty,
            topic: item.topic,
            count: 1,
          });
        }
      });

      setCoverageData(Array.from(countMap.values()));

      // Calculate gaps
      const gapsList: GapItem[] = [];
      const modulesToCheck = selectedModule === 'all' ? MODULES : [selectedModule];

      for (const mod of modulesToCheck) {
        const topics = getTopicsForModule(mod);
        const questionTypes = QUESTION_TYPES[mod] || ['mixed'];

        for (const qType of questionTypes) {
          for (const diff of DIFFICULTIES) {
            for (const topic of topics) {
              const key = `${mod}|${qType}|${diff}|${topic}`;
              const existing = countMap.get(key);
              if (!existing || existing.count < 1) {
                gapsList.push({
                  module: mod,
                  questionType: qType,
                  difficulty: diff,
                  topic: topic,
                  existingCount: existing?.count || 0,
                });
              }
            }
          }
        }
      }

      // Sort gaps by module, then by topic
      gapsList.sort((a, b) => {
        if (a.module !== b.module) return a.module.localeCompare(b.module);
        if (a.difficulty !== b.difficulty) return a.difficulty.localeCompare(b.difficulty);
        return a.topic.localeCompare(b.topic);
      });

      setGaps(gapsList.slice(0, 50)); // Show top 50 gaps
    } catch (err) {
      console.error('Error fetching coverage:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCoverage();
  }, [selectedModule]);

  // Calculate coverage stats
  const totalPresets = coverageData.length;
  const modulesToCheck = selectedModule === 'all' ? MODULES : [selectedModule];
  let totalPossible = 0;
  for (const mod of modulesToCheck) {
    const topics = getTopicsForModule(mod);
    const qTypes = QUESTION_TYPES[mod] || ['mixed'];
    totalPossible += topics.length * qTypes.length * DIFFICULTIES.length;
  }
  const coveragePercent = totalPossible > 0 ? Math.round((totalPresets / totalPossible) * 100) : 0;

  const getModuleColor = (mod: string) => {
    switch (mod) {
      case 'reading': return 'bg-blue-500/10 text-blue-600 border-blue-200';
      case 'listening': return 'bg-purple-500/10 text-purple-600 border-purple-200';
      case 'writing': return 'bg-emerald-500/10 text-emerald-600 border-emerald-200';
      case 'speaking': return 'bg-orange-500/10 text-orange-600 border-orange-200';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const getDifficultyColor = (diff: string) => {
    switch (diff) {
      case 'easy': return 'bg-green-100 text-green-700';
      case 'medium': return 'bg-yellow-100 text-yellow-700';
      case 'hard': return 'bg-red-100 text-red-700';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  return (
    <Card className="border-0 shadow-lg">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" />
            <CardTitle>Preset Coverage Gaps</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Select value={selectedModule} onValueChange={setSelectedModule}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Modules</SelectItem>
                <SelectItem value="reading">Reading</SelectItem>
                <SelectItem value="listening">Listening</SelectItem>
                <SelectItem value="writing">Writing</SelectItem>
                <SelectItem value="speaking">Speaking</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" onClick={fetchCoverage} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
        <CardDescription>
          Identify missing presets to generate next. Shows combinations of module + question type + difficulty + topic without published presets.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Coverage Summary */}
        <div className="mb-6 p-4 bg-muted/50 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Overall Coverage</span>
            <span className="text-sm text-muted-foreground">{totalPresets} / {totalPossible} combinations</span>
          </div>
          <Progress value={coveragePercent} className="h-2" />
          <div className="flex items-center gap-2 mt-2">
            {coveragePercent >= 80 ? (
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            )}
            <span className="text-sm">{coveragePercent}% coverage</span>
          </div>
        </div>

        {/* Gaps List */}
        {loading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 bg-muted animate-pulse rounded" />
            ))}
          </div>
        ) : gaps.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-12 w-12 mx-auto mb-2 text-green-500" />
            <p>Great coverage! No major gaps found.</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {gaps.map((gap, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={getModuleColor(gap.module)}>
                    {gap.module}
                  </Badge>
                  <Badge variant="secondary" className="text-xs">
                    {gap.questionType.replace(/_/g, ' ')}
                  </Badge>
                  <Badge className={getDifficultyColor(gap.difficulty)}>
                    {gap.difficulty}
                  </Badge>
                </div>
                <span className="text-sm text-muted-foreground truncate max-w-[200px]" title={gap.topic}>
                  {gap.topic}
                </span>
              </div>
            ))}
          </div>
        )}

        {gaps.length > 0 && (
          <p className="text-xs text-muted-foreground mt-4">
            Showing top 50 gaps. Generate presets via the Test Factory to fill these gaps.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
