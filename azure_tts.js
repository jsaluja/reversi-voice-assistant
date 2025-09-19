class AzureTTS {
  constructor(subscriptionKey, region) {
    this.subscriptionKey = subscriptionKey;
    this.region = region;
    this.tokenUrl = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
    this.ttsUrl = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  // Get access token for Azure Speech Services
  async getAccessToken() {
    // Check if we have a valid token
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const response = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': this.subscriptionKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      if (!response.ok) {
        throw new Error(`Token request failed: ${response.status}`);
      }

      this.accessToken = await response.text();
      // Tokens expire after 10 minutes, refresh after 9 minutes
      this.tokenExpiry = Date.now() + (9 * 60 * 1000);
      
      return this.accessToken;
      
    } catch (error) {
      console.error('Failed to get Azure access token:', error);
      throw error;
    }
  }

  // Convert text to speech and play audio
  async speakText(text, voice = 'en-US-AriaNeural') {
    if (!this.subscriptionKey || !this.region) {
      throw new Error('Azure TTS not configured');
    }

    try {
      const token = await this.getAccessToken();
      
      // Create SSML (Speech Synthesis Markup Language)
      const ssml = `
        <speak version='1.0' xml:lang='en-US'>
          <voice xml:lang='en-US' xml:gender='Female' name='${voice}'>
            <prosody rate='medium' pitch='medium'>
              ${text}
            </prosody>
          </voice>
        </speak>
      `;

      const response = await fetch(this.ttsUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3'
        },
        body: ssml
      });

      if (!response.ok) {
        throw new Error(`TTS request failed: ${response.status}`);
      }

      // Get audio data as blob
      const audioBlob = await response.blob();
      
      // Create audio URL and play
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      
      // Play the audio
      await new Promise((resolve, reject) => {
        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          resolve();
        };
        audio.onerror = (error) => {
          URL.revokeObjectURL(audioUrl);
          reject(error);
        };
        audio.play().catch(reject);
      });

      console.log('🔊 TTS playback completed');
      
    } catch (error) {
      console.error('Azure TTS failed:', error);
      throw error;
    }
  }

  // Speak move recommendation with coordinates
  async speakMoveRecommendation(analysis) {
    let fullText = '';
    try {
      if (analysis && Array.isArray(analysis.recommendedMove)) {
        const [row, col] = analysis.recommendedMove;
        const coordinates = `Row ${row + 1}, Column ${col + 1}`;
        const reasoningText = analysis.reasoning && typeof analysis.reasoning === 'string' ? analysis.reasoning.trim() : '';
        fullText = reasoningText ? `Recommended move: ${coordinates}. ${reasoningText}` : `Recommended move: ${coordinates}.`;
      } else if (analysis && analysis.recommendedMove === null) {
        // No safe move - announce reasoning directly
        fullText = analysis.reasoning || 'No safe move available under current policy.';
      } else {
        fullText = analysis && analysis.reasoning ? analysis.reasoning : 'Recommendation unavailable.';
      }

      console.log('🔊 Talking:', fullText);
      await this.speakText(fullText);
    } catch (e) {
      console.error('AzureTTS speakMoveRecommendation failed:', e);
      throw e;
    }
  }

  // Quick test of TTS functionality
  async testTTS() {
    try {
      await this.speakText('Azure Text to Speech is working correctly.');
      return true;
    } catch (error) {
      console.error('TTS test failed:', error);
      return false;
    }
  }
}

// Export for use in background script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AzureTTS;
}
