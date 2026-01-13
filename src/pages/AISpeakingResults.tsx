import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { ModelAnswersAccordion } from '@/components/speaking/ModelAnswersAccordion';
import { useSpeakingEvaluationRealtime } from '@/hooks/useSpeakingEvaluationRealtime';
import {
  Mic,
  RotateCcw,
  Home,
  ChevronDown,
  ChevronUp,
  Sparkles,
  TrendingUp,
  ArrowUpRight,
  MessageSquare,
  Target,
  Loader2,
  Volume2,
  CheckCircle2,
  AlertCircle,
  Lightbulb,
  Play,
  Clock,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface CriterionScore {
  score: number;
  feedback?: string;
  examples?: string[];
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
}

interface LexicalUpgrade {
  original: string;
  upgraded: string;
  context: string;
}

interface PartAnalysis {
  part_number: number;
  performance_notes: string;
  key_moments: string[];
  areas_for_improvement: string[];
}

interface ModelAnswer {
  partNumber: number;
  question: string;
  candidateResponse?: string;
  modelAnswer?: string; // Legacy single model answer (Band 8+)
  modelAnswerBand7?: string; // New: Band 7 model answer
  modelAnswerBand8?: string; // New: Band 8 model answer
  keyFeatures: string[];
}

interface TranscriptEntry {
  question_number: number;
  question_text: string;
  transcript: string;
}

interface EvaluationReport {
  overall_band: number;
  overallBand?: number;
  fluency_coherence: CriterionScore;
  fluencyCoherence?: CriterionScore;
  lexical_resource: CriterionScore;
  lexicalResource?: {
    score: number;
    feedback: string;
    examples: string[];
    lexicalUpgrades?: LexicalUpgrade[];
  };
  grammatical_range: CriterionScore;
  grammaticalRange?: CriterionScore;
  pronunciation: CriterionScore;
  lexical_upgrades: LexicalUpgrade[];
  part_analysis: PartAnalysis[];
  partAnalysis?: Array<{ partNumber: number; strengths: string[]; improvements: string[] }>;
  improvement_priorities: string[];
  priorityImprovements?: string[];
  strengths_to_maintain: string[];
  keyStrengths?: string[];
  examiner_notes: string;
  summary?: string;
  modelAnswers?: ModelAnswer[];
}

interface SpeakingResult {
  id: string;
  test_id: string;
  overall_band: number;
  evaluation_report: EvaluationReport | null;
  audio_urls: Record<string, string>;
  candidate_transcripts: {
    by_part: Record<number, string>;
    by_question?: Record<number, TranscriptEntry[]>;
  };
  created_at: string;
}

function normalizeEvaluationReport(raw: any): EvaluationReport {
  const toNumber = (v: any, fallback = 0) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
  };

  const asArray = <T,>(v: any): T[] => (Array.isArray(v) ? v : []);

  const normalizeCriterion = (v: any): CriterionScore => {
    const feedback = typeof v?.feedback === 'string' ? v.feedback : undefined;
    const examples = asArray<string>(v?.examples);

    const strengths = asArray<string>(v?.strengths);
    const weaknesses = asArray<string>(v?.weaknesses ?? v?.errors);
    const suggestions = asArray<string>(v?.suggestions ?? v?.notes);

    return {
      score: toNumber(v?.score, 0),
      feedback,
      examples,
      strengths: strengths.length ? strengths : examples,
      weaknesses,
      suggestions: suggestions.length ? suggestions : feedback ? [feedback] : [],
    };
  };

  const overallBand = toNumber(raw?.overall_band ?? raw?.overallBand, 0);

  const lexicalUpgrades: LexicalUpgrade[] = (() => {
    const direct = raw?.lexical_upgrades;
    const lr = raw?.lexical_resource ?? raw?.lexicalResource;
    const nested = lr?.lexicalUpgrades ?? lr?.lexical_upgrades;
    const list = Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : [];
    return list.map((u: any) => ({
      original: String(u?.original ?? ''),
      upgraded: String(u?.upgraded ?? ''),
      context: String(u?.context ?? ''),
    }));
  })();

  const partAnalysis: PartAnalysis[] = (() => {
    const list = Array.isArray(raw?.part_analysis) ? raw.part_analysis : asArray<any>(raw?.partAnalysis);

    return list.map((p: any) => {
      const partNumber = toNumber(p?.part_number ?? p?.partNumber ?? p?.part_number, 0);
      const keyMoments = asArray<string>(p?.key_moments ?? p?.strengths);
      const areas = asArray<string>(p?.areas_for_improvement ?? p?.improvements);
      const notes = String(p?.performance_notes ?? p?.performanceNotes ?? p?.feedback ?? '');

      return {
        part_number: partNumber,
        performance_notes: notes,
        key_moments: keyMoments,
        areas_for_improvement: areas,
      };
    });
  })();

  const modelAnswers = asArray<ModelAnswer>(raw?.modelAnswers ?? raw?.model_answers);

  return {
    overall_band: overallBand,
    fluency_coherence: normalizeCriterion(raw?.fluency_coherence ?? raw?.fluencyCoherence),
    lexical_resource: normalizeCriterion(raw?.lexical_resource ?? raw?.lexicalResource),
    grammatical_range: normalizeCriterion(raw?.grammatical_range ?? raw?.grammaticalRange),
    pronunciation: normalizeCriterion(raw?.pronunciation),
    lexical_upgrades: lexicalUpgrades,
    part_analysis: partAnalysis,
    improvement_priorities: asArray<string>(raw?.improvement_priorities ?? raw?.priorityImprovements),
    strengths_to_maintain: asArray<string>(raw?.strengths_to_maintain ?? raw?.keyStrengths),
    examiner_notes: String(raw?.examiner_notes ?? raw?.summary ?? ''),
    modelAnswers,
  };
}

