import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { Tables } from '@/integrations/supabase/types';
import { renderRichText } from '@/components/admin/RichTextEditor';
import { AddToFlashcardButton } from '@/components/common/AddToFlashcardButton';
import { ModelAnswersAccordion } from '@/components/speaking/ModelAnswersAccordion';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { cn } from '@/lib/utils';
import {
  ArrowLeft,
  Mic,
  MessageSquare,
  Lightbulb,
  CheckCircle2,
  History,
  AlertCircle,
  Volume2,
  FileText,
  BookOpen,
  Loader2,
  RotateCcw,
  Home,
  Sparkles,
  TrendingUp,
  Target,
  ChevronDown,
  ChevronUp,
  ArrowUpRight,
} from 'lucide-react';

type SpeakingTest = Tables<'speaking_tests'>;
type SpeakingSubmission = Tables<'speaking_submissions'>;

interface SpeakingQuestionGroupWithQuestions extends Tables<'speaking_question_groups'> {
  speaking_questions: Array<Tables<'speaking_questions'>>;
}

// Criterion evaluation structure matching AI Speaking
interface CriterionScore {
  band?: number;
  score?: number;
  strengths?: string | string[];
  weaknesses?: string | string[];
  suggestions?: string[];
  suggestions_for_improvement?: string;
  feedback?: string;
}

interface PartByPartAnalysis {
  part1?: { summary?: string; strengths?: string; weaknesses?: string };
  part2?: { topic_coverage?: string; organization_quality?: string; cue_card_fulfillment?: string };
  part3?: { depth_of_discussion?: string; question_notes?: string };
}

interface ModelAnswer {
  partNumber: number;
  question: string;
  candidateResponse?: string;
  modelAnswer?: string; // Legacy single model answer (Band 8+)
  modelAnswerBand7?: string; // New: Band 7 model answer
  modelAnswerBand8?: string; // New: Band 8 model answer
  keyFeatures?: string[];
}

interface LexicalUpgrade {
  original: string;
  upgraded: string;
  context: string;
  type?: 'vocabulary' | 'correction'; // Optional for backward compatibility
}

interface VocabularyUpgrade {
  type: 'vocabulary';
  original: string;
  upgraded: string;
  context: string;
}

interface RecognitionCorrection {
  type: 'correction';
  captured: string;
  intended: string;
  context: string;
}

interface PartAnalysis {
  part_number: number;
  performance_notes: string;
  key_moments: string[];
  areas_for_improvement: string[];
}

interface TranscriptEntry {
  segment_key?: string;
  question_number: number;
  question_text: string;
  transcript: string;
}

interface EvaluationReport {
  fluency_coherence?: CriterionScore;
  lexical_resource?: CriterionScore;
  grammatical_range_accuracy?: CriterionScore;
  grammatical_range?: CriterionScore;
  pronunciation?: CriterionScore;
  part_by_part_analysis?: PartByPartAnalysis;
  improvement_recommendations?: string[];
  improvement_priorities?: string[];
  strengths_to_maintain?: string[];
  examiner_notes?: string;
  raw_response?: string;
  parse_error?: string;
  transcripts?: Record<string, string>;
  transcripts_by_question?: Record<string, TranscriptEntry[]>; // keyed by part number as string
  modelAnswers?: ModelAnswer[];
  lexical_upgrades?: LexicalUpgrade[];
  vocabulary_upgrades?: VocabularyUpgrade[];
  recognition_corrections?: RecognitionCorrection[];
  part_analysis?: PartAnalysis[];
}

// Helper function to round to nearest 0.5
const roundToHalf = (num: number): number => {
  return Math.round(num * 2) / 2;
};

