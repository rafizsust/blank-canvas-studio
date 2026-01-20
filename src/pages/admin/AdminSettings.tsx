import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Key, 
  Plus, 
  Trash2, 
  RefreshCw, 
  Settings, 
  CheckCircle,
  Eye,
  EyeOff,
  Gauge,
  BarChart3,
  Zap
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import ApiKeyQuotaDashboard from '@/components/admin/ApiKeyQuotaDashboard';
import ModelPerformanceAnalytics from '@/components/admin/ModelPerformanceAnalytics';

interface ApiKey {
  id: string;
  provider: string;
  key_value: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  tts_quota_exhausted: boolean | null;
  tts_quota_exhausted_date: string | null;
  flash_2_5_quota_exhausted: boolean | null;
  flash_2_5_quota_exhausted_date: string | null;
  flash_lite_quota_exhausted: boolean | null;
  flash_lite_quota_exhausted_date: string | null;
  pro_3_0_quota_exhausted: boolean | null;
  pro_3_0_quota_exhausted_date: string | null;
  exp_pro_quota_exhausted: boolean | null;
  exp_pro_quota_exhausted_date: string | null;
  // Groq-specific
  groq_whisper_exhausted?: boolean | null;
  groq_whisper_exhausted_date?: string | null;
  groq_llama_exhausted?: boolean | null;
  groq_llama_exhausted_date?: string | null;
  groq_ash_used_this_hour?: number | null;
  groq_ash_reset_at?: string | null;
  groq_rpm_cooldown_until?: string | null;
}

interface ProviderSettings {
  provider: 'gemini' | 'groq';
  groq_stt_model: string;
  groq_llm_model: string;
  gemini_model: string;
  auto_fallback_enabled: boolean;
}