function normalizeSpeakingAnswers(raw: any): {
  audioUrls: Record<string, string>;
  transcriptsByPart: Record<number, string>;
  transcriptsByQuestion?: Record<number, TranscriptEntry[]>;
} {
  // New format: { audio_urls, transcripts_by_part, transcripts_by_question }
  const audioUrls: Record<string, string> =
    raw && typeof raw === 'object' && raw.audio_urls && typeof raw.audio_urls === 'object'
      ? (raw.audio_urls as Record<string, string>)
      : {};

  const transcriptsByPart: Record<number, string> =
    raw && typeof raw === 'object' && raw.transcripts_by_part && typeof raw.transcripts_by_part === 'object'
      ? (raw.transcripts_by_part as Record<number, string>)
      : (raw && typeof raw === 'object' ? (raw as Record<number, string>) : {});

  const transcriptsByQuestion =
    raw && typeof raw === 'object' && raw.transcripts_by_question && typeof raw.transcripts_by_question === 'object'
      ? (raw.transcripts_by_question as Record<number, TranscriptEntry[]>)
      : undefined;

  return { audioUrls, transcriptsByPart, transcriptsByQuestion };
}

export default function AISpeakingResults() {
  const { testId } = useParams<{ testId: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [result, setResult] = useState<SpeakingResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [availableParts, setAvailableParts] = useState<number[]>([1, 2, 3]);
  const [expandedParts, setExpandedParts] = useState<Set<number>>(new Set([1, 2, 3]));

  // Realtime subscription for async evaluation
  const {
    jobStatus,
    isWaiting,
    isFailed,
    retryCount,
    lastError,
    isSubscribed,
  } = useSpeakingEvaluationRealtime({
    testId: testId || '',
    onComplete: () => {
      // Reload results when job completes
      loadResults();
    },
    onFailed: (error) => {
      toast.error(`Evaluation failed: ${error}`);
    },
  });

  const loadResults = async () => {
    if (!testId || !user) return;

    // Determine which parts this test actually contains (so we don't render empty Part 2/3 UI).
    const { data: testRow } = await supabase
      .from('ai_practice_tests')
      .select('payload, question_type')
      .eq('id', testId)
      .eq('user_id', user.id)
      .maybeSingle();

    const partsFromPayload = Array.isArray((testRow as any)?.payload?.speakingParts)
      ? (testRow as any).payload.speakingParts
          .map((p: any) => Number(p?.part_number))
          .filter((n: any) => n === 1 || n === 2 || n === 3)
      : [];

    const partsFromType = (() => {
      const qt = String((testRow as any)?.question_type || '');
      if (qt === 'PART_1') return [1];
      if (qt === 'PART_2') return [2];
      if (qt === 'PART_3') return [3];
      return [];
    })();

    const partsToShow = (partsFromPayload.length ? partsFromPayload : partsFromType).length
      ? (partsFromPayload.length ? partsFromPayload : partsFromType)
      : [1, 2, 3];

    setAvailableParts(partsToShow);

    // Try to find the result in ai_practice_results
    const { data, error } = await supabase
      .from('ai_practice_results')
      .select('*')
      .eq('test_id', testId)
      .eq('user_id', user.id)
      .eq('module', 'speaking')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('Failed to load speaking results:', error);
      // Don't navigate away - let the realtime handle it
      return;
    }

    if (data) {
      const report = normalizeEvaluationReport(data.question_results);
      const { audioUrls, transcriptsByPart, transcriptsByQuestion } = normalizeSpeakingAnswers(data.answers);

      setResult({
        id: data.id,
        test_id: data.test_id,
        overall_band: data.band_score || report.overall_band || 0,
        evaluation_report: report,
        audio_urls: audioUrls,
        candidate_transcripts: {
          by_part: transcriptsByPart,
          by_question: transcriptsByQuestion,
        },
        created_at: data.completed_at,
      });
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!testId) {
      navigate('/ai-practice');
      return;
    }

    if (authLoading) return;

    if (!user) {
      toast.error('Please sign in to view your results');
      navigate('/ai-practice');
      return;
    }

    loadResults();
  }, [testId, navigate, user, authLoading]);

  const togglePart = (partNum: number) => {
    setExpandedParts(prev => {
      const next = new Set(prev);
      if (next.has(partNum)) {
        next.delete(partNum);
      } else {
        next.add(partNum);
      }
      return next;
    });
  };

  const getBandColor = (band: number) => {
    if (band >= 7) return 'text-success';
    if (band >= 6) return 'text-warning';
    return 'text-destructive';
  };

  const getBandBg = (band: number) => {
    if (band >= 7) return 'bg-success/20 border-success/30';
    if (band >= 6) return 'bg-warning/20 border-warning/30';
    return 'bg-destructive/20 border-destructive/30';
  };

  // Show async processing state
  if ((loading && !result) || isWaiting) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Navbar />
        <main className="flex-1 flex items-center justify-center p-4">
          <Card className="max-w-md w-full">
            <CardContent className="py-8 text-center">
              <div className="relative mx-auto w-16 h-16 mb-6">
                <div className="absolute inset-0 rounded-full border-4 border-primary/20"></div>
                <div className="absolute inset-0 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
                <Mic className="absolute inset-0 m-auto w-6 h-6 text-primary" />
              </div>
              
              <h2 className="text-xl font-bold mb-2">
                {jobStatus === 'processing' ? 'Analyzing Your Speech...' : 'Preparing Evaluation...'}
              </h2>
              
              <p className="text-muted-foreground mb-4">
                {jobStatus === 'processing' 
                  ? 'AI is evaluating your pronunciation, fluency, and grammar'
                  : 'Your recordings have been submitted successfully'
                }
              </p>

              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground mb-4">
                <Clock className="w-4 h-4" />
                <span>This typically takes 30-60 seconds</span>
              </div>

              {retryCount > 0 && (
                <div className="flex items-center justify-center gap-2 text-sm text-warning">
                  <RefreshCw className="w-4 h-4" />
                  <span>Retry attempt {retryCount}...</span>
                </div>
              )}

              {isSubscribed && (
                <Badge variant="outline" className="mt-4">
                  <span className="w-2 h-2 rounded-full bg-success animate-pulse mr-2"></span>
                  Live updates enabled
                </Badge>
              )}
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  // Show failed state
  if (isFailed) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Navbar />
        <main className="flex-1 flex items-center justify-center p-4">
          <Card className="max-w-md w-full">
            <CardContent className="py-8 text-center">
              <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
              <h2 className="text-xl font-bold mb-2">Evaluation Failed</h2>
              <p className="text-muted-foreground mb-4">
                {lastError || 'We couldn\'t process your evaluation. Please try again.'}
              </p>
              <div className="flex gap-3 justify-center">
                <Button variant="outline" onClick={() => navigate('/ai-practice')}>
                  <Home className="w-4 h-4 mr-2" />
                  Go Back
                </Button>
                <Button onClick={() => window.location.reload()}>
                  <RotateCcw className="w-4 h-4 mr-2" />
                  Retry
                </Button>
              </div>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Navbar />
        <main className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto mb-4" />
            <p className="text-muted-foreground">Loading your speaking evaluation...</p>
          </div>
        </main>
      </div>
    );
  }

  const report = result.evaluation_report;

  if (!report) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Navbar />
        <main className="flex-1 flex items-center justify-center">
          <Card className="max-w-md">
            <CardContent className="py-8 text-center">
              <AlertCircle className="w-12 h-12 text-warning mx-auto mb-4" />
              <h2 className="text-xl font-bold mb-2">Evaluation In Progress</h2>
              <p className="text-muted-foreground mb-4">
                Your speaking test is still being evaluated. Please check back in a few moments.
              </p>
              <Button onClick={() => window.location.reload()}>
                <RotateCcw className="w-4 h-4 mr-2" />
                Refresh
              </Button>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  const criteria = [
    { key: 'fluency_coherence', label: 'Fluency & Coherence', data: report.fluency_coherence },
    { key: 'lexical_resource', label: 'Lexical Resource', data: report.lexical_resource },
    { key: 'grammatical_range', label: 'Grammatical Range & Accuracy', data: report.grammatical_range },
    { key: 'pronunciation', label: 'Pronunciation', data: report.pronunciation },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Navbar />
      
      <main className="flex-1 py-4 md:py-8">
        <div className="container max-w-5xl mx-auto px-3 md:px-4">
          {/* Header */}
          <div className="text-center mb-6 md:mb-8">
            <div className="inline-flex items-center gap-2 px-3 md:px-4 py-1.5 md:py-2 rounded-full bg-primary/10 text-primary mb-3 md:mb-4">
              <Sparkles className="w-3 h-3 md:w-4 md:h-4" />
              <span className="text-xs md:text-sm font-medium">AI Speaking Evaluation</span>
            </div>
            <h1 className="text-xl md:text-2xl lg:text-3xl font-bold mb-2">
              Speaking Test Results
            </h1>
            <p className="text-sm md:text-base text-muted-foreground">
              Comprehensive analysis based on official IELTS 2025 criteria
            </p>
          </div>

          {/* Overall Band Score */}
          <Card className="mb-4 md:mb-6 overflow-hidden">
            <div className="bg-gradient-to-br from-primary/10 to-accent/10 p-4 md:p-8">
              <div className="text-center">
                <Badge className="text-3xl md:text-5xl lg:text-6xl font-bold px-4 md:px-8 py-2 md:py-4 mb-3 md:mb-4 bg-primary/20 text-primary border-primary/30">
                  {report.overall_band.toFixed(1)}
                </Badge>
                <p className="text-base md:text-lg text-muted-foreground">Overall Band Score</p>
              </div>
              
              {/* Criteria Overview */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mt-6 md:mt-8">
                {criteria.map(({ label, data }) => (
                  <div key={label} className="text-center p-2 md:p-0">
                    <div className={cn("text-lg md:text-2xl font-bold mb-1", getBandColor(data?.score || 0))}>
                      {data?.score?.toFixed(1) || 'N/A'}
                    </div>
                    <p className="text-[10px] md:text-xs text-muted-foreground leading-tight">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <Tabs defaultValue="criteria" className="mb-6">
            <TabsList className="w-full overflow-x-auto flex md:grid md:grid-cols-6 h-auto p-1">
              <TabsTrigger value="criteria" className="text-xs md:text-sm px-2 md:px-3 py-1.5 whitespace-nowrap">Criteria</TabsTrigger>
              <TabsTrigger value="transcript" className="text-xs md:text-sm px-2 md:px-3 py-1.5 whitespace-nowrap">Transcript</TabsTrigger>
              <TabsTrigger value="model" className="text-xs md:text-sm px-2 md:px-3 py-1.5 whitespace-nowrap">Model</TabsTrigger>
              <TabsTrigger value="lexical" className="text-xs md:text-sm px-2 md:px-3 py-1.5 whitespace-nowrap">Lexical</TabsTrigger>
              <TabsTrigger value="parts" className="text-xs md:text-sm px-2 md:px-3 py-1.5 whitespace-nowrap">Parts</TabsTrigger>
              <TabsTrigger value="improve" className="text-xs md:text-sm px-2 md:px-3 py-1.5 whitespace-nowrap">Improve</TabsTrigger>
            </TabsList>

            {/* Criteria Breakdown */}
            <TabsContent value="criteria" className="mt-4 md:mt-6 space-y-3 md:space-y-4">
              {criteria.map(({ key, label, data }) => (
                <Card key={key}>
                  <CardHeader className="pb-2 md:pb-3 p-3 md:p-6">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-sm md:text-lg">{label}</CardTitle>
                      <Badge className={cn("text-sm md:text-lg font-bold px-2 md:px-3", getBandBg(data?.score || 0))}>
                        {data?.score?.toFixed(1) || 'N/A'}
                      </Badge>
                    </div>
                    <Progress 
                      value={(data?.score || 0) / 9 * 100} 
                      className="h-1.5 md:h-2 mt-2"
                    />
                  </CardHeader>
                  <CardContent className="space-y-3 md:space-y-4 p-3 md:p-6 pt-0 md:pt-0">
                    {/* Strengths */}
                    {data?.strengths && data.strengths.length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 text-success mb-1.5 md:mb-2">
                          <CheckCircle2 className="w-3 h-3 md:w-4 md:h-4" />
                          <span className="font-medium text-xs md:text-sm">Strengths</span>
                        </div>
                        <ul className="space-y-1 pl-4 md:pl-6">
                          {data.strengths.map((s, i) => (
                            <li key={i} className="text-xs md:text-sm text-muted-foreground list-disc">{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    
                    {/* Weaknesses */}
                    {data?.weaknesses && data.weaknesses.length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 text-destructive mb-1.5 md:mb-2">
                          <AlertCircle className="w-3 h-3 md:w-4 md:h-4" />
                          <span className="font-medium text-xs md:text-sm">Areas to Improve</span>
                        </div>
                        <ul className="space-y-1 pl-4 md:pl-6">
                          {data.weaknesses.map((w, i) => (
                            <li key={i} className="text-xs md:text-sm text-muted-foreground list-disc">{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    
                    {/* Suggestions */}
                    {data?.suggestions && data.suggestions.length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 text-primary mb-1.5 md:mb-2">
                          <Lightbulb className="w-3 h-3 md:w-4 md:h-4" />
                          <span className="font-medium text-xs md:text-sm">Suggestions</span>
                        </div>
                        <ul className="space-y-1 pl-4 md:pl-6">
                          {data.suggestions.map((s, i) => (
                            <li key={i} className="text-xs md:text-sm text-muted-foreground list-disc">{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </TabsContent>

            {/* Model Answers */}
            <TabsContent value="model" className="mt-4 md:mt-6">
              <ModelAnswersAccordion 
                modelAnswers={report.modelAnswers || []} 
                userBandScore={report.overall_band}
              />
            </TabsContent>

            {/* Candidate Transcript with Audio Playback */}
            <TabsContent value="transcript" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <MessageSquare className="w-5 h-5 text-primary" />
                    Your Transcript
                  </CardTitle>
                  <CardDescription>
                    What the app captured from your speech. Listen to your recordings and read the transcript.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {availableParts.map((part) => {
                    const byQuestion = result.candidate_transcripts.by_question?.[part];
                    const byPart = result.candidate_transcripts.by_part?.[part];

                    // Find audio URLs for this part (they follow pattern "partX-qXXX")
                    const partAudioUrls = Object.entries(result.audio_urls).filter(
                      ([key]) => key.startsWith(`part${part}-`)
                    );

                    // Fallback: extract transcripts from modelAnswers if dedicated transcript data is missing
                    const modelAnswersForPart = report.modelAnswers?.filter(m => m.partNumber === part) || [];
                    const hasModelTranscripts = modelAnswersForPart.some(m => m.candidateResponse);

                    // Determine if we have any transcript data for this part
                    const hasQuestionTranscripts = Array.isArray(byQuestion) && byQuestion.length > 0;

                    return (
                      <div key={part} className="border rounded-lg p-4 space-y-4">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">Part {part}</Badge>
                          {partAudioUrls.length > 0 && (
                            <Badge variant="secondary" className="text-xs flex items-center gap-1">
                              <Volume2 className="w-3 h-3" />
                              {partAudioUrls.length} recording{partAudioUrls.length > 1 ? 's' : ''}
                            </Badge>
                          )}
                        </div>

                        {hasQuestionTranscripts ? (
                          // Use per-question transcript data
                          <div className="space-y-4">
                            {byQuestion!.map((q, i) => {
                              const audioUrl = partAudioUrls[i]?.[1] || null;

                              return (
                                <div key={`${q.question_number}-${i}`} className="space-y-2 pb-3 border-b last:border-b-0 last:pb-0">
                                  <p className="text-sm font-medium">Q{q.question_number}: {q.question_text}</p>
                                  
                                  {audioUrl && (
                                    <div className="bg-muted/50 rounded-lg p-2">
                                      <audio
                                        controls
                                        src={audioUrl}
                                        className="w-full h-10"
                                        preload="auto"
                                        crossOrigin="anonymous"
                                      >
                                        Your browser does not support audio playback.
                                      </audio>
                                    </div>
                                  )}
                                  
                                  <div className="pl-3 border-l-2 border-muted">
                                    <p className="text-xs text-muted-foreground mb-1">Transcript:</p>
                                    <p className="text-sm text-muted-foreground whitespace-pre-line">
                                      {q.transcript || (
                                        <span className="italic text-muted-foreground/70">
                                          (Transcript unavailable - listen to the recording above)
                                        </span>
                                      )}
                                    </p>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : hasModelTranscripts ? (
                          // Fallback: use transcripts from Model Answers section
                          <div className="space-y-4">
                            {modelAnswersForPart.map((model, i) => {
                              const audioUrl = partAudioUrls[i]?.[1] || null;

                              return (
                                <div key={`model-${i}`} className="space-y-2 pb-3 border-b last:border-b-0 last:pb-0">
                                  <p className="text-sm font-medium">{model.question}</p>
                                  
                                  {audioUrl && (
                                    <div className="bg-muted/50 rounded-lg p-2">
                                      <audio
                                        controls
                                        src={audioUrl}
                                        className="w-full h-10"
                                        preload="auto"
                                        crossOrigin="anonymous"
                                      >
                                        Your browser does not support audio playback.
                                      </audio>
                                    </div>
                                  )}
                                  
                                  <div className="pl-3 border-l-2 border-muted">
                                    <p className="text-xs text-muted-foreground mb-1">Transcript:</p>
                                    <p className="text-sm text-muted-foreground whitespace-pre-line">
                                      {model.candidateResponse || (
                                        <span className="italic text-muted-foreground/70">
                                          (Transcript unavailable - listen to the recording above)
                                        </span>
                                      )}
                                    </p>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          // Final fallback: show part-level transcript or audio only
                          <div className="space-y-2">
                            {partAudioUrls.length > 0 && (
                              <div className="space-y-2">
                                {partAudioUrls.map(([key, url], i) => (
                                  <div key={key} className="bg-muted/50 rounded-lg p-2">
                                    <p className="text-xs text-muted-foreground mb-1">Recording {i + 1}</p>
                                    <audio
                                      controls
                                      src={url}
                                      className="w-full h-10"
                                      preload="auto"
                                      crossOrigin="anonymous"
                                    >
                                      Your browser does not support audio playback.
                                    </audio>
                                  </div>
                                ))}
                              </div>
                            )}
                            
                            <div className="pl-3 border-l-2 border-muted">
                              <p className="text-xs text-muted-foreground mb-1">Transcript:</p>
                              <p className="text-sm text-muted-foreground whitespace-pre-line">
                                {byPart || (
                                  partAudioUrls.length > 0 ? (
                                    <span className="italic text-muted-foreground/70">
                                      (Transcript unavailable - listen to the recordings above)
                                    </span>
                                  ) : (
                                    '(No response recorded)'
                                  )
                                )}
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  
                  {/* Info note about transcript availability */}
                  <p className="text-xs text-muted-foreground text-center pt-2 border-t">
                    💡 Transcripts are generated by AI. If a transcript is missing, you can still listen to your recording.
                  </p>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Lexical Upgrades Table */}
            <TabsContent value="lexical" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ArrowUpRight className="w-5 h-5 text-primary" />
                    Lexical Upgrade Suggestions
                  </CardTitle>
                  <CardDescription>
                    Replace common words with Band 8+ alternatives
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {report.lexical_upgrades && report.lexical_upgrades.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="text-left py-3 px-2 font-medium">Original Word</th>
                            <th className="text-left py-3 px-2 font-medium">Band 8+ Alternative</th>
                            <th className="text-left py-3 px-2 font-medium">Context</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.lexical_upgrades.map((upgrade, i) => (
                            <tr key={i} className="border-b last:border-0">
                              <td className="py-3 px-2">
                                <Badge variant="outline" className="bg-destructive/10 text-destructive">
                                  {upgrade.original}
                                </Badge>
                              </td>
                              <td className="py-3 px-2">
                                <Badge variant="outline" className="bg-success/10 text-success">
                                  {upgrade.upgraded}
                                </Badge>
                              </td>
                              <td className="py-3 px-2 text-muted-foreground italic">
                                "{upgrade.context}"
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-center py-8">
                      No lexical upgrades suggested - great vocabulary usage!
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Part-by-Part Analysis */}
            <TabsContent value="parts" className="mt-6 space-y-4">
              {report.part_analysis && report.part_analysis
                .filter((p) => availableParts.includes(p.part_number))
                .map((part) => (
                <Card key={part.part_number}>
                  <CardHeader 
                    className="cursor-pointer"
                    onClick={() => togglePart(part.part_number)}
                  >
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg flex items-center gap-2">
                        <Mic className="w-5 h-5 text-primary" />
                        Part {part.part_number}
                      </CardTitle>
                      {expandedParts.has(part.part_number) ? (
                        <ChevronUp className="w-5 h-5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                  </CardHeader>
                  {expandedParts.has(part.part_number) && (
                    <CardContent className="space-y-4">
                      <p className="text-sm">{part.performance_notes}</p>
                      
                      {part.key_moments && part.key_moments.length > 0 && (
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <Target className="w-4 h-4 text-primary" />
                            <span className="font-medium text-sm">Key Moments</span>
                          </div>
                          <ul className="space-y-1 pl-6">
                            {part.key_moments.map((m, i) => (
                              <li key={i} className="text-sm text-muted-foreground list-disc">{m}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      
                      {part.areas_for_improvement && part.areas_for_improvement.length > 0 && (
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <TrendingUp className="w-4 h-4 text-warning" />
                            <span className="font-medium text-sm">Areas for Improvement</span>
                          </div>
                          <ul className="space-y-1 pl-6">
                            {part.areas_for_improvement.map((a, i) => (
                              <li key={i} className="text-sm text-muted-foreground list-disc">{a}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Audio Playback if available */}
                      {result.audio_urls[`part${part.part_number}`] && (
                        <div className="pt-4 border-t">
                          <div className="flex items-center gap-2 mb-2">
                            <Volume2 className="w-4 h-4" />
                            <span className="font-medium text-sm">Your Recording</span>
                          </div>
                          <audio 
                            controls 
                            className="w-full" 
                            src={result.audio_urls[`part${part.part_number}`]} 
                          />
                        </div>
                      )}
                    </CardContent>
                  )}
                </Card>
              ))}
            </TabsContent>

            {/* Improvement Priorities */}
            <TabsContent value="improve" className="mt-6 space-y-4">
              {/* Priorities */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <TrendingUp className="w-5 h-5 text-warning" />
                    Improvement Priorities
                  </CardTitle>
                  <CardDescription>Focus on these areas to boost your band score</CardDescription>
                </CardHeader>
                <CardContent>
                  {report.improvement_priorities && report.improvement_priorities.length > 0 ? (
                    <ol className="space-y-3">
                      {report.improvement_priorities.map((priority, i) => (
                        <li key={i} className="flex items-start gap-3">
                          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-warning/20 text-warning text-sm font-bold flex items-center justify-center">
                            {i + 1}
                          </span>
                          <span className="text-sm">{priority}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-muted-foreground">No specific improvement priorities identified.</p>
                  )}
                </CardContent>
              </Card>

              {/* Strengths to Maintain */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-success" />
                    Strengths to Maintain
                  </CardTitle>
                  <CardDescription>Keep doing these well!</CardDescription>
                </CardHeader>
                <CardContent>
                  {report.strengths_to_maintain && report.strengths_to_maintain.length > 0 ? (
                    <ul className="space-y-2">
                      {report.strengths_to_maintain.map((strength, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm">
                          <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                          <span>{strength}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground">Keep practicing to develop more strengths!</p>
                  )}
                </CardContent>
              </Card>

              {/* Examiner Notes */}
              {report.examiner_notes && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <MessageSquare className="w-5 h-5 text-primary" />
                      Examiner Notes
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm italic text-muted-foreground">
                      "{report.examiner_notes}"
                    </p>
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          </Tabs>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-3 md:gap-4 justify-center mt-6 md:mt-8 px-2 md:px-0">
            <Button variant="outline" asChild className="w-full sm:w-auto">
              <Link to="/ai-practice">
                <Home className="w-4 h-4 mr-2" />
                Back to AI Practice
              </Link>
            </Button>
            {report.modelAnswers && report.modelAnswers.length > 0 && (
              <Button 
                variant="secondary"
                className="w-full sm:w-auto"
                onClick={() => {
                  // Store practice data for re-attempt
                  const practiceData = {
                    testId: result.test_id,
                    modelAnswers: report.modelAnswers,
                    topic: report.examiner_notes || 'Speaking Practice'
                  };
                  sessionStorage.setItem('speaking_practice_mode', JSON.stringify(practiceData));
                  navigate(`/ai-practice/speaking/${result.test_id}?mode=practice`);
                }}
              >
                <Play className="w-4 h-4 mr-2" />
                Practice These Questions
              </Button>
            )}
            <Button asChild className="w-full sm:w-auto">
              <Link to="/ai-practice">
                <RotateCcw className="w-4 h-4 mr-2" />
                New Test
              </Link>
            </Button>
          </div>
        </div>
      </main>
      
      <Footer />
    </div>
  );
}
