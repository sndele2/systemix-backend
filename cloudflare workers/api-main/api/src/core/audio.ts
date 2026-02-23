export type AudioFetchResult = {
  blob: Blob | null;
  status: number | null;
};

function isTrustedTwilioHost(recordingUrl: string): boolean {
  try {
    const url = new URL(recordingUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'twilio.com' || host.endsWith('.twilio.com'));
  } catch {
    return false;
  }
}

export async function fetchRecordingAudio(
  recordingUrl: string,
  accountSid: string,
  authToken: string
): Promise<AudioFetchResult> {
  const headers: Record<string, string> = {};

  if (isTrustedTwilioHost(recordingUrl)) {
    const auth = btoa(`${accountSid}:${authToken}`);
    headers.Authorization = `Basic ${auth}`;
  }

  const audioUrl = recordingUrl.endsWith('.wav') ? recordingUrl : `${recordingUrl}.wav`;
  console.log('Fetching recording URL:', audioUrl);
  console.log('Recording auth attached:', Boolean(headers.Authorization));

  try {
    const response = await fetch(audioUrl, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    console.log(`Audio fetch status: ${response.status}`);

    if (response.status !== 200) {
      console.error(`Audio fetch failed: HTTP ${response.status}`);
      return { blob: null, status: response.status };
    }

    const blob = await response.blob();
    return { blob, status: response.status };
  } catch (e: any) {
    console.error(`Audio fetch error: ${e?.message || e}`);
    return { blob: null, status: null };
  }
}

export async function transcribeWhisper(openaiKey: string, audioBlob: Blob): Promise<string> {
  const formData = new FormData();
  formData.append('file', audioBlob, 'recording.wav');
  formData.append('model', 'whisper-1');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiKey}`,
    },
    body: formData,
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Whisper API failed: ${response.status} - ${errorText}`);
  }

  const data: any = await response.json();
  return data.text?.trim() || 'No transcription.';
}
