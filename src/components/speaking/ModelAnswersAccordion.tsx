import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Sparkles, ArrowUp, CheckCircle2, Lightbulb, Target } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ModelAnswer {
  partNumber: number;
  question: string;
  questionNumber?: number;
  candidateResponse?: string;
  // New format: single targeted model answer
  estimatedBand?: number;
  targetBand?: number;
  modelAnswer?: string;
  whyItWorks?: string[];
  keyImprovements?: string[];
  // Legacy format support
  modelAnswerBand6?: string;
  modelAnswerBand7?: string;
  modelAnswerBand8?: string;
  modelAnswerBand9?: string;
  whyBand6Works?: string[];
  whyBand7Works?: string[];
  whyBand8Works?: string[];
  whyBand9Works?: string[];
  keyFeatures?: string[];
}

interface ModelAnswersAccordionProps {
  modelAnswers: ModelAnswer[];
  userBandScore?: number;
  className?: string;
}

const BAND_CONFIG = {
  6: { label: 'Band 6', color: 'border-orange-500', textColor: 'text-orange-600', bgColor: 'bg-orange-500/10' },
  7: { label: 'Band 7', color: 'border-warning', textColor: 'text-warning', bgColor: 'bg-warning/10' },
  8: { label: 'Band 8', color: 'border-success', textColor: 'text-success', bgColor: 'bg-success/10' },
  9: { label: 'Band 9', color: 'border-primary', textColor: 'text-primary', bgColor: 'bg-primary/10' },
} as const;

type BandLevel = keyof typeof BAND_CONFIG;

function getBandConfig(band: number) {
  const roundedBand = Math.min(9, Math.max(6, Math.round(band))) as BandLevel;
  return BAND_CONFIG[roundedBand] || BAND_CONFIG[7];
}

