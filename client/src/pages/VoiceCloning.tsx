import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigation } from "@/components/Navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { 
  Mic, 
  Upload, 
  Play, 
  Pause, 
  Check, 
  ChevronRight, 
  ChevronLeft,
  Loader2,
  Volume2,
  Trash2,
  Sparkles,
  User,
  AudioWaveform
} from "lucide-react";
import { cn } from "@/lib/utils";

type WizardStep = 'name' | 'record' | 'preview';

interface VoiceProfile {
  id: string;
  name: string;
  status: 'pending' | 'training' | 'ready' | 'failed';
  provider?: string;
  createdAt?: string;
}

export default function VoiceCloning() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  
  const [currentStep, setCurrentStep] = useState<WizardStep>('name');
  const [voiceName, setVoiceName] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordedAudio, setRecordedAudio] = useState<Blob | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);

  const { data: voiceProfiles, isLoading: profilesLoading } = useQuery<VoiceProfile[]>({
    queryKey: ["/api/voice-profiles"],
    refetchInterval: 5000,
  });

  const createProfileMutation = useMutation({
    mutationFn: async ({ name, audio }: { name: string; audio: File }) => {
      const formData = new FormData();
      formData.append("name", name.trim());
      formData.append("audio", audio);

      const response = await fetch("/api/voice-profiles", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create voice profile");
      }

      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Voice Clone Created!",
        description: "Your voice is being processed. This takes about 30 seconds.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/voice-profiles"] });
      setSelectedProfileId(data.id);
      resetWizard();
    },
    onError: (error: any) => {
      toast({
        title: "Creation Failed",
        description: error.message || "Could not create voice profile",
        variant: "destructive",
      });
    },
  });

  const deleteProfileMutation = useMutation({
    mutationFn: async (profileId: string) => {
      const response = await fetch(`/api/voice-profiles/${profileId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete voice profile");
      }

      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Voice Deleted",
        description: "The voice profile has been removed.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/voice-profiles"] });
      if (selectedProfileId) {
        setSelectedProfileId(null);
        setPreviewAudioUrl(null);
      }
    },
    onError: (error: any) => {
      toast({
        title: "Delete Failed",
        description: error.message || "Could not delete voice profile",
        variant: "destructive",
      });
    },
  });

  const resetWizard = () => {
    setCurrentStep('name');
    setVoiceName('');
    setRecordedAudio(null);
    setUploadedFile(null);
    setRecordingTime(0);
    setIsPlaying(false);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setAudioStream(stream);
      
      const recorder = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };
      
      recorder.onstop = () => {
        const audioBlob = new Blob(chunks, { type: 'audio/webm' });
        setRecordedAudio(audioBlob);
        stream.getTracks().forEach(track => track.stop());
        setAudioStream(null);
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current);
        }
      };
      
      setMediaRecorder(recorder);
      recorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
      
    } catch (error) {
      toast({
        title: "Microphone Access Required",
        description: "Please allow microphone access to record your voice.",
        variant: "destructive",
      });
    }
  };

  const stopRecording = () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      setIsRecording(false);
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.type.startsWith("audio/")) {
        setUploadedFile(file);
        setRecordedAudio(null);
        toast({
          title: "File Uploaded",
          description: `${file.name} is ready to use.`,
        });
      } else {
        toast({
          title: "Invalid File",
          description: "Please upload an audio file (MP3, WAV, etc.)",
          variant: "destructive",
        });
      }
    }
  };

  const playRecordedAudio = () => {
    if (!audioRef.current) return;
    
    const audioSource = recordedAudio || uploadedFile;
    if (!audioSource) return;
    
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      const url = URL.createObjectURL(audioSource);
      audioRef.current.src = url;
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const handleCreateProfile = () => {
    const audioSource = recordedAudio || uploadedFile;
    if (!audioSource || !voiceName.trim()) return;
    
    const file = audioSource instanceof File 
      ? audioSource 
      : new File([audioSource], 'recording.webm', { type: 'audio/webm' });
    
    createProfileMutation.mutate({ name: voiceName.trim(), audio: file });
  };

  const playVoicePreview = async (profileId: string) => {
    try {
      const response = await fetch(`/api/voice-profiles/${profileId}/preview`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
      });
      
      if (!response.ok) {
        throw new Error("Preview not available");
      }
      
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.play();
        setIsPlaying(true);
        setSelectedProfileId(profileId);
      }
    } catch (error) {
      toast({
        title: "Preview Unavailable",
        description: "Voice preview is not ready yet.",
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.onended = () => setIsPlaying(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
      if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [audioStream]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const hasAudio = recordedAudio || uploadedFile;
  const canProceedToRecord = voiceName.trim().length >= 2;
  const canProceedToPreview = hasAudio;

  const steps = [
    { id: 'name', label: 'Name', icon: User },
    { id: 'record', label: 'Record', icon: Mic },
    { id: 'preview', label: 'Create', icon: Sparkles },
  ];

  const currentStepIndex = steps.findIndex(s => s.id === currentStep);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <audio ref={audioRef} preload="none" />
      <Navigation />
      
      <main className="pt-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          
          <div className="text-center mb-12">
            <h1 className="text-4xl font-bold bg-gradient-to-r from-primary to-purple-500 bg-clip-text text-transparent mb-3">
              Voice Cloning Studio
            </h1>
            <p className="text-muted-foreground text-lg">
              Create a digital copy of any voice in just 3 simple steps
            </p>
          </div>

          <div className="flex justify-center mb-12">
            <div className="flex items-center gap-2">
              {steps.map((step, index) => {
                const Icon = step.icon;
                const isActive = step.id === currentStep;
                const isComplete = index < currentStepIndex;
                
                return (
                  <div key={step.id} className="flex items-center">
                    <div 
                      className={cn(
                        "flex items-center gap-2 px-4 py-2 rounded-full transition-all",
                        isActive && "bg-primary text-primary-foreground",
                        isComplete && "bg-primary/20 text-primary",
                        !isActive && !isComplete && "bg-muted text-muted-foreground"
                      )}
                    >
                      {isComplete ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <Icon className="w-4 h-4" />
                      )}
                      <span className="text-sm font-medium hidden sm:inline">{step.label}</span>
                    </div>
                    {index < steps.length - 1 && (
                      <ChevronRight className="w-4 h-4 mx-2 text-muted-foreground" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <Card className="border-2 mb-12">
            <CardContent className="p-8">
              
              {currentStep === 'name' && (
                <div className="max-w-md mx-auto text-center space-y-8">
                  <div className="w-20 h-20 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
                    <User className="w-10 h-10 text-primary" />
                  </div>
                  
                  <div>
                    <h2 className="text-2xl font-semibold mb-2">Name This Voice</h2>
                    <p className="text-muted-foreground">
                      Give your voice clone a memorable name
                    </p>
                  </div>
                  
                  <Input
                    value={voiceName}
                    onChange={(e) => setVoiceName(e.target.value)}
                    placeholder="e.g., Grandpa Joe, Mom's Voice"
                    className="text-center text-lg h-14"
                    maxLength={50}
                  />
                  
                  <Button 
                    size="lg"
                    onClick={() => setCurrentStep('record')}
                    disabled={!canProceedToRecord}
                    className="w-full gap-2"
                  >
                    Continue
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )}

              {currentStep === 'record' && (
                <div className="max-w-lg mx-auto space-y-8">
                  <div className="text-center">
                    <h2 className="text-2xl font-semibold mb-2">Record or Upload Voice</h2>
                    <p className="text-muted-foreground">
                      Provide at least 10 seconds of clear speech
                    </p>
                  </div>

                  <div className="relative">
                    <div 
                      className={cn(
                        "aspect-square max-w-[280px] mx-auto rounded-full flex items-center justify-center transition-all duration-300",
                        isRecording 
                          ? "bg-red-500/20 ring-4 ring-red-500/50 animate-pulse" 
                          : hasAudio
                          ? "bg-green-500/20 ring-4 ring-green-500/50"
                          : "bg-muted"
                      )}
                    >
                      {isRecording ? (
                        <div className="text-center">
                          <div className="text-5xl font-mono text-red-500 mb-2">
                            {formatTime(recordingTime)}
                          </div>
                          <AudioWaveform className="w-12 h-12 mx-auto text-red-500 animate-pulse" />
                        </div>
                      ) : hasAudio ? (
                        <div className="text-center">
                          <Check className="w-16 h-16 text-green-500 mx-auto mb-2" />
                          <p className="text-green-600 font-medium">Audio Ready</p>
                        </div>
                      ) : (
                        <Mic className="w-16 h-16 text-muted-foreground" />
                      )}
                    </div>
                  </div>

                  <div className="flex gap-4 justify-center">
                    {!isRecording ? (
                      <>
                        <Button 
                          size="lg"
                          onClick={startRecording}
                          className="gap-2"
                          variant={hasAudio ? "outline" : "default"}
                        >
                          <Mic className="w-5 h-5" />
                          {hasAudio ? 'Record Again' : 'Start Recording'}
                        </Button>
                        
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="audio/*"
                          onChange={handleFileUpload}
                          className="hidden"
                        />
                        <Button 
                          size="lg"
                          variant="outline"
                          onClick={() => fileInputRef.current?.click()}
                          className="gap-2"
                        >
                          <Upload className="w-5 h-5" />
                          Upload File
                        </Button>
                      </>
                    ) : (
                      <Button 
                        size="lg"
                        variant="destructive"
                        onClick={stopRecording}
                        className="gap-2"
                      >
                        <div className="w-4 h-4 bg-white rounded-sm" />
                        Stop Recording
                      </Button>
                    )}
                  </div>

                  {hasAudio && !isRecording && (
                    <div className="flex justify-center">
                      <Button 
                        variant="ghost" 
                        onClick={playRecordedAudio}
                        className="gap-2"
                      >
                        {isPlaying ? (
                          <>
                            <Pause className="w-4 h-4" />
                            Pause
                          </>
                        ) : (
                          <>
                            <Play className="w-4 h-4" />
                            Listen to Recording
                          </>
                        )}
                      </Button>
                    </div>
                  )}

                  <div className="bg-muted/50 rounded-lg p-4">
                    <h4 className="font-medium mb-2 text-sm">Tips for Best Results:</h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Find a quiet room with minimal background noise</li>
                      <li>• Speak naturally at a normal pace</li>
                      <li>• Hold your device 6-8 inches from your mouth</li>
                      <li>• Read a few sentences for variety in tone</li>
                    </ul>
                  </div>

                  <div className="flex gap-4">
                    <Button 
                      variant="outline"
                      onClick={() => setCurrentStep('name')}
                      className="gap-2"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      Back
                    </Button>
                    <Button 
                      className="flex-1 gap-2"
                      onClick={() => setCurrentStep('preview')}
                      disabled={!canProceedToPreview}
                    >
                      Continue
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}

              {currentStep === 'preview' && (
                <div className="max-w-md mx-auto text-center space-y-8">
                  <div className="w-20 h-20 mx-auto rounded-full bg-gradient-to-br from-primary to-purple-500 flex items-center justify-center">
                    <Sparkles className="w-10 h-10 text-white" />
                  </div>
                  
                  <div>
                    <h2 className="text-2xl font-semibold mb-2">Ready to Create!</h2>
                    <p className="text-muted-foreground">
                      Your voice clone "{voiceName}" will be ready in about 30 seconds
                    </p>
                  </div>

                  <Card className="bg-muted/30 border-dashed">
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center">
                            <Volume2 className="w-6 h-6 text-primary" />
                          </div>
                          <div className="text-left">
                            <p className="font-medium">{voiceName}</p>
                            <p className="text-sm text-muted-foreground">
                              {uploadedFile ? uploadedFile.name : `${formatTime(recordingTime)} recording`}
                            </p>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={playRecordedAudio}
                          aria-label={isPlaying ? "Pause recording" : "Play recording"}
                        >
                          {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>

                  <div className="flex gap-4">
                    <Button 
                      variant="outline"
                      onClick={() => setCurrentStep('record')}
                      className="gap-2"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      Back
                    </Button>
                    <Button 
                      className="flex-1 gap-2"
                      onClick={handleCreateProfile}
                      disabled={createProfileMutation.isPending}
                    >
                      {createProfileMutation.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Creating Voice Clone...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4" />
                          Create Voice Clone
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {Array.isArray(voiceProfiles) && voiceProfiles.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold">Your Voice Clones</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {voiceProfiles.map((profile) => (
                  <Card 
                    key={profile.id}
                    className={cn(
                      "transition-all hover:shadow-md",
                      selectedProfileId === profile.id && "ring-2 ring-primary"
                    )}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={cn(
                            "w-10 h-10 rounded-full flex items-center justify-center",
                            profile.status === 'ready' 
                              ? "bg-green-500/20" 
                              : profile.status === 'training'
                              ? "bg-yellow-500/20"
                              : profile.status === 'failed'
                              ? "bg-red-500/20"
                              : "bg-muted"
                          )}>
                            {profile.status === 'ready' ? (
                              <Volume2 className="w-5 h-5 text-green-600" />
                            ) : profile.status === 'training' ? (
                              <Loader2 className="w-5 h-5 text-yellow-600 animate-spin" />
                            ) : profile.status === 'failed' ? (
                              <span className="text-red-600 text-xl">!</span>
                            ) : (
                              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
                            )}
                          </div>
                          <div>
                            <p className="font-medium">{profile.name}</p>
                            <p className="text-xs text-muted-foreground capitalize">
                              {profile.status === 'ready' ? 'Ready to use' : profile.status}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {profile.status === 'ready' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => playVoicePreview(profile.id)}
                              disabled={isPlaying && selectedProfileId === profile.id}
                              aria-label={isPlaying && selectedProfileId === profile.id ? `Pause ${profile.name} preview` : `Play ${profile.name} preview`}
                            >
                              {isPlaying && selectedProfileId === profile.id ? (
                                <Pause className="w-4 h-4" />
                              ) : (
                                <Play className="w-4 h-4" />
                              )}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              if (confirm(`Delete voice "${profile.name}"?`)) {
                                deleteProfileMutation.mutate(profile.id);
                              }
                            }}
                            className="text-muted-foreground hover:text-destructive"
                            aria-label={`Delete ${profile.name}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {profilesLoading && (
            <div className="flex justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          )}

          {!profilesLoading && (!voiceProfiles || voiceProfiles.length === 0) && (
            <div className="text-center py-8 text-muted-foreground">
              <Volume2 className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No voice clones yet. Create your first one above!</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