// Normalize criterion to consistent format
const normalizeCriterion = (data: CriterionScore | undefined): {
  score: number;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
} => {
  if (!data) return { score: 0, strengths: [], weaknesses: [], suggestions: [] };
  
  const score = data.band ?? data.score ?? 0;
  const strengths = Array.isArray(data.strengths) ? data.strengths : 
    (typeof data.strengths === 'string' && data.strengths) ? [data.strengths] : [];
  const weaknesses = Array.isArray(data.weaknesses) ? data.weaknesses : 
    (typeof data.weaknesses === 'string' && data.weaknesses) ? [data.weaknesses] : [];
  const suggestions = Array.isArray(data.suggestions) ? data.suggestions : 
    (data.suggestions_for_improvement) ? [data.suggestions_for_improvement] :
    (data.feedback) ? [data.feedback] : [];
  
  return { score, strengths, weaknesses, suggestions };
};

export default function SpeakingEvaluationReport() {
  const { testId, submissionId: urlSubmissionId } = useParams<{ testId: string; submissionId?: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [speakingTest, setSpeakingTest] = useState<SpeakingTest | null>(null);
  const [questionGroups, setQuestionGroups] = useState<SpeakingQuestionGroupWithQuestions[]>([]);
  const [allSubmissions, setAllSubmissions] = useState<SpeakingSubmission[]>([]);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(urlSubmissionId || null);
  const [currentSubmission, setCurrentSubmission] = useState<SpeakingSubmission | null>(null);
  const [expandedParts, setExpandedParts] = useState<Set<number>>(new Set([1, 2, 3]));

  useEffect(() => {
    if (testId && user) {
      fetchEvaluationData();
    } else if (!user) {
      toast.error('You must be logged in to view evaluation reports.');
      navigate('/auth');
    }
  }, [testId, user, navigate]);

  useEffect(() => {
    if (selectedSubmissionId && allSubmissions.length > 0) {
      const submission = allSubmissions.find(s => s.id === selectedSubmissionId);
      if (submission) {
        setCurrentSubmission(submission);
      }
    }
  }, [selectedSubmissionId, allSubmissions]);

  const fetchEvaluationData = async () => {
    setLoading(true);
    try {
      const { data: testData, error: testError } = await supabase
        .from('speaking_tests')
        .select('*')
        .eq('id', testId!)
        .single();

      if (testError) throw testError;
      setSpeakingTest(testData);

      const { data: groupsData, error: groupsError } = await supabase
        .from('speaking_question_groups')
        .select('*, speaking_questions(*)')
        .eq('test_id', testId!)
        .order('part_number')
        .order('order_index', { foreignTable: 'speaking_questions' });

      if (groupsError) throw groupsError;
      setQuestionGroups(groupsData || []);

      if (user) {
        const { data: submissions, error: submissionsError } = await supabase
          .from('speaking_submissions')
          .select('*')
          .eq('user_id', user.id)
          .eq('test_id', testId!)
          .order('submitted_at', { ascending: false });

        if (submissionsError) throw submissionsError;
        
        setAllSubmissions(submissions || []);

        let submissionToDisplay: SpeakingSubmission | null = null;
        if (urlSubmissionId) {
          submissionToDisplay = submissions?.find(s => s.id === urlSubmissionId) || null;
        } else if (submissions && submissions.length > 0) {
          submissionToDisplay = submissions[0];
          setSelectedSubmissionId(submissions[0].id);
        }
        setCurrentSubmission(submissionToDisplay);

        if (!submissionToDisplay) {
          toast.info('No submissions found for this test.');
        }
      }

    } catch (error: any) {
      console.error('Error fetching evaluation data:', error);
      toast.error(`Failed to load evaluation report: ${error.message}`);
      navigate('/speaking/cambridge-ielts-a');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmissionSelect = (submissionId: string) => {
    setSelectedSubmissionId(submissionId);
    navigate(`/speaking/evaluation/${testId}/${submissionId}`);
  };

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

  const evaluationReport = currentSubmission?.evaluation_report as unknown as EvaluationReport | null;
  const overallBand = currentSubmission?.overall_band;

  // Available parts for this test
  const availableParts = useMemo(() => {
    return questionGroups.map(g => g.part_number).filter((v, i, a) => a.indexOf(v) === i).sort();
  }, [questionGroups]);

  // Criteria for display - consistent with AI Speaking Results
  const criteria = useMemo(() => {
    if (!evaluationReport) return [];
    
    return [
      { key: 'fluency_coherence', label: 'Fluency & Coherence', data: normalizeCriterion(evaluationReport.fluency_coherence) },
      { key: 'lexical_resource', label: 'Lexical Resource', data: normalizeCriterion(evaluationReport.lexical_resource) },
      { key: 'grammatical_range', label: 'Grammatical Range & Accuracy', data: normalizeCriterion(evaluationReport.grammatical_range_accuracy || evaluationReport.grammatical_range) },
      { key: 'pronunciation', label: 'Pronunciation', data: normalizeCriterion(evaluationReport.pronunciation) },
    ];
  }, [evaluationReport]);

  // Audio URLs from submission
  const audioUrls = useMemo(() => {
    const urls: Record<string, string> = {};
    if (currentSubmission?.audio_url_part1) urls['part1'] = currentSubmission.audio_url_part1;
    if (currentSubmission?.audio_url_part2) urls['part2'] = currentSubmission.audio_url_part2;
    if (currentSubmission?.audio_url_part3) urls['part3'] = currentSubmission.audio_url_part3;
    return urls;
  }, [currentSubmission]);

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

  if (loading) {
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

  if (!currentSubmission) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Navbar />
        <main className="flex-1 flex items-center justify-center">
          <Card className="max-w-md">
            <CardContent className="py-8 text-center">
              <AlertCircle className="w-12 h-12 text-warning mx-auto mb-4" />
              <h2 className="text-xl font-bold mb-2">No Submission Found</h2>
              <p className="text-muted-foreground mb-4">
                No submission was found for this test.
              </p>
              <Button onClick={() => navigate('/speaking/cambridge-ielts-a')}>
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Speaking Tests
              </Button>
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    );
  }

  if (!evaluationReport) {
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
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Navbar />
      
      <main className="flex-1 py-4 md:py-8">
        <div className="container max-w-5xl mx-auto px-3 md:px-4">
          {/* Header - consistent with AI Speaking Results */}
          <div className="text-center mb-6 md:mb-8">
            <div className="inline-flex items-center gap-2 px-3 md:px-4 py-1.5 md:py-2 rounded-full bg-primary/10 text-primary mb-3 md:mb-4">
              <Sparkles className="w-3 h-3 md:w-4 md:h-4" />
              <span className="text-xs md:text-sm font-medium">AI Speaking Evaluation</span>
            </div>
            <h1 className="text-xl md:text-2xl lg:text-3xl font-bold mb-2">
              {speakingTest?.name || 'Speaking Test Results'}
            </h1>
            <p className="text-sm md:text-base text-muted-foreground">
              Comprehensive analysis based on official IELTS 2025 criteria
            </p>
          </div>

          {/* Submission History Selector */}
          {allSubmissions.length > 1 && (
            <Card className="mb-6">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <History size={18} />
                  Submission History
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Select value={selectedSubmissionId || ''} onValueChange={handleSubmissionSelect}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a past submission" />
                  </SelectTrigger>
                  <SelectContent>
                    {allSubmissions.map((sub, index) => {
                      const bandForAttempt = sub.overall_band !== null && sub.overall_band !== undefined
                        ? roundToHalf(sub.overall_band)
                        : null;

                      return (
                        <SelectItem key={sub.id} value={sub.id}>
                          Attempt {allSubmissions.length - index} - {new Date(sub.submitted_at!).toLocaleString()}
                          {bandForAttempt != null && (
                            <span className="ml-2 text-muted-foreground">
                              (Band {bandForAttempt.toFixed(1)})
                            </span>
                          )}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>
          )}

          {/* Overall Band Score - consistent with AI Speaking Results */}
          <Card className="mb-4 md:mb-6 overflow-hidden">
            <div className="bg-gradient-to-br from-primary/10 to-accent/10 p-4 md:p-8">
              <div className="text-center">
                <Badge className="text-3xl md:text-5xl lg:text-6xl font-bold px-4 md:px-8 py-2 md:py-4 mb-3 md:mb-4 bg-primary/20 text-primary border-primary/30">
                  {(overallBand ?? 0).toFixed(1)}
                </Badge>
                <p className="text-base md:text-lg text-muted-foreground">Overall Band Score</p>
              </div>
              
              {/* Criteria Overview */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mt-6 md:mt-8">
                {criteria.map(({ label, data }) => (
                  <div key={label} className="text-center p-2 md:p-0">
                    <div className={cn("text-lg md:text-2xl font-bold mb-1", getBandColor(data.score || 0))}>
                      {data.score?.toFixed(1) || 'N/A'}
                    </div>
                    <p className="text-[10px] md:text-xs text-muted-foreground leading-tight">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* Tabbed Content - matching AI Speaking Results structure */}
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
                      <Badge className={cn("text-sm md:text-lg font-bold px-2 md:px-3", getBandBg(data.score || 0))}>
                        {data.score?.toFixed(1) || 'N/A'}
                      </Badge>
                    </div>
                    <Progress 
                      value={(data.score || 0) / 9 * 100} 
                      className="h-1.5 md:h-2 mt-2"
                    />
                  </CardHeader>
                  <CardContent className="space-y-3 md:space-y-4 p-3 md:p-6 pt-0 md:pt-0">
                    {/* Strengths */}
                    {data.strengths && data.strengths.length > 0 && (
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
                    {data.weaknesses && data.weaknesses.length > 0 && (
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
                    {data.suggestions && data.suggestions.length > 0 && (
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

            {/* Transcript Tab - matching AI Speaking Results */}
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
                  {availableParts.map((partNum) => {
                    const group = questionGroups.find(g => g.part_number === partNum);
                    const audioUrl = audioUrls[`part${partNum}`];
                    const questions = group?.speaking_questions || [];
                    
                    // Get transcripts from evaluation report
                    const transcriptsForPart: TranscriptEntry[] =
                      (evaluationReport?.transcripts_by_question?.[String(partNum)] as TranscriptEntry[] | undefined) || [];

                    const transcriptByQuestionNumber = new Map<number, TranscriptEntry>();
                    for (const t of transcriptsForPart) {
                      if (typeof t?.question_number === 'number') transcriptByQuestionNumber.set(t.question_number, t);
                    }

                    // Model answers for this part (normalize into a lookup by questionNumber)
                    const modelAnswersForPart = (evaluationReport?.modelAnswers || []).filter(
                      (m) => m.partNumber === partNum,
                    );

                    const modelByQuestionNumber = new Map<number, ModelAnswer>();
                    for (const m of modelAnswersForPart) {
                      if (typeof (m as any)?.questionNumber === 'number') {
                        modelByQuestionNumber.set((m as any).questionNumber, m);
                      }
                    }

                    // Stable fallback ordering when Gemini returns modelAnswers without questionNumber
                    const modelAnswersSorted = modelAnswersForPart
                      .slice()
                      .sort((a, b) => (Number((a as any).questionNumber) || 0) - (Number((b as any).questionNumber) || 0));

                    return (
                      <div key={partNum} className="border rounded-lg p-4 space-y-4">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">Part {partNum}</Badge>
                          {audioUrl && (
                            <Badge variant="secondary" className="text-xs flex items-center gap-1">
                              <Volume2 className="w-3 h-3" />
                              Recording available
                            </Badge>
                          )}
                        </div>

                        {/* Part-level audio */}
                        {audioUrl && (
                          <div className="bg-muted/50 rounded-lg p-3">
                            <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                              <Volume2 className="w-3 h-3" />
                              Part {partNum} Recording
                            </p>
                            <audio controls src={audioUrl} className="w-full h-10" preload="metadata">
                              Your browser does not support audio playback.
                            </audio>
                          </div>
                        )}

                        {/* Per-question transcripts */}
                        <div className="space-y-3">
                          {questions.length > 0 ? (
                            questions.map((question, i) => {
                              const qn = question.question_number;
                              const transcriptEntry = transcriptByQuestionNumber.get(qn);

                              const matchingModel =
                                modelByQuestionNumber.get(qn) ||
                                // fallback to position only AFTER sorting by questionNumber
                                modelAnswersSorted[i];

                              const candidateResponse = matchingModel?.candidateResponse;
                              const transcript = transcriptEntry?.transcript || candidateResponse || '';

                              return (
                                <div key={question.id} className="space-y-2 pb-3 border-b last:border-b-0 last:pb-0">
                                  <p className="text-sm font-medium">
                                    Q{qn}: {question.question_text}
                                  </p>

                                  <div className="pl-3 border-l-2 border-muted">
                                    <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                                      <FileText className="w-3 h-3" />
                                      Transcript:
                                    </p>
                                    <p className="text-sm text-muted-foreground whitespace-pre-line">
                                      {transcript || (
                                        <span className="italic text-muted-foreground/70">
                                          {audioUrl
                                            ? '(Transcript unavailable - listen to the recording above)'
                                            : '(No transcript recorded)'}
                                        </span>
                                      )}
                                    </p>
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <p className="text-sm text-muted-foreground italic">No questions available for this part.</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  
                  <p className="text-xs text-muted-foreground text-center pt-2 border-t">
                    💡 Transcripts are generated by AI. If a transcript is missing, you can still listen to your recording.
                  </p>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Model Answers Tab */}
            <TabsContent value="model" className="mt-4 md:mt-6">
              <ModelAnswersAccordion 
                modelAnswers={evaluationReport.modelAnswers || []} 
                userBandScore={overallBand ?? undefined}
              />
            </TabsContent>

            {/* Lexical Upgrades Tab - NEW FORMAT WITH SEPARATION */}
            <TabsContent value="lexical" className="mt-6 space-y-4">
              {/* Helper function for band label */}
              {(() => {
                const getTargetBandLabel = () => {
                  const band = overallBand ?? 0;
                  if (band >= 7.5) return 'Band 9';
                  if (band >= 7.0) return 'Band 8+';
                  if (band >= 6.0) return 'Band 7+';
                  return 'Band 7+';
                };

                const recognitionCorrections = evaluationReport.recognition_corrections || [];
                const vocabularyUpgrades = evaluationReport.vocabulary_upgrades || [];
                
                // Legacy format support (if no new arrays, use old)
                const legacyUpgrades = evaluationReport.lexical_upgrades || [];
                const hasNewFormat = recognitionCorrections.length > 0 || vocabularyUpgrades.length > 0;

                return (
                  <>
                    {/* Recognition Corrections Section */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <AlertCircle className="w-5 h-5 text-warning" />
                          Speech Recognition Corrections
                        </CardTitle>
                        <CardDescription>
                          Words that may have been misheard by speech recognition
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {recognitionCorrections.length > 0 ? (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b">
                                  <th className="text-left py-3 px-2 font-medium">As Captured</th>
                                  <th className="text-left py-3 px-2 font-medium">Likely Intended</th>
                                  <th className="text-left py-3 px-2 font-medium hidden md:table-cell">Context</th>
                                </tr>
                              </thead>
                              <tbody>
                                {recognitionCorrections.map((correction, i) => (
                                  <tr key={i} className="border-b last:border-0">
                                    <td className="py-3 px-2">
                                      <Badge variant="outline" className="bg-warning/10 text-warning-foreground border-warning/30">
                                        {correction.captured}
                                      </Badge>
                                    </td>
                                    <td className="py-3 px-2">
                                      <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30">
                                        {correction.intended}
                                      </Badge>
                                    </td>
                                    <td className="py-3 px-2 text-muted-foreground italic hidden md:table-cell">
                                      "{correction.context}"
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="text-center py-6 space-y-2">
                            <CheckCircle2 className="w-10 h-10 text-success mx-auto" />
                            <p className="text-sm text-muted-foreground">
                              No recognition errors detected — your speech was clearly captured.
                            </p>
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {/* Vocabulary Upgrades Section */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <ArrowUpRight className="w-5 h-5 text-primary" />
                          Vocabulary Upgrades
                        </CardTitle>
                        <CardDescription>
                          You used these phrases correctly. Here are higher-band alternatives to practice.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {(hasNewFormat && vocabularyUpgrades.length > 0) || (!hasNewFormat && legacyUpgrades.length > 0) ? (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b">
                                  <th className="text-left py-3 px-2 font-medium">Your Phrase</th>
                                  <th className="text-left py-3 px-2 font-medium">{getTargetBandLabel()} Alternative</th>
                                  <th className="text-left py-3 px-2 font-medium hidden md:table-cell">Context</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(hasNewFormat ? vocabularyUpgrades : legacyUpgrades).map((upgrade, i) => (
                                  <tr key={i} className="border-b last:border-0">
                                    <td className="py-3 px-2">
                                      <Badge variant="outline" className="bg-muted text-foreground">
                                        {upgrade.original}
                                      </Badge>
                                    </td>
                                    <td className="py-3 px-2">
                                      <div className="flex items-center gap-2">
                                        <Badge variant="outline" className="bg-success/10 text-success">
                                          {upgrade.upgraded}
                                        </Badge>
                                        <AddToFlashcardButton 
                                          word={upgrade.upgraded}
                                          meaning={`Better alternative to: "${upgrade.original}"`}
                                          example={upgrade.context}
                                          variant="icon"
                                        />
                                      </div>
                                    </td>
                                    <td className="py-3 px-2 text-muted-foreground italic hidden md:table-cell">
                                      "{upgrade.context}"
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="text-center py-6 space-y-2">
                            <Sparkles className="w-10 h-10 text-primary mx-auto" />
                            <p className="text-sm text-muted-foreground">
                              Excellent vocabulary usage!
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Your word choice already demonstrates strong {getTargetBandLabel()} proficiency.
                            </p>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </>
                );
              })()}
            </TabsContent>

            {/* Part-by-Part Analysis Tab */}
            <TabsContent value="parts" className="mt-6 space-y-4">
              {evaluationReport.part_by_part_analysis && (
                <>
                  {evaluationReport.part_by_part_analysis.part1 && (
                    <Card>
                      <CardHeader className="cursor-pointer" onClick={() => togglePart(1)}>
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-lg flex items-center gap-2">
                            <Mic className="w-5 h-5 text-primary" />
                            Part 1: Introduction & Interview
                          </CardTitle>
                          {expandedParts.has(1) ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                        </div>
                      </CardHeader>
                      {expandedParts.has(1) && (
                        <CardContent className="space-y-3">
                          {evaluationReport.part_by_part_analysis.part1.summary && (
                            <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: renderRichText(evaluationReport.part_by_part_analysis.part1.summary) }} />
                          )}
                          {evaluationReport.part_by_part_analysis.part1.strengths && (
                            <div>
                              <p className="font-medium text-sm flex items-center gap-1 text-success"><CheckCircle2 className="w-4 h-4" /> Strengths:</p>
                              <div className="prose prose-sm max-w-none text-muted-foreground" dangerouslySetInnerHTML={{ __html: renderRichText(evaluationReport.part_by_part_analysis.part1.strengths) }} />
                            </div>
                          )}
                          {evaluationReport.part_by_part_analysis.part1.weaknesses && (
                            <div>
                              <p className="font-medium text-sm flex items-center gap-1 text-destructive"><AlertCircle className="w-4 h-4" /> Weaknesses:</p>
                              <div className="prose prose-sm max-w-none text-muted-foreground" dangerouslySetInnerHTML={{ __html: renderRichText(evaluationReport.part_by_part_analysis.part1.weaknesses) }} />
                            </div>
                          )}
                          {audioUrls.part1 && (
                            <div className="pt-3 border-t">
                              <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1"><Volume2 className="w-3 h-3" /> Your Recording</p>
                              <audio controls src={audioUrls.part1} className="w-full" />
                            </div>
                          )}
                        </CardContent>
                      )}
                    </Card>
                  )}

                  {evaluationReport.part_by_part_analysis.part2 && (
                    <Card>
                      <CardHeader className="cursor-pointer" onClick={() => togglePart(2)}>
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-lg flex items-center gap-2">
                            <Mic className="w-5 h-5 text-primary" />
                            Part 2: Individual Long Turn
                          </CardTitle>
                          {expandedParts.has(2) ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                        </div>
                      </CardHeader>
                      {expandedParts.has(2) && (
                        <CardContent className="space-y-3">
                          {evaluationReport.part_by_part_analysis.part2.topic_coverage && (
                            <div>
                              <p className="font-medium text-sm">Topic Coverage:</p>
                              <div className="prose prose-sm max-w-none text-muted-foreground" dangerouslySetInnerHTML={{ __html: renderRichText(evaluationReport.part_by_part_analysis.part2.topic_coverage) }} />
                            </div>
                          )}
                          {evaluationReport.part_by_part_analysis.part2.organization_quality && (
                            <div>
                              <p className="font-medium text-sm">Organization Quality:</p>
                              <div className="prose prose-sm max-w-none text-muted-foreground" dangerouslySetInnerHTML={{ __html: renderRichText(evaluationReport.part_by_part_analysis.part2.organization_quality) }} />
                            </div>
                          )}
                          {evaluationReport.part_by_part_analysis.part2.cue_card_fulfillment && (
                            <div>
                              <p className="font-medium text-sm">Cue Card Fulfillment:</p>
                              <div className="prose prose-sm max-w-none text-muted-foreground" dangerouslySetInnerHTML={{ __html: renderRichText(evaluationReport.part_by_part_analysis.part2.cue_card_fulfillment) }} />
                            </div>
                          )}
                          {audioUrls.part2 && (
                            <div className="pt-3 border-t">
                              <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1"><Volume2 className="w-3 h-3" /> Your Recording</p>
                              <audio controls src={audioUrls.part2} className="w-full" />
                            </div>
                          )}
                        </CardContent>
                      )}
                    </Card>
                  )}

                  {evaluationReport.part_by_part_analysis.part3 && (
                    <Card>
                      <CardHeader className="cursor-pointer" onClick={() => togglePart(3)}>
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-lg flex items-center gap-2">
                            <Mic className="w-5 h-5 text-primary" />
                            Part 3: Two-way Discussion
                          </CardTitle>
                          {expandedParts.has(3) ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                        </div>
                      </CardHeader>
                      {expandedParts.has(3) && (
                        <CardContent className="space-y-3">
                          {evaluationReport.part_by_part_analysis.part3.depth_of_discussion && (
                            <div>
                              <p className="font-medium text-sm">Depth of Discussion:</p>
                              <div className="prose prose-sm max-w-none text-muted-foreground" dangerouslySetInnerHTML={{ __html: renderRichText(evaluationReport.part_by_part_analysis.part3.depth_of_discussion) }} />
                            </div>
                          )}
                          {evaluationReport.part_by_part_analysis.part3.question_notes && (
                            <div>
                              <p className="font-medium text-sm">Question Notes:</p>
                              <div className="prose prose-sm max-w-none text-muted-foreground" dangerouslySetInnerHTML={{ __html: renderRichText(evaluationReport.part_by_part_analysis.part3.question_notes) }} />
                            </div>
                          )}
                          {audioUrls.part3 && (
                            <div className="pt-3 border-t">
                              <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1"><Volume2 className="w-3 h-3" /> Your Recording</p>
                              <audio controls src={audioUrls.part3} className="w-full" />
                            </div>
                          )}
                        </CardContent>
                      )}
                    </Card>
                  )}
                </>
              )}

              {/* Fallback: Use part_analysis if available */}
              {evaluationReport.part_analysis && evaluationReport.part_analysis.length > 0 && !evaluationReport.part_by_part_analysis && (
                evaluationReport.part_analysis.map((part) => (
                  <Card key={part.part_number}>
                    <CardHeader className="cursor-pointer" onClick={() => togglePart(part.part_number)}>
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-lg flex items-center gap-2">
                          <Mic className="w-5 h-5 text-primary" />
                          Part {part.part_number}
                        </CardTitle>
                        {expandedParts.has(part.part_number) ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
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

                        {audioUrls[`part${part.part_number}`] && (
                          <div className="pt-4 border-t">
                            <div className="flex items-center gap-2 mb-2">
                              <Volume2 className="w-4 h-4" />
                              <span className="font-medium text-sm">Your Recording</span>
                            </div>
                            <audio controls className="w-full" src={audioUrls[`part${part.part_number}`]} />
                          </div>
                        )}
                      </CardContent>
                    )}
                  </Card>
                ))
              )}

              {/* If no part analysis at all, show available audio */}
              {!evaluationReport.part_by_part_analysis && (!evaluationReport.part_analysis || evaluationReport.part_analysis.length === 0) && (
                <Card>
                  <CardContent className="py-8 text-center text-muted-foreground">
                    <p>Part-by-part analysis not available for this submission.</p>
                    {Object.keys(audioUrls).length > 0 && (
                      <div className="mt-4 space-y-3">
                        <p className="text-sm">Your recordings:</p>
                        {Object.entries(audioUrls).map(([key, url]) => (
                          <div key={key} className="space-y-1">
                            <p className="text-xs font-medium">{key.replace('part', 'Part ')}</p>
                            <audio controls src={url} className="w-full" />
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            {/* Improvement Priorities Tab */}
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
                  {(evaluationReport.improvement_priorities || evaluationReport.improvement_recommendations)?.length ? (
                    <ol className="space-y-3">
                      {(evaluationReport.improvement_priorities || evaluationReport.improvement_recommendations)?.map((priority, i) => (
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
                  {evaluationReport.strengths_to_maintain && evaluationReport.strengths_to_maintain.length > 0 ? (
                    <ul className="space-y-2">
                      {evaluationReport.strengths_to_maintain.map((strength, i) => (
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
              {evaluationReport.examiner_notes && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <MessageSquare className="w-5 h-5 text-primary" />
                      Examiner Notes
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm italic text-muted-foreground">
                      "{evaluationReport.examiner_notes}"
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* Flashcard Import */}
              <div className="pt-4 border-t border-border/50 flex items-center gap-3">
                <BookOpen size={18} className="text-primary" />
                <span className="text-sm text-muted-foreground">Save key vocabulary from this feedback:</span>
                <AddToFlashcardButton 
                  word=""
                  meaning=""
                  example=""
                  variant="button"
                />
              </div>
            </TabsContent>
          </Tabs>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-3 md:gap-4 justify-center mt-6 md:mt-8 px-2 md:px-0">
            <Button variant="outline" asChild className="w-full sm:w-auto">
              <Link to="/speaking/cambridge-ielts-a">
                <Home className="w-4 h-4 mr-2" />
                Back to Speaking Tests
              </Link>
            </Button>
            <Button asChild className="w-full sm:w-auto">
              <Link to={`/speaking/test/${testId}`}>
                <RotateCcw className="w-4 h-4 mr-2" />
                Retake Test
              </Link>
            </Button>
          </div>
        </div>
      </main>
      
      <Footer />
    </div>
  );
}
