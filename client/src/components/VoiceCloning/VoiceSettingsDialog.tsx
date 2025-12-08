
import React, { useState, useEffect, useRef } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { toast } from '@/hooks/use-toast';
import { Loader2, Info, Play, Pause, RefreshCw } from 'lucide-react';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';

interface VoiceSettings {
    stability: number;
    similarity_boost: number;
    style: number;
    use_speaker_boost: boolean;
}

interface VoiceSettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    voiceProfileId: string;
    initialSettings?: Partial<VoiceSettings>;
    voiceName: string;
}

const DEFAULT_SETTINGS: VoiceSettings = {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.0,
    use_speaker_boost: true,
};

const PREVIEW_TEXT = "Hello! This is a preview of my voice with the current settings. How do I sound?";

export const VoiceSettingsDialog: React.FC<VoiceSettingsDialogProps> = ({
    open,
    onOpenChange,
    voiceProfileId,
    initialSettings,
    voiceName,
}) => {
    const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_SETTINGS);
    const [previewText, setPreviewText] = useState(PREVIEW_TEXT);
    const [isPlaying, setIsPlaying] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const queryClient = useQueryClient();

    useEffect(() => {
        if (open) {
            setSettings({
                stability: initialSettings?.stability ?? DEFAULT_SETTINGS.stability,
                similarity_boost: initialSettings?.similarity_boost ?? DEFAULT_SETTINGS.similarity_boost,
                style: initialSettings?.style ?? DEFAULT_SETTINGS.style,
                use_speaker_boost: initialSettings?.use_speaker_boost ?? DEFAULT_SETTINGS.use_speaker_boost,
            });
            setPreviewUrl(null);
            setPreviewText(PREVIEW_TEXT);
        } else {
            // Cleanup audio on close
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
            }
            setIsPlaying(false);
        }
    }, [open, initialSettings]);

    const updateSettingsMutation = useMutation({
        mutationFn: async (newSettings: VoiceSettings) => {
            await apiRequest('PATCH', `/api/voice-profiles/${voiceProfileId}`, {
                metadata: {
                    voiceSettings: newSettings,
                },
            });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['voice-profiles'] });
            toast({
                title: "Settings Saved",
                description: "Voice settings have been updated successfully.",
            });
            onOpenChange(false);
        },
        onError: (error: any) => {
            toast({
                title: "Update Failed",
                description: error.message || "Could not update voice settings",
                variant: "destructive",
            });
        },
    });

    const previewMutation = useMutation({
        mutationFn: async () => {
            // Stop current playback
            if (audioRef.current) {
                audioRef.current.pause();
                setIsPlaying(false);
            }

            const response = await apiRequest('POST', `/api/voice-profiles/${voiceProfileId}/preview`, {
                targetSeconds: 10, // Short preview
                voiceSettings: settings, // Pass current settings override
                // We might want to pass custom text if the backend supported it, 
                // but currently it generates a story. 
                // Ideally, we'd update the backend to accept 'text' for preview too.
                // For now, we rely on the story generation but with our settings.
            });
            return response.json();
        },
        onSuccess: (data) => {
            if (data.generation?.audioUrl) {
                setPreviewUrl(data.generation.audioUrl);
                // Auto-play
                const audio = new Audio(data.generation.audioUrl);
                audioRef.current = audio;
                audio.onended = () => setIsPlaying(false);
                audio.onerror = () => {
                    setIsPlaying(false);
                    toast({
                        title: "Playback Error",
                        description: "Failed to play preview audio",
                        variant: "destructive"
                    });
                };
                audio.play();
                setIsPlaying(true);
            } else if (data.warning) {
                toast({
                    title: "Preview Warning",
                    description: data.warning,
                    variant: "destructive"
                });
            }
        },
        onError: (error: any) => {
            toast({
                title: "Preview Failed",
                description: error.message || "Could not generate preview",
                variant: "destructive",
            });
        }
    });

    const handlePlayPreview = () => {
        if (previewUrl && !previewMutation.isPending) {
            if (isPlaying && audioRef.current) {
                audioRef.current.pause();
                setIsPlaying(false);
            } else if (audioRef.current) {
                audioRef.current.play();
                setIsPlaying(true);
            } else {
                // Should not happen if previewUrl is set, but just in case
                const audio = new Audio(previewUrl);
                audioRef.current = audio;
                audio.onended = () => setIsPlaying(false);
                audio.play();
                setIsPlaying(true);
            }
        } else {
            previewMutation.mutate();
        }
    };

    const handleSave = () => {
        updateSettingsMutation.mutate(settings);
    };

    const handleReset = () => {
        setSettings(DEFAULT_SETTINGS);
        setPreviewUrl(null);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Fine-tune Voice: {voiceName}</DialogTitle>
                    <DialogDescription>
                        Adjust parameters to customize speech generation. Preview changes before saving.
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-6 py-4">
                    {/* Preview Section */}
                    <div className="bg-muted/30 p-4 rounded-lg space-y-4 border">
                        <div className="flex items-center justify-between">
                            <Label className="text-base font-semibold">Preview Settings</Label>
                            {previewUrl && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                        setPreviewUrl(null);
                                        previewMutation.mutate();
                                    }}
                                    className="h-8 text-xs"
                                >
                                    <RefreshCw className="h-3 w-3 mr-1" />
                                    Regenerate
                                </Button>
                            )}
                        </div>

                        <div className="flex gap-2">
                            <Button
                                onClick={handlePlayPreview}
                                disabled={previewMutation.isPending}
                                className="w-full"
                                variant={previewUrl ? "secondary" : "default"}
                            >
                                {previewMutation.isPending ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : isPlaying ? (
                                    <Pause className="mr-2 h-4 w-4" />
                                ) : (
                                    <Play className="mr-2 h-4 w-4" />
                                )}
                                {previewMutation.isPending ? "Generating..." : isPlaying ? "Pause Preview" : previewUrl ? "Play Preview" : "Generate Preview"}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground text-center">
                            Generates a short sample using the current slider positions.
                        </p>
                    </div>

                    <Separator />

                    {/* Settings Controls */}
                    <div className="space-y-6">
                        {/* Stability */}
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Label htmlFor="stability" className="font-medium">Stability</Label>
                                    <TooltipProvider>
                                        <Tooltip>
                                            <TooltipTrigger>
                                                <Info className="h-4 w-4 text-muted-foreground" />
                                            </TooltipTrigger>
                                            <TooltipContent className="max-w-xs">
                                                <p>Lower values: More emotion, but potential instability.</p>
                                                <p>Higher values: More stable, but potential monotony.</p>
                                                <p>Recommended: 0.50</p>
                                            </TooltipContent>
                                        </Tooltip>
                                    </TooltipProvider>
                                </div>
                                <span className="text-sm font-mono bg-muted px-2 py-0.5 rounded">
                                    {settings.stability.toFixed(2)}
                                </span>
                            </div>
                            <Slider
                                id="stability"
                                min={0}
                                max={1}
                                step={0.01}
                                value={[settings.stability]}
                                onValueChange={(vals) => {
                                    setSettings({ ...settings, stability: vals[0] });
                                    setPreviewUrl(null); // Invalidate preview on change
                                }}
                            />
                        </div>

                        {/* Similarity Boost */}
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Label htmlFor="similarity" className="font-medium">Similarity Boost</Label>
                                    <TooltipProvider>
                                        <Tooltip>
                                            <TooltipTrigger>
                                                <Info className="h-4 w-4 text-muted-foreground" />
                                            </TooltipTrigger>
                                            <TooltipContent className="max-w-xs">
                                                <p>Higher values: Closer to original voice, but potential artifacts.</p>
                                                <p>Lower values: Clearer audio, but less similar.</p>
                                                <p>Recommended: 0.75</p>
                                            </TooltipContent>
                                        </Tooltip>
                                    </TooltipProvider>
                                </div>
                                <span className="text-sm font-mono bg-muted px-2 py-0.5 rounded">
                                    {settings.similarity_boost.toFixed(2)}
                                </span>
                            </div>
                            <Slider
                                id="similarity"
                                min={0}
                                max={1}
                                step={0.01}
                                value={[settings.similarity_boost]}
                                onValueChange={(vals) => {
                                    setSettings({ ...settings, similarity_boost: vals[0] });
                                    setPreviewUrl(null);
                                }}
                            />
                        </div>

                        {/* Style Exaggeration */}
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Label htmlFor="style" className="font-medium">Style Exaggeration</Label>
                                    <TooltipProvider>
                                        <Tooltip>
                                            <TooltipTrigger>
                                                <Info className="h-4 w-4 text-muted-foreground" />
                                            </TooltipTrigger>
                                            <TooltipContent className="max-w-xs">
                                                <p>Amplifies the style of the original speaker.</p>
                                                <p>Setting to 0 is most stable and fastest.</p>
                                                <p>Recommended: 0.00</p>
                                            </TooltipContent>
                                        </Tooltip>
                                    </TooltipProvider>
                                </div>
                                <span className="text-sm font-mono bg-muted px-2 py-0.5 rounded">
                                    {settings.style.toFixed(2)}
                                </span>
                            </div>
                            <Slider
                                id="style"
                                min={0}
                                max={1}
                                step={0.01}
                                value={[settings.style]}
                                onValueChange={(vals) => {
                                    setSettings({ ...settings, style: vals[0] });
                                    setPreviewUrl(null);
                                }}
                            />
                        </div>

                        {/* Speaker Boost */}
                        <div className="flex items-center justify-between space-x-2 p-3 border rounded-lg bg-muted/10">
                            <div className="flex items-center gap-2">
                                <Label htmlFor="speaker-boost" className="font-medium cursor-pointer">Speaker Boost</Label>
                                <TooltipProvider>
                                    <Tooltip>
                                        <TooltipTrigger>
                                            <Info className="h-4 w-4 text-muted-foreground" />
                                        </TooltipTrigger>
                                        <TooltipContent className="max-w-xs">
                                            <p>Boosts similarity to the original speaker.</p>
                                            <p>Slightly increases latency.</p>
                                        </TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                            </div>
                            <Switch
                                id="speaker-boost"
                                checked={settings.use_speaker_boost}
                                onCheckedChange={(checked) => {
                                    setSettings({ ...settings, use_speaker_boost: checked });
                                    setPreviewUrl(null);
                                }}
                            />
                        </div>
                    </div>
                </div>

                <DialogFooter className="flex justify-between sm:justify-between gap-4">
                    <Button variant="outline" onClick={handleReset}>
                        Reset Defaults
                    </Button>
                    <div className="flex gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleSave} disabled={updateSettingsMutation.isPending}>
                            {updateSettingsMutation.isPending && (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            )}
                            Save Settings
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