function QuestionModelAnswer({
  model,
  index,
}: {
  model: ModelAnswer;
  index: number;
}) {
  // Calculate target band from estimatedBand if not provided
  // Target band is one level above estimated: 5.5 -> 6, 6 -> 7, 7 -> 8, etc.
  const calculateTargetBand = (estimated: number): number => {
    if (estimated <= 4.5) return 5;
    if (estimated <= 5.5) return 6;
    if (estimated <= 6.5) return 7;
    if (estimated <= 7.5) return 8;
    return 9;
  };

  // Determine if using new format (has modelAnswer field) or legacy (multiple band answers)
  // Also handle cases where targetBand is missing but estimatedBand exists
  const hasNewFormatAnswer = !!model.modelAnswer && model.modelAnswer.length > 0;
  
  // For legacy format, pick the closest band answer based on estimated or overall score
  const legacyAnswer = useMemo(() => {
    if (hasNewFormatAnswer) return null;
    
    // Try to find any available model answer from legacy format
    if (model.modelAnswerBand7) return { band: 7, answer: model.modelAnswerBand7, why: model.whyBand7Works };
    if (model.modelAnswerBand8) return { band: 8, answer: model.modelAnswerBand8, why: model.whyBand8Works };
    if (model.modelAnswerBand6) return { band: 6, answer: model.modelAnswerBand6, why: model.whyBand6Works };
    if (model.modelAnswerBand9) return { band: 9, answer: model.modelAnswerBand9, why: model.whyBand9Works };
    
    return null;
  }, [model, hasNewFormatAnswer]);

  // Determine target band: use explicit targetBand, or calculate from estimatedBand, or fallback
  const targetBand = hasNewFormatAnswer 
    ? (model.targetBand ?? (model.estimatedBand ? calculateTargetBand(model.estimatedBand) : 7))
    : (legacyAnswer?.band || 7);
  
  const modelAnswerText = hasNewFormatAnswer ? model.modelAnswer! : (legacyAnswer?.answer || '');
  const whyItWorks = hasNewFormatAnswer ? model.whyItWorks : (legacyAnswer?.why || model.keyFeatures);
  const keyImprovements = model.keyImprovements;
  
  const config = getBandConfig(targetBand);

  if (!modelAnswerText) {
    return null;
  }

  return (
    <div className="border rounded-lg p-3 md:p-4 space-y-4">
      {/* Question Header */}
      <div className="flex items-start gap-2">
        <Badge variant="outline" className="text-xs shrink-0">
          Q{model.questionNumber || index + 1}
        </Badge>
        <p className="text-sm font-medium">{model.question}</p>
      </div>
      
      {/* Candidate's Response */}
      {model.candidateResponse && (
        <div className="pl-3 md:pl-4 border-l-2 border-muted">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-[10px] md:text-xs text-muted-foreground">Your response</p>
            {model.estimatedBand && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                ~Band {model.estimatedBand.toFixed(1)}
              </Badge>
            )}
          </div>
          <p className="text-xs md:text-sm italic text-muted-foreground">{model.candidateResponse}</p>
        </div>
      )}
      
      {/* Target Model Answer - The Next Level */}
      <div className={cn(
        "rounded-lg border-l-4 p-3 md:p-4 space-y-3",
        config.color,
        config.bgColor
      )}>
        <div className="flex items-center gap-2">
          <ArrowUp className={cn("w-4 h-4", config.textColor)} />
          <Badge className={cn("text-xs font-bold", config.textColor, config.bgColor, "border", config.color)}>
            {config.label}
          </Badge>
          <span className="text-xs text-muted-foreground">Target Answer</span>
        </div>
        
        <p className="text-sm leading-relaxed">
          {modelAnswerText}
        </p>
        
        {/* Why This Band Works */}
        {whyItWorks && whyItWorks.length > 0 && (
          <div className="pt-2 border-t border-border/50">
            <p className={cn("text-xs font-medium mb-2 flex items-center gap-1", config.textColor)}>
              <Lightbulb className="w-3 h-3" />
              Why this is {config.label}:
            </p>
            <ul className="space-y-1">
              {whyItWorks.map((feature, j) => (
                <li key={j} className="text-xs text-muted-foreground flex items-start gap-2">
                  <CheckCircle2 className={cn("w-3 h-3 flex-shrink-0 mt-0.5", config.textColor)} />
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        )}
        
        {/* Key Improvements to Reach This Level */}
        {keyImprovements && keyImprovements.length > 0 && (
          <div className="pt-2 border-t border-border/50">
            <p className="text-xs font-medium mb-2 flex items-center gap-1 text-primary">
              <Target className="w-3 h-3" />
              To reach this level:
            </p>
            <ul className="space-y-1">
              {keyImprovements.map((improvement, j) => (
                <li key={j} className="text-xs text-muted-foreground flex items-start gap-2">
                  <span className="text-primary">•</span>
                  {improvement}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export function ModelAnswersAccordion({ modelAnswers, userBandScore, className }: ModelAnswersAccordionProps) {
  // Group by part
  const groupedByPart = useMemo(() => {
    const groups: Record<number, ModelAnswer[]> = {};
    modelAnswers.forEach((answer) => {
      if (!groups[answer.partNumber]) {
        groups[answer.partNumber] = [];
      }
      groups[answer.partNumber].push(answer);
    });
    return groups;
  }, [modelAnswers]);

  if (!modelAnswers || modelAnswers.length === 0) {
    return (
      <Card className={className}>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground">No model answers available for this test.</p>
        </CardContent>
      </Card>
    );
  }

  let globalIndex = 0;

  return (
    <Card className={className}>
      <CardHeader className="p-3 md:p-6">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base md:text-lg">
            <Sparkles className="w-4 h-4 md:w-5 md:h-5 text-primary" />
            Model Answers — Your Next Level
          </CardTitle>
          <CardDescription className="text-xs md:text-sm">
            Each model answer shows exactly one band higher than your current level — the next achievable step. 
            {userBandScore && (
              <span className="font-medium text-primary">
                {' '}Your overall score: {userBandScore.toFixed(1)}
              </span>
            )}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-6 p-3 md:p-6 pt-0 md:pt-0">
        {Object.entries(groupedByPart)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([partNum, answers]) => (
            <div key={partNum} className="space-y-4">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs">Part {partNum}</Badge>
                <span className="text-xs text-muted-foreground">
                  {Number(partNum) === 1 ? 'Introduction & Interview' : 
                   Number(partNum) === 2 ? 'Individual Long Turn' : 'Two-way Discussion'}
                </span>
              </div>
              
              {answers.map((model) => {
                const idx = globalIndex;
                globalIndex++;
                return (
                  <QuestionModelAnswer
                    key={`${partNum}-${model.questionNumber || idx}`}
                    model={model}
                    index={idx}
                  />
                );
              })}
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
