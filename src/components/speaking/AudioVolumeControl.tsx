import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';

// localStorage keys for volume persistence
const VOLUME_STORAGE_KEY = 'speaking_tts_volume';
const MUTED_STORAGE_KEY = 'speaking_tts_muted';

interface AudioVolumeControlProps {
  volume: number;
  setVolume: (v: number) => void;
  isMuted: boolean;
  setIsMuted: (m: boolean) => void;
  audioRef?: React.RefObject<HTMLAudioElement | null>;
  isPlaying?: boolean; // Show waveform animation when audio is playing
  className?: string;
  // TTS control callbacks (for browser speech synthesis)
  onTTSVolumeChange?: (v: number) => void;
  onTTSMutedChange?: (m: boolean) => void;
}

export function AudioVolumeControl({
  volume,
  setVolume,
  isMuted,
  setIsMuted,
  audioRef,
  isPlaying = false,
  className,
  onTTSVolumeChange,
  onTTSMutedChange,
}: AudioVolumeControlProps) {
  const [showWaveform, setShowWaveform] = useState(false);
  const hasInitialized = useRef(false);

  // Show waveform when audio is playing
  useEffect(() => {
    setShowWaveform(isPlaying);
  }, [isPlaying]);

  // Restore volume state from localStorage on mount and sync with audio element
  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    try {
      const savedVolume = localStorage.getItem(VOLUME_STORAGE_KEY);
      const savedMuted = localStorage.getItem(MUTED_STORAGE_KEY);
      
      if (savedVolume !== null) {
        const vol = Math.max(0, Math.min(1, parseFloat(savedVolume)));
        setVolume(vol);
        onTTSVolumeChange?.(vol);
        
        // Sync with audio element if available
        if (audioRef?.current) {
          audioRef.current.volume = vol;
        }
      }
      
      if (savedMuted !== null) {
        const muted = savedMuted === 'true';
        setIsMuted(muted);
        onTTSMutedChange?.(muted);
        
        // Sync with audio element if available
        if (audioRef?.current) {
          audioRef.current.muted = muted;
        }
      }
    } catch {}
  }, [setVolume, setIsMuted, audioRef, onTTSVolumeChange, onTTSMutedChange]);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseInt(e.target.value) / 100;
    setVolume(newVolume);
    if (newVolume > 0 && isMuted) {
      setIsMuted(false);
      onTTSMutedChange?.(false);
    }
    if (audioRef?.current) {
      audioRef.current.volume = newVolume;
      audioRef.current.muted = newVolume === 0;
    }
    // Also update TTS volume
    onTTSVolumeChange?.(newVolume);
  };

  const handleMuteToggle = () => {
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    // Mute the audio instead of stopping it - audio continues playing but is silent
    if (audioRef?.current) {
      audioRef.current.muted = newMuted;
    }
    // Also update TTS muted state
    onTTSMutedChange?.(newMuted);
  };

  const displayVolume = isMuted ? 0 : Math.round(volume * 100);

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {/* Waveform visualization - shows when audio is playing (even when muted) */}
      {showWaveform && (
        <div className="flex items-center gap-0.5 h-6 px-1">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className={cn(
                "w-0.5 bg-primary rounded-full transition-all",
                isMuted ? "opacity-30" : "opacity-100"
              )}
              style={{
                height: isMuted ? '4px' : undefined,
                animation: isMuted ? 'none' : `waveform ${0.5 + i * 0.1}s ease-in-out infinite alternate`,
              }}
            />
          ))}
        </div>
      )}

      {/* Horizontal Volume Slider */}
      <div className="flex items-center gap-1 bg-muted/50 rounded-full px-2 py-1">
        <input
          type="range"
          min="0"
          max="100"
          value={displayVolume}
          onChange={handleVolumeChange}
          className="w-16 md:w-20 h-1.5 appearance-none bg-muted-foreground/30 rounded-full cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-3
            [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-primary
            [&::-webkit-slider-thumb]:cursor-pointer
            [&::-webkit-slider-thumb]:transition-transform
            [&::-webkit-slider-thumb]:hover:scale-110
            [&::-moz-range-thumb]:w-3
            [&::-moz-range-thumb]:h-3
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:bg-primary
            [&::-moz-range-thumb]:border-0
            [&::-moz-range-thumb]:cursor-pointer"
          style={{
            background: `linear-gradient(to right, hsl(var(--primary)) ${displayVolume}%, hsl(var(--muted-foreground) / 0.3) ${displayVolume}%)`,
          }}
          aria-label="Volume control"
        />
        <span className="text-xs text-muted-foreground font-mono w-8 text-center">
          {displayVolume}%
        </span>
      </div>

      {/* Speaker/Mute Button */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 md:h-9 md:w-9"
        onClick={handleMuteToggle}
        aria-label={isMuted ? "Unmute" : "Mute"}
      >
        {isMuted || volume === 0 ? (
          <VolumeX className="w-4 h-4 md:w-5 md:h-5" />
        ) : (
          <Volume2 className="w-4 h-4 md:w-5 md:h-5" />
        )}
      </Button>

      {/* CSS for waveform animation */}
      <style>{`
        @keyframes waveform {
          0% { height: 4px; }
          100% { height: 16px; }
        }
      `}</style>
    </div>
  );
}