export default function AdminSettings() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [groqApiKeys, setGroqApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyValue, setNewKeyValue] = useState('');
  const [newGroqKeyValue, setNewGroqKeyValue] = useState('');
  const [showNewKey, setShowNewKey] = useState(false);
  const [showNewGroqKey, setShowNewGroqKey] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addGroqDialogOpen, setAddGroqDialogOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>({
    provider: 'gemini',
    groq_stt_model: 'whisper-large-v3-turbo',
    groq_llm_model: 'llama-3.3-70b-versatile',
    gemini_model: 'gemini-2.5-flash',
    auto_fallback_enabled: true,
  });
  const [savingProvider, setSavingProvider] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetchApiKeys();
    fetchGroqApiKeys();
    fetchProviderSettings();
  }, []);

  const fetchApiKeys = async () => {
    try {
      const { data, error } = await supabase
        .from('api_keys')
        .select('*')
        .eq('provider', 'gemini')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setApiKeys(data || []);
    } catch (error) {
      console.error('Error fetching API keys:', error);
      toast({
        title: 'Error',
        description: 'Failed to load API keys',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const fetchGroqApiKeys = async () => {
    try {
      const { data, error } = await supabase
        .from('api_keys')
        .select('*')
        .eq('provider', 'groq')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setGroqApiKeys(data || []);
    } catch (error) {
      console.error('Error fetching Groq API keys:', error);
    }
  };

  const fetchProviderSettings = async () => {
    try {
      // Use raw query since table may not exist yet
      const { data, error } = await supabase
        .from('speaking_evaluation_settings' as any)
        .select('*')
        .limit(1)
        .maybeSingle();

      if (error) {
        console.log('Provider settings table may not exist yet:', error.message);
        return;
      }
      
      if (data) {
        const settingsData = data as any;
        setProviderSettings({
          provider: settingsData.provider as 'gemini' | 'groq',
          groq_stt_model: settingsData.groq_stt_model || 'whisper-large-v3-turbo',
          groq_llm_model: settingsData.groq_llm_model || 'llama-3.3-70b-versatile',
          gemini_model: settingsData.gemini_model || 'gemini-2.5-flash',
          auto_fallback_enabled: settingsData.auto_fallback_enabled ?? true,
        });
      }
    } catch (error) {
      console.error('Error fetching provider settings:', error);
    }
  };

  const saveProviderSettings = async (newSettings: Partial<ProviderSettings>) => {
    setSavingProvider(true);
    try {
      const updatedSettings = { ...providerSettings, ...newSettings };
      
      const { error } = await supabase
        .from('speaking_evaluation_settings' as any)
        .upsert({
          id: crypto.randomUUID(),
          provider: updatedSettings.provider,
          groq_stt_model: updatedSettings.groq_stt_model,
          groq_llm_model: updatedSettings.groq_llm_model,
          gemini_model: updatedSettings.gemini_model,
          auto_fallback_enabled: updatedSettings.auto_fallback_enabled,
          updated_at: new Date().toISOString(),
        });

      if (error) throw error;

      setProviderSettings(updatedSettings);
      toast({
        title: 'Success',
        description: `Provider switched to ${updatedSettings.provider === 'groq' ? 'Groq (Whisper + Llama)' : 'Gemini'}`,
      });
    } catch (error: any) {
      console.error('Error saving provider settings:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to save provider settings',
        variant: 'destructive',
      });
    } finally {
      setSavingProvider(false);
    }
  };

  const addApiKey = async () => {
    if (!newKeyValue.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a valid API key',
        variant: 'destructive',
      });
      return;
    }

    setAdding(true);
    try {
      const { error } = await supabase
        .from('api_keys')
        .insert({
          provider: 'gemini',
          key_value: newKeyValue.trim(),
          is_active: true,
          error_count: 0,
        });

      if (error) throw error;

      toast({
        title: 'Success',
        description: 'API key added successfully',
      });
      setNewKeyValue('');
      setAddDialogOpen(false);
      fetchApiKeys();
    } catch (error) {
      console.error('Error adding API key:', error);
      toast({
        title: 'Error',
        description: 'Failed to add API key',
        variant: 'destructive',
      });
    } finally {
      setAdding(false);
    }
  };

  const addGroqApiKey = async () => {
    if (!newGroqKeyValue.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a valid Groq API key',
        variant: 'destructive',
      });
      return;
    }

    setAdding(true);
    try {
      const { error } = await supabase
        .from('api_keys')
        .insert({
          provider: 'groq',
          key_value: newGroqKeyValue.trim(),
          is_active: true,
          error_count: 0,
        });

      if (error) throw error;

      toast({
        title: 'Success',
        description: 'Groq API key added successfully',
      });
      setNewGroqKeyValue('');
      setAddGroqDialogOpen(false);
      fetchGroqApiKeys();
    } catch (error) {
      console.error('Error adding Groq API key:', error);
      toast({
        title: 'Error',
        description: 'Failed to add Groq API key',
        variant: 'destructive',
      });
    } finally {
      setAdding(false);
    }
  };

  const toggleKeyStatus = async (id: string, currentStatus: boolean, isGroq: boolean = false) => {
    try {
      const { error } = await supabase
        .from('api_keys')
        .update({ is_active: !currentStatus })
        .eq('id', id);

      if (error) throw error;

      const setter = isGroq ? setGroqApiKeys : setApiKeys;
      setter(prev => 
        prev.map(key => 
          key.id === id ? { ...key, is_active: !currentStatus } : key
        )
      );

      toast({
        title: 'Success',
        description: `API key ${!currentStatus ? 'enabled' : 'disabled'}`,
      });
    } catch (error) {
      console.error('Error toggling key status:', error);
      toast({
        title: 'Error',
        description: 'Failed to update key status',
        variant: 'destructive',
      });
    }
  };

  const deleteApiKey = async (id: string, isGroq: boolean = false) => {
    try {
      const { error } = await supabase
        .from('api_keys')
        .delete()
        .eq('id', id);

      if (error) throw error;

      const setter = isGroq ? setGroqApiKeys : setApiKeys;
      setter(prev => prev.filter(key => key.id !== id));

      toast({
        title: 'Success',
        description: 'API key deleted',
      });
    } catch (error) {
      console.error('Error deleting API key:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete API key',
        variant: 'destructive',
      });
    }
  };

  const resetQuota = async (id: string, quotaType: 'tts' | 'flash_2_5' | 'flash_lite' | 'pro_3_0' | 'exp_pro' | 'all') => {
    try {
      const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
      const quotaTypes = ['tts', 'flash_2_5', 'flash_lite', 'pro_3_0', 'exp_pro'];
      
      if (quotaType === 'all') {
        quotaTypes.forEach(qt => {
          updateData[`${qt}_quota_exhausted`] = false;
          updateData[`${qt}_quota_exhausted_date`] = null;
        });
      } else {
        updateData[`${quotaType}_quota_exhausted`] = false;
        updateData[`${quotaType}_quota_exhausted_date`] = null;
      }

      const { error } = await supabase
        .from('api_keys')
        .update(updateData)
        .eq('id', id);

      if (error) throw error;

      setApiKeys(prev =>
        prev.map(key => {
          if (key.id !== id) return key;
          const updates: Partial<ApiKey> = {};
          if (quotaType === 'all') {
            quotaTypes.forEach(qt => {
              (updates as Record<string, unknown>)[`${qt}_quota_exhausted`] = false;
              (updates as Record<string, unknown>)[`${qt}_quota_exhausted_date`] = null;
            });
          } else {
            (updates as Record<string, unknown>)[`${quotaType}_quota_exhausted`] = false;
            (updates as Record<string, unknown>)[`${quotaType}_quota_exhausted_date`] = null;
          }
          return { ...key, ...updates };
        })
      );

      const quotaLabel = quotaType === 'all' ? 'All quotas' : quotaType.replace(/_/g, ' ').toUpperCase() + ' quota';
      toast({
        title: 'Success',
        description: `${quotaLabel} reset successfully`,
      });
    } catch (error) {
      console.error('Error resetting quota:', error);
      toast({
        title: 'Error',
        description: 'Failed to reset quota',
        variant: 'destructive',
      });
    }
  };

  const resetAllQuotas = async () => {
    try {
      const { error } = await supabase
        .from('api_keys')
        .update({
          tts_quota_exhausted: false,
          tts_quota_exhausted_date: null,
          flash_2_5_quota_exhausted: false,
          flash_2_5_quota_exhausted_date: null,
          flash_lite_quota_exhausted: false,
          flash_lite_quota_exhausted_date: null,
          pro_3_0_quota_exhausted: false,
          pro_3_0_quota_exhausted_date: null,
          exp_pro_quota_exhausted: false,
          exp_pro_quota_exhausted_date: null,
          updated_at: new Date().toISOString(),
        })
        .eq('provider', 'gemini');

      if (error) throw error;

      setApiKeys(prev =>
        prev.map(key => ({
          ...key,
          tts_quota_exhausted: false,
          tts_quota_exhausted_date: null,
          flash_2_5_quota_exhausted: false,
          flash_2_5_quota_exhausted_date: null,
          flash_lite_quota_exhausted: false,
          flash_lite_quota_exhausted_date: null,
          pro_3_0_quota_exhausted: false,
          pro_3_0_quota_exhausted_date: null,
          exp_pro_quota_exhausted: false,
          exp_pro_quota_exhausted_date: null,
        }))
      );

      toast({
        title: 'Success',
        description: 'All API key quotas have been reset',
      });
    } catch (error) {
      console.error('Error resetting all quotas:', error);
      toast({
        title: 'Error',
        description: 'Failed to reset quotas',
        variant: 'destructive',
      });
    }
  };

  const maskKey = (key: string) => {
    if (key.length <= 8) return '••••••••';
    return key.substring(0, 4) + '••••••••' + key.substring(key.length - 4);
  };

  const isQuotaExhaustedToday = (date: string | null) => {
    if (!date) return false;
    const today = new Date().toISOString().split('T')[0];
    return date === today;
  };

  const activeCount = apiKeys.filter(k => k.is_active).length;
  const groqActiveCount = groqApiKeys.filter(k => k.is_active).length;
  const ttsExhaustedCount = apiKeys.filter(k => k.tts_quota_exhausted && isQuotaExhaustedToday(k.tts_quota_exhausted_date)).length;
  const flash25ExhaustedCount = apiKeys.filter(k => k.flash_2_5_quota_exhausted && isQuotaExhaustedToday(k.flash_2_5_quota_exhausted_date)).length;

  return (
    <div className="p-6 bg-gradient-to-br from-background via-background to-primary/5 min-h-full">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-xl bg-gradient-to-br from-primary to-accent">
            <Settings className="w-6 h-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-bold font-heading">Admin Settings</h1>
            <p className="text-muted-foreground">Manage API keys and system configuration</p>
          </div>
        </div>
      </div>

      <Tabs defaultValue="provider" className="space-y-6">
        <TabsList className="grid w-full max-w-lg grid-cols-4">
          <TabsTrigger value="provider" className="flex items-center gap-2">
            <Zap className="w-4 h-4" />
            Provider
          </TabsTrigger>
          <TabsTrigger value="keys" className="flex items-center gap-2">
            <Key className="w-4 h-4" />
            API Keys
          </TabsTrigger>
          <TabsTrigger value="quotas" className="flex items-center gap-2">
            <Gauge className="w-4 h-4" />
            Quotas
          </TabsTrigger>
          <TabsTrigger value="analytics" className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />
            Analytics
          </TabsTrigger>
        </TabsList>

        {/* Provider Settings Tab */}
        <TabsContent value="provider" className="space-y-6">
          <Card className="border-0 shadow-lg">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="text-primary" />
                Speaking Evaluation Provider
              </CardTitle>
              <CardDescription>
                Switch between Gemini (audio-native) and Groq (Whisper STT + Llama LLM) for speaking evaluation
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Provider Selection */}
              <div className="flex items-center gap-4">
                <Label className="min-w-32">Current Provider:</Label>
                <Select 
                  value={providerSettings.provider} 
                  onValueChange={(value: 'gemini' | 'groq') => saveProviderSettings({ provider: value })}
                  disabled={savingProvider}
                >
                  <SelectTrigger className="w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gemini">
                      <div className="flex flex-col">
                        <span>Gemini 2.5 Flash (Audio-Native)</span>
                        <span className="text-xs text-muted-foreground">Direct audio analysis, better pronunciation</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="groq">
                      <div className="flex flex-col">
                        <span>Groq (Whisper + Llama 3.3 70B)</span>
                        <span className="text-xs text-muted-foreground">2-step: STT → LLM, faster inference</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
                {savingProvider && <RefreshCw className="w-4 h-4 animate-spin" />}
              </div>

              {/* Provider-specific info */}
              {providerSettings.provider === 'groq' && (
                <Alert>
                  <Zap className="h-4 w-4" />
                  <AlertDescription>
                    <strong>Groq Mode:</strong> Uses Whisper STT for transcription, then Llama 3.3 70B for evaluation. 
                    Pronunciation is <em>estimated</em> from transcription confidence scores (not direct audio analysis).
                    Requires multiple free Groq accounts for key rotation (20 RPM, 7,200 ASH/hour limits).
                  </AlertDescription>
                </Alert>
              )}

              {providerSettings.provider === 'gemini' && (
                <Alert>
                  <Zap className="h-4 w-4" />
                  <AlertDescription>
                    <strong>Gemini Mode:</strong> Uses Gemini 2.5 Flash with native audio understanding. 
                    Direct pronunciation analysis from audio prosody. Single API call per evaluation part.
                  </AlertDescription>
                </Alert>
              )}

              {/* Auto-fallback toggle */}
              <div className="flex items-center gap-4">
                <Switch 
                  checked={providerSettings.auto_fallback_enabled}
                  onCheckedChange={(checked) => saveProviderSettings({ auto_fallback_enabled: checked })}
                  disabled={savingProvider}
                />
                <Label>Auto-fallback to Gemini if Groq fails after 3 attempts</Label>
              </div>

              {/* Status summary */}
              <div className="flex items-center gap-4 pt-4 border-t">
                <Badge variant={providerSettings.provider === 'gemini' ? 'default' : 'outline'}>
                  Gemini: {activeCount} keys
                </Badge>
                <Badge variant={providerSettings.provider === 'groq' ? 'default' : 'outline'}>
                  Groq: {groqActiveCount} keys
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* Groq API Keys Section */}
          <Card className="border-0 shadow-lg">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Key className="text-primary" />
                  Groq API Keys (Free Tier)
                </CardTitle>
                <CardDescription>
                  Each key should be from a separate Groq account. Free tier: 20 RPM (Whisper), 7,200 ASH/hour
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={groqActiveCount > 0 ? 'default' : 'secondary'}>
                  {groqActiveCount} Active
                </Badge>
                <Dialog open={addGroqDialogOpen} onOpenChange={setAddGroqDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm">
                      <Plus className="w-4 h-4 mr-2" />
                      Add Groq Key
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add New Groq API Key</DialogTitle>
                      <DialogDescription>
                        Add a key from a separate Groq account. Get free keys at console.groq.com
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label htmlFor="groqApiKey">API Key</Label>
                        <div className="relative">
                          <Input
                            id="groqApiKey"
                            type={showNewGroqKey ? 'text' : 'password'}
                            placeholder="gsk_..."
                            value={newGroqKeyValue}
                            onChange={(e) => setNewGroqKeyValue(e.target.value)}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                            onClick={() => setShowNewGroqKey(!showNewGroqKey)}
                          >
                            {showNewGroqKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </Button>
                        </div>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setAddGroqDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button onClick={addGroqApiKey} disabled={adding}>
                        {adding ? 'Adding...' : 'Add Key'}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {groqApiKeys.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Key className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No Groq API keys configured</p>
                  <p className="text-sm">Add Groq keys to enable the Groq evaluation provider</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Key</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>ASH Used/Hour</TableHead>
                      <TableHead>Whisper Quota</TableHead>
                      <TableHead>Llama Quota</TableHead>
                      <TableHead>Added</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groqApiKeys.map((key) => (
                      <TableRow key={key.id}>
                        <TableCell className="font-mono text-sm">
                          {maskKey(key.key_value)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={key.is_active}
                              onCheckedChange={() => toggleKeyStatus(key.id, key.is_active, true)}
                            />
                            {key.is_active ? (
                              <Badge variant="outline" className="text-emerald-600 border-emerald-600">
                                <CheckCircle className="w-3 h-3 mr-1" />
                                Active
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground">
                                Disabled
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">
                            {key.groq_ash_used_this_hour || 0} / 7,200s
                          </span>
                        </TableCell>
                        <TableCell>
                          {key.groq_whisper_exhausted && isQuotaExhaustedToday(key.groq_whisper_exhausted_date || null) ? (
                            <Badge variant="outline" className="text-amber-600 border-amber-600">
                              Exhausted
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-emerald-600 border-emerald-600">
                              <CheckCircle className="w-3 h-3 mr-1" />
                              OK
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {key.groq_llama_exhausted && isQuotaExhaustedToday(key.groq_llama_exhausted_date || null) ? (
                            <Badge variant="outline" className="text-amber-600 border-amber-600">
                              Exhausted
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-emerald-600 border-emerald-600">
                              <CheckCircle className="w-3 h-3 mr-1" />
                              OK
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {new Date(key.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete Groq API Key?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will permanently remove this Groq API key.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => deleteApiKey(key.id, true)}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="keys">
          {/* API Keys Section */}
          <Card className="border-0 shadow-lg">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Key className="text-primary" />
                  Gemini API Keys
                </CardTitle>
                <CardDescription>
                  Manage the pool of API keys used for AI generation (Random rotation with quota management)
                </CardDescription>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={activeCount > 0 ? 'default' : 'destructive'}>
                  {activeCount} Active
                </Badge>
                {ttsExhaustedCount > 0 && (
                  <Badge variant="outline" className="text-amber-600 border-amber-600">
                    {ttsExhaustedCount} TTS Quota Hit
                  </Badge>
                )}
                {flash25ExhaustedCount > 0 && (
                  <Badge variant="outline" className="text-amber-600 border-amber-600">
                    {flash25ExhaustedCount} Flash 2.5 Quota Hit
                  </Badge>
                )}
                {(ttsExhaustedCount > 0 || flash25ExhaustedCount > 0) && (
                  <Button variant="outline" size="sm" onClick={resetAllQuotas}>
                    <RefreshCw className="w-3 h-3 mr-1" />
                    Reset All Quotas
                  </Button>
                )}
                <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm">
                      <Plus className="w-4 h-4 mr-2" />
                      Add Key
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add New Gemini API Key</DialogTitle>
                      <DialogDescription>
                        Add a new API key to the rotation pool. Keys are used randomly with automatic quota management.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label htmlFor="apiKey">API Key</Label>
                        <div className="relative">
                          <Input
                            id="apiKey"
                            type={showNewKey ? 'text' : 'password'}
                            placeholder="AIza..."
                            value={newKeyValue}
                            onChange={(e) => setNewKeyValue(e.target.value)}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                            onClick={() => setShowNewKey(!showNewKey)}
                          >
                            {showNewKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </Button>
                        </div>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button onClick={addApiKey} disabled={adding}>
                        {adding ? 'Adding...' : 'Add Key'}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : apiKeys.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Key className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No API keys configured</p>
                  <p className="text-sm">Add your first Gemini API key to enable AI generation</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Key</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>TTS Quota</TableHead>
                      <TableHead>Flash 2.5 Quota</TableHead>
                      <TableHead>Added</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {apiKeys.map((key) => (
                      <TableRow key={key.id}>
                        <TableCell className="font-mono text-sm">
                          {maskKey(key.key_value)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={key.is_active}
                              onCheckedChange={() => toggleKeyStatus(key.id, key.is_active)}
                            />
                            {key.is_active ? (
                              <Badge variant="outline" className="text-emerald-600 border-emerald-600">
                                <CheckCircle className="w-3 h-3 mr-1" />
                                Active
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground">
                                Disabled
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {key.tts_quota_exhausted && isQuotaExhaustedToday(key.tts_quota_exhausted_date) ? (
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-amber-600 border-amber-600">
                                Exhausted
                              </Badge>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => resetQuota(key.id, 'tts')}
                                title="Reset TTS quota"
                              >
                                <RefreshCw className="w-3 h-3" />
                              </Button>
                            </div>
                          ) : (
                            <Badge variant="outline" className="text-emerald-600 border-emerald-600">
                              <CheckCircle className="w-3 h-3 mr-1" />
                              OK
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {key.flash_2_5_quota_exhausted && isQuotaExhaustedToday(key.flash_2_5_quota_exhausted_date) ? (
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-amber-600 border-amber-600">
                                Exhausted
                              </Badge>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => resetQuota(key.id, 'flash_2_5')}
                                title="Reset Flash 2.5 quota"
                              >
                                <RefreshCw className="w-3 h-3" />
                              </Button>
                            </div>
                          ) : (
                            <Badge variant="outline" className="text-emerald-600 border-emerald-600">
                              <CheckCircle className="w-3 h-3 mr-1" />
                              OK
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {new Date(key.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete API Key?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will permanently remove this API key from the rotation pool.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => deleteApiKey(key.id)}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="quotas">
          <ApiKeyQuotaDashboard />
        </TabsContent>

        <TabsContent value="analytics">
          <ModelPerformanceAnalytics />
        </TabsContent>
      </Tabs>
    </div>
  );
}
