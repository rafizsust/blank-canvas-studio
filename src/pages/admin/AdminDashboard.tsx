import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BookOpen, FileText, TrendingUp, Headphones, PenTool, Mic, Brain, Sparkles, Factory } from 'lucide-react';
import ModelHealthOverviewCard from '@/components/admin/ModelHealthOverviewCard';

interface Stats {
  readingTests: number;
  listeningTests: number;
  writingTests: number;
  speakingTests: number;
  totalPassages: number;
  totalQuestions: number;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats>({
    readingTests: 0,
    listeningTests: 0,
    writingTests: 0,
    speakingTests: 0,
    totalPassages: 0,
    totalQuestions: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const [
        readingRes,
        listeningRes,
        writingRes,
        speakingRes,
        passagesRes,
        questionsRes
      ] = await Promise.all([
        supabase.from('reading_tests').select('id', { count: 'exact', head: true }),
        supabase.from('listening_tests').select('id', { count: 'exact', head: true }),
        supabase.from('writing_tests').select('id', { count: 'exact', head: true }),
        supabase.from('speaking_tests').select('id', { count: 'exact', head: true }),
        supabase.from('reading_passages').select('id', { count: 'exact', head: true }),
        supabase.from('reading_questions').select('id', { count: 'exact', head: true }),
      ]);

      setStats({
        readingTests: readingRes.count || 0,
        listeningTests: listeningRes.count || 0,
        writingTests: writingRes.count || 0,
        speakingTests: speakingRes.count || 0,
        totalPassages: passagesRes.count || 0,
        totalQuestions: questionsRes.count || 0,
      });
    } catch (error) {
      console.error('Error fetching stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const statCards = [
    { label: 'Reading Tests', value: stats.readingTests, icon: BookOpen, color: 'from-blue-500 to-blue-600', bgColor: 'bg-blue-500/10' },
    { label: 'Listening Tests', value: stats.listeningTests, icon: Headphones, color: 'from-purple-500 to-purple-600', bgColor: 'bg-purple-500/10' },
    { label: 'Writing Tests', value: stats.writingTests, icon: PenTool, color: 'from-emerald-500 to-emerald-600', bgColor: 'bg-emerald-500/10' },
    { label: 'Speaking Tests', value: stats.speakingTests, icon: Mic, color: 'from-orange-500 to-orange-600', bgColor: 'bg-orange-500/10' },
    { label: 'Total Passages', value: stats.totalPassages, icon: FileText, color: 'from-teal-500 to-teal-600', bgColor: 'bg-teal-500/10' },
    { label: 'Total Questions', value: stats.totalQuestions, icon: TrendingUp, color: 'from-rose-500 to-rose-600', bgColor: 'bg-rose-500/10' },
  ];

  return (
    <div className="p-6 bg-gradient-to-br from-background via-background to-primary/5 min-h-full">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-xl bg-gradient-to-br from-primary to-accent">
            <Brain className="w-6 h-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-bold font-heading bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text">
              IELTS AI Admin
            </h1>
            <p className="text-muted-foreground">Manage your IELTS test content</p>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        {statCards.map((stat) => (
          <Card key={stat.label} className="relative border-0 shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 overflow-hidden">
            <div className={`absolute inset-0 bg-gradient-to-br ${stat.color} opacity-5`} />
            <CardHeader className="flex flex-row items-center justify-between pb-2 relative">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.label}
              </CardTitle>
              <div className={`p-2 rounded-lg ${stat.bgColor}`}>
                <stat.icon className={`h-5 w-5 bg-gradient-to-br ${stat.color} bg-clip-text`} style={{ color: stat.color.includes('blue') ? '#3b82f6' : stat.color.includes('purple') ? '#a855f7' : stat.color.includes('emerald') ? '#10b981' : stat.color.includes('orange') ? '#f97316' : stat.color.includes('teal') ? '#14b8a6' : '#f43f5e' }} />
              </div>
            </CardHeader>
            <CardContent className="relative">
              <div className="text-4xl font-bold">
                {loading ? (
                  <div className="h-10 w-20 bg-muted animate-pulse rounded" />
                ) : (
                  stat.value
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Model Health Overview */}
      <ModelHealthOverviewCard />

      {/* Quick Actions */}
      <Card className="border-0 shadow-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="text-primary" />
            Quick Actions
          </CardTitle>
          <CardDescription>Common tasks for content management</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Link to="/admin/reading" className="p-4 rounded-xl border bg-card hover:bg-muted/50 transition-colors text-center group">
              <BookOpen className="w-8 h-8 mx-auto mb-2 text-blue-500 group-hover:scale-110 transition-transform" />
              <p className="font-medium text-sm">Manage Reading</p>
            </Link>
            <Link to="/admin/listening" className="p-4 rounded-xl border bg-card hover:bg-muted/50 transition-colors text-center group">
              <Headphones className="w-8 h-8 mx-auto mb-2 text-purple-500 group-hover:scale-110 transition-transform" />
              <p className="font-medium text-sm">Manage Listening</p>
            </Link>
            <Link to="/admin/writing" className="p-4 rounded-xl border bg-card hover:bg-muted/50 transition-colors text-center group">
              <PenTool className="w-8 h-8 mx-auto mb-2 text-emerald-500 group-hover:scale-110 transition-transform" />
              <p className="font-medium text-sm">Manage Writing</p>
            </Link>
            <Link to="/admin/speaking" className="p-4 rounded-xl border bg-card hover:bg-muted/50 transition-colors text-center group">
              <Mic className="w-8 h-8 mx-auto mb-2 text-orange-500 group-hover:scale-110 transition-transform" />
              <p className="font-medium text-sm">Manage Speaking</p>
            </Link>
            <Link to="/admin/test-factory" className="p-4 rounded-xl border bg-card hover:bg-muted/50 transition-colors text-center group col-span-2 md:col-span-4 bg-gradient-to-r from-primary/5 to-accent/5">
              <Factory className="w-8 h-8 mx-auto mb-2 text-primary group-hover:scale-110 transition-transform" />
              <p className="font-medium text-sm">Test Factory</p>
              <p className="text-xs text-muted-foreground mt-1">Bulk generate tests with audio</p>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}