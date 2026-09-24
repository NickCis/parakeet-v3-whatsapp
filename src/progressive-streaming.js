/**
 * Smart Progressive Streaming Handler
 *
 * Port of the andito/parakeet-v3-streaming Space algorithm (speech-to-speech
 * smart_progressive_streaming), adapted for offline WhatsApp voice notes.
 *
 * For complete audio files we use batch mode: process ~15s windows as fast as
 * the GPU allows (no artificial 500ms delays), lock finished sentences, and
 * slide the window forward so peak memory stays bounded.
 */

export class PartialTranscription {
  constructor(fixedText, activeText, timestamp, isFinal) {
    this.fixedText = fixedText;
    this.activeText = activeText;
    this.timestamp = timestamp;
    this.isFinal = isFinal;
  }

  get text() {
    const parts = [];
    if (this.fixedText) parts.push(this.fixedText);
    if (this.activeText) parts.push(this.activeText);
    return parts.join(' ').trim();
  }
}

/**
 * @param {object} model - Object with async transcribe(Float32Array) => { text, sentences }
 * @param {object} [options]
 */
export class SmartProgressiveStreamingHandler {
  constructor(model, options = {}) {
    this.model = model;
    this.maxWindowSize = options.maxWindowSize ?? 15.0;
    this.sentenceBuffer = options.sentenceBuffer ?? 2.0;
    this.sampleRate = options.sampleRate ?? 16000;
    this.reset();
  }

  reset() {
    this.fixedSentences = [];
    this.fixedEndTime = 0.0;
  }

  /**
   * Offline batch progressive transcription (no live-mic re-emits).
   * Yields PartialTranscription updates as windows complete.
   *
   * @param {Float32Array} audio
   * @yields {PartialTranscription}
   */
  async *transcribeBatch(audio) {
    const totalDuration = audio.length / this.sampleRate;
    this.reset();

    let processedUpTo = 0;

    while (processedUpTo < totalDuration) {
      const windowStart = processedUpTo;
      const windowEnd = Math.min(
        processedUpTo + this.maxWindowSize,
        totalDuration,
      );
      const windowDuration = windowEnd - windowStart;

      const windowStartSamples = Math.floor(windowStart * this.sampleRate);
      const windowEndSamples = Math.floor(windowEnd * this.sampleRate);
      const audioWindow = audio.subarray(windowStartSamples, windowEndSamples);

      const result = await this.model.transcribe(audioWindow);

      if (windowDuration >= this.maxWindowSize) {
        const cutoffTime = windowDuration - this.sentenceBuffer;

        if (result.sentences && result.sentences.length > 1) {
          const sentencesToFix = result.sentences.filter(
            s => s.end < cutoffTime,
          );

          if (sentencesToFix.length > 0) {
            this.fixedSentences.push(
              ...sentencesToFix.map(s => s.text.trim()).filter(Boolean),
            );
            const lastSentenceTime =
              sentencesToFix[sentencesToFix.length - 1].end;
            const next = windowStart + lastSentenceTime;
            // Guard against a zero-length advance looping forever
            processedUpTo =
              next > processedUpTo
                ? next
                : windowStart + Math.max(windowDuration / 2, 0.5);

            const activeSentences = result.sentences.filter(
              s => s.end >= cutoffTime,
            );
            const activeText = activeSentences
              .map(s => s.text)
              .join(' ')
              .trim();

            yield new PartialTranscription(
              this.fixedSentences.join(' '),
              activeText,
              windowEnd,
              false,
            );
          } else {
            // No sentence before cutoff — advance halfway to make progress
            const halfText = result.text ? result.text.trim() : '';
            if (halfText) this.fixedSentences.push(halfText);
            processedUpTo = windowStart + windowDuration / 2;

            yield new PartialTranscription(
              this.fixedSentences.join(' '),
              '',
              windowEnd,
              false,
            );
          }
        } else {
          const halfText = result.text ? result.text.trim() : '';
          if (halfText) this.fixedSentences.push(halfText);
          processedUpTo = windowStart + windowDuration / 2;

          yield new PartialTranscription(
            this.fixedSentences.join(' '),
            '',
            windowEnd,
            false,
          );
        }
      } else {
        const finalText = result.text ? result.text.trim() : '';
        if (finalText) this.fixedSentences.push(finalText);
        processedUpTo = windowEnd;

        yield new PartialTranscription(
          this.fixedSentences.join(' '),
          '',
          windowEnd,
          true,
        );
      }
    }
  }
}
